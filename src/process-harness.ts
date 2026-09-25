import{mkdir,rm}from"node:fs/promises";
import{resourceSnapshot,type ResourceSnapshot}from"./resources";
import type{ChaosPolicy}from"./types";

export interface ProcessNode{index:number;address:string;api:number;dataDir:string;process?:Bun.Subprocess;startedAt?:number;stderr?:string;stdout?:string;stderrDone?:Promise<void>;stdoutDone?:Promise<void>}

export function classifyProcessError(error:unknown){
  const message=String(error).toLowerCase();
  if(message.includes("unable to connect")||message.includes("connection refused")||message.includes("econnrefused"))return"connect-error";
  if(message.includes("timed out")||message.includes("timeout"))return"request-timeout";
  return"other";
}

export class LocalProcessCluster{
  readonly nodes:ProcessNode[]=[];
  constructor(private count=3,private basePort=7301,private apiBase=7401,private root="./.ha-process",private secret="local-test-secret"){
    for(let i=0;i<count;i++)this.nodes.push({index:i,address:`http://127.0.0.1:${basePort+i}`,api:apiBase+i,dataDir:`${root}/${i}`})
  }
  private seeds(){return this.nodes[0]?.address||""}
  private peers(){return this.nodes.map(n=>n.address).join(",")}
  async start(){
    await rm(this.root,{recursive:true,force:true});
    await mkdir(this.root,{recursive:true});
    if(this.nodes.length){
      await this.startNode(this.nodes[0]);
      const concurrency=Math.max(1,Number(Bun.env.HA_PROCESS_START_CONCURRENCY||1));
      for(let offset=1;offset<this.nodes.length;offset+=concurrency){
        await Promise.all(this.nodes.slice(offset,offset+concurrency).map(n=>this.startNode(n)));
      }
    }
    return this
  }
  async startNode(n:ProcessNode){
    if(n.process&&n.process.exitCode===null)return n;
    await mkdir(n.dataDir,{recursive:true});
    n.stderr="";n.stdout="";n.startedAt=Date.now();n.process=Bun.spawn(["bun","run","src/server.ts"],{env:{...Bun.env,HA_SERVICE:"process-test",HA_CLUSTER:"process-test",HA_ADDRESS:n.address.replace("http://",""),HA_API_PORT:String(n.api),HA_DATA_DIR:n.dataDir,HA_SECRET:this.secret,HA_SEEDS:this.seeds(),HA_PEERS:this.peers(),HA_BOOTSTRAP:n.index===0?"true":"false",HA_HEARTBEAT_MS:Bun.env.HA_PROCESS_HEARTBEAT_MS||"200",HA_ELECTION_MIN_MS:Bun.env.HA_PROCESS_ELECTION_MIN_MS||"1200",HA_ELECTION_MAX_MS:Bun.env.HA_PROCESS_ELECTION_MAX_MS||"3000",HA_JOIN_TIMEOUT_MS:Bun.env.HA_PROCESS_JOIN_TIMEOUT_MS||"30000"},stdout:"pipe",stderr:"pipe"});
    n.stdoutDone=this.capture(n.process.stdout,s=>n.stdout=s);n.stderrDone=this.capture(n.process.stderr,s=>n.stderr=s);
    await this.waitReady(n,Math.max(10000,Number(Bun.env.HA_PROCESS_START_TIMEOUT_MS||35000)));
    if(n.index>0)await this.waitClusterAdmission(n.index);
    return n
  }
  private async waitClusterAdmission(index:number){
    const timeout=Math.max(5000,Number(Bun.env.HA_PROCESS_JOIN_SETTLE_TIMEOUT_MS||10000));
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      try{
        const states=await Promise.all(this.nodes.slice(0,index+1).map((_,i)=>this.state(i) as Promise<any>));
        const target=states[index];
        const voters=Array.isArray(target.voters)?target.voters:[];
        const admitted=voters.length>=index+1;
        const membershipSettled=states.every((state:any)=>Number(state.membershipSize||0)>=index+1);
        const committed=states.every((state:any)=>Number(state.configurationVersion||0)>=index);
        if(admitted&&membershipSettled&&committed)return;
      }catch{}
      await Bun.sleep(100);
    }
    const diagnostics=await Promise.all(this.nodes.slice(0,index+1).map((_,i)=>this.diagnose(i)));
    throw new Error(`HA process ${index} joined locally but cluster admission did not settle within ${timeout}ms: ${JSON.stringify(diagnostics)}`);
  }
  private capture(stream:ReadableStream<Uint8Array>|null|undefined,target:(value:string)=>void){if(!stream)return Promise.resolve();return(async()=>{const reader=stream.getReader();const decoder=new TextDecoder();let value="";const limit=16384;try{while(true){const part=await reader.read();if(part.done)break;if(value.length<limit)value+=decoder.decode(part.value,{stream:true}).slice(0,limit-value.length)}}catch{}target(value.slice(-limit))})()}
  private async waitReady(n:ProcessNode,timeoutMs:number){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(!n.process||n.process.exitCode!==null){await Promise.allSettled([n.stdoutDone,n.stderrDone]);const survivors=await Promise.all(this.nodes.filter(x=>x.index!==n.index).map(x=>this.diagnose(x.index)));const compactSurvivors=survivors.map((s:any)=>({index:s.index,status:s.status,error:s.error,state:s.state?{term:s.state.term,role:s.state.role,leaderId:s.state.leaderId,quorum:s.state.quorum,fenced:s.state.fenced,membershipSize:s.state.membershipSize,votingSize:s.state.votingSize,configurationVersion:s.state.configurationVersion,voters:s.state.voters,membershipReady:s.state.membershipReady,flow:s.state.flow}:undefined,stdout:s.stdout?.slice(-3000),stderr:s.stderr?.slice(-3000)}));throw new Error(`HA process ${n.index} exited during startup: ${JSON.stringify({survivors:compactSurvivors,failed:{index:n.index,stdout:n.stdout,stderr:n.stderr}})}`)}
      try{
        const r=await fetch(`http://127.0.0.1:${n.api}/ready`,{signal:AbortSignal.timeout(250)});
        if(r.ok)return;
      }catch{}
      await Bun.sleep(50)
    }
    await Promise.allSettled([n.stdoutDone,n.stderrDone]);const diagnostic=[n.stderr,n.stdout].filter(Boolean).join("\n").trim();throw new Error("HA process "+n.index+" did not become ready within "+timeoutMs+"ms"+(diagnostic?": "+diagnostic:""))
  }
  async stop(index?:number){
    const targets=index===undefined?this.nodes:this.nodes.filter(n=>n.index===index);
    await Promise.all(targets.map(async n=>{const p=n.process;if(!p)return;p.kill("SIGTERM");const deadline=Date.now()+1500;while(p.exitCode===null&&Date.now()<deadline)await Bun.sleep(25);if(p.exitCode===null)p.kill("SIGKILL");await p.exited;n.process=undefined;n.startedAt=undefined;}));
  }
  async hardKill(index:number){const n=this.nodes[index];const p=n.process;if(!p)return;p.kill("SIGKILL");await p.exited;n.process=undefined;n.startedAt=undefined}
  async restart(index:number){await this.stop(index);return this.startNode(this.nodes[index])}
  async state(index:number){
    const r=await fetch(`http://127.0.0.1:${this.nodes[index].api}/state`,{signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw new Error(`HA state request failed: HTTP ${r.status}`);
    return r.json()
  }
  async diagnose(index:number):Promise<{index:number;status:"ready"|"starting"|"unreachable"|"dead";error?:string;state?:any;stdout?:string;stderr?:string}>{
    const n=this.nodes[index];if(!n)return{index,status:"dead",error:"unknown-process-node"};const p=n.process;if(!p||p.exitCode!==null)return{index,status:n.startedAt?"dead":"starting"};
    const age=n.startedAt?Date.now()-n.startedAt:Infinity;
    try{
      const ready=await fetch(`http://127.0.0.1:${n.api}/ready`,{signal:AbortSignal.timeout(750)});
      let state:any;
      try{const response=await fetch(`http://127.0.0.1:${n.api}/state`,{signal:AbortSignal.timeout(1000)});if(response.ok)state=await response.json()}catch{}
      if(ready.ok)return{index,status:"ready",state,stdout:n.stdout,stderr:n.stderr};
      return{index,status:age<10000?"starting":"unreachable",error:`ready-http-${ready.status}`,state,stdout:n.stdout,stderr:n.stderr};
    }catch(error){
      return{index,status:age<10000?"starting":"unreachable",error:classifyProcessError(error),stdout:n.stdout,stderr:n.stderr};
    }
  }
  async setChaos(index:number,policy:ChaosPolicy){
    const r=await fetch(`http://127.0.0.1:${this.nodes[index].api}/chaos`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({delayMs:policy.delayMs||0,dropRate:policy.dropRate||0,duplicateRate:policy.duplicateRate||0,reorder:!!policy.reorder,partition:[...(policy.partition||[])]}),signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw new Error(`HA chaos request failed for node ${index}: HTTP ${r.status}`);
    return r.json()
  }
  async clearChaos(){await Promise.all(this.nodes.map((_,i)=>this.setChaos(i,{})))}
  async isolate(index:number){
    const address=this.nodes[index].address;
    const peers=this.nodes.filter((_,j)=>j!==index).map(x=>x.address);
    await Promise.all(this.nodes.map((n,i)=>this.setChaos(i,i===index?{partition:peers}:{partition:[address]})));
  }
  async partitionGroups(groups:number[][]){
    const groupByIndex=new Map<number,number>();
    for(const[groupIndex,group]of groups.entries())for(const index of group)groupByIndex.set(index,groupIndex);
    await Promise.all(this.nodes.map((n,i)=>{const group=groupByIndex.get(i);const peers=this.nodes.filter((_,j)=>groupByIndex.get(j)!==group).map(x=>x.address);return this.setChaos(i,{partition:peers})}));
  }
  async heal(){await this.clearChaos()}
  async resources(includeParent=true):Promise<ResourceSnapshot>{
    const entries=this.nodes.filter(n=>n.process).map(n=>({pid:n.process!.pid,label:`node-${n.index}`}));
    if(includeParent)entries.unshift({pid:process.pid,label:"soak"});
    return resourceSnapshot(entries);
  }
  async cleanup(){await this.stop();await rm(this.root,{recursive:true,force:true})}
}
