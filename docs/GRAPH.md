# PostgreSQL graph evidence

The graph projects existing synthetic events into account and identifier nodes. Identifier types cover devices, networks, payees, and sessions. An account hop traverses an identifier shared by two accounts. Each of the two edges has a stable ID based on its event UUID and relationship type. Edges record the event kind and occurrence time. The full snapshot is suitable for case traces. The Graph specialist receives the bounded witness paths that support the eligible evidence IDs, with hop types and timestamps. The compact output requires one or two valid citations, a short rationale and an advisory action. Graph findings have zero policy points.

## Bounded query

`src/graph.ts` uses a recursive CTE. It starts from identifiers on the incoming event. Intermediate accounts expand from up to eight of their most recent events in a 24-hour window. At most eight typed identifiers are considered at an expansion. Each identifier lookup samples the newest 16 matching events. After deduplicating a related account per identifier, candidates are chosen in rounds by relationship type so a busy device cannot displace every payee or session link.

The traversal follows at most four branches per expansion and two account hops, which gives a maximum of 20 returned paths. It checks both the account list and the typed identifier list before expanding a path. This prevents it from revisiting either type of node on that path. The snapshot's direct-account counts describe accounts represented in the returned one-hop paths.

An account's corroborating authentication count samples up to 64 events within ten minutes before the cutoff. A path can attach the most recent explicitly confirmed fraud case among up to 64 recent events for the terminal account over 30 days. The attached case reports both its event and feedback timestamps. A confirmed case is a historical label. It does not transfer the old case's verdict or establish that a memory still applies.

The query reuses existing account, device, and network history indexes. Migration `005_graph_indexes.sql` adds indexes for payee-time and the session identifier in the stored event payload. Because legacy events can have no session ID, the session index is partial and those rows still contribute their other identifiers. No replicated graph tables are required.

## Clocks and evidence thresholds

The current incoming event is an explicit starting point. Its historical neighbours must have occurred strictly before the earlier of the incoming event time and database statement time. They must also have been received by that statement time. Historical case decisions and analyst confirmations must have been recorded by the same database statement time. The graph query sees the rows visible to PostgreSQL for that statement. The snapshot records the observed time for audit.

- A shared device or session plus at least two recent failed logins or resets by a different linked account can yield `graph_coordinated_authentication`.
- A common payee requires independent device or session overlap with a linked account that also has recent authentication risk before producing `graph_coordinated_payment`.
- `graph_confirmed_connection` requires corroboration. A one-hop path requires device or session overlap and recent authentication risk. A two-hop path must use two different non-network relationship types, including a device or session.

Household devices, office networks and popular recipients remain visible in graph paths. Sharing any one identifier alone yields no graph assessment evidence. Current rules retain final authority for allowing, challenging or blocking an event. The graph reports bounded associations that are suitable for review and provisional observations. It does not identify real devices or networks.

## Verification and limitations

Five integration tests ran against PostgreSQL 18 in local Docker Compose. They cover typed device, session and payee edges, a two-hop path to an analyst-confirmed case, coordinated authentication and payment, legitimate shared infrastructure, cutoff rules, cycle prevention, and fan-out limits. Across a synthetic fixture with approximately 2,000 unrelated events and a densely linked group, the median wall time from seven warm requests was 12.75 ms on the local host. This includes the local PostgreSQL round trip for the graph query. Timing depends on the machine and concurrent load.

```bash
npm run test:postgres -- --reporter=verbose --disableConsoleIntercept test/graph.postgres.ts
```

The caps trade coverage for bounded work. The graph can miss a less recent shared account behind a hot identifier or a confirmed case outside the sampled history. It detects local coordination candidates within the returned neighbourhood. A global clustering pass and an operational performance or concurrency study would need separate evaluation.
