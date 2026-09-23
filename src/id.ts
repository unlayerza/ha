export function id(prefix="id"){return prefix+"_"+crypto.randomUUID().replaceAll("-","")}
export function deterministicId(seed:string,index=0){let h=2166136261>>>0; for(const c of seed+"#"+index){h^=c.charCodeAt(0);h=Math.imul(h,16777619)} return "d_"+(h>>>0).toString(16).padStart(8,"0")}
