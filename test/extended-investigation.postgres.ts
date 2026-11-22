import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CaseService } from '../src/cases.js';
import { createPool, migrate } from '../src/database.js';
import { DEVICE_AGENT } from '../src/device-evidence.js';
import { eventSchema, type FraudEvent } from '../src/events.js';
import { DependencyError, type StructuredModel } from '../src/integrations/ports.js';
import {
  GRAPH_AGENT, LearningService, LOGIN_AGENT, TRANSFER_AGENT, type MemoryGateway,
} from '../src/learning.js';

const endpoint = process.env.TEST_DATABASE_URL;
if (!endpoint) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'contextcon_extended_test_' + randomUUID().replaceAll('-', '');
const policy = { challenge: 25, block: 72 };
const zeroTime = Date.UTC(2026, 9, 2, 12, 0);
const home = { latitude: 19.076, longitude: 72.8777 };
const away = { latitude: 51.5072, longitude: -0.1276 };
const typical = { dwellMs: 101, flightMs: 148, interactionMs: 640 };
const changed = { dwellMs: 28, flightMs: 36, interactionMs: 170 };
let admin: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  admin = createPool(endpoint);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(endpoint, '-c search_path=' + schema);
  await migrate(pool);
});
beforeEach(async () => {
  // All rows belong to this suite's disposable isolated schema.
  await pool.query('TRUNCATE memory_publications, analyst_feedback, cases, events');
});

afterAll(async () => {
  await pool?.end();
  if (admin) {
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.end();
    }
  }
});

function makeEvent(account: string, minute: number, changes: Record<string, unknown> = {}) {
  return eventSchema.parse({
    id: randomUUID(),
    timestamp: new Date(zeroTime + minute * 60_000).toISOString(),
    accountId: 'acct-' + account,
    deviceId: 'dev-' + account + '-usual',
    networkId: 'net-' + account + '-usual',
    sessionId: 'sess-' + account + '-usual',
    kind: 'login',
    location: home,
    behaviour: typical,
    ...changes,
  });
}

type ModelInput = {
  evidence: { id: string }[];
  specialistResults?: { agentId: string }[];
  earlierProvisionalSignals?: { originAgent?: string; receivingAgent?: string; crossSession?: boolean }[];
  deviceActivity30d?: number;
  paths?: { pathId: string }[];
};
const usage = { inputTokens: 100, outputTokens: 30, reasoningTokens: null, totalTokens: 130 };

function createFixtures() {
  const documents = new Map<string, string>();
  const gateway = {
    search: vi.fn<MemoryGateway['search']>(async () => ({
      matches: [...documents.keys()].map((id) => ({ id, score: 0.87 })),
      records: [...documents].map(([id, text]) => ({ id, text })),
    })),
    read: vi.fn<MemoryGateway['read']>(async (id) => documents.has(id) ? { id, text: documents.get(id)! } : null),
    recent: vi.fn<MemoryGateway['recent']>(async () => [...documents].map(([id, text]) => ({ id, text }))),
    write: vi.fn<MemoryGateway['write']>(async (text) => {
      const id = randomUUID();
      documents.set(id, text);
      return id;
    }),
  };

  const generate = vi.fn<StructuredModel['generate']>(async (_prompt, data) => {
    const input = JSON.parse(data) as ModelInput;
    const recommendedAction = input.specialistResults || input.deviceActivity30d !== undefined ? 'BLOCK' : 'ALLOW';
    const rationale = 'Deterministic test fixture recommendation.';
    const evidenceIds = input.evidence.slice(0, 3).map((item) => item.id);
    const response = { recommendedAction, rationale };
    return {
      text: JSON.stringify(input.specialistResults ? response : input.paths ?
        { ...response, evidenceIds: evidenceIds.slice(0, 2) } :
        { ...response, riskScore: 70, confidence: 0.8, missingContext: [], evidenceIds }),
      usage,
    };
  });

  const learning = new LearningService(pool, { risk: gateway }, 1000);
  const service = new CaseService(pool, policy, {
    mode: 'meko', advanced: true, collective: true, learning,
    model: { provider: 'test-double', model: 'extended-orchestration-fixture', generate },
    memoryTimeoutMs: 1000, modelTimeoutMs: 1000,
  });
  const rules = new CaseService(pool, policy, {
    mode: 'rules', memoryTimeoutMs: 1000, modelTimeoutMs: 1000,
  });
  return { gateway, learning, service, rules, generate };
}
type Fixtures = ReturnType<typeof createFixtures>;

