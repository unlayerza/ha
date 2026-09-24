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
        const diagnostics=await Promise.all(cluster.nodes.map((_,i)=>cluster.diagnose(i)));const compact=initial.map((s,i)=>({index:i,role:s.role,term:s.term,quorum:s.quorum,membershipSize:s.membershipSize,votingSize:s.votingSize,configurationVersion:s.configurationVersion,voters:s.voters,membershipReady:s.membershipReady}));
        throw new Error(`initial cluster convergence failed: ${JSON.stringify({states:compact,diagnostics})}`);
      }

      await cluster.partitionGroups([[0,1],[2,3,4]]);
      await Bun.sleep(1800);
      const partitioned=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
      const minority=partitioned.slice(0,2);
      const majority=partitioned.slice(2);
      expect(minority.every(s=>s.quorum===false)).toBe(true);
      expect(minority.every(s=>s.fenced===true||s.role!=="leader")).toBe(true);
      expect(majority.filter(s=>s.role==="leader"&&s.quorum===true)).toHaveLength(1);

      await cluster.heal();
      await Bun.sleep(2200);
      const recovered=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
      expect(recovered.every(s=>s.quorum===true)).toBe(true);
      expect(new Set(recovered.map(s=>s.term.toString())).size).toBe(1);
      expect(recovered.filter(s=>s.role==="leader")).toHaveLength(1);
      expect(recovered.every(s=>s.membershipReady)).toBe(true);
    }finally{await cluster.cleanup()}
  },15000);
});
