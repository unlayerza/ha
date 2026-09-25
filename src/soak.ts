import{LocalProcessCluster}from"./process-harness";
import{ChaosController}from"./chaos";
import{formatBytes,type ResourceSnapshot}from"./resources";

interface SoakProfile{
  name:string;
  targetHours:number;
  durationMs:number;
  faultBurst:number;
  networkDwellMs:number;
  recoveryDwellMs:number;
}

const PROFILES:Record<string,SoakProfile>={
  "12h":{name:"12h",targetHours:12,durationMs:30*60*1000,faultBurst:2,networkDwellMs:300,recoveryDwellMs:500},
  "24h":{name:"24h",targetHours:24,durationMs:60*60*1000,faultBurst:3,networkDwellMs:250,recoveryDwellMs:450},
  "72h":{name:"72h",targetHours:72,durationMs:2*60*60*1000,faultBurst:4,networkDwellMs:200,recoveryDwellMs:400},
  flood:{name:"flood",targetHours:72,durationMs:30*60*1000,faultBurst:6,networkDwellMs:150,recoveryDwellMs:300},
};

export function resolveSoakProfile(name=Bun.env.HA_SOAK_PROFILE||""){
  return PROFILES[name]||undefined;
}

const profile=resolveSoakProfile();
const hours=Number(Bun.env.HA_SOAK_HOURS||0);
const explicitDuration=Number(Bun.env.HA_SOAK_MS||0);
const duration=explicitDuration||hours*3600000||profile?.durationMs||3600000;
const seed=Number(Bun.env.CHAOS_SEED||12345);
const nodeCount=Number(Bun.env.HA_SOAK_NODES||3);
const chaos=new ChaosController(seed);
const compact=Bun.env.HA_SOAK_COMPACT==="1";
const burst=Math.max(1,Number(Bun.env.HA_SOAK_FAULT_BURST||profile?.faultBurst||1));
const networkDwellMs=Math.max(0,Number(Bun.env.HA_SOAK_NETWORK_DWELL_MS||profile?.networkDwellMs||500));
const recoveryDwellMs=Math.max(0,Number(Bun.env.HA_SOAK_RECOVERY_DWELL_MS||profile?.recoveryDwellMs||700));
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
const networkActions=new Set(["delay","drop","duplicate","reorder","partition"]);
const chooseAction=()=>chaos.choose([
  {type:"kill",node:String(randomNode())},
  {type:"delay",node:String(randomNode()),ms:100},
  {type:"drop",node:String(randomNode())},
  {type:"duplicate",node:String(randomNode())},
  {type:"reorder",node:String(randomNode())},
  {type:"partition",node:String(randomNode())},
  {type:"heal"}
]);
const uniqueNetworkNodes=(actions:ReturnType<typeof chooseAction>)=>{
  const seen=new Set<number>();
  return actions.filter(action=>{
    if(!action.node||!networkActions.has(action.type))return false;
    const index=Number(action.node);
    if(seen.has(index))return false;
    seen.add(index);
    return true;
  });
};

if(!compact){
  console.log(`HA soak starting: nodes=${nodeCount} duration=${duration}ms seed=${seed} processes=${nodeCount+1}${profile?` profile=${profile.name} target=${profile.targetHours}h burst=${burst}`:""}`);
}
await cluster.start();
await recordResources();
if(!compact)console.log(`HA soak cluster ready: ${nodeCount} HA processes + 1 soak supervisor`);

const started=Date.now();
const end=started+duration;
let iterations=0;
let actionErrors=0;
const actionErrorTypes:Record<string,number>={};
const classifyActionError=(error:unknown)=>{
  const message=String(error).toLowerCase();
  if(message.includes("did not become ready")||message.includes("exited during startup"))return"ready-timeout";
  if(message.includes("unable to connect")||message.includes("connection refused")||message.includes("econnrefused"))return"connect-error";
  if(message.includes("timed out")||message.includes("timeout"))return"request-timeout";
  if(message.includes("http "))return"http-error";
  return"other";
};

