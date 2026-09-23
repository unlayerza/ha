import {mkdir,rm} from "node:fs/promises";

export interface ProcessNode{index:number;address:string;api:number;dataDir:string;process?:Bun.Subprocess}

export class LocalProcessCluster{
  readonly nodes:ProcessNode[]=[];
  constructor(private count=3,private basePort=7301,private apiBase=7401,private root="./.ha-process",private secret="local-test-secret"){
    for(let i=0;i<count;i++)this.nodes.push({index:i,address:`http://127.0.0.1:${basePort+i}`,api:apiBase+i,dataDir:`${root}/${i}`})
  }
  private seeds(){return this.nodes.map(n=>n.address).join(",")}
  async start(){await mkdir(this.root,{recursive:true});for(const n of this.nodes)await this.startNode(n);return this}
  async startNode(n:ProcessNode){
    await mkdir(n.dataDir,{recursive:true});
    n.process=Bun.spawn(["bun","run","src/server.ts"],{env:{...Bun.env,HA_SERVICE:"process-test",HA_CLUSTER:"process-test",HA_ADDRESS:n.address.replace("http://",""),HA_API_PORT:String(n.api),HA_DATA_DIR:n.dataDir,HA_SECRET:this.secret,HA_SEEDS:this.seeds(),HA_PEERS:this.seeds(),HA_HEARTBEAT_MS:"200",HA_ELECTION_MIN_MS:"600",HA_ELECTION_MAX_MS:"1000"},stdout:"ignore",stderr:"ignore"});
    await this.waitReady(n,5000);
    return n
  }
  private async waitReady(n:ProcessNode,timeoutMs:number){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(!n.process||n.process.exitCode!==null)throw new Error(`HA process ${n.index} exited during startup`);
      try{
        const r=await fetch(`http://127.0.0.1:${n.api}/ready`,{signal:AbortSignal.timeout(250)});
        if(r.ok)return;
      }catch{}
      await Bun.sleep(50)
    }
    throw new Error(`HA process ${n.index} did not become ready within ${timeoutMs}ms`)
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
    const r=await fetch(`http://127.0.0.1:${this.nodes[index].api}/state`,{signal:AbortSignal.timeout(1000)});
    if(!r.ok)throw new Error(`HA state request failed: HTTP ${r.status}`);
    return r.json()
  }
  async cleanup(){await this.stop();await rm(this.root,{recursive:true,force:true})}
}
