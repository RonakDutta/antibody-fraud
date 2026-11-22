import { spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CaseService } from '../cases.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import { createFallbackModel, createModel } from '../integrations/models.js';
import { generateScenario } from '../simulator.js';
import { createLearning } from '../wiring.js';

const { values } = parseArgs({ options: {
  seed: { type: 'string' },
  'reuse-schema': { type: 'string' },
  'resume-schema': { type: 'string' },
} });
const schemaPattern = /^contextcon_demo_([1-9][0-9]{0,7})_(?:[0-9]{4}|[0-9a-f]{16})$/;
const existingSchema = values['resume-schema'] ?? values['reuse-schema'];
const existingSeed = existingSchema && schemaPattern.exec(existingSchema)?.[1];
if (existingSchema && !existingSeed) throw new Error('Use the exact demo schema printed by the run.');
const seed = z.coerce.number().int().min(1).max(99_999_990).parse(values.seed ?? existingSeed ?? randomInt(100_000, 90_000_000));
if (existingSeed && Number(existingSeed) !== seed) throw new Error('Resume seed does not match the existing demo schema.');
const config = loadConfig();
const model = createModel(config);
if (!model) throw new Error('Configure an inference provider in .env first.');
const policies = { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD };
const admin = createPool(config.DATABASE_URL);

function connect(schema: string, mode: 'meko' | 'agents') {
  if (!schemaPattern.test(schema.replace(/_baseline$/, ''))) throw new Error('Invalid demo schema name');
  const pool = createPool(config.DATABASE_URL, '-c search_path=' + schema);
  const learning = createLearning(pool, config, mode === 'meko');
  const team = new CaseService(pool, policies, {
    mode, collective: true, learning, model, investigatorModel: createModel(config, true),
    fallbackModel: createFallbackModel(config), memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
  });
  const rules = new CaseService(pool, policies, {
    mode: 'rules', memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
  });
  return { pool, learning, team, rules };
}

async function runCase(services: ReturnType<typeof connect>, caseSeed: number, variant: 'A' | 'B' | 'C' | 'D') {
  const events = generateScenario(caseSeed, 'takeover').events;
  const last = events.at(-1);
  if (last?.kind !== 'transfer') throw new Error('Expected a synthetic transfer case');
  const sessionId = 'sess-demo-' + caseSeed;
  const legitimate = variant === 'C' || variant === 'D';
  for (const event of events.slice(0, -1)) {
    if (legitimate && event.kind === 'password_reset') continue;
    await services.rules.ingest({ ...event, sessionId });
  }
  const event = { ...last, sessionId, amountMinor: last.amountMinor + (variant === 'A' ? 0 : 321) };
  const result = (await services.team.ingest(event)).case;
  if (result.status === 'pending') {
    throw new Error('Case ' + variant + ' still has an investigation lease. Resume after it expires.');
  }
  return result;
}

type DemoCase = Awaited<ReturnType<typeof runCase>>;
function measure(row: DemoCase) {
  const agents = row.trace.team ?? [];
  const attempts = agents.flatMap((agent) => agent.attempts);
  return {
    caseId: row.id, sessionId: row.trace.sessionId, synthesis: row.trace.synthesis, action: row.action, calls: row.trace.modelCalls,
    inputTokensReported: attempts.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
    outputTokensReported: attempts.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
    usageMissingCalls: attempts.filter((call) => call.usage?.inputTokens == null || call.usage?.outputTokens == null).length,
    durationMs: Math.round(row.trace.durationMs), reuse: row.trace.reuse,
    rejected: row.trace.rejectedMemories,
    agents: agents.map((agent) => ({
      agent: agent.agentId, model: agent.model, provider: agent.provider, accepted: Boolean(agent.result),
      attempts: agent.attempts.map((call) => ({ ...call, durationMs: Math.round(call.durationMs) })),
    })),
  };
}

async function publish(services: ReturnType<typeof connect>, caseId: string, publicationId: string, stage: string) {
  const learning = services.learning!;
  const deadline = Date.now() + 100_000;
  const initial = (await learning.pubs(caseId)).find((job) => job.id === publicationId);
  const canExtendReads = values['resume-schema'] && initial && ['sending', 'indexing', 'uncertain'].includes(initial.state);
  const attemptLimit = canExtendReads ? Math.max(10, initial.attempts + 3) : 10;
  let last = initial;
  console.error(stage + ' publication ' + publicationId + ' starts in ' + (last?.state ?? 'missing'));
  while (Date.now() < deadline) {
    if (last?.state === 'published') return last;
    if (last?.state === 'failed' || (last && last.attempts >= attemptLimit)) break;
    const next = await learning.workOne(publicationId, attemptLimit);
    last = next ?? (await learning.pubs(caseId)).find((job) => job.id === publicationId);
    if (next) console.error(stage + ' ' + next.state + ' after ' + next.last_operation +
      ' (attempt ' + next.attempts + (next.last_error ? ', ' + next.last_error : '') + ')');
    if (last?.state === 'published') return last;
    await pause(1600);
  }
  throw new Error(stage + ' publication ' + publicationId + ' is ' + (last?.state ?? 'missing') +
    ' after ' + (last?.attempts ?? 0) + ' attempts' +
    (last?.last_error ? ' (' + last.last_error + ')' : '') + '. Resume this schema to continue.');
}

