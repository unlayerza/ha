import type {Clock,Role,Transport,ClusterMessage,VoteRequest,VoteResponse,Member} from "./types";
import {id} from "./id";
import {StaleTermError} from "./errors";

interface ElectionHooks{
  members():Member[];
  healthy():number;
  voters():string[];
  configurationVersion():bigint;
  persist(term:bigint,votedFor:string|null):Promise<void>;
  onRole(role:Role,term:bigint):Promise<void>;
  onTerm(term:bigint):Promise<void>;
}
export interface ElectionOptions{random?:()=>number}
type PreVoteResponse={from:string;term:bigint;configurationVersion:bigint;granted:boolean};

export class Election{
  role:Role="follower";term=0n;leaderId:string|null=null;votedFor:string|null=null;
  private deadline=0;private timer?:Timer;private votes=new Set<string>();private preVotes=new Set<string>();private lastHeartbeat=0;private random:()=>number;private electionAllowed=true;
  constructor(private nodeId:string,private transport:Transport,private clock:Clock,private heartbeatMs:number,private minElectionMs:number,private maxElectionMs:number,private hooks:ElectionHooks,o:ElectionOptions={}){this.random=o.random||Math.random}
  setNodeId(id:string){this.nodeId=id}
  setElectionAllowed(allowed:boolean){this.electionAllowed=allowed;if(allowed)this.resetDeadline()}
  async stepDown(){if(this.role==="follower")return;this.role="follower";this.leaderId=null;this.votes.clear();this.preVotes.clear();this.resetDeadline();await this.hooks.onRole(this.role,this.term)}
  isElectionAllowed(){return this.electionAllowed}
  private timeout(){const span=this.maxElectionMs-this.minElectionMs;return this.minElectionMs+(span?Math.floor(this.random()*span):0)}
  private resetDeadline(){this.deadline=this.clock.now()+this.timeout()}
  private voters(){return this.hooks.voters()}
  private majority(){const n=this.voters().length;return Math.floor(n/2)+1}
  private isVoter(nodeId:string){return this.voters().includes(nodeId)}
  async restore(term:bigint,votedFor:string|null){this.term=term;this.votedFor=votedFor;this.resetDeadline()}
  async observeTerm(term:bigint){if(term<=this.term)return false;this.term=term;this.role="follower";this.votedFor=null;this.leaderId=null;this.votes.clear();this.preVotes.clear();await this.hooks.persist(this.term,null);await this.hooks.onTerm(this.term);await this.hooks.onRole(this.role,this.term);this.resetDeadline();return true}
  async start(){this.resetDeadline();this.timer=setInterval(()=>void this.tick().catch(()=>{}),Math.max(20,Math.floor(this.heartbeatMs/2)));if(this.electionAllowed&&this.isVoter(this.nodeId)&&this.voters().length===1)await this.startElection()}
  async stop(){if(this.timer)clearInterval(this.timer)}
  private async tick(){if(this.role==="leader"){if(this.clock.now()-this.lastHeartbeat>=this.heartbeatMs){this.lastHeartbeat=this.clock.now();await this.broadcastHeartbeat()}return}if(!this.electionAllowed||!this.isVoter(this.nodeId))return;if(this.clock.now()>=this.deadline)await this.startPreVote()}
  private async startPreVote(){if(!this.electionAllowed||!this.isVoter(this.nodeId))return;this.role="candidate";this.preVotes=new Set([this.nodeId]);this.resetDeadline();if(this.preVotes.size>=this.majority()){await this.startElection();return}const req={from:this.nodeId,term:this.term+1n,lastTerm:this.term,lastIndex:0,configurationVersion:this.hooks.configurationVersion()};await this.send("pre_vote_request",req)}
  private async startElection(){if(!this.electionAllowed||!this.isVoter(this.nodeId))return;this.role="candidate";this.term++;this.votedFor=this.nodeId;this.votes=new Set([this.nodeId]);this.preVotes.clear();await this.hooks.persist(this.term,this.votedFor);await this.hooks.onTerm(this.term);await this.hooks.onRole(this.role,this.term);this.resetDeadline();if(this.votes.size>=this.majority()){this.role="leader";this.leaderId=this.nodeId;this.lastHeartbeat=0;await this.hooks.onRole(this.role,this.term);await this.broadcastHeartbeat();return}const req:VoteRequest={from:this.nodeId,term:this.term,lastTerm:this.term,lastIndex:0};await this.send("vote_request",{...req,configurationVersion:this.hooks.configurationVersion()})}
  private async send(kind:string,payload:unknown){const m={id:id("msg"),kind,from:this.nodeId,term:this.term,configurationVersion:this.hooks.configurationVersion(),sentAt:this.clock.now(),payload,signature:""} as ClusterMessage;try{await this.transport.broadcast(this.nodeId,m)}catch{}}
  async receive(m:ClusterMessage){
    const configVersion=m.configurationVersion;
    const currentConfigurationVersion=this.hooks.configurationVersion();
    const convergenceHeartbeat=configVersion!==undefined&&configVersion!==currentConfigurationVersion&&m.kind==="heartbeat";
    if(configVersion!==undefined&&configVersion!==currentConfigurationVersion&&!convergenceHeartbeat)throw new StaleTermError("stale configuration");
    if(m.kind==="pre_vote_request")return this.onPreVoteRequest(m);
    if(m.kind==="pre_vote_response")return this.onPreVoteResponse(m);
    if(m.term<this.term)throw new StaleTermError();
    if(m.term>this.term){this.term=m.term;this.role="follower";this.votedFor=null;this.leaderId=null;this.votes.clear();this.preVotes.clear();await this.hooks.persist(this.term,null);await this.hooks.onTerm(this.term);await this.hooks.onRole(this.role,this.term);this.resetDeadline()}
    if(m.kind==="heartbeat")return this.onHeartbeat(m);
    if(m.kind==="vote_request")return this.onVoteRequest(m);
    if(m.kind==="vote_response")return this.onVoteResponse(m)
  }
  private async onPreVoteRequest(m:ClusterMessage){const r=m.payload as any;const candidate=m.from;const candidateTerm=BigInt(r.term);const version=BigInt(String(r.configurationVersion??m.configurationVersion??-1));const healthyLeader=this.leaderId!==null&&this.clock.now()-this.lastHeartbeat<this.minElectionMs;const grant=this.isVoter(candidate)&&version===this.hooks.configurationVersion()&&candidateTerm>=this.term+1n&&!healthyLeader;const resp:PreVoteResponse={from:this.nodeId,term:this.term,configurationVersion:this.hooks.configurationVersion(),granted:grant};const out={id:id("msg"),kind:"pre_vote_response",from:this.nodeId,fromAddress:m.fromAddress||m.from,term:this.term,configurationVersion:this.hooks.configurationVersion(),sentAt:this.clock.now(),payload:resp,signature:""} as ClusterMessage;try{await this.transport.send(m.fromAddress||m.from,out)}catch{}}
  private async onPreVoteResponse(m:ClusterMessage){const r=m.payload as PreVoteResponse;if(this.role!=="candidate"||!r.granted||BigInt(String(r.term))!==this.term||BigInt(String(r.configurationVersion))!==this.hooks.configurationVersion()||!this.isVoter(r.from))return;this.preVotes.add(r.from);if(this.preVotes.size>=this.majority())await this.startElection()}
  private async onHeartbeat(m:ClusterMessage){if(!this.isVoter(m.from))return;this.leaderId=(m.payload as any).leaderId||m.from;this.lastHeartbeat=this.clock.now();this.resetDeadline();if(this.role!=="follower"){this.role="follower";this.preVotes.clear();this.votes.clear();await this.hooks.onRole(this.role,this.term)}}
  private async onVoteRequest(m:ClusterMessage){const r=m.payload as VoteRequest;let grant=false;const version=BigInt(String((r as any).configurationVersion??m.configurationVersion??-1));if(this.isVoter(r.from)&&version===this.hooks.configurationVersion()&&BigInt(String(r.term))===this.term&&(this.votedFor===null||this.votedFor===r.from)){grant=true;this.votedFor=r.from;await this.hooks.persist(this.term,this.votedFor);this.resetDeadline()}const resp:VoteResponse={from:this.nodeId,term:this.term,granted:grant,reason:grant?undefined:"not_authorized"};const out={id:id("msg"),kind:"vote_response",from:this.nodeId,fromAddress:m.fromAddress||m.from,term:this.term,configurationVersion:this.hooks.configurationVersion(),sentAt:this.clock.now(),payload:resp,signature:""} as ClusterMessage;try{await this.transport.send(m.fromAddress||m.from,out)}catch{}}
  private async onVoteResponse(m:ClusterMessage){const r=m.payload as VoteResponse;if(BigInt(String(r.term))!==this.term||this.role!=="candidate"||!r.granted||m.configurationVersion!==this.hooks.configurationVersion()||!this.isVoter(r.from))return;this.votes.add(r.from);if(this.votes.size>=this.majority()){this.role="leader";this.leaderId=this.nodeId;this.lastHeartbeat=0;await this.hooks.onRole(this.role,this.term);await this.broadcastHeartbeat()}}
  private async broadcastHeartbeat(){const payload={leaderId:this.nodeId,configurationVersion:this.hooks.configurationVersion()};const m={id:id("msg"),kind:"heartbeat",from:this.nodeId,term:this.term,configurationVersion:this.hooks.configurationVersion(),sentAt:this.clock.now(),payload,signature:""} as ClusterMessage;try{await this.transport.broadcast(this.nodeId,m)}catch{}}
}
