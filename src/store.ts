import type {StateStore} from "./types";
import {mkdir,rename,rm} from "node:fs/promises";
import {HAError} from "./errors";

export class JsonFileStore implements StateStore {
  private writeQueue=Promise.resolve();

  constructor(private file:string){}

  async load(){
    try{
      return JSON.parse(await Bun.file(this.file).text());
    }catch(e){
      if((e as NodeJS.ErrnoException).code==="ENOENT")return {};
      if(e instanceof SyntaxError)throw new HAError("Corrupt HA state","CORRUPT_STATE");
      throw e;
    }
  }

  async save(state:Record<string,unknown>){
    const operation=this.writeQueue.then(async()=>{
      await mkdir(this.file.substring(0,this.file.lastIndexOf("/"))||".",{recursive:true});
      const tmp=this.file+"."+crypto.randomUUID()+".tmp";
      try{
        await Bun.write(tmp,JSON.stringify(state,null,2));
        await rename(tmp,this.file);
      }finally{
        await rm(tmp,{force:true}).catch(()=>{});
      }
    });
    this.writeQueue=operation.catch(()=>{});
    return operation;
  }
}

export class MemoryStore implements StateStore {
  private state:Record<string,unknown>={};
  async load(){return structuredClone(this.state)}
  async save(s:Record<string,unknown>){this.state=structuredClone(s)}
}
