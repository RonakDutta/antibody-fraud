# Decision flow

1. Validate and canonicalize the event. Identical event IDs and bodies replay the stored case. A changed body at the same ID returns HTTP 409.
2. Extract risk features from preceding events, including a recent-login location, rolling activity windows and behaviour baselines. Persist a point-in-time snapshot.
3. Apply the provisional scoring rules below. Actions mean simulated permission, a simulated verification requirement, or a simulated block. Failed logins are observations. Their `ALLOW` action means the lab accepted the record while the authentication attempt remains failed.
4. With the default cutoffs, a score below 25 allows a decision-capable event. A score of at least 72 blocks only if a hard predicate is met. Other scores of at least 25 require verification. The hard predicates are failed-login pressure with impossible travel and an unfamiliar device, or a high-amount burst to a fresh payee.
5. Ambiguous cases can run the behaviour and login specialist in `agents` or `meko` mode when they have relevant active evidence. Meko mode first requests up to three memory matches for controlled topics derived from the active rules. Agent responses must cite evidence IDs in their own scope. An invalid structured response can be retried once. Timeout, missing configuration, failed retrieval, or a missing specialist preserve step-up. A model recommendation cannot change the Phase 2 slice's policy decision. Confidence is a model-reported estimate without a calibrated probability interpretation.

| Rule | Evidence | Points |
| --- | --- | ---: |
| Login pressure | Three or more failures in the preceding 15 minutes | 20 |
| Recent reset | A reset in the preceding 30 minutes before a transfer | 12 |
| New device | Up to 30 days of account history with no non-failed activity on this device | 14 |
| New payee | No transfer to this payee in the preceding 30 days | 10 |
| Fresh payee | New payee added within the preceding 15 minutes | 14 |
| Amount spike | At least 25,000 minor units and 3× the mean of at least three historical transfers | 20 |
| Transfer burst | Three or more preceding transfers in 10 minutes | 18 |
| Impossible travel | At least 500 km and 1,000 km/h implied by the prior login | 26 |
| Timing change | At least two timing dimensions at or above 3 normalized deviations each | 18 |
| Shared device or network | At least two other accounts in 24 hours | 8 device, 4 network |

The behaviour profile uses up to 50 earlier login samples in a 30-day window and requires at least three. It uses sample standard deviation with minimum denominators of 15 ms dwell, 25 ms flight and 100 ms interaction. The amount and behaviour baselines exclude the most recent hour, reducing the influence of the current activity burst. Available history provides an estimate and can still include older unverified activity. Shared identifiers and behaviour changes alone cannot justify blocking.

Configure `RISK_CHALLENGE_THRESHOLD` and `RISK_BLOCK_THRESHOLD` in `.env`. These are hand-set demonstration parameters. Calibrate on separate validation scenarios and report false positives, alert timing and subgroups before drawing quality conclusions.

Each decision records risk features, evidence IDs, provenance, threshold and hard-block checks, path, timings, context metadata, any agent result and provider token counts, verdict, and rationale. Provider counts can be null. `modelCalls` counts attempted provider calls for the recorded investigation. Application durations measure work in the finalizing attempt, and exclude idle time after a crashed lease. The trace snapshot persists independently of Meko.

## Extended early policy

Explicit synthetic sessions support two narrow pre-impact cues under the existing 25/72 cutoffs. An unfamiliar-device reset adds 12 points only after account failure pressure and at least two earlier failures on that device. A payee registration adds 12 points only with independent timing deviation and a prior reset or at least two recent transfers. The legacy benchmark uses the original rules. A failed login remains a recorded observation, even when its score is high. Device network reputation is calculated from synthetic activity in PostgreSQL and represents no external IP feed. Shared infrastructure or a change in country alone is insufficient to infer fraud.

The temporal evaluator separates a step-up request from its outcome. Only a scripted failed challenge on the matching session holds a later attempted impact. Passing a challenge can still allow harm in the simulator. The sign-in API exposes the requested action and trace; enforcement and impact are modeled in the evaluator.
