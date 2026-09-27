import type {ClusterMessage,Transport,ChaosPolicy} from "./types";
import {id} from "./id";
import {canonicalMessage,sign} from "./security";

export class InMemoryTransport implements Transport{
  static peers=new Map<string,InMemoryTransport>();
  private handler?:((m:ClusterMessage)=>Promise<void>);
  policy:ChaosPolicy={};
  constructor(public address:string){}
  async start(h:(m:ClusterMessage)=>Promise<void>){this.handler=h;InMemoryTransport.peers.set(this.address,this)}
  async stop(){InMemoryTransport.peers.delete(this.address)}
  private async deliver(to:string,m:ClusterMessage){
    if(this.policy.partition?.has(to)||this.policy.partition?.has(m.fromAddress||m.from))return;
    if(this.policy.dropRate&&Math.random()<this.policy.dropRate)return;
    if(this.policy.delayMs)await Bun.sleep(this.policy.reorder?((hash(m.id)%this.policy.delayMs)+1):this.policy.delayMs);
    await InMemoryTransport.peers.get(to)?.handler?.(m);
    if(this.policy.duplicateRate&&Math.random()<this.policy.duplicateRate)await InMemoryTransport.peers.get(to)?.handler?.(m);
  }
  async send(to:string,m:ClusterMessage){await this.deliver(to,m)}
  async broadcast(from:string,m:ClusterMessage){await Promise.all([...InMemoryTransport.peers.keys()].filter(x=>x!==from).map(x=>this.deliver(x,m).catch(()=>{})))}
}

const hash=(value:string)=>{let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const wire=(m:ClusterMessage)=>JSON.stringify({...m,term:m.term.toString(),configurationVersion:m.configurationVersion.toString()},(_,value)=>typeof value==="bigint"?value.toString():value);
const unwire=(s:string)=>{
  const m=JSON.parse(s) as any;
  m.term=BigInt(m.term);
  m.configurationVersion=BigInt(m.configurationVersion??"0");
  if(m.payload&&typeof m.payload==="object"){
    if(typeof m.payload.version==="string"&&(m.kind==="membership_snapshot"||m.kind==="configuration_snapshot"))m.payload.version=BigInt(m.payload.version);
    if(typeof m.payload.baseVersion==="string")m.payload.baseVersion=BigInt(m.payload.baseVersion);
    if(typeof m.payload.nextVersion==="string")m.payload.nextVersion=BigInt(m.payload.nextVersion);
    if(typeof m.payload.acknowledgements==="undefined"&&m.kind==="configuration_commit")m.payload.acknowledgements=[];
  }
  return m as ClusterMessage;
};

const normalizeAddress=(x:string)=>x.replace(/^https?:\/\//,"").replace(/\/$/,"");
export class HttpTransport implements Transport{
  private server?:ReturnType<typeof Bun.serve>;
  private peers=new Map<string,string>();
  private policy:ChaosPolicy={};
  constructor(private address:string){}
  setPeers(peers:Record<string,string>){this.peers=new Map(Object.entries(peers))}
  setChaos(policy:ChaosPolicy={}){this.policy={...policy,partition:new Set(policy.partition||[])}}
  chaosPolicy(){return {...this.policy,partition:new Set(this.policy.partition||[])}}
  async start(handler:(m:ClusterMessage)=>Promise<void>){
    this.server=Bun.serve({hostname:this.address.split(":")[0]||"0.0.0.0",port:Number(this.address.split(":").pop()),fetch:async req=>{
      if(req.method!=="POST"||new URL(req.url).pathname!=="/ha/message")return new Response("not found",{status:404});
      try{await handler(unwire(await req.text()));return Response.json({ok:true})}catch{return Response.json({ok:false},{status:400})}
    }})
  }
  async stop(){this.server?.stop()}
  private blocked(to:string,m:ClusterMessage){const partition=this.policy.partition;if(!partition?.size)return false;const blocked=new Set([...partition].map(normalizeAddress));return blocked.has(normalizeAddress(to))||blocked.has(normalizeAddress(m.fromAddress||m.from))}
  private async deliver(to:string,m:ClusterMessage){
    if(this.blocked(to,m))return false;
    if(this.policy.dropRate&&Math.random()<this.policy.dropRate)return false;
    if(this.policy.delayMs){
      const delay=this.policy.reorder?((hash(m.id)%this.policy.delayMs)+1):this.policy.delayMs;
      await Bun.sleep(delay);
    }
    const r=await fetch(this.endpoint(to),{method:"POST",headers:{"content-type":"application/json"},body:wire(m),signal:AbortSignal.timeout(1000)});
    if(!r.ok)throw new Error("HA peer returned "+r.status);
    if(this.policy.duplicateRate&&Math.random()<this.policy.duplicateRate)void fetch(this.endpoint(to),{method:"POST",headers:{"content-type":"application/json"},body:wire(m),signal:AbortSignal.timeout(1000)}).catch(()=>{});
    return true;
  }
  private endpoint(to:string){const peer=to.includes("://")?to:this.peers.get(to)||[...this.peers.values()].find(p=>normalizeAddress(p)===normalizeAddress(to))||"http://"+to;return peer.replace(/\/$/,"")+"/ha/message"}
  async send(to:string,m:ClusterMessage){await this.deliver(to,m)}
  async broadcast(from:string,m:ClusterMessage){const normalize=normalizeAddress;const sender=normalize(from);await Promise.all([...this.peers.keys()].filter(x=>normalize(x)!==sender).map(x=>this.deliver(x,m).catch(()=>{})))}
}

export class ChaosTransport implements Transport{
  constructor(private inner:Transport,private policy:ChaosPolicy,private rand=()=>Math.random()){}
  async start(h:(m:ClusterMessage)=>Promise<void>){return this.inner.start?.(h)}
  async stop(){return this.inner.stop?.()}
  private allowed(to:string,m:ClusterMessage){return !(this.policy.partition?.has(to)||this.policy.partition?.has(m.fromAddress||m.from))}
  async send(to:string,m:ClusterMessage){
    if(!this.allowed(to,m)||this.rand()<(this.policy.dropRate||0))return;
    if(this.policy.delayMs)await Bun.sleep(this.policy.reorder?((hash(m.id)%this.policy.delayMs)+1):this.policy.delayMs);
    await this.inner.send(to,m);
    if(this.rand()<(this.policy.duplicateRate||0))await this.inner.send(to,m);
  }
  async broadcast(from:string,m:ClusterMessage){
    if(this.rand()<(this.policy.dropRate||0))return;
    await this.inner.broadcast(from,m);
  }
}

export class SignedTransport implements Transport{
  constructor(private inner:Transport,private address:string,private secret:string){}
  async start(h:(m:ClusterMessage)=>Promise<void>){return this.inner.start?.(h)}
  async stop(){return this.inner.stop?.()}
  private async secure(m:ClusterMessage){const x={...m,fromAddress:m.fromAddress||this.address};return{...x,signature:await sign(this.secret,canonicalMessage(x.id,x.kind,x.from,x.term,x.sentAt,x.payload,x.configurationVersion))}}
  async send(to:string,m:ClusterMessage){await this.inner.send(to,await this.secure(m))}
  async broadcast(_from:string,m:ClusterMessage){await this.inner.broadcast(this.address,await this.secure(m))}
}
