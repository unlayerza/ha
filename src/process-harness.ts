import {mkdir,rm} from "node:fs/promises";
import {resourceSnapshot,type ResourceSnapshot} from "./resources";
import type {ChaosPolicy} from "./types";

export interface ProcessNode{index:number;address:string;api:number;dataDir:string;process?:Bun.Subprocess;stderr?:string;stdout?:string;stderrDone?:Promise<void>;stdoutDone?:Promise<void>}

export class LocalProcessCluster{
  readonly nodes:ProcessNode[]=[];
  constructor(private count=3,private basePort=7301,private apiBase=7401,private root="./.ha-process",private secret="local-test-secret"){
    for(let i=0;i<count;i++)this.nodes.push({index:i,address:`http://127.0.0.1:${basePort+i}`,api:apiBase+i,dataDir:`${root}/${i}`})
  }
  private seeds(){return this.nodes[0]?.address.replace(/^https?:\\/\\//,"")||""}
  private peers(){return this.nodes.map(n=>n.address).join(",")}
  async start(){await rm(this.root,{recursive:true,force:true});await mkdir(this.root,{recursive:true});if(this.nodes.length){await this.startNode(this.nodes[0]);await Promise.all(this.nodes.slice(1).map(n=>this.startNode(n)))}return this}
  async startNode(n:ProcessNode){
    await mkdir(n.dataDir,{recursive:true});
    n.stderr="";n.stdout="";n.process=Bun.spawn(["bun","run","src/server.ts"],{env:{...Bun.env,HA_SERVICE:"process-test",HA_CLUSTER:"process-test",HA_ADDRESS:n.address.replace("http://",""),HA_API_PORT:String(n.api),HA_DATA_DIR:n.dataDir,HA_SECRET:this.secret,HA_SEEDS:this.seeds(),HA_PEERS:this.peers(),HA_BOOTSTRAP:n.index===0?"true":"false",HA_HEARTBEAT_MS:Bun.env.HA_PROCESS_HEARTBEAT_MS||"200",HA_ELECTION_MIN_MS:Bun.env.HA_PROCESS_ELECTION_MIN_MS||"1200",HA_ELECTION_MAX_MS:Bun.env.HA_PROCESS_ELECTION_MAX_MS||"3000"},stdout:"pipe",stderr:"pipe"});
    n.stdoutDone=this.capture(n.process.stdout,s=>n.stdout=s);n.stderrDone=this.capture(n.process.stderr,s=>n.stderr=s);
    await this.waitReady(n,5000);
    return n
  }
  private capture(stream:ReadableStream<Uint8Array>|null|undefined,target:(value:string)=>void){if(!stream)return Promise.resolve();return (async()=>{const reader=stream.getReader();const decoder=new TextDecoder();let value="";const limit=16384;try{while(true){const part=await reader.read();if(part.done)break;if(value.length<limit)value+=decoder.decode(part.value,{stream:true}).slice(0,limit-value.length)}}catch{}target(value.slice(-limit))})()}
  private async waitReady(n:ProcessNode,timeoutMs:number){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(!n.process||n.process.exitCode!==null){await Promise.allSettled([n.stdoutDone,n.stderrDone]);const diagnostic=[n.stderr,n.stdout].filter(Boolean).join("\n").trim();throw new Error(`HA process ${n.index} exited during startup${diagnostic?`:\n${diagnostic}`:""}`)}
      try{
        const r=await fetch(`http://127.0.0.1:${n.api}/ready`,{signal:AbortSignal.timeout(250)});
        if(r.ok)return;
      }catch{}
      await Bun.sleep(50)
    }
    const diagnostic=[n.stderr,n.stdout].filter(Boolean).join("\n").trim();throw new Error("HA process "+n.index+" did not become ready within "+timeoutMs+"ms"+(diagnostic?": "+diagnostic:""))
  }
  async stop(index?:number){
    const targets=index===undefined?this.nodes:this.nodes.filter(n=>n.index===index);
    for(const n of targets){n.process?.kill("SIGTERM");await n.process?.exited;n.process=undefined}
  }
  async hardKill(index:number){
    const n=this.nodes[index];
    n.process?.kill("SIGKILL");
    await n.process?.exited;
    n.process=undefined
  }
  async restart(index:number){await this.stop(index);return this.startNode(this.nodes[index])}
  async state(index:number){
    const r=await fetch(`http://127.0.0.1:${this.nodes[index].api}/state`,{signal:AbortSignal.timeout(500)});
    if(!r.ok)throw new Error(`HA state request failed: HTTP ${r.status}`);
    return r.json()
  }
  async setChaos(index:number,policy:ChaosPolicy){
    const r=await fetch(`http://127.0.0.1:${this.nodes[index].api}/chaos`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({delayMs:policy.delayMs||0,dropRate:policy.dropRate||0,duplicateRate:policy.duplicateRate||0,reorder:!!policy.reorder,partition:[...(policy.partition||[]) ]}),signal:AbortSignal.timeout(500)});
    if(!r.ok)throw new Error(`HA chaos request failed for node ${index}: HTTP ${r.status}`);
    return r.json()
  }
  async clearChaos(){await Promise.all(this.nodes.map((_,i)=>this.setChaos(i,{})))}
  async isolate(index:number){
    const address=this.nodes[index].address;
    await Promise.all(this.nodes.map((n,i)=>this.setChaos(i,i===index?{partition:this.nodes.filter((_,j)=>j!==index).map(x=>x.address)}:{partition:[address]})))
  }
  async heal(){await this.clearChaos()}
  async resources(includeParent=true):Promise<ResourceSnapshot>{
    const entries=this.nodes.filter(n=>n.process).map(n=>({pid:n.process!.pid,label:`node-${n.index}`}));
    if(includeParent)entries.unshift({pid:process.pid,label:"soak"});
    return resourceSnapshot(entries);
  }
  async cleanup(){await this.stop();await rm(this.root,{recursive:true,force:true})}
}
