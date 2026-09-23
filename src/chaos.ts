import type {ChaosPolicy} from "./types";
import {deterministicId} from "./id";

export class SeededRandom{
  private s:number;
  constructor(seed:number){this.s=(seed>>>0)||1}
  next(){let x=this.s;x^=x<<13;x^=x>>>17;x^=x<<5;this.s=x>>>0;return this.s/4294967296}
  int(max:number){return Math.floor(this.next()*max)}
}

export interface ChaosAction{type:"kill"|"delay"|"drop"|"duplicate"|"reorder"|"partition"|"heal";node?:string;peer?:string;ms?:number}
export interface ChaosCampaign{
  seed:number;
  actions:ChaosAction[];
  startedAt:number;
  finishedAt?:number;
  invariants:string[];
  failures:string[];
  actionCounts:Record<string,number>;
  invariantStats:{checks:number;passed:number;failed:number};
  unexpectedFailures:Array<{at:number;name:string;error?:string}>;
}

export class ChaosController{
  readonly random:SeededRandom;
  readonly campaign:ChaosCampaign;
  constructor(seed=Date.now()){
    this.random=new SeededRandom(seed);
    this.campaign={seed,actions:[],startedAt:Date.now(),invariants:[],failures:[],actionCounts:{},invariantStats:{checks:0,passed:0,failed:0},unexpectedFailures:[]}
  }
  choose(actions:ChaosAction[]){
    const action=actions[this.random.int(actions.length)];
    this.campaign.actions.push(action);
    this.campaign.actionCounts[action.type]=(this.campaign.actionCounts[action.type]||0)+1;
    return action
  }
  recordInvariant(name:string,ok:boolean,error?:string){
    this.campaign.invariants.push(name+":"+(ok?"pass":"fail"));
    this.campaign.invariantStats.checks++;
    if(ok)this.campaign.invariantStats.passed++;
    else{
      this.campaign.invariantStats.failed++;
      this.campaign.failures.push(name);
      this.campaign.unexpectedFailures.push({at:Date.now(),name,error});
    }
  }
  finish(){this.campaign.finishedAt=Date.now();return structuredClone(this.campaign)}
}

export function deterministicPolicy(seed:number):ChaosPolicy{
  const r=new SeededRandom(seed);
  return{seed,delayMs:r.int(100),dropRate:r.next()*0.2,duplicateRate:r.next()*0.1}
}
export function campaignId(seed:number){return deterministicId("chaos:"+seed)}
