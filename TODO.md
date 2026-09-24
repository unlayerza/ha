# HA TODO

This is the active work queue for `unlayerza/ha`. Update this file whenever an implementation milestone is completed or a new production gap is discovered.

**Last verified:** 2026-09-24  
**Current milestone:** Multi-process cluster foundation validated; committed membership/configuration is next.

## COMPLETE — validated foundation

- [x] Bun-native dependency-free HA runtime
- [x] Durable node identity and incarnation
- [x] Membership admission and lifecycle states
- [x] Health/readiness/authority separation
- [x] Persisted monotonic terms
- [x] Pre-vote and leader election
- [x] Quorum primitives
- [x] Fencing tokens and stale-authority checks
- [x] Lifecycle/drain/recovery primitives
- [x] Real multi-process process harness
- [x] Kill/restart/fault injection
- [x] HMAC authenticated cluster traffic
- [x] Replay protection
- [x] Credential rotation and redaction
- [x] Structured events and diagnostics
- [x] Generic service adapter contracts
- [x] Database/Identity/Voice-neutral adapter contracts
- [x] Deterministic chaos controller
- [x] Executable process soak runner
- [x] 21-node chaos campaign with 84/84 invariants passing
- [x] Resource instrumentation observing all 22 processes in the latest campaign

## NEXT — committed membership/configuration

### Configuration model
- [ ] Define committed configuration identity/version independently from gossip membership version.
- [ ] Define the authoritative voter set.
- [ ] Define configuration proposal records and transitions.
- [ ] Define quorum acknowledgement and commit rules.
- [ ] Define configuration persistence and restart recovery.
- [ ] Define stale configuration rejection.

### Membership changes
- [ ] Join through a configuration proposal and commit path.
- [ ] Graceful leave/remove through a configuration proposal.
- [ ] Replacement of failed nodes without voter-set ambiguity.
- [ ] Prevent concurrent configuration changes from conflicting.
- [ ] Prevent an obsolete configuration from resurrecting after partition/restart.

### Election integration
- [ ] Make election quorum use the committed voter set.
- [ ] Make election reject stale configuration versions.
- [ ] Ensure leader authority is tied to both term and committed configuration.
- [ ] Add tests for elections during configuration changes.

## THEN — adversarial correctness

- [ ] Partition during membership commit.
- [ ] Kill leader during configuration commit.
- [ ] Restart a node with obsolete configuration.
- [ ] Simultaneous join/leave attempts.
- [ ] Replacement while old node returns.
- [ ] Minority partition attempts election.
- [ ] Repeated membership churn.
- [ ] Long delayed/reordered configuration messages.
- [ ] Fencing tests against obsolete configurations.
- [ ] Recovery from persisted committed configuration.

## THEN — production hardening

- [ ] Bound process shutdown waits.
- [ ] Harden transport timeout/backpressure behavior.
- [ ] Explicitly decode/validate typed BigInt protocol fields.
- [ ] Make chaos transport randomness fully seedable.
- [ ] Add bounded memory/message queues.
- [ ] Improve operational diagnostics for join/admission/configuration failures.
- [ ] Validate resource behavior under larger node counts.
- [ ] Run 1h soak on target infrastructure.
- [ ] Run 24h soak on target infrastructure.
- [ ] Run 72h soak on target infrastructure.

## THEN — consumer validation

- [ ] Fake service consumes committed HA configuration.
- [ ] Database consumes HA contracts without embedding HA internals.
- [ ] Identity consumes HA contracts without embedding HA internals.
- [ ] Voice consumes HA contracts without embedding HA internals.
- [ ] Validate active-active gateway/edge use cases without forcing leader/follower topology.

## Evidence rule

A checkbox is only marked complete when there is implementation plus a corresponding test, validation run, or explicitly documented external evidence. Passing a short local soak does not by itself mark long-duration production validation complete.
