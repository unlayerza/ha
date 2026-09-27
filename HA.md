# Unlayer HA — Architecture, Engineering Contract & Roadmap

> Generic high-availability and cluster-coordination substrate for Unlayer services.

## 1. Mission

Unlayer HA provides reusable primitives for services that need coordinated distributed operation without knowing anything about the service's domain.

HA owns:
- node identity
- membership
- health and readiness
- terms/epochs
- leader election
- quorum
- fencing
- lifecycle/draining
- failover coordination
- recovery
- deterministic chaos hooks
- cluster observability

HA does not own:
- SQL
- SIP
- users
- calls
- application data
- service-specific replication semantics
- billing
- routing policy

## 2. Core Rule

HA provides **coordination**, not a mandatory topology.

A service may be:
- active-active
- leader/follower
- leader-for-control-plane + active-active data plane
- single-writer with multiple readers
- externally coordinated

HA must not force every service into leader/follower.

## 3. Layering

```
                    Unlayer Services
          ┌────────────┬────────────┬────────────┐
          ▼            ▼            ▼            ▼
       Database     Identity      Voice       Future
          │            │            │
          └────────────┴────────────┘
                       │
                       ▼
                 Unlayer HA
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     Membership     Election       Fencing
```

HA is below service semantics and above transport/process primitives.

## 4. Node Identity

Every node has a durable identity:
- node ID
- service ID
- cluster ID
- instance ID
- address/endpoints
- region/zone metadata
- software version
- protocol version
- creation time
- credential/key reference

Node IDs must not be reused casually.

## 5. Membership

Membership states:

```
joining
healthy
degraded
draining
unhealthy
suspect
failed
removed
quarantined
```

Membership changes must be observable and versioned.

A node cannot become authoritative merely by declaring itself healthy.

## 6. Health

Separate:
- liveness: process is alive
- readiness: process can serve
- authority: process is permitted to perform authoritative operations

A live but fenced node is not authoritative.

## 7. Terms and Epochs

Leadership and authoritative membership changes use monotonically increasing terms.

Example:

```
term 41 -> node A leader
term 42 -> node B leader
```

A node operating with an old term must reject authoritative work.

Terms must be persisted or otherwise recoverable so restart cannot silently reuse an old authority epoch.

## 8. Election

The election layer must guarantee that an accepted leader has the required quorum/authority for the configured cluster.

Requirements:
- no last-heartbeat-wins election
- explicit term
- quorum awareness
- election timeout
- candidate/voter state
- leader lease or equivalent authority mechanism
- stale-leader rejection
- deterministic testability

The exact consensus protocol is an implementation decision and must be validated with failure-injection tests before production use.

**Current implementation note:** leader election, quorum and authority now use the persisted committed configuration as the voter-set source of truth. Membership remains a discovery/health mechanism; it does not grant voting or authoritative status. Initial cluster bootstrap is explicit (HA_BOOTSTRAP=true), creates a one-voter configuration, and subsequent joins expand that configuration through the normal proposal/acknowledgement/quorum/commit path.

## 9. Quorum

HA supports configurable quorum policies.

For N members:
- membership quorum
- election quorum
- write quorum
- service-specific quorum

These are not necessarily identical.

HA should expose quorum state without deciding what a service considers durable.

## 10. Fencing

Fencing prevents a stale node from continuing authoritative work after leadership changes.

Possible mechanisms:
- term validation on authoritative requests
- lease expiration
- control-plane fencing token
- storage-generation token
- connection/session invalidation

The minimum invariant is:

> A node that loses authority must be unable to commit new authoritative state.

## 11. Lifecycle

A node lifecycle should support:

```
provision
join
sync
ready
active
drain
leave
recover
rejoin
retire
quarantine
```

Drain must stop new work before terminating existing work where the service permits it.

## 12. Generic Service Contract

Conceptual interfaces:

```ts
interface HANode {
  id: string
  service: string
  address: string
  region?: string
  zone?: string
}

interface HAState {
  term: bigint
  leaderId: string | null
  quorum: boolean
}

interface HAService {
  start(): Promise<void>
  stop(): Promise<void>
  state(): Promise<HAState>
  drain(): Promise<void>
}

interface Authority {
  term: bigint
  nodeId: string
  fencingToken: string
}
```

Exact interfaces are expected to evolve through tests.

## 13. Service Adapter Boundary

A service adapter translates HA decisions into domain actions.

Database:
```
HA -> database leader/follower + replication
```

Identity:
```
HA -> API node coordination + authoritative mutations
```

Voice:
```
HA -> routing/config ownership, registration coordination and selected control operations
```

HA must never import those domains.

## 14. Failure Model

Expected:
- process crash
- host reboot
- node loss
- delayed messages
- dropped messages
- duplicate messages
- reordered messages
- network partition
- slow node
- clock skew within bounded assumptions
- stale node
- rolling deployment

Later:
- regional loss
- storage failure
- control-plane outage
- mass restart

## 15. Local Cluster Harness

The repository must provide a real multi-process test harness.

Default example:

```
ha-a -> 127.0.0.1:7301
ha-b -> 127.0.0.1:7302
ha-c -> 127.0.0.1:7303
```

