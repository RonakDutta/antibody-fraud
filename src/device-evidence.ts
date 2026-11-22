import type { Features } from './features.js';
import type { Evidence, RiskAssessment } from './risk.js';

export const DEVICE_AGENT = 'contextcon-device-ip';

const topics = new Map([
  ['new_device', 'unfamiliar device history'],
  ['impossible_travel', 'impossible travel from earlier login'],
  ['shared_device', 'devices shared across accounts'],
  ['shared_network', 'networks shared across accounts'],
  ['device_geo_change', 'large geographic change may be legitimate travel'],
  ['session_device_change', 'device change within active session'],
  ['session_network_change', 'network change within active session'],
  ['unfamiliar_device_failed_auth', 'repeated failed authentication on an unfamiliar device'],
  ['simulated_network_auth_pressure', 'simulated multi-account authentication pressure'],
  ['new_network', 'network absence from account history'],
]);

export function describeDeviceEvidence(features: Features, risk: RiskAssessment) {
  const device = features.deviceContext;
  const evidence: Evidence[] = risk.evidence.filter((item) => topics.has(item.id));

  // These facts guide the Device/IP review. They add no policy points.
  function add(condition: boolean, id: string, detail: string) {
    if (condition) evidence.push({ id, detail, points: 0, provenance: 'postgres_features' });
  }

  add((features.distanceKm ?? 0) >= 500 && !evidence.some((item) => item.id === 'impossible_travel'),
    'device_geo_change', 'The previous successful login was at least 500 km away. Evaluate elapsed time and legitimate travel explanations');
  add(device?.sessionTransition?.deviceChanged === true,
    'session_device_change', 'The synthetic device changed within the same account session in 30 minutes');
  add(device?.sessionTransition?.networkChanged === true,
    'session_network_change', 'The synthetic network changed within the same account session in 30 minutes');
  add(features.newDevice && features.historyCount30d > 0 && (device?.failedLoginsOnDevice15m ?? 0) >= 2,
    'unfamiliar_device_failed_auth', 'At least two earlier failed logins on the unfamiliar synthetic device in 15 minutes');
  add(device?.networkReputation.level === 'elevated_auth_pressure',
    'simulated_network_auth_pressure', 'Simulated network telemetry contains at least six failed logins across three accounts in 15 minutes');
  add(features.historyCount30d > 0 && device?.networkActivity30d === 0,
    'new_network', 'The synthetic network is absent from this account history in 30 days');

  return {
    evidence,
    queryTopics: evidence.map((item) => topics.get(item.id)!),
    // Send numerical summaries and booleans to the model. Raw synthetic identifiers
    // and event references remain in the deterministic case trace.
    input: {
      deviceActivity30d: device?.deviceActivity30d ?? null,
      deviceSuccessfulLogins30d: device?.deviceSuccessfulLogins30d ?? null,
      networkActivity30d: device?.networkActivity30d ?? null,
      failedLoginsOnDevice15m: device?.failedLoginsOnDevice15m ?? null,
      failedAuthOnNetwork15m: device?.failedAuthOnNetwork15m ?? null,
      failedAuthAccountsOnNetwork15m: device?.failedAuthAccountsOnNetwork15m ?? null,
      networkReputation: device?.networkReputation ?? null,
      changedDeviceWithinSession: device?.sessionTransition?.deviceChanged ?? null,
      changedNetworkWithinSession: device?.sessionTransition?.networkChanged ?? null,
      distanceKm: features.distanceKm === null ? null : Math.round(features.distanceKm),
      travelSpeedKmh: features.travelSpeedKmh === null ? null : Math.round(features.travelSpeedKmh),
      sharedDeviceAccounts24h: features.sharedDeviceAccounts24h,
      sharedNetworkAccounts24h: features.sharedNetworkAccounts24h,
    },
  };
}
