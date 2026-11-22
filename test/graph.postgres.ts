import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../src/database.js';
import { eventSchema, type FraudEvent } from '../src/events.js';
import { extractGraph, graphAssessment } from '../src/graph.js';

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');

const schema = 'graph_test_' + randomUUID().replaceAll('-', '');
const baseTime = Date.parse('2025-06-02T12:00:00.000Z');
const timestamp = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();
let admin: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  admin = createPool(connection);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(connection, '-c search_path=' + schema);
  await migrate(pool);
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

type Common = Pick<FraudEvent, 'accountId' | 'deviceId' | 'networkId' | 'sessionId'>;
function event(kind: 'transfer', time: number, specifics: Partial<Common> & { payeeId: string; amountMinor: number }):
  Extract<FraudEvent, { kind: 'transfer' }>;
function event(kind: 'payee_added', time: number, specifics: Partial<Common> & { payeeId: string }):
  Extract<FraudEvent, { kind: 'payee_added' }>;
function event(kind: 'login' | 'login_failed' | 'password_reset', time: number, specifics: Partial<Common>): FraudEvent;
function event(
  kind: FraudEvent['kind'],
  time: number,
  specifics: Partial<Common> & { payeeId?: string; amountMinor?: number },
): FraudEvent {
  return eventSchema.parse({
    accountId: 'acct-base', deviceId: 'dev-base', networkId: 'net-base',
    location: { latitude: 13.0, longitude: 77.6 },
    ...specifics,
    kind, id: randomUUID(), timestamp: timestamp(time),
  });
}

async function save(input: FraudEvent, receivedAt?: Date) {
  await pool.query(`
    INSERT INTO events (id, occurred_at, account_id, kind, device_id, network_id,
      payee_id, amount_minor, latitude, longitude, payload, received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,clock_timestamp()))
  `, [
    input.id, input.timestamp, input.accountId, input.kind, input.deviceId, input.networkId,
    'payeeId' in input ? input.payeeId : null, input.kind === 'transfer' ? input.amountMinor : null,
    input.location.latitude, input.location.longitude, input, receivedAt ?? null,
  ]);
}

async function confirm(input: FraudEvent, feedbackAt?: Date, decidedAt?: Date) {
  await pool.query(`
    INSERT INTO cases (id, status, action, trace, decided_at)
    VALUES ($1, 'decided', 'BLOCK', '{}', coalesce($2, clock_timestamp()))
  `, [input.id, decidedAt ?? null]);
  await pool.query(`
    INSERT INTO analyst_feedback (case_id, request, created_at)
    VALUES ($1, '{"verdict":"fraud_confirmed"}', coalesce($2, clock_timestamp()))
  `, [input.id, feedbackAt ?? null]);
}

async function graph(input: FraudEvent) {
  const client = await pool.connect();
  try {
    return await extractGraph(client, input);
  } finally {
    client.release();
  }
}

