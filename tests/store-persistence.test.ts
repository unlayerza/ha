import{describe,test,expect}from"bun:test";
import{JsonFileStore}from"../src/store";
import{rm,mkdir}from"node:fs/promises";

describe("JSON state persistence",()=>{
  const root="./.ha-store-tests";
  const file=root+"/state.json";

  test("replaces state atomically and leaves no temporary file",async()=>{
    await rm(root,{recursive:true,force:true});
    await mkdir(root,{recursive:true});
    const store=new JsonFileStore(file);
    await store.save({term:"1",configuration:{version:"1",voters:["a"]}});
    await store.save({term:"2",configuration:{version:"2",voters:["a","b"]}});
    expect(await store.load()).toEqual({term:"2",configuration:{version:"2",voters:["a","b"]}});
    const entries=await Array.fromAsync(new Bun.Glob("state.json.*.tmp").scan({cwd:root}));
    expect(entries).toEqual([]);
    await rm(root,{recursive:true,force:true});
  });

  test("serializes concurrent saves so the final complete state is not torn",async()=>{
    await rm(root,{recursive:true,force:true});
    const store=new JsonFileStore(file);
    await Promise.all(Array.from({length:25},(_,i)=>store.save({term:String(i),payload:"x".repeat(1000)})));
    const state=await store.load() as any;
    expect(Number(state.term)).toBe(24);
    expect(state.payload).toHaveLength(1000);
    await rm(root,{recursive:true,force:true});
  });
});
