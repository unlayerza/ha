import{LocalProcessCluster}from"./process-harness";
import{ChaosController}from"./chaos";
import{formatBytes,type ResourceSnapshot}from"./resources";
import{mkdir}from"node:fs/promises";

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

const scenarioCounts:Record<string,number>={};
const transitionEvidence:Array<{at:number;scenario:string;label:string;nodes:Array<{index:number;role?:string;term?:string;quorum?:boolean;fenced?:boolean;leaderId?:string;configurationVersion?:string}>}>=[];

const readTransitionEvidence=async(scenario:string,label:string)=>{
  const nodes=await Promise.all(cluster.nodes.map(async(_,i)=>{
    try{
      const state=await cluster.state(i) as any;
      return{index:i,nodeId:state.nodeId,role:state.role,term:String(state.term),quorum:!!state.quorum,fenced:!!state.fenced,leaderId:state.leaderId||undefined,configurationVersion:String(state.configurationVersion??"0")};
    }catch{return undefined}
  }));
  transitionEvidence.push({at:Date.now(),scenario,label,nodes:nodes.filter((node):node is NonNullable<typeof node>=>node!==undefined)});
  return nodes;
};

const authoritativeLeader=async()=>{
  try{
    const states=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
    const leaders=states.map((state:any,index)=>state?.role==="leader"&&!state?.fenced&&state?.quorum?index:undefined).filter((index):index is number=>index!==undefined);
    return leaders.length===1?leaders[0]:undefined;
  }catch{return undefined}
};
const waitForAuthoritativeLeader=async(excluded=new Set<number>(),timeoutMs=10000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const leader=await authoritativeLeader();
    if(leader!==undefined&&!excluded.has(leader))return leader;
    await Bun.sleep(100);
  }
  return undefined;
};
const currentLeader=async()=>authoritativeLeader();

const chooseScenarioWindow=async()=>{
  const leader=await currentLeader();
  let leaderTerm:string|undefined;
  let leaderConfiguration:string|undefined;
  if(leader!==undefined){
    try{
      const state=await cluster.state(leader) as any;
      leaderTerm=String(state.term??"0");
      leaderConfiguration=String(state.configurationVersion??"0");
    }catch{}
  }
  const scenarios:string[]=[];
  if(leader!==undefined)scenarios.push("leader-assassination","leader-double-fault","rapid-leader-churn");
  scenarios.push("quorum-split","minority-isolation");
  const scenario=scenarios[chaos.random.int(scenarios.length)];
  scenarioCounts[scenario]=(scenarioCounts[scenario]||0)+1;
  if(leader===undefined){
    return{scenario,actions:Array.from({length:burst},()=>chooseAction())};
  }
  if(scenario==="leader-assassination"){
    return{scenario,originalLeader:leader,originalTerm:leaderTerm,originalConfiguration:leaderConfiguration,actions:[
      {type:"partition",node:String(leader)},
      {type:"kill",node:String(leader)},
      {type:"drop",node:String(chaos.random.int(cluster.nodes.length))},
      {type:"reorder",node:String(chaos.random.int(cluster.nodes.length))}
    ].slice(0,Math.max(2,burst))};
  }
  if(scenario==="leader-double-fault"){
    let second=chaos.random.int(cluster.nodes.length);
    while(second===leader)second=chaos.random.int(cluster.nodes.length);
    return{scenario,originalLeader:leader,originalTerm:leaderTerm,originalConfiguration:leaderConfiguration,actions:[
      {type:"partition",node:String(leader)},
      {type:"kill",node:String(leader)},
      {type:"kill",node:String(second)},
      {type:"delay",node:String(second),ms:150}
    ].slice(0,Math.max(3,burst))};
  }
  if(scenario==="rapid-leader-churn"){
    return{scenario,originalLeader:leader,originalTerm:leaderTerm,originalConfiguration:leaderConfiguration,actions:[
      {type:"partition",node:String(leader)},
      {type:"kill",node:String(leader)},
      {type:"drop",node:String(chaos.random.int(cluster.nodes.length))},
      {type:"duplicate",node:String(chaos.random.int(cluster.nodes.length))}
    ].slice(0,Math.max(2,burst))};
  }
  if(scenario==="quorum-split"){
    const half=Math.floor(cluster.nodes.length/2);
    const first=Array.from({length:half},(_,i)=>i);
    const second=cluster.nodes.map(n=>n.index).filter(i=>!first.includes(i));
    return{scenario,actions:first.map(index=>({type:"partition",node:String(index)})).concat(second.map(index=>({type:"partition",node:String(index)}))).slice(0,cluster.nodes.length)};
  }
  const minority=cluster.nodes.slice(0,Math.max(1,Math.floor(cluster.nodes.length/2)-1)).map(n=>n.index);
  return{scenario,actions:minority.map(index=>({type:"partition",node:String(index)})).slice(0,Math.max(1,Math.min(burst,minority.length)))};
};