try {
  if (values['reuse-schema']) {
    const fresh = connect(values['reuse-schema'], 'meko');
    try { console.log(JSON.stringify(measure(await runCase(fresh, seed + 1, 'B')))); }
    finally { await fresh.pool.end(); }
  } else {
    const schema = values['resume-schema'] ?? 'contextcon_demo_' + seed + '_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const baselineSchema = schema + '_baseline';
    const live = connect(schema, 'meko');
    const baseline = connect(baselineSchema, 'agents');
    try {
      if (!live.learning?.hasPack('confirmed')) throw new Error('Configure the confirmed-patterns datapack first.');
      console.error('Demo seed:', seed, 'schema:', schema, 'risk pack configured:', live.learning.hasPack('risk'));
      if (values['resume-schema'] && !(await admin.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0]?.name) {
        throw new Error('Resume schema does not exist.');
      }
      if (!values['resume-schema']) await admin.query('CREATE SCHEMA ' + schema);
      await admin.query('CREATE SCHEMA IF NOT EXISTS ' + baselineSchema);
      console.error('Resume with --resume-schema ' + schema + ' if interrupted.');
      await migrate(live.pool);
      await migrate(baseline.pool);
      console.error(values['resume-schema']
        ? 'Loading settled cases and continuing unfinished work.'
        : 'Investigating Case A with fresh case history.');
      const a = await runCase(live, seed, 'A');
      if (a.trace.reuse) throw new Error('Case A unexpectedly reused prior knowledge.');
      console.error('Case A completed with model calls:', a.trace.modelCalls);
      const confirmed = await live.learning.feedback(a.id, { verdict: 'fraud_confirmed' });
      const original = await publish(live, a.id, confirmed.id, 'A fingerprint');

      console.error('Reading the published fingerprint from a fresh process for Case B.');
      const child = spawnSync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'src/scripts/learn-demo.ts',
        '--seed', String(seed), '--reuse-schema', schema], { encoding: 'utf8', timeout: 600_000 });
      if (child.status !== 0) throw new Error('Restarted Case B process did not complete.');
      const b = JSON.parse(child.stdout.trim()) as ReturnType<typeof measure>;
      if (b.reuse?.originCase !== a.id || b.reuse.memoryId !== original.remote_id ||
          b.reuse.originAgent === b.reuse.retrievingAgent || b.sessionId === a.trace.sessionId) {
        throw new Error('Case B did not reuse the intended Meko fingerprint.');
      }
      console.error('Running the matched Case B baseline without Meko.');
      const withoutMemory = measure(await runCase(baseline, seed + 1, 'B'));
      if (withoutMemory.caseId !== b.caseId || withoutMemory.reuse) throw new Error('Baseline mismatch.');
      console.error('Case B reuse completed. Starting the analyst correction.');
      const c = await runCase(live, seed + 2, 'C');
      if (c.trace.reuse?.publicationId !== confirmed.id) throw new Error('Case C did not demonstrate the broad fingerprint.');
      const corrected = await live.learning.feedback(c.id, { verdict: 'legitimate_correction', publicationId: confirmed.id, require: 'recent_reset' });
      const replacement = await publish(live, c.id, corrected.id, 'C correction');
      console.error('Investigating Case D with the corrected fingerprint.');
      const d = await runCase(live, seed + 3, 'D');
      const rejects = d.trace.rejectedMemories ?? [];
      if (d.trace.reuse || !rejects.some((item) => item.memoryId === original.remote_id && item.reason === 'superseded') ||
          !rejects.some((item) => item.memoryId === replacement.remote_id && item.reason === 'conditions_not_met')) {
        throw new Error('Case D did not demonstrate applicability or supersession.');
      }
      const caseIds = [a.id, b.caseId, c.id, d.id];
      for (const [index, caseId] of caseIds.entries()) {
        for (const job of await live.learning.pubs(caseId)) {
          if (job.pack === 'risk' && job.state !== 'published') {
            await publish(live, caseId, job.id, ['A', 'B', 'C', 'D'][index] + ' observation');
          }
        }
      }
      const publicationJobs = await Promise.all(caseIds.map((id) => live.learning!.pubs(id)));
      const publications = publicationJobs.flat().map(({ id, pack, state, attempts, last_operation }) => ({ id, pack, state, attempts, verification: last_operation }));
      console.log(JSON.stringify({ seed, schema, baselineSchema, riskPackConfigured: live.learning.hasPack('risk'),
        baselineB: withoutMemory, a: measure(a), b, c: measure(c), d: measure(d), correction: {
          incorrectFingerprintAttributionBefore: Number(Boolean(c.trace.reuse)),
          incorrectFingerprintAttributionAfter: Number(Boolean(d.trace.reuse)),
        }, publications }, null, 2));
    } finally {
      await live.pool.end();
      await baseline.pool.end();
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(?:Case |Baseline mismatch|A fingerprint|C correction|[ABCD] observation|Resume schema|Configure the confirmed|Restarted Case|verified_specialist_evidence_required|correction_not_supported_by_evidence)/.test(message);
  console.error('Collective learning demo failed:', safe ? message : 'Database, transport, or configuration failure.');
  process.exitCode = 1;
} finally {
  await admin.end();
}