describe('PostgreSQL graph evidence', () => {
  it('exposes typed device, session and payee edges and a two-hop path to an earlier confirmed account', async () => {
    const current = event('login', 0, {
      accountId: 'acct-linked-origin', deviceId: 'dev-linked-bridge',
      networkId: 'net-linked-origin', sessionId: 'sess-linked-bridge',
    });
    const neighbourLogin = event('login', -90, {
      accountId: 'acct-linked-intermediate', deviceId: 'dev-linked-bridge',
      networkId: 'net-linked-intermediate', sessionId: 'sess-linked-bridge',
    });
    const recipientLink = event('transfer', -140, {
      accountId: 'acct-linked-intermediate', deviceId: 'dev-linked-intermediate',
      networkId: 'net-linked-intermediate', payeeId: 'payee-linked-bridge', amountMinor: 8400,
    });
    const earlierFraud = event('transfer', -210, {
      accountId: 'acct-linked-confirmed', deviceId: 'dev-linked-confirmed',
      networkId: 'net-linked-confirmed', payeeId: 'payee-linked-bridge', amountMinor: 11100,
    });
    for (const item of [neighbourLogin, recipientLink, earlierFraud]) await save(item);
    await confirm(earlierFraud);
    const evidence = await graph(current);
    expect(evidence.directAccountCounts).toMatchObject({ device: 1, session: 1, payee: 0 });
    const path = evidence.paths.find((item) => item.accounts.at(-1) === earlierFraud.accountId);
    expect(path).toMatchObject({
      accounts: [current.accountId, neighbourLogin.accountId, earlierFraud.accountId],
      priorConfirmedCase: { caseId: earlierFraud.id },
    });
    expect(path?.priorConfirmedCase && Date.parse(path.priorConfirmedCase.confirmedAt))
      .toBeLessThanOrEqual(Date.parse(evidence.observedAt));
    const [device, payee] = path?.links ?? [];
    expect(device).toMatchObject({
      via: { type: 'device', id: current.deviceId },
      edges: [
        { edgeId: current.id + ':device', eventKind: 'login' },
        { edgeId: neighbourLogin.id + ':device', relationship: 'uses_device', eventId: neighbourLogin.id },
      ],
    });
    expect(payee?.edges.map((edge) => [edge.eventId, Date.parse(edge.occurredAt)])).toEqual([
      [recipientLink.id, Date.parse(recipientLink.timestamp)], [earlierFraud.id, Date.parse(earlierFraud.timestamp)],
    ]);
    expect(graphAssessment(evidence).evidence.map(({ id, points }) => ({ id, points })))
      .toEqual([{ id: 'graph_confirmed_connection', points: 0 }]);
  });

  it('retains legitimate household devices, office networks and common recipients as descriptive links', async () => {
    const current = event('transfer', 0, {
      accountId: 'acct-benign-origin', deviceId: 'dev-benign-household',
      networkId: 'net-benign-office', payeeId: 'payee-benign-utility', amountMinor: 4300,
    });
    await save(event('login', -200, {
      accountId: 'acct-benign-housemate', deviceId: current.deviceId, networkId: 'net-benign-home',
    }));
    await save(event('login', -120, {
      accountId: 'acct-benign-colleague', networkId: current.networkId, deviceId: 'dev-benign-colleague',
    }));
    await save(event('transfer', -280, {
      accountId: 'acct-benign-utility-user', payeeId: current.payeeId, amountMinor: 5900,
      networkId: 'net-benign-utility-user', deviceId: 'dev-benign-utility-user',
    }));
    const snapshot = await graph(current);
    expect(snapshot.directAccountCounts).toEqual({ device: 1, session: 0, network: 1, payee: 1 });
    expect(graphAssessment(snapshot).evidence).toEqual([]);
  });

  it('uses corroborating authentication and payment evidence across accounts without scoring the verdict', async () => {
    const current = event('transfer', 0, {
      accountId: 'acct-coordinated-origin', deviceId: 'dev-coordinated-overlap', networkId: 'net-coordinated-origin',
      payeeId: 'payee-coordinated-overlap', amountMinor: 8000,
    });
    const other = { accountId: 'acct-coordinated-other', deviceId: current.deviceId, networkId: 'net-coordinated-other' };
    await save(event('login_failed', -120, other));
    await save(event('password_reset', -90, other));
    await save(event('payee_added', -70, { ...other, payeeId: current.payeeId }));
    const authentication = await graph(event('login', 0, {
      accountId: current.accountId, deviceId: current.deviceId, networkId: current.networkId,
    }));
    expect(graphAssessment(authentication).evidence.map(({ id }) => id))
      .toContain('graph_coordinated_authentication');
    const payment = await graph(current);
    expect(graphAssessment(payment).evidence).toEqual([
      expect.objectContaining({ id: 'graph_coordinated_payment', points: 0 }),
    ]);
  });

  it('excludes future occurrence, future reception and feedback recorded after the snapshot', async () => {
    const current = event('login', 0, {
      accountId: 'acct-time-origin', deviceId: 'dev-time-device', networkId: 'net-time-origin',
    });
    const network = 'net-time-peer-independent';
    const futureReceived = new Date(Date.now() + 86_400_000);
    for (const [delta, label, reception] of [
      [1, 'future', undefined], [0, 'simultaneous', undefined], [-1, 'future-reception', futureReceived],
    ] as const) {
      await save(event('login', delta, {
        accountId: 'acct-time-' + label, deviceId: current.deviceId, networkId: network,
      }), reception);
    }

    const futureConfirmed = event('login', -100, {
      accountId: 'acct-time-future-feedback', deviceId: current.deviceId, networkId: network,
    });
    await save(futureConfirmed);
    await confirm(futureConfirmed, futureReceived);
    const futureDecision = event('login', -110, {
      accountId: 'acct-time-future-decision', deviceId: current.deviceId, networkId: network,
    });
    await save(futureDecision);
    await confirm(futureDecision, undefined, futureReceived);
    const observed = await graph(current);
    expect(observed.directAccountCounts.device).toBe(2);
    for (const unexpected of ['acct-time-future', 'acct-time-simultaneous', 'acct-time-future-reception']) {
      expect(observed.paths.flatMap((path) => path.accounts)).not.toContain(unexpected);
    }
    expect(observed.paths.every((item) => item.priorConfirmedCase === null)).toBe(true);
  });

  it('bounds hot identifiers, recursive fan-out and cyclic paths among 2,000 unrelated events', async () => {
    await pool.query(`
      INSERT INTO events (id, occurred_at, account_id, kind, device_id, network_id, latitude, longitude, payload)
      SELECT md5('graph-scale-' || i)::uuid, $1::timestamptz - i * interval '1 second',
        'acct-scale-' || i, 'login', 'dev-scale-' || i, 'net-scale-' || i, 0, 0, '{}'::jsonb
      FROM generate_series(1,2000) AS i
    `, [timestamp(0)]);
    const current = event('login', 0, {
      accountId: 'acct-cycle-origin', deviceId: 'dev-cycle-shared', networkId: 'net-cycle-origin',
    });
    for (let number = 1; number <= 24; number++) {
      const item = event('login', -number, {
        accountId: 'acct-cycle-' + number, networkId: 'net-cycle-' + (number % 2),
        deviceId: current.deviceId, sessionId: 'sess-cycle-' + (number % 3),
      });
      await save(item);
    }
    await save(event('login', -150, {
      accountId: current.accountId, deviceId: current.deviceId, networkId: 'net-cycle-0',
    }));
    await pool.query('ANALYZE events');
    const observed = await graph(current);
    expect(observed.paths.some((path) => path.links.length === 2)).toBe(true);
    expect(observed.directAccountCounts.device).toBe(4);
    expect(observed.paths).toHaveLength(20);
    expect(observed.paths.every((path) =>
      path.links.length <= 2 && new Set(path.accounts).size === path.accounts.length &&
      new Set(path.links.map(({ via }) => via.type + ':' + via.id)).size === path.links.length)).toBe(true);
    expect(graphAssessment(observed).evidence).toEqual([]);

    const samples = [];
    const client = await pool.connect();
    try {
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        await extractGraph(client, current);
        samples.push(performance.now() - start);
      }
    } finally {
      client.release();
    }
    samples.sort((first, second) => first - second);
    console.log('PostgreSQL graph wall time on ~2,000 events (7 warm requests), median ms:', samples[3]?.toFixed(2));
  });
});