const chooseFaultWindow=async()=>{
  let leader:number|undefined;
  try{
    const states=await Promise.all(cluster.nodes.map((_,i)=>cluster.state(i) as Promise<any>));
    const leaders=states.map((state:any,index)=>state?.role==="leader"?index:undefined).filter((index):index is number=>index!==undefined);
    if(leaders.length===1)leader=leaders[0];
  }catch{}

  const targeted=leader!==undefined&&chaos.random.int(100)<40;
  if(!targeted)return Array.from({length:burst},()=>chooseAction());

  const actions=[
    {type:"partition",node:String(leader)},
    {type:"kill",node:String(leader)},
  ];
  while(actions.length<burst)actions.push(chooseAction());
  return actions;
};
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

const transitionMaxTerms=new Map<number,bigint>();
const transitionMaxConfigurations=new Map<number,bigint>();

const observeTransition=async(label:string)=>{
  const states=await Promise.all(cluster.nodes.map(async(_,i)=>{
    try{return{i,state:await cluster.state(i) as any}}
    catch{return undefined}
  }));
  const live=states.filter((entry):entry is {i:number;state:any}=>entry!==undefined);
  const authoritative=live.filter(({state})=>state.role==="leader"&&!state.fenced&&state.quorum);
  chaos.recordInvariant("transition-authority-unique",authoritative.length<=1,authoritative.map(({i,state})=>`node-${i}:term=${state.term}:leader=${state.leaderId}`).join(","));
  for(const{i,state}of live){
    const term=BigInt(String(state.term??"0"));
    const configuration=BigInt(String(state.configurationVersion??"0"));
    const previousTerm=transitionMaxTerms.get(i);
    const previousConfiguration=transitionMaxConfigurations.get(i);
    chaos.recordInvariant("transition-term-monotonic",previousTerm===undefined||term>=previousTerm,`node-${i} ${previousTerm??"none"}->${term} ${label}`);
    chaos.recordInvariant("transition-configuration-monotonic",previousConfiguration===undefined||configuration>=previousConfiguration,`node-${i} ${previousConfiguration??"none"}->${configuration} ${label}`);
    if(previousTerm===undefined||term>previousTerm)transitionMaxTerms.set(i,term);
    if(previousConfiguration===undefined||configuration>previousConfiguration)transitionMaxConfigurations.set(i,configuration);
  }
  return live;
};