const applyNetworkBurst=async(actions:ReturnType<typeof chooseAction>[])=>{
  const selected=uniqueNetworkNodes(actions);
  if(!selected.length)return false;
  await Promise.all(selected.map(action=>{
    const node=Number(action.node);
    if(action.type==="delay")return cluster.setChaos(node,{delayMs:action.ms||100});
    if(action.type==="drop")return cluster.setChaos(node,{dropRate:0.35});
    if(action.type==="duplicate")return cluster.setChaos(node,{duplicateRate:0.25});
    if(action.type==="reorder")return cluster.setChaos(node,{delayMs:120,reorder:true});
    if(action.type==="partition"){
      const address=cluster.nodes[node].address;
      const peers=cluster.nodes.filter((_,i)=>i!==node).map(n=>n.address);
      return Promise.all(cluster.nodes.map((_,i)=>cluster.setChaos(i,i===node?{partition:peers}:{partition:[address]}))).then(()=>({}));
    }
    return Promise.resolve({});
  }));
  await Bun.sleep(networkDwellMs);
  await cluster.heal();
  await Bun.sleep(recoveryDwellMs);
  return true;
};

const applyAction=async(action:ReturnType<typeof chooseAction>)=>{
  if(action.type==="kill"){
    const i=Number(action.node);
    await cluster.hardKill(i);
    await Bun.sleep(700);
    await cluster.restart(i);
    await Bun.sleep(1200);
  }else if(action.type==="delay"){
    await cluster.setChaos(Number(action.node),{delayMs:action.ms||100});
    await Bun.sleep(networkDwellMs);
    await cluster.heal();
    await Bun.sleep(recoveryDwellMs);
  }else if(action.type==="drop"){
    await cluster.setChaos(Number(action.node),{dropRate:0.35});
    await Bun.sleep(networkDwellMs);
    await cluster.heal();
    await Bun.sleep(recoveryDwellMs);
  }else if(action.type==="duplicate"){
    await cluster.setChaos(Number(action.node),{duplicateRate:0.25});
    await Bun.sleep(networkDwellMs);
    await cluster.heal();
    await Bun.sleep(recoveryDwellMs);
  }else if(action.type==="reorder"){
    await cluster.setChaos(Number(action.node),{delayMs:120,reorder:true});
    await Bun.sleep(networkDwellMs);
    await cluster.heal();
    await Bun.sleep(recoveryDwellMs);
  }else if(action.type==="partition"){
    await cluster.isolate(Number(action.node));
    await Bun.sleep(networkDwellMs);
    await cluster.heal();
    await Bun.sleep(recoveryDwellMs);
  }else{
    await cluster.heal();
    await Bun.sleep(Math.max(100,recoveryDwellMs));
  }
};

