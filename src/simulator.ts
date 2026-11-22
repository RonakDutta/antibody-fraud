import { createHash } from 'node:crypto';
import { eventSchema, type FraudEvent } from './events.js';

export const scenarios = ['ordinary', 'takeover', 'credential-stuffing', 'velocity', 'shared-identifiers', 'legitimate-travel'] as const;
export type Scenario = (typeof scenarios)[number];
export type Label = { scenario: Scenario; fraud: boolean; attackStep?: number; impactStep?: number };
export type ScenarioRun = { events: FraudEvent[]; labels: ReadonlyMap<string, Label> };

const locations = {
  home: { latitude: 19.076, longitude: 72.8777 },
  far: { latitude: 51.5072, longitude: -0.1276 },
};
const typical = { dwellMs: 101, flightMs: 148, interactionMs: 640 };
const unusual = { dwellMs: 28, flightMs: 36, interactionMs: 170 };

function hash(value: string) {
  return createHash('sha256').update(value).digest();
}

function deterministicId(key: string) {
  const bytes = hash(key).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function generateScenario(seed: number, scenario: Scenario): ScenarioRun {
  const namespace = seed + '-' + scenario;
  const handle = hash('synthetic-account-v1:' + namespace).subarray(0, 12).toString('hex');
  const day = Date.parse('2026-10-01T12:00:00.000Z');
  const accountId = 'acct-' + handle;
  const normalDevice = 'dev-' + handle;
  const alternateDevice = normalDevice + '-alternate';
  const normalNetwork = 'net-' + handle;
  const usualPayee = 'payee-' + handle;
  const newPayee = usualPayee + '-new';
  const events: FraudEvent[] = [];
  const labels = new Map<string, Label>();
  type EventDetails = {
    accountId?: string;
    deviceId?: string;
    networkId?: string;
    location?: FraudEvent['location'];
    behaviour?: FraudEvent['behaviour'];
    payeeId?: string;
    amountMinor?: number;
  };

  function emit(minutes: number, kind: FraudEvent['kind'], details: EventDetails = {}, attackStep?: number, impactStep?: number) {
    const id = deterministicId('synthetic-event-v1:' + namespace + ':' + events.length);
    events.push(eventSchema.parse({
      id, timestamp: new Date(day + minutes * 60_000).toISOString(), accountId, kind,
      deviceId: normalDevice, networkId: normalNetwork, location: locations.home, ...details,
    }));
    labels.set(id, { scenario, fraud: attackStep !== undefined, attackStep, impactStep });
  }

  for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
    const jitter = hash(namespace + ':' + daysAgo)[0]! % 9 - 4;
    emit(-1440 * daysAgo, 'login', {
      behaviour: { dwellMs: typical.dwellMs + jitter, flightMs: typical.flightMs - jitter, interactionMs: typical.interactionMs + jitter },
    });
    emit(-1440 * daysAgo + 10, 'transfer', { payeeId: usualPayee, amountMinor: 6000 + jitter * 100 });
  }

  switch (scenario) {
    case 'ordinary':
      emit(0, 'login', { behaviour: typical });
      emit(2, 'transfer', { payeeId: usualPayee, amountMinor: 7200 });
      break;
    case 'takeover': {
      const changed = { deviceId: alternateDevice, behaviour: unusual };
      emit(0, 'login', changed, 1, 4);
      emit(2, 'password_reset', changed, 2, 4);
      emit(4, 'payee_added', { ...changed, payeeId: newPayee }, 3, 4);
      emit(5, 'transfer', { ...changed, payeeId: newPayee, amountMinor: 80_000 }, 4, 4);
      break;
    }
    case 'credential-stuffing': {
      emit(0, 'login', { behaviour: typical });
      const changed = { deviceId: alternateDevice, location: locations.far };
      for (let step = 1; step <= 3; step++) emit(step, 'login_failed', changed, step, 4);
      emit(4, 'login', { ...changed, behaviour: unusual }, 4, 4);
      break;
    }
    case 'velocity':
      emit(0, 'payee_added', { payeeId: newPayee }, 1, 5);
      for (let step = 2; step <= 4; step++) {
        emit(step - 1, 'transfer', { payeeId: usualPayee, amountMinor: 7000 }, step, 5);
      }
      emit(4, 'transfer', { payeeId: newPayee, amountMinor: 95_000 }, 5, 5);
      break;
    case 'shared-identifiers': {
      const reused = { deviceId: alternateDevice, networkId: normalNetwork + '-shared' };
      emit(0, 'login', { ...reused, accountId: accountId + '-one' }, 1, 4);
      emit(1, 'login', { ...reused, accountId: accountId + '-two' }, 2, 4);
      emit(2, 'login', { ...reused, behaviour: unusual }, 3, 4);
      emit(3, 'transfer', { ...reused, payeeId: newPayee, amountMinor: 52_000 }, 4, 4);
      break;
    }
    case 'legitimate-travel':
      emit(0, 'login', { deviceId: alternateDevice, location: locations.far, behaviour: typical });
      emit(2, 'transfer', { deviceId: alternateDevice, location: locations.far, payeeId: usualPayee, amountMinor: 6200 });
      break;
  }
  return { events, labels };
}