const observeQuorumTopology=async(scenario:string)=>{
  if(scenario!=="quorum-split")return;
  const half=Math.floor(cluster.nodes.length/2);
  const groups=[Array.from({length:half},(_,i)=>i),cluster.nodes.map(n=>n.index).filter(i=>i>=half)];
  const states=await Promise.all(groups.map(async group=>{
    const live=await Promise.all(group.map(async i=>{try{return{i,state:await cluster.state(i) as any}}catch{return undefined}}));
    const usable=live.filter((x):x is {i:number;state:any}=>x!==undefined);
    const authorities=usable.filter(x=>x.state.role==="leader"&&!x.state.fenced&&x.state.quorum);
    const quorumCount=usable.filter(x=>x.state.quorum).length;
    return{size:group.length,observed:usable.length,quorumCount,authorities:authorities.map(x=>x.i)};
  }));
  const exact=groups.every((group,i)=>states[i].size===half&&states[i].observed===group.length);
  const safe=exact&&states.every(s=>s.authorities.length===0);
  chaos.recordInvariant("quorum-split-no-authority",safe,JSON.stringify(states));
};
const applyFaultWindow=async(actions:ReturnType<typeof chooseAction>[],scenario="random",context?:{originalLeader?:number;originalTerm?:string;originalConfiguration?:string})=>{
  const network=uniqueNetworkNodes(actions);
  const kills=[...new Set(actions.filter(action=>action.type==="kill").map(action=>Number(action.node)))];
  const partition=network.find(action=>action.type==="partition");
  if(scenario==="minority-isolation"||scenario==="quorum-split"){
    const split=Math.floor(cluster.nodes.length/2)+(scenario==="quorum-split"?0:-1);
    const minority=cluster.nodes.slice(0,Math.max(1,split)).map(n=>n.index);
    const majority=cluster.nodes.map(n=>n.index).filter(index=>!minority.includes(index));
    await cluster.partitionGroups([minority,majority]);
    await observeTransition("minority-isolation-applied");
  }else if(partition){
    const node=Number(partition.node),address=cluster.nodes[node].address;
    const peers=cluster.nodes.filter((_,i)=>i!==node).map(n=>n.address);
    await Promise.all(cluster.nodes.map((_,i)=>cluster.setChaos(i,i===node?{partition:peers}:{partition:[address]})));
    await observeTransition("partition-applied");
    await observeQuorumTopology(scenario);
  }
  await Promise.all(network.filter(action=>action.type!=="partition").map(action=>{
    const node=Number(action.node);
    if(action.type==="delay")return cluster.setChaos(node,{delayMs:action.ms||100});
    if(action.type==="drop")return cluster.setChaos(node,{dropRate:0.35});
    if(action.type==="duplicate")return cluster.setChaos(node,{duplicateRate:0.25});
    if(action.type==="reorder")return cluster.setChaos(node,{delayMs:120,reorder:true});
    return Promise.resolve({});
  }));
  if(kills.length)await Promise.all(kills.map(i=>cluster.hardKill(i)));
  await observeTransition("post-kill");
  await Bun.sleep(networkDwellMs);
  await observeTransition("fault-window");
  await cluster.heal();
  if(kills.length)await Promise.all(kills.map(i=>cluster.restart(i)));
  await Bun.sleep(Math.max(1200,recoveryDwellMs));
  await observeTransition("recovered");
  if(scenario==="leader-assassination"||scenario==="leader-double-fault"){
    const original=context?.originalLeader;
    const replacement=await waitForAuthoritativeLeader(original===undefined?new Set<number>():new Set([original]),Math.max(10000,networkDwellMs+recoveryDwellMs+5000));
    const replacementState=replacement===undefined?undefined:await cluster.state(replacement) as any;
    chaos.recordInvariant("leader-succession-replacement-exists",replacement!==undefined,"scenario="+scenario+" original="+(original??"none")+" replacement="+(replacement??"none"));
    chaos.recordInvariant("leader-succession-original-relinquished",original!==undefined&&replacement!==undefined&&replacement!==original,"original="+(original??"none")+" replacement="+(replacement??"none"));
    chaos.recordInvariant("leader-succession-term-advanced",context?.originalTerm!==undefined&&replacementState!==undefined&&BigInt(String(replacementState.term))>BigInt(context.originalTerm),"originalTerm="+(context?.originalTerm??"none")+" replacementTerm="+(replacementState?.term??"none"));
    chaos.recordInvariant("leader-succession-configuration-unchanged",context?.originalConfiguration!==undefined&&replacementState!==undefined&&String(replacementState.configurationVersion??"0")===context.originalConfiguration,"originalConfiguration="+(context?.originalConfiguration??"none")+" replacementConfiguration="+(replacementState?.configurationVersion??"none"));
  }
  if(scenario==="rapid-leader-churn"){
    const firstLeader=context?.originalLeader;
    const nextLeader=await waitForAuthoritativeLeader(firstLeader===undefined?new Set<number>():new Set([firstLeader]),10000);
    const nextState=nextLeader===undefined?undefined:await cluster.state(nextLeader) as any;
    chaos.recordInvariant("leader-churn-second-leader-exists",nextLeader!==undefined,"first="+(firstLeader??"none")+" second="+(nextLeader??"none"));
    chaos.recordInvariant("leader-churn-second-leader-different",firstLeader!==undefined&&nextLeader!==undefined&&nextLeader!==firstLeader,"first="+(firstLeader??"none")+" second="+(nextLeader??"none"));
    chaos.recordInvariant("leader-churn-second-term-advanced",context?.originalTerm!==undefined&&nextState!==undefined&&BigInt(String(nextState.term))>BigInt(context.originalTerm),"firstTerm="+(context?.originalTerm??"none")+" secondTerm="+(nextState?.term??"none"));
    chaos.recordInvariant("leader-churn-configuration-unchanged",context?.originalConfiguration!==undefined&&nextState!==undefined&&String(nextState.configurationVersion??"0")===context.originalConfiguration,"originalConfiguration="+(context?.originalConfiguration??"none")+" secondConfiguration="+(nextState?.configurationVersion??"none"));
    if(nextLeader!==undefined){
      await readTransitionEvidence(scenario,"second-leader-before-kill");
      await cluster.hardKill(nextLeader);
      await observeTransition("second-leader-killed");
      await Bun.sleep(networkDwellMs);
      const thirdLeader=await waitForAuthoritativeLeader(new Set([nextLeader]),15000);
      if(thirdLeader===undefined){
        const diagnostic=await readTransitionEvidence(scenario,"third-leader-timeout");
        chaos.recordInvariant("leader-churn-third-leader-diagnostic",diagnostic.length>0,JSON.stringify(diagnostic));
      }
      const thirdState=thirdLeader===undefined?undefined:await cluster.state(thirdLeader) as any;
      chaos.recordInvariant("leader-churn-third-leader-exists",thirdLeader!==undefined,"second="+nextLeader+" third="+(thirdLeader??"none"));
      chaos.recordInvariant("leader-churn-third-leader-different",thirdLeader!==undefined&&thirdLeader!==nextLeader,"second="+nextLeader+" third="+(thirdLeader??"none"));
      chaos.recordInvariant("leader-churn-third-term-advanced",nextState!==undefined&&thirdState!==undefined&&BigInt(String(thirdState.term))>BigInt(String(nextState.term)),"secondTerm="+(nextState?.term??"none")+" thirdTerm="+(thirdState?.term??"none"));
      await cluster.restart(nextLeader);
      await Bun.sleep(Math.max(1200,recoveryDwellMs));
      const settledLeader=await waitForAuthoritativeLeader(new Set(),10000);
      const settledState=settledLeader===undefined?undefined:await cluster.state(settledLeader) as any;
      chaos.recordInvariant("leader-churn-final-authority-exists",settledLeader!==undefined,"leader="+(settledLeader??"none"));
      chaos.recordInvariant("leader-churn-final-configuration-unchanged",context?.originalConfiguration!==undefined&&settledState!==undefined&&String(settledState.configurationVersion??"0")===context.originalConfiguration,"originalConfiguration="+(context?.originalConfiguration??"none")+" finalConfiguration="+(settledState?.configurationVersion??"none"));
    }
  }
  return kills.length+network.length>0;
};

