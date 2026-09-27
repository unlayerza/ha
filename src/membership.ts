import type { Clock, HAEvent, Member, MembershipSnapshot, NodeStatus } from "./types";
import { AdmissionError, HAError } from "./errors";
import { id } from "./id";

const statusRank: Record<NodeStatus, number> = {
  provision: 0, joining: 1, syncing: 2, healthy: 5, degraded: 4, draining: 3,
  unhealthy: 2, suspect: 2, failed: 1, removed: 0, quarantined: 0, retired: 0,
};

export class Membership {
  private members = new Map<string, Member>();
  private v = 0n;
  private listeners = new Set<(s: MembershipSnapshot) => void>();
  // Local failure-detector evidence; kept out of the gossiped member record so it never outranks a peer's own advertisement.
  private contact = new Map<string, number>();

  constructor(private clock: Clock, private local: Member, private emit: (e: HAEvent) => void) {
    this.members.set(local.id, local);
  }

  rebindLocal(nodeId: string) {
    this.local.id = nodeId;
    this.normalize();
    this.members.set(nodeId, this.local);
  }

  private normalize() {
    const normalized = new Map<string, Member>();
    for (const member of this.members.values()) {
      const existing = normalized.get(member.id);
      if (!existing) normalized.set(member.id, member);
      else {
        const merged = this.mergeMember(existing, member);
        if (merged) normalized.set(member.id, merged);
      }
    }
    this.members = normalized;
  }

  snapshot(): MembershipSnapshot {
    return { version: this.v, members: [...this.members.values()].map(x => ({ ...x })) };
  }

  onChange(fn: (s: MembershipSnapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private changed(type: string, nodeId: string, data?: Record<string, unknown>) {
    this.v++;
    this.emit({ id: id("evt"), type, at: this.clock.now(), nodeId, data });
    this.publish();
  }

  private mergeMember(existing: Member | undefined, incoming: Member): Member | undefined {
    if (!existing) return { ...incoming };
    if (existing.cluster !== incoming.cluster || existing.service !== incoming.service) {
      throw new AdmissionError("cluster/service mismatch");
    }
    if (existing.incarnation > incoming.incarnation) return existing;
    if (incoming.incarnation > existing.incarnation) return { ...incoming };
    if (existing.address !== incoming.address) throw new AdmissionError("identity/address collision");

    // A join/sync advertisement must never downgrade an already active member.
    const existingRank = statusRank[existing.status];
    const incomingRank = statusRank[incoming.status];
    if (incomingRank < existingRank) return existing;

    if (incoming.lastSeen > existing.lastSeen) return { ...incoming };
    if (incoming.lastSeen < existing.lastSeen) return existing;
    return incomingRank > existingRank ? { ...incoming } : existing;
  }

  admit(node: Member) {
    if (node.cluster !== this.local.cluster || node.service !== this.local.service) {
      throw new AdmissionError("cluster/service mismatch");
    }
    const old = this.members.get(node.id);
    if (old && old.incarnation > node.incarnation) throw new AdmissionError("older incarnation");
    if (old && old.address !== node.address) throw new AdmissionError("identity/address collision");

    const merged = this.mergeMember(old, node);
    if (!merged) return;
    const same = old && JSON.stringify(old) === JSON.stringify(merged);
    this.members.set(node.id, merged);
    if (!same) this.changed("node_joined", node.id);
  }

  touch(nodeId: string) {
    const member = this.members.get(nodeId);
    if (!member) return;
    this.contact.set(nodeId, this.clock.now());
    // Direct contact clears a failure-detector suspicion; other statuses are owned by lifecycle/admission.
    if (member.status === "suspect") this.setStatus(nodeId, "healthy");
  }

  update(nodeId: string, patch: Partial<Member>) {
    const member = this.members.get(nodeId);
    if (!member) throw new HAError("unknown member", "UNKNOWN_MEMBER");
    this.members.set(nodeId, { ...member, ...patch, lastSeen: this.clock.now() });
    this.changed("membership_changed", nodeId);
  }

  setLocalState(status: NodeStatus, lifecycle = this.local.lifecycle) {
    if (this.local.status === status && this.local.lifecycle === lifecycle) return;
    this.local.status = status;
    this.local.lifecycle = lifecycle;
    this.local.lastSeen = this.clock.now();
    this.changed("local_state_changed", this.local.id, { status, lifecycle });
  }

  remove(nodeId: string) {
    if (nodeId === this.local.id) throw new HAError("cannot remove local node");
    if (this.members.delete(nodeId)) this.changed("node_removed", nodeId);
  }

  setStatus(nodeId: string, status: NodeStatus) {
    const member = this.members.get(nodeId);
    if (member && member.status !== status) {
      this.members.set(nodeId, { ...member, status, lastSeen: this.clock.now() });
      this.changed(
        status === "quarantined" ? "node_quarantined" :
        status === "failed" ? "node_failed" : "health_transition",
        nodeId,
      );
    }
  }

  get(nodeId: string) { return this.members.get(nodeId); }
  values() { return [...this.members.values()]; }

  votingMembers() {
    return this.values().filter(member =>
      !["provision", "joining", "syncing", "removed", "retired", "quarantined"].includes(member.status),
    );
  }

  size() { return this.members.size; }
  votingSize() { return this.votingMembers().length; }

  healthy() {
    return this.votingMembers().filter(member =>
      ["healthy", "degraded", "draining"].includes(member.status),
    ).length;
  }

  markSuspect(timeout: number) {
    const now = this.clock.now();
    for (const member of this.values()) {
      if (
        member.id !== this.local.id &&
        now - Math.max(member.lastSeen, this.contact.get(member.id) ?? 0) > timeout &&
        ["healthy", "degraded"].includes(member.status)
      ) this.setStatus(member.id, "suspect");
    }
  }

  restore(snapshot: MembershipSnapshot) {
    if (snapshot.version < this.v) throw new HAError("stale membership", "STALE_MEMBERSHIP");

    let changed = false;
    for (const incoming of snapshot.members) {
      if (incoming.cluster !== this.local.cluster || incoming.service !== this.local.service) {
        throw new AdmissionError("cluster/service mismatch");
      }
      const current = this.members.get(incoming.id);
      const merged = this.mergeMember(current, incoming);
      if (merged && JSON.stringify(merged) !== JSON.stringify(current)) {
        this.members.set(incoming.id, merged);
        changed = true;
      }
    }

    this.v = snapshot.version > this.v ? snapshot.version : this.v;

    // Collapse any legacy/key drift before restoring the local authoritative record.
    this.normalize();
    this.members.set(this.local.id, this.local);

    if (changed) {
      this.emit({
        id: id("evt"),
        type: "membership_synced",
        at: this.clock.now(),
        nodeId: this.local.id,
        data: { version: this.v.toString(), size: this.members.size },
      });
      this.publish();
    }
  }
}
