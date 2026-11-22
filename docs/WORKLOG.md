# Work log

A running record of what was changed, why, and what is still open. Add a new dated entry at the top for each work session. Keep earlier entries as they were written; update only the [open items](#open-items) table.

## Open items

| Item | Status | Where |
| --- | --- | --- |
| Rerun the memory comparison against hosted Meko (`--memory-store meko`) | Open | [Benchmarks](BENCHMARKS.md#memory-that-changes-the-decision) |
| Rerun with live agents (Ollama or Groq) in `agents` and `meko` modes | Open | `npm run evaluate:early -- --mode all --memory compare` |
| Attack variants that reorder or skip steps, and more legitimate look-alikes | Open | `src/early-scenarios.ts` |
| Learning through the API needs Meko keys. Without them the feedback route is not mounted | Open | `src/wiring.ts`, `src/app.ts` |
| Fraud playbooks in a Meko knowledge base, retrieved and shown in traces | Open | [Hackathon strategy](HACKATHON_STRATEGY.md) |
| React analyst workspace (stream, case timeline, graph, memory history, feedback) | Open | [Roadmap](ROADMAP.md) Phase 4 |
| Demo recording under five minutes with at least three trace walkthroughs | Open | Deadline 17 January 2027, 11:59 p.m. Pacific |
| Memory cannot change a decision | Fixed 22 Nov 2026 | Entry below |
| Only one hard-coded fingerprint can be learned | Fixed 22 Nov 2026 | Entry below |
| No warmed-memory comparison on the 2,000-event stream | Fixed 22 Nov 2026, local store | Entry below |
| Stale design, decision-flow and README text | Fixed 22 Nov 2026 | Entry below |

## 22 November 2026 — audit, then memory that changes decisions

Commit `4eeb8dc`, on `claude/gallant-pascal-c86pge` and fast-forwarded into `main`.

### Audit

Checks run on the existing code:

- `npm run typecheck`, `npm run build` and `npm test` (23 unit tests) passed.
- `npm run test:postgres` passed 29 tests on PostgreSQL 16. CI uses 18.4.
- The seed-22 replay reproduced the documented 94 events, with 6 true positives, 0 false positives and 11 false negatives.
- The 1,999-event `evaluate:early` run reproduced the documented legacy and extended results.

Findings:

| Finding | Detail |
| --- | --- |
| Memory never changed an action | Agents ran only on events the rules had already stepped up. `src/cases.ts` always applied the rules' action. Verified reuse only skipped the Behaviour/Login agent. That is the whole source of the token saving. |
| Prevention was capped by the challenge | All 58 attacks were alerted before impact, but the 15 that executed passed the step-up challenge. Only a block stops them, and the stream had 0 blocks. |
| One learnable pattern | Feedback accepted only `behaviour_shift + fresh_payee + amount_spike` on a transfer. The only possible correction was `recent_reset`. |
| No warmed comparison on the stream | `evaluate:early` disabled publishing and started with no learned patterns. |
| Demo Case B used an exact-ID read, not ranked search | Retrieval in the demo is scoped through the local registry. Present this accurately. |
| Extended rules raise false positives | Legitimate-burst false-positive rate rose from 11% to 29% (legacy to extended) with no extra attacks prevented. |
| Out-of-date external summary | It said not all five agents existed (they do). It placed the demo failure in correction publication (it was the post-D observation drain). It called false-positive and lead measurement pending (both existed). |
| Stale docs and leftovers | `DESIGN_DECISIONS.md` and step 5 of `DECISION_FLOW.md` predated writes, the graph agent and the team. The README had a stray `# antibody-fraud` line and a personal Windows path. Migration 004 is absent. That is harmless and now documented. |

### What changed

**Verified-pattern policy** (`src/memory-policy.ts`, `src/risk.ts`, `src/cases.ts`, `src/config.ts`, `src/server.ts`)
- A new `MEMORY_POLICY` setting: `off` (default), `shadow` or `enforce`.
- **What blocks:** a session on another account blocks when it repeats at least two ordered opening steps of an active analyst-confirmed pattern. A step is the event kind plus the rule IDs that fired on it. The repeated steps must carry at least 40 rule points, and the pattern must have been read back from Meko before the case started.
- **Safeguards:** no model is involved, and provisional observations never qualify. Patterns expire after 30 days and never match their origin account. A failed login stays an observation.
- **Trace:** adds `verified_pattern_match` evidence (provenance `verified_memory`) and a `memoryPolicy` block with the publication, origin case, matched steps and points, candidates, session rules and whether the action changed.

**Learning** (`src/learning.ts`, `migrations/007_feedback_publication.sql`)
- Any confirmed case with at least two informative session steps and 40 rule points becomes a `session_sequence` pattern, attributed to `contextcon-investigator`.
- The specialist-verified transfer signature keeps its agent-reuse meaning and also carries steps.
- A repeat confirmation of identical steps corroborates the existing pattern. It is serialized by an advisory lock, and `analyst_feedback.publication_id` records the link.
- Corrections accept any rule the attack had and the customer lacked. They supersede the old version, and v2 adds the rule to `conditions`.
- Session patterns are ignored by the agent-skip path.

**Evaluation** (`src/scripts/evaluate-early.ts`, `src/early-scenarios.ts`, `src/integrations/local-memory.ts`)
- `--memory off|shadow|enforce|compare` adds an online simulated analyst. It confirms each attack 30 simulated minutes after impact and corrects a pattern once if it changes a legitimate action.
- Reports split attacks into first and repeat encounters and add memory telemetry.
- `--hard-negatives` adds the `legitimate-recovery` scenario. It is opt-in, so the default tape is unchanged.
- `--memory-store local|meko`. The local store is an in-process stand-in with the same read-back contract.
- `EVAL_DEBUG=1` prints the underlying error.

**Tests**
- `test/memory-policy.test.ts`: matching, compaction, minimum weight and scoring.
- `test/memory-policy.postgres.ts`:
  - an unpublished pattern is unusable
  - shadow records without enforcing, and enforce blocks with a trace
  - identical confirmations corroborate one pattern
  - correction relieves the customer and still blocks the attack at the transfer
  - revocation disables the pattern, and the origin account never matches
- Hard-negative and encounter tests in `test/early-scenarios.test.ts`.
- Totals: 33 unit and 33 PostgreSQL tests pass.

**Docs:** [Decision flow](DECISION_FLOW.md#verified-pattern-policy), [Benchmarks](BENCHMARKS.md#memory-that-changes-the-decision), [Design decisions](DESIGN_DECISIONS.md), [Data model](DATA_MODEL.md), [Architecture](ARCHITECTURE.md), [Testing](TESTING.md), [Roadmap](ROADMAP.md), [Hackathon strategy](HACKATHON_STRATEGY.md), README and `.env.example`.

### Results

Rules mode on the 1,999-event tape, seed 7403, with the local stand-in store.

| | Memory off | Memory on |
| --- | ---: | ---: |
| Attacks executed | 15 / 58 | 1 / 58 |
| Repeat attacks executed | — | 0 / 54 |
| Executed transfer harm (minor units) | 1,043,800 | 0 |
| Legitimate alert rate | 6.41% | 6.41% |
| Per-event latency p95 | 3.1 ms | 5.9 ms |

With `--hard-negatives` across seeds 7403, 1, 2027 and 90210, the development split and the legacy profile:
- Repeat attacks executed 0 of 48 in every run.
- In each run, one legitimate recovering customer was blocked twice, at the reset and the payee step, before the analyst's correction. No customer was blocked afterwards.

Data: `benchmarks/memory-policy-7403.json`, `benchmarks/memory-policy-hard-negatives-7403.json` and `benchmarks/memory-policy-sweep.json`.

**Limits:**
- Repeats come from one synthetic template per attack type, so recognising them is easy.
- The store was the local stand-in, not hosted Meko.
- The analyst is perfect and prompt.
- Agent modes were not run because no model provider was configured.

### Reproduce

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:postgres
```

```bash
npm run evaluate:early -- --events 1999 --memory compare
```

```bash
npm run evaluate:early -- --events 1999 --memory compare --hard-negatives
```
