# Benchmark evidence

## Phase 1 rules smoke replay

Ran all six synthetic scenarios with seed 22, default thresholds, the compiled API and a fresh Docker Compose PostgreSQL 18.4 database. A positive alert is a step-up or block. Failed login observations and preparatory attack events remain in the event-level denominator. See [observed rows and counts](../benchmarks/rules-seed22.json).

| Observed metric | Value |
| --- | ---: |
| Events | 94 |
| Labelled attack events | 17 |
| Allows / step-ups / blocks | 88 / 5 / 1 |
| True positives / false positives / false negatives / true negatives | 6 / 0 / 11 / 77 |
| Alert precision / recall / F1 | 100% / 35.3% / 52.2% |
| False-positive / false-negative rate | 0 / 64.7% |
| Step-up rate | 5.3% |
| No-model rate | 100% |
| Attack scenarios flagged before impact | 2 of 4 |

The first takeover alert led the transfer by three steps. The first shared-identifiers alert led its transfer by one step. Credential-stuffing and velocity first flagged on their planted impact step. The simulator streams all events for evaluation, including events after a simulated intervention. These counts come from one development seed with clean history. They do not establish general detection rates or improvement from Meko.

To reproduce on a fresh local database in `rules` mode, run `npm run --silent simulate -- --seed 22 --json` and save the output. Replaying an already-used seed deliberately reads stored traces.

## Early alert gaps

- Credential stuffing showed three failed-login steps before the impact login. Those rows were saved as observations even when their risk score was 40. The rules made the enforcement decision on the attempted successful login. A distinct early warning for a burst of failed authentication, evaluated on separate legitimate retry and shared-network cases, could surface this signal sooner.
- Velocity used several normal transfers before the large transfer to the new payee. Each of the first four steps scored zero. The final transfer supplied the qualifying volume and payee/amount evidence together. A sequence review over recent behaviour and intent signals could help earlier only when those signals already exist. Evaluate any added warning against independent legitimate bursts and establish its false-positive rate before changing the policy.

No baseline thresholds changed for the collective-learning experiments.

## Trace walkthroughs available now

| Example from the smoke replay | Case UUID | Inspect |
| --- | --- | --- |
| Ordinary established transfer | `8d65123d-ee24-8cd2-9235-673d28169088` | Fast path, zero external calls, low score. |
| Early simulated takeover | `ade88dde-d0a1-8380-bac8-ef13490b2d13` | New device plus all three behavioural timing dimensions shifted. Step-up. |
| Credential pressure and impossible travel | `3e4920bb-cecb-84c2-a718-b03778e9297e` | Three earlier failed logins plus distance, speed, timing and device evidence. Fast block. |

## Local model probes

Two takeover logins in agent mode exercised the live Ollama adapter. Seed 26 returned a valid cited assessment in about 19.2 seconds with 232 input and 118 output tokens. Seed 25 required fallback after two invalid assessments. Both cases preserved step-up. Different seeds, a small local model and two cases provide smoke evidence only. [Observed provider data](../benchmarks/ollama-probes.json)

## Comparative evaluation after memory reuse

Use identical seeds and separate fresh PostgreSQL schemas or databases for rules-only, specialists without memory, and specialists with Meko. Keep the same model, settings and call budgets across the two specialist modes. Build verified memory from designated earlier cases. Measure novel and recurring held-out attack variants separately, and include legitimate activity with shared devices, travel and timing drift. Compare detection quality with matched behaviour-on and behaviour-off runs.

Record precision, recall, F1, false positives and negatives, step-up rate, pre-impact lead, no-model rate, reuse and fallback rates, provider-reported input/output counts, calls and wall-clock p50/p95. Separate retrieval latency and capture correction outcomes with the case and memory version IDs needed to reproduce them.

## First live collective-learning run

Seed 661022 used the same Ollama qwen2.5:3b model and identical Case B transfer in isolated PostgreSQL schemas. The Meko run retrieved the exact confirmed publication from a fresh process. The two runs used the same policy. The baseline bypassed Meko. Context lookup, model retries and latency were captured from the actual run.

