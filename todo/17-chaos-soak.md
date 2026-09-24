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

**Validated evidence:** 21-node / 15-minute campaigns on both Alpha and the development machine passed 3,330/3,330 and 2,880/2,880 invariant checks respectively, with 0 action errors and 0 unexpected failures. Additional 5-node campaigns on Alpha and development passed 325/325 checks with 0 action errors; a 42-node Alpha campaign passed 165/165 checks with 0 action errors. The 42-node run ended with one node transiently unreachable during final diagnostics, so larger-scale recovery evidence remains open.

**Next validation added:** a 5-node process-level quorum-loss/recovery test now partitions a 2-node minority from a 3-node majority, verifies minority fencing/quorum loss, verifies a single authoritative majority leader, then heals and verifies convergence. The checkbox remains open until this test is executed successfully.

**Important:** transport chaos still uses non-seeded randomness, so the entire campaign is not yet perfectly reproducible.