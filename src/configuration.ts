import type { Clock, StateStore } from "./types";
import { HAError } from "./errors";
import { id } from "./id";

export interface ClusterConfiguration {
  version: bigint;
  voters: string[];
  committedAt: number;
}

export interface ConfigurationProposal {
  id: string;
  baseVersion: bigint;
  nextVersion: bigint;
  voters: string[];
  proposer: string;
  acknowledgements: string[];
}

const uniqueSorted=(ids:string[])=>[...new Set(ids.filter(Boolean))].sort();

export class ConfigurationManager {
  private current: ClusterConfiguration;
  private pending: ConfigurationProposal|null=null;

  constructor(
    private readonly clock: Clock,
    private readonly localId: ()=>string,
    private readonly emit: (type:string,data?:Record<string,unknown>)=>void,
    private readonly store?: StateStore,
  ) {
    this.current={version:0n,voters:[],committedAt:clock.now()};
  }

  async load(initialVoters:string[]=[]){
    const saved=await this.store?.load();
    const raw=saved?.configuration as any;
    if(raw){
      const version=BigInt(String(raw.version??"0"));
      const voters=uniqueSorted(Array.isArray(raw.voters)?raw.voters:[]);
      if(version<0n||(version>0n&&voters.length===0))throw new HAError("Invalid committed configuration","CORRUPT_CONFIGURATION");
      this.current={version,voters,committedAt:Number(raw.committedAt)||this.clock.now()};
    }else{
      const voters=uniqueSorted(initialVoters);
      this.current={version:0n,voters:voters,committedAt:this.clock.now()};
      await this.persist();
    }
    this.pending=null;
  }

  private async persist(){
    if(!this.store)return;
    const state=await this.store.load();
    await this.store.save({...state,configuration:{
      version:this.current.version.toString(),
      voters:this.current.voters,
      committedAt:this.current.committedAt,
    }});
  }

  snapshot():ClusterConfiguration{return{...this.current,voters:[...this.current.voters]}};
  pendingProposal(){return this.pending?{...this.pending,voters:[...this.pending.voters],acknowledgements:[...this.pending.acknowledgements]}:null}
  isVoter(nodeId=this.localId()){return this.current.voters.includes(nodeId)}
  voters(){return [...this.current.voters]}
  majority(){return Math.floor(this.current.voters.length/2)+1}
  private transitionIsSafe(nextVoters:string[]){
    const old=new Set(this.current.voters);
    const next=new Set(nextVoters);
    if(old.size===0)return true;
    const oldMajority=Math.floor(old.size/2)+1;
    const nextMajority=Math.floor(next.size/2)+1;
    const union=new Set([...old,...next]).size;
    return oldMajority+nextMajority>union;
  }
  hasQuorum(healthy:Set<string>|string[]){const set=healthy instanceof Set?healthy:new Set(healthy);return this.current.voters.filter(x=>set.has(x)).length>=this.majority()}

  begin(voters:string[], proposer=this.localId()){
    if(!this.isVoter(proposer))throw new HAError("Only committed voters may change configuration","CONFIG_AUTHORITY_REQUIRED");
    if(this.pending)throw new HAError("Configuration change already in progress","CONFIG_CHANGE_IN_PROGRESS");
    const next=uniqueSorted(voters);
    if(!next.length)throw new HAError("Configuration must contain at least one voter","INVALID_CONFIGURATION");
    if(!this.transitionIsSafe(next))throw new HAError("Configuration transition does not preserve quorum intersection","UNSAFE_CONFIGURATION_TRANSITION");
    if(!next.includes(proposer))throw new HAError("A configuration proposer cannot remove itself","CONFIG_AUTHORITY_REQUIRED");
    if(next.length===this.current.voters.length&&next.every((v,i)=>v===this.current.voters[i]))throw new HAError("Configuration is unchanged","CONFIGURATION_UNCHANGED");
    const p={id:id("cfg"),baseVersion:this.current.version,nextVersion:this.current.version+1n,voters:next,proposer,acknowledgements:[proposer]};
    this.pending=p;
    this.emit("configuration_proposed",{id:p.id,baseVersion:p.baseVersion.toString(),nextVersion:p.nextVersion.toString(),voters:next});
    return {...p,voters:[...p.voters],acknowledgements:[...p.acknowledgements]};
  }

  accept(proposal:ConfigurationProposal,sourceId=proposal.proposer){
    if(sourceId!==proposal.proposer)throw new HAError("Configuration proposal source does not match proposer","CONFIG_AUTHORITY_REQUIRED");
    if(proposal.baseVersion!==this.current.version)throw new HAError("Stale configuration proposal","STALE_CONFIGURATION");
    if(proposal.nextVersion!==this.current.version+1n)throw new HAError("Invalid configuration version","INVALID_CONFIGURATION");
    if(!this.current.voters.includes(proposal.proposer)&&!(this.current.voters.length===0&&proposal.baseVersion===0n&&proposal.nextVersion===1n&&proposal.voters.includes(proposal.proposer)))throw new HAError("Unauthorized configuration proposer","CONFIG_AUTHORITY_REQUIRED");
    const voters=uniqueSorted(proposal.voters);
    if(!voters.length||voters.length!==proposal.voters.length)throw new HAError("Invalid configuration voters","INVALID_CONFIGURATION");
    if(this.pending&&this.pending.id!==proposal.id)throw new HAError("Conflicting configuration change","CONFIG_CHANGE_CONFLICT");
    this.pending={...proposal,voters,acknowledgements:uniqueSorted(proposal.acknowledgements)};
    this.emit("configuration_proposal_received",{id:proposal.id,version:proposal.nextVersion.toString()});
    return this.pendingProposal()!;
  }