| Case B mode | Provider attempts | Input tokens | Output tokens | Case wall time | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| Specialists without shared memory | 4 | 1782 | 665 | 93.98 s | STEP_UP_VERIFICATION |
| Live Meko retrieval and applicability checks | 3 | 1331 | 518 | 91.74 s | STEP_UP_VERIFICATION |

Both comparisons also show rejected Investigator responses from the first response schema. These are single local runs and do not establish a general speed or accuracy improvement. C demonstrated an overly broad match. After an analyst required a distinguishing reset signal, D rejected both the superseded version and the inapplicable replacement. The deterministic policy still required step-up for that legitimate challenge. [Initial live run](../benchmarks/collective-initial-661022.json)

## Live two-datapack rerun with the narrowed Investigator schema

Seed 661072 used distinct synthetic account histories and session IDs for A, B, C and D. The identical Case B transfer and session also ran without Meko. Both runs used the same qwen2.5:3b model and policy. Case B with Meko ran in a fresh process. The Investigator returned a valid response for each measured case.

| Case B mode | Provider attempts | Input tokens | Output tokens | Case wall time | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| Without shared memory | 3 | 1173 | 351 | 53.55 s | STEP_UP_VERIFICATION |
| With real Meko retrieval | 2 | 706 | 229 | 46.10 s | STEP_UP_VERIFICATION |

The worker verified six observations in the risk pack and two fingerprint versions in the confirmed pack after indexing. The originating Behaviour/Login specialist and retrieving Transaction specialist appear in B's trace. C reused version 1. After correction D rejected v1 as superseded and v2 because its reset condition was absent. D was still challenged by unchanged rules. These measurements compare work and evidence within this one synthetic pair. Broader detection quality and latency remain unmeasured. [Complete rerun](../benchmarks/collective-live-661072.json)


## Repeated-seed publication incident

Execution `contextcon_demo_661072_6793` had already settled A through D. The original fingerprint and the correction were published on attempt 2 each. The correction was verified at 09:08:06 UTC. The failed stage was the post-D risk observation drain. Four risk rows from B, C and D remained in `indexing` with acknowledged remote IDs, 6–8 attempts, and no recorded tool error. The old demo spent up to 100 seconds draining the shared queue while waiting for a particular D observation.

A read-only inspection retrieved all four documents by exact Meko ID. Their publication-marker queries each returned ten ranked hits and omitted the target. Four or five of the hits in each query came from the earlier successful run with the same seed. The previous worker treated a ranked miss as missing publication visibility. The incident and the read-only reproduction establish a ranking problem. They do not recover individual historical response timings.

The repair verified the four existing acknowledgements by exact ID. It preserved their remote IDs, the two existing fingerprint versions, and the settled decision traces. No additional memory write or deletion was needed for the failed run.

### What the correction changed

C was a legitimate synthetic transfer that reused v1. Feedback superseded v1 and made a recent password reset mandatory for v2. D had no recent reset. It rejected v1 as superseded and v2 as inapplicable. Its active rules still contributed 10 points for a new payee, 14 for recent payee registration, 20 for the amount spike and 18 for timing deviation. The sum of 62 exceeded the unchanged 25-point step-up threshold. D's legitimate false fingerprint attribution fell from one to zero in the C/D walkthrough. The full specialist review returned, so this change improved evidence accuracy without removing step-up or reducing review work. Establishing a safe allow outcome would require independently verified legitimacy evidence and evaluation on held-out cases.

### Live reproducibility check

The interrupted schema resumed with all eight publications verified. Two fresh runs used seed 661072, the same configured hosted Meko packs and local Ollama qwen2.5:3b. Each completed A through D with two fingerprints and six observations. Both fresh runs used one write followed by one exact-ID verification for every publication. The synthetic Case B ID matched across executions, while each execution retrieved its own original remote memory ID. Both versions were independently rejected by D for the expected reasons. The earlier benchmark records were preserved. [Observed verification, timings and model telemetry](../benchmarks/publication-reliability-661072.json)

