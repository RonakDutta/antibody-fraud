import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CaseService } from '../cases.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import { fingerprintQuery } from '../investigation.js';
import { TRANSFER_AGENT } from '../learning.js';
import { generateScenario } from '../simulator.js';
import { createLearning } from '../wiring.js';

const { values } = parseArgs({ options: { schema: { type: 'string' }, seed: { type: 'string' } } });
const schema = z.string().regex(/^contextcon_demo_[0-9]{1,8}_(?:[0-9]{4}|[a-f0-9]{16})$/).parse(values.schema);
const seed = z.coerce.number().int().min(1).max(99_999_900).parse(values.seed ?? 50271);
const config = loadConfig();
const admin = createPool(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL, '-c search_path=' + schema);
const learning = createLearning(pool, config);
const service = new CaseService(pool, { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD }, {
  mode: 'rules', advanced: true, memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
});

try {
  if (!learning?.hasPack('confirmed')) throw new Error('confirmed_unconfigured');
  if (!(await admin.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0]?.name) throw new Error('schema_missing');
  await migrate(pool);
  const count = (await pool.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM memory_publications WHERE pack = 'confirmed' AND state = 'published'
  `)).rows[0]?.count ?? 0;
  if (count < 2) throw new Error('schema_requires_fingerprint_history');

  const scenarios = [
    { case: 'takeover after a reset', scenario: 'takeover', omitReset: false, applicable: true },
    { case: 'second account after a reset', scenario: 'takeover', omitReset: false, applicable: true },
    { case: 'legitimate look-alike without a reset', scenario: 'takeover', omitReset: true, applicable: false },
    { case: 'velocity without timing deviation', scenario: 'velocity', omitReset: false, applicable: false },
    { case: 'reset and amount spike without timing evidence', scenario: 'takeover', omitReset: false, applicable: false, omitTransferTiming: true },
  ] as const;
  const results = [];
  for (const [index, item] of scenarios.entries()) {
    const stream = generateScenario(seed + index, item.scenario).events;
    const sessionId = 'sess-ranked-' + (seed + index);
    let current;
    for (const event of stream) {
      if (item.omitReset && event.kind === 'password_reset') continue;
      const timestamp = new Date(Date.parse(event.timestamp) + 86_400_000).toISOString();
      const activity = 'omitTransferTiming' in item && item.omitTransferTiming && event.kind === 'transfer'
        ? { ...event, behaviour: undefined } : event;
      current = (await service.ingest({ ...activity, timestamp, sessionId })).case;
    }
    if (!current) throw new Error('missing_case');
    const query = fingerprintQuery(current.trace.risk);
    const started = performance.now();
    const retrieved = await learning.recall('confirmed', query, TRANSFER_AGENT);
    if (!retrieved || retrieved.lookup !== 'search') throw new Error('ranked_search_missing');
    const verdict = await learning.validateRecall(current.id, current.trace.risk, retrieved, true);
    const rejectionsByReason: Record<string, number> = {};
    for (const { reason } of verdict.rejected) rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + 1;
    results.push({
      scenario: item.case, expectedApplicable: item.applicable, observedApplicable: !!verdict.reuse,
      policyAction: current.action, query, lookup: retrieved.lookup, candidates: retrieved.matches.length,
      elapsedMs: Math.round(performance.now() - started), selected: verdict.reuse, rejectionsByReason,
    });
  }
  const agreement = results.filter((result) => result.expectedApplicable === result.observedApplicable).length;
  console.log(JSON.stringify({ schema, seed, historicalFingerprintsInRegistry: count, results, agreement }, null, 2));
  if (agreement !== results.length) process.exitCode = 1;
} catch (error) {
  const known = error instanceof Error ? error.message : '';
  console.error(/^(confirmed_unconfigured|schema_missing|schema_requires_fingerprint_history|ranked_search_missing)$/.test(known)
    ? known : 'Ranked evaluation failed. Check the schema, configured datapack, and service availability.');
  process.exitCode = 1;
} finally {
  await pool.end();
  await admin.end();
}
