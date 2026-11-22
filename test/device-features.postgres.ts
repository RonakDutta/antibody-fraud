import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '../src/database.js';
import { describeDeviceEvidence } from '../src/device-evidence.js';
import { eventSchema, type FraudEvent } from '../src/events.js';
import { extractFeatures } from '../src/features.js';
import { scoreRisk } from '../src/risk.js';

const endpoint = process.env.TEST_DATABASE_URL;
if (!endpoint) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'contextcon_device_test_' + randomUUID().replaceAll('-', '');
const policy = { challenge: 25, block: 72 };
const home = { latitude: 19.076, longitude: 72.8777 };
const far = { latitude: 51.5072, longitude: -0.1276 };
let admin: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  admin = createPool(endpoint);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(endpoint, '-c search_path=' + schema);
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

function fixture(minute: number, fields: Record<string, unknown> = {}) {
  const timestamp = new Date(Date.UTC(2026, 9, 24, 12, minute)).toISOString();
  return eventSchema.parse({
    id: randomUUID(), accountId: 'acct-device-history', deviceId: 'dev-device-usual',
    networkId: 'net-device-usual', kind: 'login', sessionId: 'sess-device-active', location: home, timestamp,
    ...fields,
  });
}

async function store(event: FraudEvent) {
  await pool.query(`
    INSERT INTO events (id, occurred_at, account_id, kind, device_id, network_id, latitude, longitude, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [
    event.id, event.timestamp, event.accountId, event.kind, event.deviceId, event.networkId,
    event.location.latitude, event.location.longitude, JSON.stringify(event),
  ]);
}

async function features(event: FraudEvent) {
  const client = await pool.connect();
  try {
    return await extractFeatures(client, event);
  } finally {
    client.release();
  }
}

it('links prior device authentication, session changes and simulated network pressure at the event timestamp', async () => {
  const prior = fixture(-9);
  const failed = { kind: 'login_failed', deviceId: 'dev-device-alternate', networkId: 'net-device-cluster', sessionId: 'sess-device-other' };
  const current = fixture(0, { ...failed, kind: 'login', sessionId: 'sess-device-active', location: far });
  const rows = [
    prior,
    fixture(-4, failed),
    fixture(-3, failed),
    fixture(-3, { ...failed, accountId: 'acct-device-second' }),
    fixture(-2, { ...failed, accountId: 'acct-device-second' }),
    fixture(-2, { ...failed, accountId: 'acct-device-third' }),
    fixture(-1, { ...failed, accountId: 'acct-device-third' }),
    fixture(0, { ...failed, accountId: 'acct-device-same-time' }),
    fixture(1, { ...failed, kind: 'login', sessionId: current.sessionId }),
  ];
  // Insert the future event first to check event-time rather than arrival order.
  for (const event of rows.reverse()) await store(event);

  const extracted = await features(current);
  expect(extracted.newDevice).toBe(true);
  expect(extracted.priorLoginId).toBe(prior.id);
  expect(extracted.distanceKm).toBeGreaterThan(7_000);
  expect(extracted.deviceContext).toMatchObject({
    deviceActivity30d: 2,
    deviceSuccessfulLogins30d: 0,
    deviceLastSeenAt: '2026-10-24T11:57:00.000Z',
    networkActivity30d: 2,
    failedLoginsOnDevice15m: 2,
    failedAuthOnNetwork15m: 6,
    failedAuthAccountsOnNetwork15m: 3,
    sessionTransition: { eventId: prior.id, timestamp: expect.any(String), deviceChanged: true, networkChanged: true },
    networkReputation: { source: 'simulated_network_telemetry', level: 'elevated_auth_pressure' },
  });

  const risk = scoreRisk(current.kind, extracted, policy);
  const device = describeDeviceEvidence(extracted, risk);
  expect(device.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'new_device', points: 14 }),
    expect.objectContaining({ id: 'impossible_travel', points: 26 }),
    ...['session_device_change', 'session_network_change', 'unfamiliar_device_failed_auth', 'simulated_network_auth_pressure']
      .map((id) => expect.objectContaining({ id, points: 0, provenance: 'postgres_features' })),
  ]));
  expect(JSON.stringify(device.input)).not.toContain(prior.id);
  expect(JSON.stringify(device.input)).not.toContain(current.deviceId);
  expect(JSON.stringify(device.input)).not.toContain(current.networkId);
  expect(risk.preliminaryAction).not.toBe('BLOCK');
});

it('records shared synthetic office infrastructure while allowing familiar low-risk activity', async () => {
  const office = { deviceId: 'dev-office-terminal', networkId: 'net-office-shared', sessionId: 'sess-office-user' };
  const current = fixture(0, { ...office, accountId: 'acct-office-one' });
  for (const [minute, accountId] of [[-10, 'acct-office-one'], [-5, 'acct-office-two'], [-4, 'acct-office-three']] as const) {
    await store(fixture(minute, { ...office, accountId }));
  }
  const extracted = await features(current);
  expect(extracted.sharedDeviceAccounts24h).toBe(2);
  expect(extracted.sharedNetworkAccounts24h).toBe(2);
  expect(extracted.deviceContext?.networkReputation).toEqual({ source: 'simulated_network_telemetry', level: 'shared_activity' });
  const risk = scoreRisk(current.kind, extracted, policy);
  expect(risk.preliminaryAction).toBe('ALLOW');
  expect(risk.needsInvestigation).toBe(false);
  expect(describeDeviceEvidence(extracted, risk).evidence.map((fact) => fact.id))
    .toEqual(['shared_device', 'shared_network']);
});

it('excludes already received future-dated activity even for a future-dated target', async () => {
  const accountId = 'acct-future-device';
  const now = Date.now();
  const future = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const earlier = fixture(0, { accountId, timestamp: future(-2), deviceId: 'dev-past-known' });
  const current = fixture(0, { accountId, timestamp: future(10), deviceId: 'dev-future-unknown' });
  await store(earlier);
  await store(fixture(0, { ...current, id: randomUUID(), timestamp: future(2) }));
  const result = await features(current);
  expect(result.priorLoginId).toBe(earlier.id);
  expect(result.deviceContext?.deviceActivity30d).toBe(0);
  expect(result.newDevice).toBe(true);
});
