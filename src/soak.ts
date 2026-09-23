import {LocalProcessCluster} from "./process-harness";
import {ChaosController} from "./chaos";

const hours=Number(Bun.env.HA_SOAK_HOURS||0);
const duration=Number(Bun.env.HA_SOAK_MS||(hours?hours*3600000:3600000));
const seed=Number(Bun.env.CHAOS_SEED||12345);
const nodeCount=Number(Bun.env.HA_SOAK_NODES||3);
const chaos=new ChaosController(seed);
const cluster=new LocalProcessCluster(nodeCount);

console.log(`HA soak starting: nodes=${nodeCount} duration=${duration}ms seed=${seed}`);
await cluster.start();
console.log("HA soak cluster ready");

const started=Date.now();
const end=started+duration;
let iterations=0;

try{
  while(Date.now()<end){
    const action=chaos.choose([
      {type:"kill",node:"0"},
      {type:"kill",node:"1"},
      {type:"kill",node:"2"},
      {type:"delay",ms:100},
      {type:"reorder"}
    ]);
    iterations++;

    if(action.type==="kill"){
      const i=Number(action.node);
      await cluster.hardKill(i);
      await Bun.sleep(1000);
      await cluster.restart(i);
    }else{
      await Bun.sleep(action.ms||250);
    }

    for(let i=0;i<cluster.nodes.length;i++){
      try{
        const s=await cluster.state(i) as any;
        chaos.recordInvariant("node-"+i+"-has-state",!!s.term);
      }catch{
        chaos.recordInvariant("node-"+i+"-reachable",false);
      }
    }

    if(iterations%10===0){
      const elapsed=((Date.now()-started)/1000).toFixed(1);
      console.log(`HA soak progress: iterations=${iterations} elapsed=${elapsed}s remaining=${Math.max(0,(end-Date.now())/1000).toFixed(1)}s`);
    }
  }

  console.log(JSON.stringify(chaos.finish(),null,2));
}finally{
  await cluster.cleanup();
}
