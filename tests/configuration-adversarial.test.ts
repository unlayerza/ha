import{describe,test,expect}from"bun:test";
import{ConfigurationManager,type ConfigurationProposal}from"../src/configuration";
import{TestClock}from"../src/clock";
import{MemoryStore}from"../src/store";
import{HANodeRuntime}from"../src/node";
import{InMemoryTransport}from"../src/transport";
import{QuorumError}from"../src/errors";

const ids=["a","b","c","d","e"];
const make=async(voters=ids)=>{
  const clock=new TestClock();
  const store=new MemoryStore();
  const manager=new ConfigurationManager(clock,()=>voters[0]||"a",()=>{},store);
  await manager.load(voters);
  return{clock,store,manager};
};
const commit=async(manager:ConfigurationManager,next:string[])=>{
  const p=manager.begin(next);
  const current=manager.voters();
  for(const voter of current)if(voter!==p.proposer)manager.acknowledge(p.id,voter);
  return manager.commit(p.id);
};
const proposal=(id:string,base:bigint,next:bigint,voters:string[],proposer="a",acknowledgements=["a"]):ConfigurationProposal=>({id,baseVersion:base,nextVersion:next,voters,proposer,acknowledgements});

describe("adversarial committed configuration",()=>{
  test("leader dies before proposal leaves configuration unchanged",async()=>{
    const{manager}=await make();const before=manager.snapshot();expect(manager.pendingProposal()).toBeNull();expect(manager.snapshot()).toEqual(before)
  });
  test("leader dies after proposal leaves an uncommitted pending transition",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);expect(manager.pendingProposal()?.id).toBe(p.id);expect(manager.snapshot().version).toBe(0n);manager.abort(p.id);expect(manager.pendingProposal()).toBeNull()
  });
  test("leader dies after one acknowledgement cannot commit",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);manager.acknowledge(p.id,"b");expect(manager.readyToCommit()).toBe(false);expect(()=>manager.commit(p.id)).toThrow("quorum")
  });
  test("leader dies after majority acknowledgement leaves enough proof for the original leader only",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);manager.acknowledge(p.id,"b");manager.acknowledge(p.id,"c");expect(manager.readyToCommit()).toBe(true);manager.abort(p.id);expect(manager.snapshot().version).toBe(0n)
  });
  test("leader dies immediately before commit does not advance committed version",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);manager.acknowledge(p.id,"b");manager.acknowledge(p.id,"c");expect(manager.snapshot().version).toBe(0n);manager.abort(p.id);expect(manager.snapshot().voters).toEqual(ids)
  });
  test("committed configuration survives leader death when a valid commit proof is delivered",async()=>{
    const source=await make();const p=source.manager.begin(["a","b","c","d","e","f"]);source.manager.acknowledge(p.id,"b");const proof=source.manager.acknowledge(p.id,"c");const target=await make();await target.manager.installCommitted(proof,"a");expect(target.manager.snapshot().version).toBe(1n);expect(target.manager.voters()).toEqual(["a","b","c","d","e","f"])
  });
  test("follower death during acknowledgement does not create quorum",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);manager.acknowledge(p.id,"b");expect(manager.readyToCommit()).toBe(false);expect(()=>manager.acknowledge(p.id,"x")).toThrow("configuration transition")
  });
  test("partition during proposal cannot be committed without current-voter quorum",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);expect(()=>manager.commit(p.id)).toThrow("quorum");expect(manager.snapshot().version).toBe(0n)
  });
  test("partition during acknowledgement cannot commit with minority acknowledgements",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);manager.acknowledge(p.id,"b");expect(manager.readyToCommit()).toBe(false);expect(()=>manager.commit(p.id)).toThrow("quorum")
  });
  test("partition during commit cannot install a proof lacking majority",async()=>{
    const target=await make();const p=proposal("p",0n,1n,["a","b","c","d","e","f"],"a",["a","b"]);expect(()=>target.manager.installCommitted(p,"a")).toThrow("quorum");expect(target.manager.snapshot().version).toBe(0n)
  });
  test("stale proposal is rejected",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);expect(()=>manager.accept(proposal("stale",0n,1n,["a","b","c","d","e","f"]))).toThrow("Stale configuration proposal")
  });
  test("stale acknowledgement cannot advance a different proposal",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d","e","f"]);expect(()=>manager.acknowledge("other","b")).toThrow("Unknown configuration proposal");manager.abort(p.id)
  });
  test("stale commit is idempotently ignored after the version is committed",async()=>{
    const source=await make();const p=source.manager.begin(["a","b","c","d","e","f"]);source.manager.acknowledge(p.id,"b");source.manager.acknowledge(p.id,"c");await source.manager.commit(p.id);const target=await make();await target.manager.installSnapshot(source.manager.snapshot(),"a");expect(await target.manager.installCommitted(p,"a")).toEqual(target.manager.snapshot())
  });
  test("reordered commit that skips a configuration version is rejected",async()=>{
    const{manager}=await make();const p=proposal("p2",1n,2n,["a","b","c","d","e","f"],"a",["a","b","c"]);expect(()=>manager.installCommitted(p,"a")).toThrow("skipped")
  });
  test("conflicting commit at the same version is rejected",async()=>{
    const{manager}=await make();await manager.installSnapshot({version:1n,voters:["a","b","c","d","e","f"],committedAt:1},"a");expect(()=>manager.installSnapshot({version:1n,voters:["a","b","c","d","e"],committedAt:2},"a")).toThrow("Conflicting configuration")
  });
  test("obsolete node rejects an older snapshot",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);expect(()=>manager.installSnapshot({version:0n,voters:ids,committedAt:0},"a")).toThrow("Stale configuration snapshot")
  });
  test("replacement node can catch up from the current authoritative snapshot",async()=>{
    const source=await make();await commit(source.manager,["a","b","c","d","e","f"]);const replacement=await make([]);await replacement.manager.installSnapshot(source.manager.snapshot(),"a");expect(replacement.manager.voters()).toEqual(source.manager.voters());expect(replacement.manager.snapshot().version).toBe(1n)
  });
  test("obsolete node cannot install a conflicting snapshot from a non-current voter",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);expect(()=>manager.installSnapshot({version:2n,voters:["a","b","c","d","e","f","g"],committedAt:2},"g")).toThrow("not in current configuration")
  });
  test("join racing with a configuration change is rejected when its base version is stale",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);expect(()=>manager.accept(proposal("join-race",0n,1n,["a","b","c","d","e","f","g"]))).toThrow("Stale configuration proposal")
  });
  test("repeated add and remove churn preserves safe overlapping transitions",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);await commit(manager,["a","b","c","d","f"]);await commit(manager,["a","b","c","d","f","g"]);await commit(manager,["a","b","c","d","f"]);expect(manager.snapshot().version).toBe(4n)
  });
  test("unsafe disjoint transition is rejected",async()=>{
    const{manager}=await make();expect(()=>manager.begin(["x","y","z","q","r"])).toThrow("quorum intersection")
  });
  test("minority cannot authorize a configuration change",async()=>{
    const config={service:"test",cluster:"test",address:"test-node",secret:"test-secret",dataDir:"./.test-adversarial",heartbeatMs:100,electionMinMs:300,electionMaxMs:600,leaseMs:1000,joinTimeoutMs:1000,shutdownMs:1000,seedNodes:[],peerNodes:[],region:"test",zone:"test",version:"1",protocolVersion:"1",bootstrap:true};
    const node=new HANodeRuntime({clock:new TestClock(),store:new MemoryStore(),transport:new InMemoryTransport("test-node"),config});await node.configuration.installSnapshot({version:1n,voters:["a","b","c"],committedAt:1},"a");(node.election as any).role="leader";(node.node as any).id="a";await expect(node.reconfigure(["a","b","c","d"])).rejects.toBeInstanceOf(QuorumError);await node.stop()
  });
  test("removed leader cannot remain authoritative after configuration removal",async()=>{
    const{manager}=await make();const p=manager.begin(["a","b","c","d"]);expect(p.voters).not.toContain("e");expect(()=>manager.begin(["b","c","d"])).toThrow("Configuration change already in progress");manager.abort(p.id);expect(manager.isVoter("a")).toBe(true)
  });
  test("old leader cannot commit an obsolete configuration after replacement",async()=>{
    const{manager}=await make();await commit(manager,["a","b","c","d","e","f"]);const stale=proposal("old",0n,1n,ids,"a",["a","b","c"]);expect(await manager.installCommitted(stale,"a")).toEqual(manager.snapshot())
  });
  test("two competing configuration proposals cannot coexist",async()=>{
    const{manager}=await make();const first=manager.begin(["a","b","c","d","e","f"]);expect(()=>manager.accept(proposal("second",0n,1n,["a","b","c","d","e","g"]),"a")).toThrow("Conflicting configuration");manager.abort(first.id)
  });
});
