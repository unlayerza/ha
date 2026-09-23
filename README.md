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