try{
  resourceTimer=setInterval(()=>void recordResources(),5000);

  while(Date.now()<end){
    const selected=Bun.env.HA_SOAK_SCENARIOS==="1"?await chooseScenarioWindow():{scenario:"random",actions:await chooseFaultWindow()};
    const actions=selected.actions;
    await readTransitionEvidence(selected.scenario,"before");
    iterations++;

    try{
      await readTransitionEvidence(selected.scenario,"pre-fault");
      await applyFaultWindow(actions,selected.scenario,selected);
      if(actions.some(action=>action.type==="heal"))await cluster.heal();
      await readTransitionEvidence(selected.scenario,"after");
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
    const healthFailures=checks.filter(c=>!c.ok).map(c=>`node-${c.i}:${c.health.status}${c.health.error?`:${c.health.error}`:""}`);
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
    scenarioCounts,
    transitionEvidence,
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
    const reportDir=Bun.env.HA_SOAK_REPORT_DIR||".ha-soak";
  await mkdir(reportDir,{recursive:true});
  const reportPath=reportDir+"/campaign-"+seed+"-"+(campaign.finishedAt||Date.now())+".json";
  let reportWriteError:string|undefined;
  try{
    await Bun.write(reportPath,JSON.stringify({...campaign,...result},null,2));
  }catch(error){
    reportWriteError=String(error);
    console.error("HA soak report write failed:",reportPath,reportWriteError);
  }
  const invariantSummary=Object.fromEntries(["all-nodes-reachable","no-split-brain","membership-converged","terms-converged","configuration-converged","final-cluster-recovered","leader-self-identity","same-term-authority-unique","transition-authority-unique","transition-term-monotonic","transition-configuration-monotonic","quorum-split-no-authority","leader-succession-replacement-exists","leader-succession-original-relinquished","leader-succession-term-advanced","leader-succession-configuration-unchanged","leader-churn-second-leader-exists","leader-churn-second-leader-different","leader-churn-second-term-advanced","leader-churn-configuration-unchanged","leader-churn-third-leader-exists","leader-churn-third-leader-different","leader-churn-third-term-advanced","leader-churn-final-authority-exists","leader-churn-final-configuration-unchanged"].map(name=>[name,campaign.invariants.filter(value=>value===name+":pass").length+"/"+campaign.invariants.filter(value=>value.startsWith(name+":")).length]));
  const terminal={...result,invariantSummary,unexpectedFailureCount:campaign.unexpectedFailures.length,reportDir,reportPath,reportWriteError};
  console.log(JSON.stringify(compact?terminal:{...terminal,actionCounts:campaign.actionCounts,failures:campaign.failures},null,2));
}finally{
  if(resourceTimer)clearInterval(resourceTimer);
  await cluster.cleanup();
}
