import {LocalProcessCluster} from "./process-harness";
import {ChaosController} from "./chaos";
import {formatBytes,type ResourceSnapshot} from "./resources";

const hours=Number(Bun.env.HA_SOAK_HOURS||0);
const duration=Number(Bun.env.HA_SOAK_MS||(hours?hours*3600000:3600000));
const seed=Number(Bun.env.CHAOS_SEED||12345);
const nodeCount=Number(Bun.env.HA_SOAK_NODES||3);
const chaos=new ChaosController(seed);
const cluster=new LocalProcessCluster(nodeCount);
const resourceSamples:ResourceSnapshot[]=[];
let resourceBusy=false;
let resourceTimer:Timer|undefined;
let peak:ResourceSnapshot|undefined;

const recordResources=async()=>{
  if(resourceBusy)return;
  resourceBusy=true;
  try{
    const sample=await cluster.resources();
    resourceSamples.push(sample);
    if(!peak||sample.totalRssBytes>peak.totalRssBytes)peak=sample;
  }catch{}
  finally{resourceBusy=false}
};

const randomNode=()=>chaos.random.int(cluster.nodes.length);

console.log(`HA soak starting: nodes=${nodeCount} duration=${duration}ms seed=${seed} processes=${nodeCount+1}`);
await cluster.start();
await recordResources();
console.log(`HA soak cluster ready: ${nodeCount} HA processes + 1 soak supervisor`);

const started=Date.now();
const end=started+duration;
let iterations=0;
let actionErrors=0;

try{
  resourceTimer=setInterval(()=>void recordResources(),5000);

  while(Date.now()<end){
    const action=chaos.choose([
      {type:"kill",node:String(randomNode())},
      {type:"delay",node:String(randomNode()),ms:100},
      {type:"drop",node:String(randomNode())},
      {type:"duplicate",node:String(randomNode())},
      {type:"reorder",node:String(randomNode())},
      {type:"partition",node:String(randomNode())},
      {type:"heal"}
    ]);
    iterations++;

    try{
    if(action.type==="kill"){
      const i=Number(action.node);
      await cluster.hardKill(i);
      await Bun.sleep(700);
      await cluster.restart(i);
      await Bun.sleep(1200);
    }else if(action.type==="delay"){
      await cluster.setChaos(Number(action.node),{delayMs:action.ms||100});
      await Bun.sleep(500);
      await cluster.heal();
      await Bun.sleep(700);
    }else if(action.type==="drop"){
      await cluster.setChaos(Number(action.node),{dropRate:0.35});
      await Bun.sleep(500);
      await cluster.heal();
      await Bun.sleep(700);
    }else if(action.type==="duplicate"){
      await cluster.setChaos(Number(action.node),{duplicateRate:0.25});
      await Bun.sleep(500);
      await cluster.heal();
      await Bun.sleep(700);
    }else if(action.type==="reorder"){
      await cluster.setChaos(Number(action.node),{delayMs:120,reorder:true});
      await Bun.sleep(500);
      await cluster.heal();
      await Bun.sleep(700);
    }else if(action.type==="partition"){
      await cluster.isolate(Number(action.node));
      await Bun.sleep(700);
      await cluster.heal();
      await Bun.sleep(1200);
    }else{
      await cluster.heal();
      await Bun.sleep(400);
    }

    }catch(error){
      actionErrors++;
      console.warn("HA soak action failed:",String(error));
      await cluster.heal().catch(()=>{});
      await Bun.sleep(250);
    }

    const checks=await Promise.all(cluster.nodes.map(async(_,i)=>{
      try{
        const state=await cluster.state(i) as any;
        return {i,ok:true,state,error:undefined};
      }catch(error){
        return {i,ok:false,state:undefined,error:String(error)};
      }
    }));
    const reachable=checks.filter(c=>c.ok);
    const allReachable=reachable.length===cluster.nodes.length;
    chaos.recordInvariant("all-nodes-reachable",allReachable,checks.filter(c=>!c.ok).map(c=>`node-${c.i}:${c.error}`).join(";"));

    const leaders=reachable.filter(c=>c.state.role==="leader").map(c=>c.state.leaderId||String(c.i));
    chaos.recordInvariant("no-split-brain",new Set(leaders).size<=1,leaders.join(","));

    const membershipSets=reachable.map(c=>JSON.stringify((c.state.membershipIds||[]).slice().sort()));
    const membershipConverged=reachable.length>0&&reachable.every(c=>c.state.membershipReady)&&new Set(membershipSets).size===1;
    chaos.recordInvariant("membership-converged",membershipConverged,membershipSets.join("|"));

    const terms=reachable.map(c=>BigInt(c.state.term));
    const minTerm=terms.length?terms.reduce((a,b)=>a<b?a:b):0n;
    const maxTerm=terms.length?terms.reduce((a,b)=>a>b?a:b):0n;
    chaos.recordInvariant("terms-converged",maxTerm-minTerm<=1n,`min=${minTerm} max=${maxTerm}`);
    const configurationVersions=reachable.map(c=>BigInt(c.state.configurationVersion||"0"));
    const minConfiguration=configurationVersions.length?configurationVersions.reduce((a,b)=>a<b?a:b):0n;
    const maxConfiguration=configurationVersions.length?configurationVersions.reduce((a,b)=>a>b?a:b):0n;
    chaos.recordInvariant("configuration-converged",maxConfiguration===minConfiguration,`min=${minConfiguration} max=${maxConfiguration}`);

    if(iterations%10===0){
      await recordResources();
      const elapsed=((Date.now()-started)/1000).toFixed(1);
      const current=resourceSamples.at(-1);
      console.log(`HA soak progress: iterations=${iterations} elapsed=${elapsed}s remaining=${Math.max(0,(end-Date.now())/1000).toFixed(1)}s rss=${current?formatBytes(current.totalRssBytes):"n/a"} cpu=${current?.cpuPercent.toFixed(1)||"n/a"}% processes=${current?.processes.length||0}`);
    }
  }

  await recordResources();
  const campaign=chaos.finish();
  console.log(JSON.stringify({
    ...campaign,
    durationMs:(campaign.finishedAt||Date.now())-campaign.startedAt,
    iterations,
    actionErrors,
    expectedProcessCount:nodeCount+1,
    resources:{
      supported:resourceSamples.some(s=>s.supported),
      samples:resourceSamples.length,
      peak:peak?{
        at:peak.at,
        processes:peak.processes.length,
        totalRssBytes:peak.totalRssBytes,
        totalVszBytes:peak.totalVszBytes,
        cpuPercent:peak.cpuPercent,
        load1:peak.load1,
        memoryAvailableBytes:peak.memoryAvailableBytes,
      }:null,
      last:resourceSamples.at(-1)||null,
    },
  },null,2));
}finally{
  if(resourceTimer)clearInterval(resourceTimer);
  await cluster.cleanup();
}
