# ContextCon Fraud Lab

A local fraud detection workbench for synthetic activity. PostgreSQL builds a point-in-time feature snapshot for each event. An explainable policy produces a simulated allow, step-up or block decision. Cases above the challenge threshold can route to Behaviour/Login, Device/IP, Transaction and PostgreSQL Graph specialists with an advisory Investigator. Each decision includes a persisted trace.

The collective-learning workflow adds analyst confirmation and correction, two Meko datapacks, and an independent provisional publication worker. An acknowledged write becomes reusable only after the worker retrieves the expected document from Meko. The live A/B/C/D loop, cross-session provisional handoff, ranked discovery and temporal detection results are recorded in [Benchmarks](docs/BENCHMARKS.md).

## Run locally in Git Bash

Open Git Bash in VS Code in `C:\Users\sansk\Downloads\CONTEXTCON`. Start Docker Desktop. Use Node.js 22.22 or newer.

```bash
test -f .env || cp .env.example .env
npm ci
docker compose up -d --wait db
npm run db:migrate
npm run dev
```

From another terminal in the same folder:

```bash
curl -fsS http://127.0.0.1:3001/health
npm run simulate -- --seed 22
curl -fsS "http://127.0.0.1:3001/api/cases/$case_id"
```

Set `case_id` to a case UUID printed by the simulator before running the last command. Replaying the same seed returns the original decisions. Use a new seed after switching modes. For an apples-to-apples comparison, use the same seed across separate fresh databases.

### API

| Route | Result |
| --- | --- |
| `GET /health` | PostgreSQL and migration readiness |
| `POST /api/events` | `201` for a new decision, `200` for replay, `202` for a pending case, `409` for a modified event reusing an ID |
| `GET /api/cases/:id` | Case status and audit trace |
| `POST /api/cases/:id/feedback` | Queue analyst confirmation or correction with a configured confirmed pack |
| `GET /api/cases/:id/publications` | Inspect write-back state and provenance |
| `POST /api/memory-publications/:id/revoke` | Retire an active confirmed fingerprint with an audit reason |

`npm run simulate -- --scenario takeover --seed 22 --emit` prints only synthetic event JSON lines for importing. Pass `--json` during ingestion to capture results joined with simulator-only labels.

### Verification

```bash
npm run typecheck
npm run build
npm test
docker compose exec -T db createdb -U contextcon contextcon_test
npm run test:postgres
```

Run `createdb` once. For local AI or Meko, follow [MANUAL_SETUP.md](MANUAL_SETUP.md). Meko keys and model keys live in the backend's ignored `.env`. The API binds to loopback and only processes synthetic IDs and events.

## Project notes

- Design and data model [Architecture](docs/ARCHITECTURE.md), [Data model](docs/DATA_MODEL.md), [Decision flow](docs/DECISION_FLOW.md), [Design decisions](docs/DESIGN_DECISIONS.md)
- Evidence and delivery [Testing](docs/TESTING.md), [Benchmarks](docs/BENCHMARKS.md), [Meko capabilities](docs/MEKO_CAPABILITIES.md), [Roadmap](docs/ROADMAP.md), [Hackathon strategy](docs/HACKATHON_STRATEGY.md)
# antibody-fraud