The harness must support:
- start
- stop
- hard kill
- restart
- delay
- drop
- duplicate
- reorder
- partition
- heal
- inspect state
- deterministic cleanup

The harness should be reusable by Database, Identity and Voice integration tests.

## 16. Chaos

Chaos is deterministic:

```
CHAOS_SEED=12345
```

Every campaign records:
- seed
- topology
- node IDs
- injected faults
- terms
- leader changes
- quorum changes
- final state
- invariant failures

## 17. Correctness Invariants

1. At most one authoritative leader exists for a term.
2. Terms never decrease.
3. A stale node cannot perform authoritative work.
4. Quorum loss is observable.
5. A fenced node cannot silently regain authority.
6. Membership transitions are deterministic and auditable.
7. Restart does not resurrect obsolete authority.
8. Recovery eventually converges when communication and quorum are restored.
9. Service-specific state remains outside HA.
10. HA behavior is testable without a particular application domain.

## 18. Security

Required:
- authenticated node identity
- authenticated cluster traffic
- authorization of membership changes
- credential/key rotation
- replay protection
- fencing-token protection
- secret redaction
- audit events for privileged cluster operations

Compromise of one node must not automatically imply unrestricted cluster administration.

## 19. Observability

Events:
- node_joined
- node_ready
- node_draining
- node_failed
- node_quarantined
- leader_elected
- leader_lost
- term_changed
- quorum_reached
- quorum_lost
- fence_issued
- fence_rejected
- recovery_started
- recovery_completed

Metrics:
- membership size
- healthy nodes
- quorum state
- current term
- leader changes
- election duration
- heartbeat latency
- stale-node rejections
- recovery duration

## 21. Current Verified State

As of 2026-09-27:

- Committed cluster configuration is persisted and is the source of truth for voters and election eligibility.
- Initial bootstrap is explicit: the first node must set HA_BOOTSTRAP=true; non-bootstrap nodes must provide HA_SEEDS.
- The audited one-voter bootstrap path is now the primary production path. The previous implicit no-seeds-means-bootstrap behavior has been removed.
- Configuration proposals require an authorized proposer, preserve quorum intersection, require current-voter acknowledgement quorum, and persist committed versions.
- Nodes reject stale, skipped, conflicting or unauthorized configuration changes.
- Leader authority is separately fenced and lease-bound; transient authority loss can be recovered without retaining stale authority.
- Cluster traffic is authenticated with HMAC-SHA256 and replay-protected.
- The multi-process harness exercises joins, kills, restarts, partitions, delay, drop, duplicate, reorder and healing deterministically.
- Recent deterministic campaigns maintained the core safety invariants through leader succession and churn. Resource-saturated runs on the development host produced liveness/reachability degradation without split-brain or configuration/term safety violations.
- JSON state persistence now uses serialized writes and atomic temporary-file replacement so a process crash cannot leave a partially written target file.

This establishes HA as the production coordination foundation for the next Unlayer service integrations. It does not claim that every future operational concern—such as PKI/key rotation, regional failure, distributed storage durability or target-environment long-duration evidence—is complete.

## 22. Production Gate

The remaining HA work is deliberately bounded:

1. **Service consumer validation** — exercise the generic HA contract from Edge first, then Database, Identity and Voice.
2. **Operational soak** — run long campaigns on appropriately provisioned target infrastructure rather than interpreting host-saturated development runs as protocol failures.
3. **Credential evolution** — introduce stronger node credentials/PKI and rotation when the platform needs them.
4. **Future failure domains** — regional loss, storage outages and multi-site recovery are later platform milestones.

These are service/platform evolution items rather than reasons to keep the current HA implementation in an experimental bootstrap state.

## 23. Bootstrap Contract

### First node

Set:

    HA_BOOTSTRAP=true
    HA_SECRET=<cluster secret>
    HA_ADDRESS=<listen address>

The first node starts as the sole committed voter. It can elect itself, issue authority, and admit subsequent nodes through configuration changes.

### Joining node

Set:

    HA_BOOTSTRAP=false
    HA_SEEDS=<address of an existing cluster node>
    HA_SECRET=<cluster secret>
    HA_ADDRESS=<listen address>

The joining node cannot self-bootstrap merely because no seed was supplied. It must obtain a committed configuration from an existing cluster authority.

### Configuration source of truth

membership answers: which nodes are visible and healthy?

committed configuration answers: which nodes are voters?

Only committed voters can participate in election/quorum and configuration authority.

## 24. Definition of Done

HA is ready for service consumption when:

- a 3-node cluster can elect authority;
- leader loss is detected;
- a replacement leader can be elected;
- stale nodes are fenced;
- partitions do not create dual authority;
- nodes can drain and rejoin;
- deterministic chaos repeatedly passes;
- membership/configuration changes are quorum committed;
- elections use a stable committed voter set;
- committed configuration survives restart and rejects obsolete configurations;
- initial bootstrap is explicit and follows the same committed-configuration model used for subsequent membership changes;
- state persistence uses atomic replacement and serialized writes;
- a fake non-database service can consume HA;
- Edge can consume HA without embedding election internals;
- Database can consume it without embedding HA internals;
- Identity and Voice can consume the same core contracts.
