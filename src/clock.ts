import type {Clock} from "./types";
export class SystemClock implements Clock { now(){return Date.now()} async sleep(ms:number){await Bun.sleep(ms)} }
export class TestClock implements Clock { private t:number; constructor(start=0){this.t=start} now(){return this.t} advance(ms:number){this.t+=ms} async sleep(ms:number){this.t+=ms} }
