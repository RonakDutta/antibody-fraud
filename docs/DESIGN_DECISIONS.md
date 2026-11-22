# Design decisions

## Choose one local data store

PostgreSQL lets a case claim, event insertion, history read and fast decision share a transaction. A separate queue or graph store would add operational dependencies before either workload is measured. Current tests exercise real PostgreSQL, parallel duplicates and crash recovery fences. Multi-hop graph traversal is planned using bounded relational queries.

## Keep numerical scoring and action policy deterministic

A model can explain timing evidence, while SQL and TypeScript calculate evidence and enforce the simulated action. This protects the fast path and makes threshold failures reproducible. The trade-off is that the first specialist cannot yet improve decision quality. Tests cover allowable travel, suspicious activity, impossible travel, policy enforcement and missing dependencies.

## Treat read-only Meko retrieval as the first integration

Meko's REST surface manages datapacks and related resources. The documented hosted MCP `memory_search` provides ranked memory IDs and scores. The app records up to three IDs and scores and excludes retrieved prose from model inputs. Meaningful write-back and reuse need locally verified fingerprints, version checks and a retry-aware external-write protocol.

## Keep provider calls outside PostgreSQL transactions

The app persists a pending case and its feature snapshot before calling a provider. A lease and commit-time token check prevent stale investigators from updating a decided case. Identical event replay can recover a timed-out lease. This still permits the remote calls of an interrupted attempt to be repeated, which is acceptable for bounded read and inference calls. Before adding Meko writes, introduce a PostgreSQL outbox and reconciliation for ambiguous remote delivery.
