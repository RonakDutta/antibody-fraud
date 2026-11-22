import { describe, expect, it } from 'vitest';
import { eventSchema } from '../src/events.js';
import { generateScenario, scenarios } from '../src/simulator.js';
import { scoreRisk } from '../src/risk.js';
import type { Features } from '../src/features.js';

const policy = { challenge: 25, block: 72 };
const lowRisk: Features = {
  historyCount30d: 10, failedLogins15m: 0, passwordResets30m: 0, transfers10m: 0,
  newDevice: false, newPayee: false, payeeAgeMinutes: null, amountMinor: null,
  amountHistoryCount: 4, historicalAmountMean: 6000, amountRatio: null, priorLoginId: null,
  distanceKm: null, travelSpeedKmh: null, sharedDeviceAccounts24h: 0, sharedNetworkAccounts24h: 0,
  behaviourSamples: 4, behaviourDeviations: { dwell: 0.2, flight: 0.4, interaction: 0.3 }, behaviourOutliers: 0,
};

describe('synthetic event contract', () => {
  it('has stable IDs, chronology, coverage and separate labels', () => {
    const runs = scenarios.map((scenario) => generateScenario(22, scenario));
    const events = runs.flatMap((run) => run.events);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    for (const [index, scenario] of scenarios.entries()) {
      expect(runs[index]).toEqual(generateScenario(22, scenario));
      expect(runs[index]?.events.map((event) => event.timestamp)).toEqual(
        runs[index]?.events.map((event) => event.timestamp).sort());
    }
    const sample = events[0]!;
    expect(generateScenario(23, 'ordinary').events[0]!.id).not.toBe(sample.id);
    expect(eventSchema.safeParse({ ...sample, fraud: true }).success).toBe(false);
    expect(events.every((event) => !('scenario' in event) && !('fraud' in event))).toBe(true);
    expect(events.every((event) => scenarios.every((scenario) => !JSON.stringify(event).includes(scenario)))).toBe(true);
  });

  it('validates kind-specific fields and rejects malformed or extra data', () => {
    const [login, transfer] = generateScenario(22, 'ordinary').events;
    expect(eventSchema.safeParse({ ...transfer, amountMinor: -15 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...login, amountMinor: 10 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...login, deviceId: 'not-synthetic' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...login, timestamp: '2000-01-01' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...login, location: { latitude: 91, longitude: 0 } }).success).toBe(false);
  });
});

describe('simulated risk policy', () => {
  it('allows ordinary activity and shared identifiers alone', () => {
    expect(scoreRisk('login', lowRisk, policy).preliminaryAction).toBe('ALLOW');
    const shared = scoreRisk('login', { ...lowRisk, sharedDeviceAccounts24h: 4, sharedNetworkAccounts24h: 5 }, policy);
    expect(shared.score).toBe(12);
    expect(shared.preliminaryAction).toBe('ALLOW');
  });

  it('uses behavioural drift as one signal', () => {
    expect(scoreRisk('login', { ...lowRisk, behaviourOutliers: 3 }, policy).preliminaryAction).toBe('ALLOW');
    const outcome = scoreRisk('login', { ...lowRisk, newDevice: true, behaviourOutliers: 3 }, policy);
    expect(outcome.preliminaryAction).toBe('STEP_UP_VERIFICATION');
    expect(outcome.evidence.map((item) => item.id)).toEqual(['new_device', 'behaviour_shift']);
  });

  it('requires multiple corroborating signals for a block', () => {
    const event = {
      ...lowRisk, amountMinor: 90000, amountRatio: 15, transfers10m: 4, newPayee: true,
      payeeAgeMinutes: 5, newDevice: true,
    };
    expect(scoreRisk('transfer', event, policy).preliminaryAction).toBe('BLOCK');
    expect(scoreRisk('transfer', { ...event, transfers10m: 0 }, policy).preliminaryAction).toBe('STEP_UP_VERIFICATION');
    expect(scoreRisk('transfer', event, { ...policy, block: 100 }).preliminaryAction).toBe('STEP_UP_VERIFICATION');
  });
});
