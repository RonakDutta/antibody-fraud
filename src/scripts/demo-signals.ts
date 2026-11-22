import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { CaseService } from '../cases.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import { createFallbackModel, createModel } from '../integrations/models.js';
import type { InvestigationOptions } from '../investigation.js';
import { startPublicationWorker } from '../publication-worker.js';
import { generateScenario } from '../simulator.js';
import { createLearning } from '../wiring.js';

const config = loadConfig();
const model = createModel(config);
if (!model) throw new Error('Configure a model before the live signal smoke.');
if (!config.MEKO_API_KEY || !config.MEKO_RISK_SIGNALS_DATAPACK_ID) throw new Error('The live smoke requires the risk-signals datapack.');
const schema = 'contextcon_signals_' + randomUUID().replaceAll('-', '').slice(0, 16);
const admin = createPool(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL, '-c search_path=' + schema);
const learning = createLearning(pool, config)!;
const policy = { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD };
const history = new CaseService(pool, policy, {
  mode: 'rules', memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
});
const reviewOptions: InvestigationOptions = {
  mode: 'meko', advanced: true, collective: true, learning, model, investigatorModel: createModel(config, true),
  fallbackModel: createFallbackModel(config), memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
};
const team = new CaseService(pool, policy, reviewOptions);
const receiver = new CaseService(pool, policy, { ...reviewOptions, publishProvisional: false });

function summarize(trace: Awaited<ReturnType<typeof team.ingest>>['case']['trace']) {
  return {
    action: trace.action, score: trace.risk.score, calls: trace.modelCalls, durationMs: Math.round(trace.durationMs),
    agents: trace.team?.map((agent) => ({
      id: agent.agentId, accepted: !!agent.result, evidence: agent.result?.evidenceIds,
      memories: agent.result?.retrievedMemoryIds,
      attempts: agent.attempts.map(({ status, error, usage }) => ({ status, error, usage })),
    })),
    graph: trace.graph,
  };
}

let stop: (() => Promise<void>) | undefined;
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  const stream = generateScenario(38140, 'takeover').events;
  for (const event of stream.slice(0, 12)) await history.ingest(event);
  const [login, reset, payee, impact] = stream.slice(12);
  if (login?.kind !== 'login' || reset?.kind !== 'password_reset' || payee?.kind !== 'payee_added' || impact?.kind !== 'transfer') {
    throw new Error('Unexpected synthetic stream.');
  }
  const start = Date.parse(login.timestamp);
  const earlier = (offsetMs: number) => new Date(start - offsetMs).toISOString();
  for (const [kind, offsetMs] of [['login_failed', 120_000], ['password_reset', 90_000]] as const) {
    await history.ingest({
      ...login, kind, id: randomUUID(), accountId: 'acct-neighbour-38140', networkId: 'net-neighbour-38140',
      sessionId: 'sess-neighbour-38140', timestamp: earlier(offsetMs),
    });
  }
  for (const ms of [120_000, 70_000, 30_000]) await history.ingest({
    ...login, kind: 'login_failed', id: randomUUID(), sessionId: 'sess-early-first', timestamp: earlier(ms),
  });

  stop = startPublicationWorker(learning, () => console.error('Publication worker will retry.'));
  console.error('Investigating the earlier login in schema ' + schema);
  const first = (await team.ingest({ ...login, sessionId: 'sess-early-first' })).case;
  // This is a controlled smoke, not the API request path. Wait only to demonstrate known
  // worker completion before submitting the next event to the ordinary investigation.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(await learning.pubs(first.id)).some((row) => row.pack === 'risk' && row.state === 'published')) {
    await wait(1500);
  }
  if (!(await learning.pubs(first.id)).some((row) => row.pack === 'risk' && row.state === 'published')) {
    throw new Error('Earlier login has no readable provisional observation.');
  }
  await history.ingest({ ...reset, sessionId: 'sess-early-first' });
  console.error('Investigating the pre-impact payee registration in a second session.');
  const later = (await receiver.ingest({ ...payee, sessionId: 'sess-early-next' })).case;
  const shared = later.trace.provisionalSignals?.filter((signal) =>
    signal.originCase === first.id && signal.originAgent !== signal.receivingAgent && signal.crossSession,
  ) ?? [];
  if (shared.length === 0) throw new Error('No cross-agent, cross-session signal reached the later role.');
  const retrievedIds = new Set(shared.map((item) => item.memoryId));
  const verifiedPublications = (await learning.pubs(first.id))
    .filter((row) => row.remote_id && retrievedIds.has(row.remote_id))
    .map(({ remote_id, state, verified_at, last_operation, attempts }) => ({
      memoryId: remote_id, state, verifiedAt: verified_at, verification: last_operation, attempts,
    }));
  console.log(JSON.stringify({
    schema, earlier: summarize(first.trace), later: summarize(later.trace), shared, verifiedPublications,
    leadSecondsBeforeTransfer: (Date.parse(impact.timestamp) - Date.parse(payee.timestamp)) / 1000,
    impactSubmitted: false,
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Earlier login|No cross-agent|Unexpected synthetic)/.test(message) ? message : 'Signal smoke failed. See the durable demo schema.');
  process.exitCode = 1;
} finally {
  await stop?.();
  await pool.end();
  await admin.end();
}
