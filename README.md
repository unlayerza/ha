# Unlayer HA

Generic high-availability and cluster-coordination substrate for Unlayer services.

HA owns node identity, membership, health, terms, election, quorum, fencing, lifecycle, recovery and deterministic chaos primitives. It does not own SQL, SIP, identity or application data.

See [HA.md](HA.md) for the engineering contract and [todo/](todo/) for the implementation roadmap.

Consumers include Database, Identity and Voice.
