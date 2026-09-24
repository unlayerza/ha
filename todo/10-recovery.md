# Phase 10 — Recovery and Rejoin

- [x] Failed-node detection
- [x] Recovery admission
- [x] State catch-up contract
- [x] Rejoin
- [x] Stale-state rejection
- [x] Resynchronization hooks
- [x] Recovery timeout
- [x] Quarantine on inconsistent state
- [x] Recovery after partition
- [x] Recovery after full restart
- [x] Repeated recovery tests

**Status:** PARTIAL. Committed configuration is persisted and synchronized before/through rejoin. Adversarial tests now cover obsolete snapshots, replacement catch-up, stale joins, and repeated configuration churn. **Remaining:** execute the recovery suite and complete authoritative recovery/runbook validation.