const unfamiliar = (account: string, session: string) => ({
  deviceId: 'dev-' + account + '-unfamiliar',
  networkId: 'net-' + account + '-unfamiliar',
  sessionId: 'sess-' + account + '-' + session,
});

async function stageBaseline(account: string, f: Fixtures) {
  for (const minute of [-7_000, -5_000, -3_000]) await f.rules.ingest(makeEvent(account, minute));
}

async function stageSource(account: string, minute: number, f: Fixtures) {
  for (const offset of [-5, -4, -3]) {
    const failed = makeEvent(account, minute + offset, {
      ...unfamiliar(account, 'before-reset'), kind: 'login_failed',
    });
    expect((await f.rules.ingest(failed)).case.action).toBe('ALLOW');
  }
  const reset = makeEvent(account, minute, {
    ...unfamiliar(account, 'before-reset'), kind: 'password_reset',
  });
  const { case: result } = await f.service.ingest(reset);
  expect(result.action).toBe('STEP_UP_VERIFICATION');
  expect(result.trace.risk.evidence.map(({ id }) => id)).toContain('reset_after_device_failures');
  return reset;
}

async function publishSource(event: FraudEvent, f: Fixtures) {
  const pending = await f.learning.pubs(event.id);
  expect(pending.length).toBeGreaterThan(0);
  const ids: string[] = [];
  for (const job of pending) {
    expect(job.state).toBe('pending');
    const acknowledged = await f.learning.workOne(job.id);
    expect(acknowledged).toMatchObject({ state: 'indexing', last_operation: 'write' });
    await pool.query(
      "UPDATE memory_publications SET next_check_at = clock_timestamp() - interval '5 seconds' WHERE id = $1",
      [job.id],
    );
    const finished = await f.learning.workOne(job.id);
    expect(finished).toMatchObject({ state: 'published', last_operation: 'exact_id' });
    expect(finished?.remote_id).toEqual(expect.any(String));
    ids.push(finished!.remote_id!);
  }
  return ids;
}

function payee(account: string, minute = 5) {
  return makeEvent(account, minute, {
    ...unfamiliar(account, 'after-reset'), kind: 'payee_added', payeeId: 'payee-' + account, behaviour: changed,
  });
}

it('routes a corroborated login to Device/IP and Graph while enforcing only deterministic policy', async () => {
  const f = createFixtures();
  const shared = { deviceId: 'dev-extended-connected', networkId: 'net-extended-connected' };
  const prior = makeEvent('extended-root', -9);
  const linked = makeEvent('extended-peer', -6, shared);
  await f.rules.ingest(prior);
  await f.rules.ingest(linked);
  await f.rules.ingest(makeEvent('extended-peer', -4, { ...shared, kind: 'login_failed' }));
  await f.rules.ingest(makeEvent('extended-peer', -2, { ...shared, kind: 'login_failed' }));

  const current = makeEvent('extended-root', 0, { ...shared, location: away });
  const { case: row } = await f.service.ingest(current);
  expect(row.trace.team?.map(({ agentId }) => agentId)).toEqual([DEVICE_AGENT, GRAPH_AGENT, 'contextcon-investigator']);
  expect(row.trace.team?.find(({ agentId }) => agentId === DEVICE_AGENT)?.result?.evidenceIds)
    .toEqual(expect.arrayContaining(['new_device', 'impossible_travel']));
  expect(row.trace.team?.find(({ agentId }) => agentId === GRAPH_AGENT)?.result?.evidenceIds)
    .toEqual(['graph_coordinated_authentication']);
  expect(row.trace.graph?.paths.some(({ links }) => links.some(({ edges }) => edges[0].eventId === current.id))).toBe(true);
  expect(row.trace.graph?.directAccountCounts.device).toBe(1);
  expect(row.trace.synthesis?.conflictingRecommendations).toBe(true);
  expect(row.trace.policy).toMatchObject({ appliedAction: 'STEP_UP_VERIFICATION', agentRecommendation: 'BLOCK' });
  expect(row.action).toBe('STEP_UP_VERIFICATION');
  expect((await f.learning.pubs(row.id)).map((job) => job.document.originAgent).sort()).toEqual([DEVICE_AGENT, GRAPH_AGENT].sort());
  expect(f.gateway.write).not.toHaveBeenCalled();
});

