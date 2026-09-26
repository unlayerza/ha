import{describe,test,expect}from"bun:test";
import{LocalProcessCluster}from"../src/process-harness";

describe("process quorum recovery",()=>{
  test("minority loses quorum and authority, majority retains a single authority, recovery converges",async()=>{
    const cluster=new LocalProcessCluster(5,7801,7901,"./.ha-quorum-process");
    try{
      await cluster.start();
      const deadline=Date.now()+8000;
      let initial:any[]=[];
      while(Date.now()<deadline){
        initial=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
        if(initial.filter(s=>s.role==="leader").length===1&&initial.every(s=>s.quorum===true))break;
        await Bun.sleep(200);
      }
      if(initial.filter(s=>s.role==="leader").length!==1||!initial.every(s=>s.quorum===true)){
        const diagnostics=await Promise.all(cluster.nodes.map((_,i)=>cluster.diagnose(i)));const compact=initial.map((s,i)=>({index:i,role:s.role,term:s.term,quorum:s.quorum,membershipSize:s.membershipSize,votingSize:s.votingSize,configurationVersion:s.configurationVersion,voters:s.voters,membershipReady:s.membershipReady,configurationEvents:(s.events||[]).filter((e:any)=>e.type.startsWith("configuration_")||e.type==="join_received"||e.type==="join_request_received"||e.type==="join_rejected"||e.type==="join_gate_rejected"||e.type==="security_reject")}));
        throw new Error(`initial cluster convergence failed: ${JSON.stringify({states:compact,diagnostics})}`);
      }

      // Election timeouts are 1200-3000ms, so poll for re-election instead of sleeping a fixed interval.
      const settle=async(done:(states:any[])=>boolean,timeoutMs:number)=>{
        const until=Date.now()+timeoutMs;
        let states:any[]=[];
        while(Date.now()<until){
          states=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
          if(done(states))break;
          await Bun.sleep(200);
        }
        return states;
      };

      await cluster.partitionGroups([[0,1],[2,3,4]]);
      const partitioned=await settle(s=>s.slice(0,2).every(x=>x.quorum===false)&&s.slice(2).filter(x=>x.role==="leader"&&x.quorum===true).length===1,10000);
      const minority=partitioned.slice(0,2);
      const majority=partitioned.slice(2);
      expect(minority.every(s=>s.quorum===false)).toBe(true);
      expect(minority.every(s=>s.fenced===true||s.role!=="leader")).toBe(true);
      expect(majority.filter(s=>s.role==="leader"&&s.quorum===true)).toHaveLength(1);

      await cluster.heal();
      const recovered=await settle(s=>s.every(x=>x.quorum===true&&x.membershipReady)&&new Set(s.map(x=>x.term.toString())).size===1&&s.filter(x=>x.role==="leader").length===1,10000);
      expect(recovered.every(s=>s.quorum===true)).toBe(true);
      expect(new Set(recovered.map(s=>s.term.toString())).size).toBe(1);
      expect(recovered.filter(s=>s.role==="leader")).toHaveLength(1);
      expect(recovered.every(s=>s.membershipReady)).toBe(true);
    }finally{await cluster.cleanup()}
  },60000);
});
