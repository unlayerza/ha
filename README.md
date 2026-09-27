# Unlayer HA

Generic high-availability and cluster-coordination substrate for Unlayer services.

HA owns node identity, membership, health/readiness, terms, election, quorum, fencing, lifecycle, recovery, deterministic chaos, security and observability. It deliberately does not own SQL, SIP, users, calls, billing or application data.

Quick start:

    export HA_SERVICE=database
    export HA_CLUSTER=production
    export HA_ADDRESS=127.0.0.1:7301
    export HA_SECRET='change-me'
    bun run src/server.ts

For a three-node local process cluster, use LocalProcessCluster or the soak runner and provide all peer addresses through HA_PEERS/HA_SEEDS.

Run tests with bun test.

See HA.md for the architecture contract and IMPLEMENTATION.md for phase-by-phase implementation status.


### Adversarial soak profiles

The deterministic soak runner supports accelerated fault-exposure profiles. These are deliberately **not** claims that 30 minutes is equivalent to 12 hours of wall-clock reliability; they increase fault density and simultaneous fault exposure so protocol failures surface faster.

    HA_SOAK_PROFILE=12h CHAOS_SEED=12345 HA_SOAK_NODES=16 bun run src/soak.ts
    HA_SOAK_PROFILE=24h CHAOS_SEED=12345 HA_SOAK_NODES=16 bun run src/soak.ts
    HA_SOAK_PROFILE=72h CHAOS_SEED=12345 HA_SOAK_NODES=16 bun run src/soak.ts

The built-in profiles run for approximately 30 minutes, 1 hour and 2 hours respectively, with progressively larger fault bursts. A more aggressive 30-minute flood profile is also available:

    HA_SOAK_PROFILE=flood CHAOS_SEED=12345 HA_SOAK_NODES=16 bun run src/soak.ts

Every campaign remains seed-deterministic. When a seed produces an invariant failure, rerun the same command to reproduce the action sequence. Use `HA_SOAK_COMPACT=1` for machine-readable JSON output.

For custom campaigns, `HA_SOAK_HOURS` and `HA_SOAK_MS` still override the profile duration, while `HA_SOAK_FAULT_BURST`, `HA_SOAK_NETWORK_DWELL_MS` and `HA_SOAK_RECOVERY_DWELL_MS` control fault density and recovery pacing.