## Independent Case A → B → C → D verification

The developer independently reran seed 661072 with hosted Meko and local `qwen2.5:3b`. All eight publications reached `published` through exact-ID verification. The following measurements are from that independent run.

| Case B mode | Provider attempts | Input tokens | Output tokens | Case wall time | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| Without shared memory | 3 | 1,173 | 351 | 49.132 s | STEP_UP_VERIFICATION |
| With hosted Meko | 2 | 706 | 229 | 45.465 s | STEP_UP_VERIFICATION |

The legitimate challenge went from one incorrect fingerprint attribution to zero after the analyst correction. The earlier recorded runs remain above. This milestone also resumed a previously settled schema through A, B, C and D with all eight publications intact. It reused the durable decisions and made no new model calls for those cases.

### Fresh milestone regression

A fresh run of seed 661072 completed in `contextcon_demo_661072_315b1a3accfd4830`. All six provisional observations and two confirmed fingerprints were verified by exact ID on the first read after the write. Case B used three calls, 1,173 input tokens and 351 output tokens without memory, versus two calls, 706 input tokens and 229 output tokens with hosted Meko. The measured times were 57.875 and 55.550 seconds and both decisions were step-up. The correction again reduced incorrect attribution from one to zero. This is an additional run with its own timings. [Fresh A/B/C/D trace](../benchmarks/collective-milestone-661072.json)

## Live provisional signal handoff

A Behaviour/Login review published a synthetic observation after a login with repeated authentication failures and timing deviation. A later Transaction review read the same canonical record by exact Meko ID in a different session. It cited the current payee transition, and the Investigator received both current evidence and the earlier observation. Both cases received step-up from their local rules. The payee decision preceded the scheduled transfer by 60 synthetic seconds. The smoke stopped before submitting impact. It demonstrates hosted evidence transfer and additional investigation context. It did not measure harm prevented or a change in enforcement.

The repeated smoke validated all seven role calls. Device/IP cited the unfamiliar device and its failed-logins history. Graph cited a shared-device path to a separate account with two recent authentication-risk events, recommended allow, and supplied that evidence to the Investigator. The independent rules still required step-up. Graph, Device/IP and Behaviour/Login each had a verified provisional publication from the earlier event. Transaction explicitly used the earlier Behaviour/Login observation alongside the current payee cue in its rationale.

The initial Graph output failed validation twice. The repeated run used a smaller response contract and projected witness paths into the model input. The earlier investigation took 77.762 wall-clock seconds and Meko verified the Behaviour/Login publication 16.135 seconds after that decision. The later investigation took 42.237 seconds. The harness waited for publication before sending the new event. Local PostgreSQL evidence is available sooner, and these measurements establish no wall-clock response guarantee. [Hosted handoff trace](../benchmarks/provisional-meko-38140.json)

The final smoke repeated that handoff in a fresh schema. All seven calls validated again. The source and receiving cases took 102.712 and 53.436 wall-clock seconds. Ollama reported 1,627 input and 439 output tokens for the source case, and 1,091 input and 319 output tokens for the receiving case. The smoke verified the source memory after one write and one exact-ID read. The second event consumed the memory and kept the local step-up decision. [Final smoke telemetry](../benchmarks/provisional-meko-milestone-38140.json)

## Live ordinary ranked Meko discovery

Seed 50271 sent five current transfer-evidence queries to the hosted confirmed-patterns datapack. No expected memory UUID was supplied. Two reset-based attack variants each selected the active v2 fingerprint. Three controls selected none, including a current reset and amount spike without the required timing behaviour. Checks rejected records outside the isolated confirmed registry, the superseded original, and a current condition mismatch. The searches exercised multiple input variants against one known fingerprint family and unrelated hosted results. Recall across independent fingerprint families and a library with many applicable near-duplicates remains open. [Ranked probe observations](../benchmarks/ranked-meko-50271.json)