try{
  resourceTimer=setInterval(()=>void recordResources(),5000);

  while(Date.now()<end){
    const actions=Array.from({length:burst},()=>chooseAction());
    iterations++;

    try{
      const networkHandled=await applyNetworkBurst(actions);
      const nonNetwork=actions.filter(action=>!networkActions.has(action.type));
      if(!networkHandled||nonNetwork.length){
        for(const action of nonNetwork)await applyAction(action);
      }
    }catch(error){
      actionErrors++;
      const kind=classifyActionError(error);
      actionErrorTypes[kind]=(actionErrorTypes[kind]||0)+1;
      if(!compact)console.warn("HA soak action failed:",String(error));
      await cluster.heal().catch(()=>{});
      await Bun.sleep(250);
    }

    const checks=await Promise.all(cluster.nodes.map(async(_,i)=>{
      try{
        const state=await cluster.state(i) as any;
        return{i,ok:true,state,error:undefined,health:{index:i,status:"ready" as const}};
      }catch(error){
        const health=await cluster.diagnose(i);
        return{i,ok:false,state:undefined,error:String(error),health};
      }
    }));
    const reachable=checks.filter(c=>c.ok);
    const allReachable=reachable.length===cluster.nodes.length;
    const healthFailures=checks.filter(c=>!c.ok).map(c=>`node-${c.i}:${c.health.status}${c.health.error?\`:${c.health.error}\`:""}`);
    chaos.recordInvariant("all-nodes-reachable",allReachable,healthFailures.join(";"));

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

    if(!compact&&iterations%10===0){
      await recordResources();
      const elapsed=((Date.now()-started)/1000).toFixed(1);
      const current=resourceSamples.at(-1);
      console.log(`HA soak progress: iterations=${iterations} elapsed=${elapsed}s remaining=${Math.max(0,(end-Date.now())/1000).toFixed(1)}s rss=${current?formatBytes(current.totalRssBytes):"n/a"} cpu=${current?.cpuPercent.toFixed(1)||"n/a"}% processes=${current?.processes.length||0}`);
    }
  }

  await cluster.heal();
  const settleMs=Math.max(1500,Number(Bun.env.HA_SOAK_SETTLE_MS||3000));
  await Bun.sleep(settleMs);
  const recoveryWindowMs=Math.max(5000,Number(Bun.env.HA_SOAK_RECOVERY_TIMEOUT_MS||15000));
  const recoveryDeadline=Date.now()+recoveryWindowMs;
  let finalHealth:Awaited<ReturnType<typeof cluster.diagnose>>[]=[];
  while(Date.now()<recoveryDeadline){
    finalHealth=await Promise.all(cluster.nodes.map((_,i)=>cluster.diagnose(i)));
    if(finalHealth.every(h=>h.status==="ready"))break;
    await Bun.sleep(500);
  }
  if(finalHealth.length===0)finalHealth=await Promise.all(cluster.nodes.map((_,i)=>cluster.diagnose(i)));
  const finalReady=finalHealth.every(h=>h.status==="ready");
  const finalFailures=finalHealth.filter(h=>h.status!=="ready").map(h=>"node-"+h.index+":"+h.status+(h.error?":"+h.error:"")).join(";");
  chaos.recordInvariant("final-cluster-recovered",finalReady,finalFailures);
  await recordResources();
  const campaign=chaos.finish();
  const result={
    seed,
    profile:profile?.name||"custom",
    targetExposureHours:profile?.targetHours||null,
    nodes:nodeCount,
    durationMs:(campaign.finishedAt||Date.now())-campaign.startedAt,
    iterations,
    faultBurst:burst,
    actionErrors,
    actionErrorTypes,
    actionCounts:campaign.actionCounts,
    invariantStats:campaign.invariantStats,
    failures:campaign.failures,
    unexpectedFailures:campaign.unexpectedFailures,
    nodeHealth:(await Promise.all(cluster.nodes.map((_,i)=>cluster.diagnose(i)))).reduce((a,h)=>(a[h.status]++,a),{ready:0,starting:0,unreachable:0,dead:0} as Record<string,number>),
    failureCounts:campaign.failures.reduce((a,name)=>(a[name]=(a[name]||0)+1,a),{} as Record<string,number>),
    expectedProcessCount:nodeCount+1,
    resources:{
      supported:resourceSamples.some(s=>s.supported),
      samples:resourceSamples.length,
      peak:peak?{
        processes:peak.processes.length,
        totalRssBytes:peak.totalRssBytes,
        cpuPercent:Number(peak.cpuPercent.toFixed(1)),
        load1:Number(peak.load1.toFixed(2)),
        memoryAvailableBytes:peak.memoryAvailableBytes,
      }:null,
    },
  };
  if(compact){
    const boundedFailures=campaign.unexpectedFailures.length>10?[...campaign.unexpectedFailures.slice(0,5),...campaign.unexpectedFailures.slice(-5)]:campaign.unexpectedFailures;
    console.log(JSON.stringify({...result,unexpectedFailureCount:campaign.unexpectedFailures.length,unexpectedFailures:boundedFailures}));
  }else console.log(JSON.stringify({...campaign,...result},null,2));
}finally{
  if(resourceTimer)clearInterval(resourceTimer);
  await cluster.cleanup();
}
