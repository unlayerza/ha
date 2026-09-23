import {AuthenticationError} from "./errors";
const enc=new TextEncoder();
function bytesToHex(a:ArrayBuffer){return [...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function key(secret:string){return crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"])}
export async function sign(secret:string,data:string){return bytesToHex(await crypto.subtle.sign("HMAC",await key(secret),enc.encode(data)))}
export async function verify(secret:string,data:string,signature:string){return crypto.subtle.verify("HMAC",await key(secret),hex(signature),enc.encode(data))}
function hex(s:string){if(s.length%2)throw new AuthenticationError();const a=new Uint8Array(s.length/2);for(let i=0;i<a.length;i++)a[i]=parseInt(s.slice(i*2,i*2+2),16);return a}
export async function requireSignature(secret:string|undefined,data:string,signature?:string){if(!secret)throw new AuthenticationError("cluster secret is not configured");if(!signature||!(await verify(secret,data,signature)))throw new AuthenticationError()}
export function canonicalMessage(id:string,kind:string,from:string,term:bigint,sentAt:number,payload:unknown){return JSON.stringify([id,kind,from,term.toString(),sentAt,payload],(_,value)=>typeof value==="bigint"?value.toString():value)}
export function secureRandomToken(){return crypto.randomUUID()+"."+crypto.randomUUID()}
export class ReplayGuard{private seen=new Map<string,number>();constructor(private ttlMs=30000,private now=()=>Date.now()){}accept(messageId:string){const t=this.now();for(const [k,v] of this.seen)if(v<=t)this.seen.delete(k);if(this.seen.has(messageId))return false;this.seen.set(messageId,t+this.ttlMs);return true}}