  acknowledge(proposalId:string,nodeId=this.localId()){
    if(!this.pending||this.pending.id!==proposalId)throw new HAError("Unknown configuration proposal","UNKNOWN_CONFIGURATION");
    if(!this.pending.voters.includes(nodeId)&&!this.current.voters.includes(nodeId))throw new HAError("Node is not part of configuration transition","CONFIG_AUTHORITY_REQUIRED");
    if(!this.pending.acknowledgements.includes(nodeId))this.pending.acknowledgements.push(nodeId);
    return this.pendingProposal()!;
  }

  readyToCommit(){
    if(!this.pending)return false;
    const acks=new Set(this.pending.acknowledgements);
    const currentAcks=this.current.voters.filter(v=>acks.has(v)).length;
    return currentAcks>=this.majority();
  }

  async commit(proposalId:string){
    if(!this.pending||this.pending.id!==proposalId)throw new HAError("Unknown configuration proposal","UNKNOWN_CONFIGURATION");
    if(!this.readyToCommit())throw new HAError("Configuration quorum not reached","CONFIGURATION_QUORUM_REQUIRED");
    const p=this.pending;
    this.current={version:p.nextVersion,voters:[...p.voters],committedAt:this.clock.now()};
    this.pending=null;
    await this.persist();
    this.emit("configuration_committed",{id:p.id,version:this.current.version.toString(),voters:this.current.voters});
    return this.snapshot();
  }

  abort(proposalId:string){
    if(this.pending?.id===proposalId){this.pending=null;this.emit("configuration_aborted",{id:proposalId})}
  }

  assertVersion(version:bigint){
    if(version!==this.current.version)throw new HAError("Stale configuration version","STALE_CONFIGURATION");
  }

  async installSnapshot(snapshot:ClusterConfiguration,sourceId:string){
    if(snapshot.version<this.current.version)throw new HAError("Stale configuration snapshot","STALE_CONFIGURATION");
    if(!snapshot.voters.includes(sourceId))throw new HAError("Configuration snapshot source is not a voter","CONFIG_AUTHORITY_REQUIRED");
    if(this.current.voters.length>0&&!this.current.voters.includes(sourceId))throw new HAError("Configuration snapshot source is not in current configuration","CONFIG_AUTHORITY_REQUIRED");
    const voters=uniqueSorted(snapshot.voters);
    if(snapshot.version>this.current.version&&this.current.voters.length>0){
      if(snapshot.version!==this.current.version+1n)throw new HAError("Configuration snapshot skipped a version","STALE_CONFIGURATION");
      if(!this.transitionIsSafe(voters))throw new HAError("Configuration snapshot does not preserve quorum intersection","UNSAFE_CONFIGURATION_TRANSITION");
    }
    if(snapshot.version===this.current.version&&this.current.voters.length>0&&voters.join(",")!==this.current.voters.join(","))throw new HAError("Conflicting configuration at committed version","CONFIG_CHANGE_CONFLICT");
    this.current={version:snapshot.version,voters,committedAt:snapshot.committedAt||this.clock.now()};
    this.pending=null;
    await this.persist();
    this.emit("configuration_synced",{version:this.current.version.toString(),voters:this.current.voters});
    return this.snapshot();
  }

  async installCommitted(proposal:ConfigurationProposal,sourceId=proposal.proposer){
    if(proposal.nextVersion<=this.current.version)return this.snapshot();
    if(sourceId!==proposal.proposer)throw new HAError("Configuration commit source does not match proposer","CONFIG_AUTHORITY_REQUIRED");
    if(proposal.baseVersion!==this.current.version)throw new HAError("Configuration commit skipped a version","STALE_CONFIGURATION");
    if(!this.current.voters.includes(proposal.proposer)&&!(this.current.voters.length===0&&proposal.baseVersion===0n&&proposal.nextVersion===1n&&proposal.voters.includes(proposal.proposer)))throw new HAError("Configuration proposer is not a committed voter","CONFIG_AUTHORITY_REQUIRED");
    const voters=uniqueSorted(proposal.voters);
    if(!this.transitionIsSafe(voters))throw new HAError("Configuration commit does not preserve quorum intersection","UNSAFE_CONFIGURATION_TRANSITION");
    const acknowledgements=new Set(proposal.acknowledgements||[]);const quorumVoters=this.current.voters.length>0?this.current.voters:[proposal.proposer];const required=Math.floor(quorumVoters.length/2)+1;const acknowledgedVoters=quorumVoters.filter(v=>acknowledgements.has(v)).length;if(acknowledgedVoters<required)throw new HAError("Configuration commit lacks voter quorum","CONFIGURATION_QUORUM_REQUIRED");this.current={version:proposal.nextVersion,voters:voters,committedAt:this.clock.now()};
    this.pending=null;
    await this.persist();
    this.emit("configuration_committed",{id:proposal.id,version:this.current.version.toString(),voters:this.current.voters});
    return this.snapshot();
  }
}
