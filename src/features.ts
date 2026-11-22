import type pg from 'pg';
import type { FraudEvent } from './events.js';

type Profile = { count: number; mean: number | null; sd: number | null };
type History = {
  history_count: number;
  failed_logins: number;
  recent_resets: number;
  recent_transfers: number;
  device_seen: boolean;
  device_activity: number;
  prior_device_logins: number;
  prior_device_last_seen: Date | null;
  account_network_activity: number;
  failures_on_device: number;
  failures_on_network: number;
  failed_accounts_on_network: number;
  prior_session_event: {
    eventId: string; timestamp: string; deviceChanged: boolean; networkChanged: boolean;
  } | null;
  payee_seen: boolean;
  payee_added_at: Date | null;
  amount_count: number;
  amount_mean: number | null;
  shared_device_accounts: number;
  shared_network_accounts: number;
  dwell: Profile;
  flight: Profile;
  interaction: Profile;
  prior_login: { id: string; timestamp: string; latitude: number; longitude: number } | null;
};

// Replay respects the event's clock and PostgreSQL's observation boundary.
const featureCutoff = 'LEAST($2::timestamptz, statement_timestamp())';

const featureQuery = `
  WITH history AS (
    SELECT * FROM events
      WHERE account_id = $1 AND received_at <= statement_timestamp() AND occurred_at < ${featureCutoff}
        AND occurred_at >= ${featureCutoff} - interval '30 days'
  ), profile AS (
    SELECT * FROM history WHERE kind = 'login' AND dwell_ms IS NOT NULL
      AND occurred_at < ${featureCutoff} - interval '1 hour'
      ORDER BY occurred_at DESC, id DESC LIMIT 50
  ), network_auth AS (
    SELECT count(*) FILTER (
      WHERE kind = 'login_failed' AND occurred_at >= ${featureCutoff} - interval '15 min'
    )::int AS failed_attempts,
    count(DISTINCT account_id) FILTER (
      WHERE kind = 'login_failed' AND occurred_at >= ${featureCutoff} - interval '15 min'
    )::int AS failed_accounts,
    count(DISTINCT account_id) FILTER (WHERE account_id <> $1 AND kind <> 'login_failed')::int AS shared_accounts
    FROM events
    WHERE network_id = $4 AND received_at <= statement_timestamp() AND occurred_at >= ${featureCutoff} - interval '24 hours' AND occurred_at < ${featureCutoff}
  )
  SELECT
    count(*)::int AS history_count,
    count(*) FILTER (WHERE kind = 'login_failed' AND occurred_at >= ${featureCutoff} - interval '15 min')::int
      AS failed_logins,
    count(*) FILTER (WHERE kind = 'password_reset' AND occurred_at >= ${featureCutoff} - interval '30 min')::int
      AS recent_resets,
    count(*) FILTER (WHERE kind = 'transfer' AND occurred_at >= ${featureCutoff} - interval '10 min')::int
      AS recent_transfers,
    coalesce(bool_or(device_id = $3 AND kind <> 'login_failed'), false) AS device_seen,
    count(*) FILTER (WHERE device_id = $3)::int AS device_activity,
    count(*) FILTER (WHERE device_id = $3 AND kind = 'login')::int AS prior_device_logins,
    max(occurred_at) FILTER (WHERE device_id = $3) AS prior_device_last_seen,
    count(*) FILTER (WHERE network_id = $4)::int AS account_network_activity,
    count(*) FILTER (
      WHERE device_id = $3 AND kind = 'login_failed' AND occurred_at >= ${featureCutoff} - interval '15 min'
    )::int AS failures_on_device,
    (SELECT failed_attempts FROM network_auth) AS failures_on_network,
    (SELECT failed_accounts FROM network_auth) AS failed_accounts_on_network,
    (SELECT jsonb_build_object('eventId', id, 'timestamp', occurred_at,
      'deviceChanged', device_id <> $3, 'networkChanged', network_id <> $4)
      FROM history WHERE $6::text IS NOT NULL AND payload->>'sessionId' = $6::text
        AND occurred_at >= ${featureCutoff} - interval '30 min'
      ORDER BY occurred_at DESC, id DESC LIMIT 1) AS prior_session_event,
    coalesce(bool_or(payee_id = $5 AND kind = 'transfer'), false) AS payee_seen,
    max(occurred_at) FILTER (WHERE payee_id = $5 AND kind = 'payee_added') AS payee_added_at,
    count(amount_minor) FILTER (WHERE occurred_at < ${featureCutoff} - interval '1 hour')::int AS amount_count,
    avg(amount_minor) FILTER (WHERE occurred_at < ${featureCutoff} - interval '1 hour')::float8 AS amount_mean,
    (SELECT count(DISTINCT account_id)::int FROM events
      WHERE device_id = $3 AND received_at <= statement_timestamp() AND account_id <> $1 AND kind <> 'login_failed'
        AND occurred_at >= ${featureCutoff} - interval '24 hours' AND occurred_at < ${featureCutoff})
      AS shared_device_accounts,
    (SELECT shared_accounts FROM network_auth) AS shared_network_accounts,
    (SELECT jsonb_build_object('id', id, 'timestamp', occurred_at, 'latitude', latitude, 'longitude', longitude)
      FROM history WHERE kind = 'login' ORDER BY occurred_at DESC, id DESC LIMIT 1) AS prior_login,
    (SELECT jsonb_build_object('count', count(*), 'mean', avg(dwell_ms), 'sd', stddev_samp(dwell_ms))
      FROM profile) AS dwell,
    (SELECT jsonb_build_object('count', count(*), 'mean', avg(flight_ms), 'sd', stddev_samp(flight_ms))
      FROM profile) AS flight,
    (SELECT jsonb_build_object('count', count(*), 'mean', avg(interaction_ms), 'sd', stddev_samp(interaction_ms))
      FROM profile) AS interaction
  FROM history
`;

