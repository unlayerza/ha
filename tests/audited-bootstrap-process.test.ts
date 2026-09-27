import{describe,test,expect}from"bun:test";
import{LocalProcessCluster}from"../src/process-harness";

describe("audited bootstrap process flow",()=>{
  test("one-voter leader admits an empty node through configuration proposal quorum",async()=>{
    const cluster=new LocalProcessCluster(2,7811,7911,"./.ha-audited-bootstrap-process");
    try{
      await cluster.start();

      const states=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
      const summary=states.map((s,i)=>({
        node:i,
        configurationVersion:s.configurationVersion,
        voters:s.voters,
        membershipSize:s.membershipSize,
        votingSize:s.votingSize,
        membershipReady:s.membershipReady,
        flow:s.flow,
      }));

      expect(states[0].configurationVersion.toString()).toBe("1");
      expect(states[1].configurationVersion.toString()).toBe("1");
      expect(states[0].voters).toEqual(states[1].voters);
      expect(states[0].voters).toHaveLength(2);
      expect(states.every(s=>s.membershipReady)).toBe(true);
      expect(states.every(s=>s.quorum===true)).toBe(true);

      console.log("AUDITED_BOOTSTRAP_FLOW",JSON.stringify(summary));
    }finally{
      await cluster.cleanup();
    }
  },30000);
});
