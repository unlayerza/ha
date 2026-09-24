# Unlayer HA Roadmap

Phases are ordered implementation contracts. This roadmap is updated as implementation and validation evidence changes.

**Last verified:** 2026-09-24

- [x] 00 Project foundation
- [x] 01 Node identity — core identity implemented; region/zone and software/protocol metadata remain
- [x] 02 Membership — core membership and convergence validated; committed configuration transitions implemented; concurrent churn remains
- [x] 03 Health and readiness
- [x] 04 Terms and authority
- [x] 05 Election — multi-process chaos validated; elections now bind to committed configuration versions and voter sets
- [ ] 06 Quorum — primitives implemented; committed voter-set semantics remain
- [x] 07 Fencing — core fencing implemented; adversarial committed-configuration tests remain
- [x] 08 Lifecycle and drain
- [x] 09 Local cluster harness — 21-node/22-process campaign validated
- [ ] 10 Recovery and rejoin — primitives exist; committed configuration and stronger recovery semantics remain
- [x] 11 Security and audit — core transport security implemented; authorization hardening remains
- [x] 12 Observability — core events/metrics/diagnostics implemented
- [x] 13 Service adapter contract
- [ ] 14 Database integration — contract exists; external consumer integration not yet proven
- [ ] 15 Identity integration — contract exists; external consumer integration not yet proven
- [ ] 16 Voice integration — contract exists; external consumer integration not yet proven
- [ ] 17 Chaos and soak — campaign infrastructure validated; 1h/24h/72h target-environment evidence remains
- [ ] 18 Production readiness — not yet complete

**Current next sprint:** committed membership/configuration and its integration with quorum/election/fencing.