A separate normal-ingestion probe used real PostgreSQL and Meko with model calls disabled to isolate retrieval. The Transaction-attributed ranked lookup returned the active v2 for the reset variant. The no-reset variant reused nothing. Both retained step-up. This verifies that the normal case route uses ranked discovery as well as the read-only evaluation command. [Normal intake observations](../benchmarks/ranked-meko-intake-50291.json)

## Held-out early detection and intervention

The matched seed-7403 comparison used 1,999 attempted synthetic events, 58 planted attack episodes and two fresh PostgreSQL schemas. Both rules-only profiles used the same 25-point challenge and 72-point block threshold. The extended profile considers a sensitive payee change with an explicit session identifier and corroborating timing and recent activity. It can also score a reset after nearby authentication failures in the same session. Ground truth and challenge outcomes are available only to the evaluator.

| Metric | Legacy rules | Extended rules |
| --- | ---: | ---: |
| Attack episodes alerted before impact | 43 / 58 | 58 / 58 |
| Attack episodes gated before impact | 33 / 58 | 43 / 58 |
| Attack episodes gated at impact | 10 / 58 | 0 / 58 |
| Total prevented modeled impact events | 43 / 58 | 43 / 58 |
| Attacks with modeled impact executed | 15 / 58 | 15 / 58 |
| Modeled financial impact prevented (synthetic minor units) | 2,219,000 | 2,219,000 |
| Alert precision | 92.7% | 86.2% |
| Alert recall | 39.0% | 48.8% |
| Alert F1 | 54.9% | 62.3% |
| Legitimate classified events stepped up | 9 / 359 (2.51%) | 23 / 359 (6.41%) |

The original credential-stuffing stream had failed-login observations followed directly by an attempted successful login. The new event tape inserts a reset before the access impact, so both profiles alert before impact in 15 of 15 credential-stuffing episodes. In the original velocity stream, earlier ordinary transfers supplied too little corroboration. On the new tape, the legacy profile first flagged all 15 velocity attacks at impact. The extended profile flagged all 15 earlier and moved ten modeled gates ahead of impact. The remaining five attacks passed the challenges under the simulator assumptions. No additional synthetic impact was prevented overall. All legitimate false alerts came from the legitimate-burst group. The household, office and travel controls had none. The median among episodes with a pre-impact alert was 420 seconds and two episode steps in the legacy profile, and 270 seconds and one step in the extended profile. All 43 previously detected episodes kept their lead. The 15 newly detected velocity episodes entered the denominator with a one-step lead. [Per-episode lead](../benchmarks/early-temporal-lead-7403.json) [Held-out measurement and classification definitions](../benchmarks/early-temporal-7403.json)

## Cold three-mode smoke on hosted Meko and Ollama

Three matched extended-profile replays used 17 attempted events from one credential-stuffing episode. Agents used the same local `qwen2.5:3b`. The Meko mode used ordinary hosted queries with a fresh local registry and new publications disabled. It made three ranked risk lookups returning 30 hits and reused none. The warmed ranked and earlier-publication paths are described separately above.

| Mode | Measured model calls | Input / output tokens | Replay wall time | Per-case p95 | Actionable alerts | Modeled impact prevented |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rules | 0 | 0 / 0 | 0.381 s | 0.022 s | 2 | 0 |
| Agents | 5 | 1,943 / 558 | 105.578 s | 69.619 s | 2 | 0 |
| Agents + hosted Meko | 5 | 1,941 / 558 | 107.825 s | 66.800 s | 2 | 0 |

The first alert led the attempted login by 240 simulated seconds in each mode. The two step-up challenges passed, so the modeled account-access impact executed. This single episode had no actionable legitimate controls and no warmed reuse. The report records actual provider token usage and describes local inference cost under those conditions. [Cold smoke telemetry](../benchmarks/early-live-smoke-7403.json)
