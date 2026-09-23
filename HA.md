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

## 20. Development Order

1. Foundation
2. Node identity
3. Membership
4. Health/readiness
5. Terms
6. Election
7. Quorum
8. Fencing
9. Lifecycle/drain
10. Local multi-process harness
11. Failure injection
12. Recovery/rejoin
13. Security/audit
14. Observability
15. Service adapter contract
16. Database integration
17. Identity integration
18. Voice integration
19. Long-running chaos/soak
20. Production hardening

## 21. Definition of Done

HA is ready for service consumption when:
- a 3-node cluster can elect authority;
- leader loss is detected;
- a replacement leader can be elected;
- stale nodes are fenced;
- partitions do not create dual authority;
- nodes can drain and rejoin;
- deterministic chaos repeatedly passes;
- a fake non-database service can consume HA;
- Database can consume it without embedding HA internals;
- Identity and Voice can consume the same core contracts.
