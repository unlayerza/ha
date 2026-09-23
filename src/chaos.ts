import type { ChaosPolicy } from "./types";
import { deterministicId } from "./id";

export class SeededRandom {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296; }
  int(max: number) { return Math.floor(this.next() * max); }
}
export interface ChaosAction { type: "kill" | "delay" | "drop" | "duplicate" | "reorder" | "partition" | "heal"; node?: string; peer?: string; ms?: number; }
export interface ChaosCampaign { seed: number; actions: ChaosAction[]; startedAt: number; finishedAt?: number; invariants: string[]; failures: string[]; }
export class ChaosController {
  readonly random: SeededRandom; readonly campaign: ChaosCampaign;
  constructor(seed = Date.now()) { this.random = new SeededRandom(seed); this.campaign = { seed, actions: [], startedAt: Date.now(), invariants: [], failures: [] }; }
  choose(actions: ChaosAction[]) { const action = actions[this.random.int(actions.length)]; this.campaign.actions.push(action); return action; }
  recordInvariant(name: string, ok: boolean) { this.campaign.invariants.push(name + ":" + (ok ? "pass" : "fail")); if (!ok) this.campaign.failures.push(name); }
  finish() { this.campaign.finishedAt = Date.now(); return structuredClone(this.campaign); }
}
export function deterministicPolicy(seed: number): ChaosPolicy {
  const r = new SeededRandom(seed);
  return { seed, delayMs: r.int(100), dropRate: r.next() * 0.2, duplicateRate: r.next() * 0.1 };
}
export function campaignId(seed: number) { return deterministicId("chaos:" + seed); }
