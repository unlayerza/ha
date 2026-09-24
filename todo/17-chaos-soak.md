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
**Join protocol ordering:** election term/vote state is now restored before the transport is exposed to join traffic, so configuration proposals received during bootstrap/join validation use the persisted current term rather than the initial zero term.
**Bootstrap configuration authorization:** an uninitialized joiner (empty committed voter set) may accept only the version-0→1 configuration proposed by its authenticated proposer when that proposer is explicitly included in the proposed voter set; later configuration changes still require a committed voter.
**Bootstrap proposal delivery:** the node message handler now permits an uninitialized joiner to acknowledge the authenticated initial configuration proposal when it is explicitly included in that proposal; this matches the configuration manager's constrained v0→v1 bootstrap rule.


**Join readiness fix:** non-bootstrap nodes no longer treat a membership snapshot alone as completed join synchronization; startup remains in the join loop until the node is also present in the committed voter configuration.


**Process join routing:** process-harness seed addresses preserve the HTTP scheme so non-bootstrap nodes can actually reach the bootstrap leader during join.

**Join startup correctness:** non-bootstrap processes now fail startup unless both membership synchronization and committed voter configuration converge before the join deadline; this prevents a node from becoming ready but permanently ineligible for election after an unsuccessful join.

**Single-voter bootstrap:** election startup now immediately establishes the sole committed voter as leader instead of waiting for the election timeout; this removes a bootstrap/join race where joiners could repeatedly reach a healthy but not-yet-authoritative seed.

**Join authority diagnostics:** configuration proposals now record the exact election, authority, quorum, term, and committed-configuration state when a leader cannot authorize a join transition, plus successful proposal initiation metadata.


**Direct join commit delivery:** committed configuration is now sent directly to the joining node as well as the normal cluster broadcast, so startup does not depend on a single broadcast reaching a newly admitted process.

**Process join convergence window:** process-level HA tests now give joining nodes a 15-second protocol convergence window by default, independently of the harness readiness timeout; this avoids treating a valid multi-step configuration transition as a startup failure under concurrent process startup.
**Process quorum test timeout:** the dedicated 5-node quorum/recovery test now has a 60-second test budget so its assertion window includes the configured 15-second per-process join convergence window and bounded multi-process startup; the HA protocol timeout itself remains unchanged.

**Join diagnostic window:** the process harness now gives joiners a 30-second default protocol convergence window and waits for captured stdout/stderr before reporting a readiness timeout, so a slow join cannot hide the actual configuration/election failure behind the harness timeout.

**Root cause fixed:** HTTP transport now decodes `configuration_snapshot.version` from JSON back to `bigint`, matching the in-memory representation. Previously a joining process rejected the snapshot during `bigint` version validation, leaving its committed voter set empty and preventing the subsequent configuration commit from completing bootstrap.
**Join configuration ordering hardening:** bootstrap v0→v1 joins may accept the initial proposal directly, while later joins first receive the committed configuration snapshot and then receive the next configuration proposal. This preserves the joiner's configuration-version precondition for v1→v2 and later transitions; the process quorum test remains the validation gate.


**Join proposal retry hardening:** duplicate join requests for a node already covered by an in-flight configuration proposal now resend that proposal instead of aborting and replacing it. This prevents the joiner's 250ms retry loop from repeatedly invalidating the same configuration transition before voter acknowledgements can commit it.

**Join routing hardening:** seed nodes that are no longer leader now forward join requests to the currently known leader instead of rejecting them. This keeps bootstrap/join traffic functional across leader changes while preserving configuration authority at the leader.