it('shares only published earlier provisional observations with a different specialist and session', async () => {
  const f = createFixtures();
  const account = 'extended-positive';
  await stageBaseline(account, f);
  const early = await stageSource(account, 0, f);
  expect(f.gateway.write).not.toHaveBeenCalled();
  const remoteIds = await publishSource(early, f);
  expect(f.gateway.write).toHaveBeenCalledTimes(remoteIds.length);
  f.gateway.read.mockClear();
  f.generate.mockClear();

  const target = payee(account);
  const { case: row } = await f.service.ingest(target);
  expect(row.trace.provisionalSignals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      originCase: early.id, originAgent: DEVICE_AGENT, receivingAgent: TRANSFER_AGENT, crossSession: true,
      sourceOccurredAt: early.timestamp,
    }),
  ]));
  expect(row.trace.provisionalSignals?.map(({ memoryId }) => memoryId).sort()).toEqual(remoteIds.sort());
  expect(f.gateway.read.mock.calls).toHaveLength(remoteIds.length);
  expect(f.gateway.read.mock.calls.every(([, receiving]) => receiving === TRANSFER_AGENT)).toBe(true);
  expect(row.trace.team?.find(({ agentId }) => agentId === TRANSFER_AGENT)?.result?.retrievedMemoryIds.sort())
    .toEqual(remoteIds);
  const inputs = f.generate.mock.calls.map(([, data]) => JSON.parse(data) as ModelInput);
  expect(inputs.filter((item) => item.earlierProvisionalSignals).length).toBe(2);
  expect(inputs.find((input) => input.specialistResults)?.earlierProvisionalSignals)
    .toEqual(expect.arrayContaining([expect.objectContaining({ receivingAgent: TRANSFER_AGENT })]));
  expect(row.action).toBe('STEP_UP_VERIFICATION');
  expect(row.trace.reuse).toBeNull();
});

it('excludes future events, wrong accounts, and observations verified after the target cut-off', async () => {
  const f = createFixtures();
  const account = 'extended-boundary';
  const other = 'extended-other';
  await stageBaseline(account, f);
  await stageBaseline(other, f);

  const future = await stageSource(account, 20, f);
  const unrelated = await stageSource(other, -2, f);
  const late = await stageSource(account, 0, f);
  await publishSource(future, f);
  await publishSource(unrelated, f);
  await publishSource(late, f);
  // Simulate observations whose verification wins its race only after the target begins.
  await pool.query("UPDATE memory_publications SET verified_at = clock_timestamp() + interval '1 day' WHERE case_id = $1", [late.id]);
  f.gateway.read.mockClear();

  const { case: row } = await f.service.ingest(payee(account));
  expect(row.trace.provisionalSignals).toEqual([]);
  expect(row.trace.specialistContexts?.some((entry) => entry.pack === 'risk' && entry.context.status === 'ok' && entry.context.matches.length > 0))
    .toBe(true);
  expect(f.gateway.read).not.toHaveBeenCalled();
  expect(row.action).toBe('STEP_UP_VERIFICATION');
});

it('retains the local action and completed reviews when a provisional lookup is unavailable', async () => {
  const f = createFixtures();
  const account = 'extended-offline';
  await stageBaseline(account, f);
  const early = await stageSource(account, 0, f);
  await publishSource(early, f);
  const unavailable = new DependencyError('meko_transport_error');
  f.gateway.read.mockRejectedValue(unavailable);
  f.gateway.search.mockRejectedValue(unavailable);

  const { case: row } = await f.service.ingest(payee(account));
  expect(f.gateway.read.mock.calls.some(([, retrieving]) => retrieving === TRANSFER_AGENT)).toBe(true);
  expect(row.trace.provisionalContextError).toBe('meko_transport_error');
  expect(row.trace.provisionalSignals).toEqual([]);
  expect(row.trace.team?.some((agent) => agent.agentId === TRANSFER_AGENT && agent.result)).toBe(true);
  expect(row.action).toBe(row.trace.risk.preliminaryAction);
  expect(row.action).toBe('STEP_UP_VERIFICATION');
});

it('takes the ordinary fast path without graph traversal, retrieval, or model calls', async () => {
  const f = createFixtures();
  const { case: row } = await f.service.ingest(makeEvent('extended-ordinary', 0));
  expect(row.action).toBe('ALLOW');
  expect(row.trace.path).toBe('fast');
  expect(row.trace.modelCalls).toBe(0);
  expect(row.trace.graph).toBeUndefined();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.gateway.search).not.toHaveBeenCalled();
  expect(f.gateway.read).not.toHaveBeenCalled();
  expect(await f.learning.pubs(row.id)).toEqual([]);
});
