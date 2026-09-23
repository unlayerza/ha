export interface ProcessResource {
  pid:number;
  label:string;
  rssBytes:number;
  vszBytes:number;
  threads:number;
  cpuUserMicros:number;
  cpuSystemMicros:number;
  cpuPercent?:number;
}

export interface ResourceSnapshot {
  supported:boolean;
  at:number;
  processes:ProcessResource[];
  totalRssBytes:number;
  totalVszBytes:number;
  cpuPercent:number;
  load1?:number;
  memoryAvailableBytes?:number;
}

const previous=new Map<number,{at:number;cpuMicros:number}>();
const hz=100;

async function readText(path:string){
  try{return await Bun.file(path).text()}catch{return null}
}

async function processResource(pid:number,label:string):Promise<ProcessResource|null>{
  const status=await readText(`/proc/${pid}/status`);
  const stat=await readText(`/proc/${pid}/stat`);
  if(!status||!stat)return null;

  let rssBytes=0,vszBytes=0,threads=0;
  for(const line of status.split("\n")){
    if(line.startsWith("VmRSS:"))rssBytes=Number(line.split(/\s+/)[1]||0)*1024;
    else if(line.startsWith("VmSize:"))vszBytes=Number(line.split(/\s+/)[1]||0)*1024;
    else if(line.startsWith("Threads:"))threads=Number(line.split(/\s+/)[1]||0);
  }

  const close=stat.lastIndexOf(")");
  if(close<0)return null;
  const fields=stat.slice(close+2).trim().split(/\s+/);
  const cpuUserMicros=(Number(fields[11]||0)/hz)*1_000_000;
  const cpuSystemMicros=(Number(fields[12]||0)/hz)*1_000_000;
  const cpuMicros=cpuUserMicros+cpuSystemMicros;
  const at=Date.now();
  const prior=previous.get(pid);
  let cpuPercent:number|undefined;
  if(prior){
    const wallMicros=(at-prior.at)*1000;
    if(wallMicros>0)cpuPercent=(cpuMicros-prior.cpuMicros)/wallMicros*100;
  }
  previous.set(pid,{at,cpuMicros});
  return {pid,label,rssBytes,vszBytes,threads,cpuUserMicros,cpuSystemMicros,cpuPercent};
}

async function systemMemory(){
  const text=await readText("/proc/meminfo");
  if(!text)return undefined;
  for(const line of text.split("\n")){
    if(line.startsWith("MemAvailable:"))return Number(line.split(/\s+/)[1]||0)*1024;
  }
}

async function load1(){
  const text=await readText("/proc/loadavg");
  return text?Number(text.split(/\s+/)[0]):undefined;
}

export async function resourceSnapshot(entries:Array<{pid:number;label:string}>):Promise<ResourceSnapshot>{
  if(typeof process==="undefined"||process.platform!=="linux"){
    return {supported:false,at:Date.now(),processes:[],totalRssBytes:0,totalVszBytes:0,cpuPercent:0};
  }
  const processes=(await Promise.all(entries.map(e=>processResource(e.pid,e.label)))).filter((x):x is ProcessResource=>!!x);
  return {
    supported:true,
    at:Date.now(),
    processes,
    totalRssBytes:processes.reduce((n,p)=>n+p.rssBytes,0),
    totalVszBytes:processes.reduce((n,p)=>n+p.vszBytes,0),
    cpuPercent:processes.reduce((n,p)=>n+(p.cpuPercent||0),0),
    load1:await load1(),
    memoryAvailableBytes:await systemMemory(),
  };
}

export function formatBytes(bytes:number){
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024**2)return `${(bytes/1024).toFixed(1)} KiB`;
  if(bytes<1024**3)return `${(bytes/1024**2).toFixed(1)} MiB`;
  return `${(bytes/1024**3).toFixed(2)} GiB`;
}
