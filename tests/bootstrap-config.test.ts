import{describe,test,expect}from"bun:test";
import{loadConfig}from"../src/config";

describe("bootstrap configuration",()=>{
  const base={HA_SERVICE:"test",HA_CLUSTER:"test",HA_ADDRESS:"127.0.0.1:7301",HA_SECRET:"secret"};

  test("requires explicit bootstrap when no seeds are configured",()=>{
    expect(()=>loadConfig({...base})).toThrow("HA_SEEDS is required for non-bootstrap nodes");
  });

  test("explicit bootstrap may start with no seeds",()=>{
    const c=loadConfig({...base,HA_BOOTSTRAP:"true"});
    expect(c.bootstrap).toBe(true);
    expect(c.seedNodes).toEqual([]);
  });

  test("non-bootstrap nodes require at least one seed",()=>{
    const c=loadConfig({...base,HA_SEEDS:"127.0.0.1:7301"});
    expect(c.bootstrap).toBe(false);
    expect(c.seedNodes).toEqual(["127.0.0.1:7301"]);
  });
});
