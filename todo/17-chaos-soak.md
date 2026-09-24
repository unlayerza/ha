# Phase 17 — Chaos and Soak

- [x] Deterministic seed for campaign/action selection
- [x] Random node kill
- [x] Leader kill
- [x] Follower kill
- [x] Partition
- [x] Delay
- [x] Drop
- [x] Duplicate
- [x] Reorder
- [ ] Quorum loss
- [ ] Quorum recovery
- [x] Stale-node return
- [ ] Rolling restart
- [ ] 1-hour soak
- [ ] 24-hour soak
- [ ] 72-hour soak

**Validated evidence:** 21-node / 15-minute campaigns on both Alpha and the development machine passed 3,330/3,330 and 2,880/2,880 invariant checks respectively, with 0 action errors and 0 unexpected failures. Additional 5-node campaigns on Alpha and development passed 325/325 checks with 0 action errors. A 42-node Alpha campaign previously passed 165/165 operational invariant checks with 0 action errors, but final recovery diagnostics exposed transient request timeouts under the 43-process load.

**Recovery hardening:** the process harness now starts large clusters with bounded concurrency instead of spawning every Bun process simultaneously. Final soak recovery now polls for convergence for a bounded recovery window, and process diagnostics allow a longer state-request timeout. These changes address test-harness observation pressure without weakening HA invariants.

**Next validation added:** a 5-node process-level quorum-loss/recovery test partitions a 2-node minority from a 3-node majority, verifies minority fencing/quorum loss, verifies a single authoritative majority leader, then heals and verifies convergence. The checkbox remains open until this test is executed successfully.

**Important:** transport chaos still uses non-seeded randomness, so the entire campaign is not yet perfectly reproducible.
**Join convergence hardening:** concurrent process joins are now serialized at the leader so a single in-flight configuration transition cannot strand admitted nodes outside the committed voter set.
**Configuration join race:** configuration proposals are now authorized by the committed voter set and current term rather than requiring prior heartbeat-based leader discovery, allowing a joiner to acknowledge the leader's proposal immediately after admission.
