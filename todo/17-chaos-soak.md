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

**Validated evidence:** 21-node / 15-minute campaigns on both Alpha and the development machine passed 3,330/3,330 and 2,880/2,880 invariant checks respectively, with 0 action errors and 0 unexpected failures.

**Important:** transport chaos still uses non-seeded randomness, so the entire campaign is not yet perfectly reproducible.