function distanceKm(from: FraudEvent['location'], to: FraudEvent['location']) {
  const rad = Math.PI / 180;
  const latitude = (to.latitude - from.latitude) * rad;
  const longitude = (to.longitude - from.longitude) * rad;
  const square = Math.sin(latitude / 2) ** 2 +
    Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.sin(longitude / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, square)));
}

function deviation(current: number, profile: Profile, floor: number) {
  if (profile.count < 3 || profile.mean === null || profile.sd === null) return null;
  return Math.abs(current - profile.mean) / Math.max(profile.sd, floor);
}

export async function extractFeatures(db: pg.PoolClient, event: FraudEvent) {
  const payeeId = 'payeeId' in event ? event.payeeId : null;
  const { rows: [history] } = await db.query<History>(featureQuery, [
    event.accountId, event.timestamp, event.deviceId, event.networkId, payeeId, event.sessionId ?? null,
  ]);
  if (!history) throw new Error('Feature query returned no row');
  const prior = history.prior_login;
  const elapsedHours = prior && (Date.parse(event.timestamp) - Date.parse(prior.timestamp)) / 3_600_000;
  const km = prior && distanceKm(prior, event.location);
  const payeeAgeMinutes = history.payee_added_at === null ? null :
    (Date.parse(event.timestamp) - history.payee_added_at.getTime()) / 60_000;
  const deviations = event.behaviour ? {
    dwell: deviation(event.behaviour.dwellMs, history.dwell, 15),
    flight: deviation(event.behaviour.flightMs, history.flight, 25),
    interaction: deviation(event.behaviour.interactionMs, history.interaction, 100),
  } : { dwell: null, flight: null, interaction: null };

  const networkReputation = syntheticNetworkReputation(
    history.failures_on_network, history.failed_accounts_on_network,
    history.shared_network_accounts, history.account_network_activity,
  );

  return {
    deviceContext: {
      deviceActivity30d: history.device_activity,
      deviceSuccessfulLogins30d: history.prior_device_logins,
      deviceLastSeenAt: history.prior_device_last_seen?.toISOString() ?? null,
      networkActivity30d: history.account_network_activity,
      failedLoginsOnDevice15m: history.failures_on_device,
      failedAuthOnNetwork15m: history.failures_on_network,
      failedAuthAccountsOnNetwork15m: history.failed_accounts_on_network,
      sessionTransition: history.prior_session_event,
      networkReputation,
    },
    historyCount30d: history.history_count,
    failedLogins15m: history.failed_logins,
    passwordResets30m: history.recent_resets,
    transfers10m: history.recent_transfers,
    newDevice: !history.device_seen,
    newPayee: payeeId !== null && !history.payee_seen,
    payeeAgeMinutes,
    amountMinor: 'amountMinor' in event ? event.amountMinor : null,
    amountHistoryCount: history.amount_count,
    historicalAmountMean: history.amount_mean,
    amountRatio: 'amountMinor' in event && history.amount_count >= 3 && history.amount_mean
      ? event.amountMinor / history.amount_mean : null,
    priorLoginId: prior?.id ?? null,
    distanceKm: km,
    travelSpeedKmh: km !== null && elapsedHours !== null && elapsedHours > 0 ? km / elapsedHours : null,
    sharedDeviceAccounts24h: history.shared_device_accounts,
    sharedNetworkAccounts24h: history.shared_network_accounts,
    behaviourSamples: history.dwell.count,
    behaviourDeviations: deviations,
    behaviourOutliers: Object.values(deviations).filter((value) => value !== null && value >= 3).length,
  };
}

function syntheticNetworkReputation(
  failures: number, failedAccounts: number, sharedAccounts: number, accountHistory: number,
) {
  const level = failures >= 6 && failedAccounts >= 3 ? 'elevated_auth_pressure'
    : sharedAccounts >= 2 ? 'shared_activity'
    : failures > 0 || sharedAccounts > 0 || accountHistory > 0 ? 'observed' : 'unknown';
  return { source: 'simulated_network_telemetry' as const, level };
}

type ExtractedFeatures = Awaited<ReturnType<typeof extractFeatures>>;
export type DeviceContext = ExtractedFeatures['deviceContext'];

// Older stored case traces remain readable and replayable after the device features are introduced.
export type Features = Omit<ExtractedFeatures, 'deviceContext'> & { deviceContext?: DeviceContext };
