import type { Clock, LifecycleState } from "./types";
import { HAError } from "./errors";

const next: Record<LifecycleState, LifecycleState[]> = {
  provision: ["join"], join: ["sync", "quarantine"], sync: ["ready", "quarantine"],
  ready: ["active", "drain"], active: ["drain", "recover"], drain: ["recover", "retired"],
  recover: ["sync", "quarantine"], retired: [], quarantine: ["recover", "retired"],
};

export class Lifecycle {
  private state: LifecycleState = "provision";
  private accepting = false;
  constructor(private clock: Clock, private onChange: (from: LifecycleState, to: LifecycleState) => void) {}
  get() { return this.state; }
  isAccepting() { return this.accepting; }
  transition(to: LifecycleState) {
    if (!next[this.state].includes(to)) throw new HAError("invalid lifecycle transition " + this.state + " -> " + to, "INVALID_LIFECYCLE");
    const from = this.state; this.state = to; this.accepting = to === "active" || to === "ready"; this.onChange(from, to);
  }
  provision() { this.transition("join"); }
  join() { this.transition("sync"); }
  ready() { this.transition("ready"); }
  activate() { this.transition("active"); }
  async drain(stopWork: () => Promise<void> | void) { if (this.state !== "active" && this.state !== "ready") return; this.transition("drain"); this.accepting = false; await stopWork(); }
  recover() { this.transition("recover"); }
  retire() { this.transition("retired"); }
  quarantine() { if (this.state !== "quarantine") this.transition("quarantine"); }
}
