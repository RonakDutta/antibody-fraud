import type pg from 'pg';
import type { FraudEvent } from './events.js';
import type { Evidence } from './risk.js';

type LinkType = 'device' | 'network' | 'payee' | 'session';
type Relationship = 'uses_device' | 'uses_network' | 'associated_payee' | 'uses_session';
type AccountNode = { type: 'account'; id: string };
type IdentifierNode = { type: LinkType; id: string };
type Edge = {
  edgeId: string;
  account: AccountNode;
  identifier: IdentifierNode;
  relationship: Relationship;
  eventId: string;
  eventKind: FraudEvent['kind'];
  occurredAt: string;
};
type GraphLink = {
  via: IdentifierNode;
  edges: [Edge, Edge];
};
type ConfirmedCase = { caseId: string; eventTime: string; confirmedAt: string };
type GraphPath = {
  pathId: string;
  accounts: string[];
  links: GraphLink[];
  recentAuthenticationRiskEvents: number;
  priorConfirmedCase: ConfirmedCase | null;
};

const limits = { historyHours: 24, accountHops: 2, branchesPerHop: 4, paths: 20 } as const;

export type GraphSnapshot = {
  root: AccountNode;
  eventKind: FraudEvent['kind'];
  eventTime: string;
  observedAt: string;
  limits: typeof limits;
  paths: GraphPath[];
  directAccountCounts: Record<LinkType, number>;
};

type Row = { observed_at: Date; paths: Omit<GraphPath, 'pathId'>[] };

// Resolve one account hop as two typed edges through a shared identifier. Limit the
// indexed slices before comparing identities so busy shared infrastructure stays cheap.
const graphQuery = `
  WITH RECURSIVE params AS (
    SELECT $1::text AS account_id, least($2::timestamptz, statement_timestamp()) AS cutoff,
      statement_timestamp() AS observed_at
  ), walk(account_id, depth, accounts, visited, links) AS (
    SELECT account_id, 0, ARRAY[account_id], ARRAY[]::text[], '[]'::jsonb FROM params
    UNION ALL
    SELECT branch.account_id, walk.depth + 1, array_append(walk.accounts, branch.account_id),
      array_append(walk.visited, branch.relation_type || ':' || branch.identifier_id),
      walk.links || jsonb_build_array(jsonb_build_object(
        'via', jsonb_build_object('type', branch.relation_type, 'id', branch.identifier_id),
        'edges', jsonb_build_array(
          jsonb_build_object(
            'edgeId', branch.source_id::text || ':' || branch.relation_type,
            'account', jsonb_build_object('type', 'account', 'id', walk.account_id),
            'identifier', jsonb_build_object('type', branch.relation_type, 'id', branch.identifier_id),
            'relationship', branch.relationship, 'eventId', branch.source_id,
            'eventKind', branch.source_kind, 'occurredAt', branch.source_time
          ),
          jsonb_build_object(
            'edgeId', branch.id::text || ':' || branch.relation_type,
            'account', jsonb_build_object('type', 'account', 'id', branch.account_id),
            'identifier', jsonb_build_object('type', branch.relation_type, 'id', branch.identifier_id),
            'relationship', branch.relationship, 'eventId', branch.id,
            'eventKind', branch.kind, 'occurredAt', branch.occurred_at
          )
        )
      ))
    FROM walk CROSS JOIN params
    CROSS JOIN LATERAL (
      SELECT candidate.*
      FROM (
        SELECT DISTINCT ON (anchor.priority, anchor.identifier_id, neighbour.account_id)
          anchor.*, neighbour.*
        FROM LATERAL (
          SELECT DISTINCT ON (identifier.priority, identifier.identifier_id)
            identifier.*, source.id AS source_id, source.kind AS source_kind,
            source.occurred_at AS source_time
          FROM LATERAL (
            SELECT $3::uuid AS id, $4::text AS kind, $2::timestamptz AS occurred_at,
              $5::text AS device_id, $6::text AS network_id, $7::text AS payee_id, $8::text AS session_id
            WHERE walk.depth = 0
            UNION ALL
            (
              SELECT id, kind, occurred_at, device_id, network_id, payee_id, payload->>'sessionId'
              FROM events
              WHERE walk.depth = 1 AND account_id = walk.account_id AND occurred_at < params.cutoff
                AND occurred_at >= params.cutoff - interval '24 hours' AND received_at <= params.observed_at
              ORDER BY occurred_at DESC, id DESC LIMIT 8
            )
          ) source
          CROSS JOIN LATERAL (
            VALUES
              (1, 'device', source.device_id, 'uses_device'),
              (2, 'session', source.session_id, 'uses_session'),
              (3, 'payee', source.payee_id, 'associated_payee'),
              (4, 'network', source.network_id, 'uses_network')
          ) identifier(priority, relation_type, identifier_id, relationship)
          WHERE identifier.identifier_id IS NOT NULL
            AND NOT (identifier.relation_type || ':' || identifier.identifier_id = ANY(walk.visited))
          ORDER BY identifier.priority, identifier.identifier_id, source.occurred_at DESC, source.id DESC
          LIMIT 8
        ) anchor
        CROSS JOIN LATERAL (
          SELECT id, account_id, kind, occurred_at
          FROM (
            (
              SELECT id, account_id, kind, occurred_at FROM events
              WHERE anchor.relation_type = 'device' AND device_id = anchor.identifier_id
                AND occurred_at < params.cutoff AND occurred_at >= params.cutoff - interval '24 hours'
                AND received_at <= params.observed_at
              ORDER BY occurred_at DESC, id DESC LIMIT 16
            )
            UNION ALL
            (
              SELECT id, account_id, kind, occurred_at FROM events
              WHERE anchor.relation_type = 'network' AND network_id = anchor.identifier_id
                AND occurred_at < params.cutoff AND occurred_at >= params.cutoff - interval '24 hours'
                AND received_at <= params.observed_at
              ORDER BY occurred_at DESC, id DESC LIMIT 16
            )
            UNION ALL
            (
              SELECT id, account_id, kind, occurred_at FROM events
              WHERE anchor.relation_type = 'payee' AND payee_id = anchor.identifier_id
                AND occurred_at < params.cutoff AND occurred_at >= params.cutoff - interval '24 hours'
                AND received_at <= params.observed_at
              ORDER BY occurred_at DESC, id DESC LIMIT 16
            )
            UNION ALL
            (
              SELECT id, account_id, kind, occurred_at FROM events
              WHERE anchor.relation_type = 'session' AND payload->>'sessionId' = anchor.identifier_id
                AND occurred_at < params.cutoff AND occurred_at >= params.cutoff - interval '24 hours'
                AND received_at <= params.observed_at
              ORDER BY occurred_at DESC, id DESC LIMIT 16
            )
          ) sample
          WHERE NOT (account_id = ANY(walk.accounts))
        ) neighbour
        ORDER BY anchor.priority, anchor.identifier_id, neighbour.account_id, neighbour.occurred_at DESC, neighbour.id DESC
      ) candidate
      ORDER BY row_number() OVER (
        PARTITION BY candidate.relation_type
        ORDER BY candidate.occurred_at DESC, candidate.id DESC, candidate.identifier_id, candidate.account_id
      ), candidate.priority
      LIMIT 4
    ) branch
    WHERE walk.depth < 2
  ), selected AS (
    SELECT account_id, depth, accounts, links, visited FROM walk WHERE depth > 0
    ORDER BY depth, accounts, visited LIMIT 20
  )
  SELECT params.observed_at, coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'accounts', selected.accounts, 'links', selected.links,
      'recentAuthenticationRiskEvents', recent.count,
      'priorConfirmedCase', proven.reference
    ) ORDER BY selected.depth, selected.accounts, selected.visited)
    FROM selected
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS count FROM (
        SELECT kind FROM events
        WHERE account_id = selected.account_id AND occurred_at < params.cutoff
          AND occurred_at >= params.cutoff - interval '10 minutes' AND received_at <= params.observed_at
        ORDER BY occurred_at DESC, id DESC LIMIT 64
      ) limited
      WHERE limited.kind IN ('login_failed', 'password_reset')
    ) recent
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'caseId', c.id, 'eventTime', e.occurred_at, 'confirmedAt', verification.created_at
      ) AS reference
      FROM (
        SELECT id, occurred_at FROM events
        WHERE account_id = selected.account_id AND occurred_at < params.cutoff
          AND occurred_at >= params.cutoff - interval '30 days' AND received_at <= params.observed_at
        ORDER BY occurred_at DESC, id DESC LIMIT 64
      ) e
      JOIN cases c ON c.id = e.id AND c.status = 'decided' AND c.decided_at <= params.observed_at
      JOIN analyst_feedback verification ON verification.case_id = c.id
        AND verification.request->>'verdict' = 'fraud_confirmed' AND verification.created_at <= params.observed_at
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
    ) proven ON true
  ), '[]'::jsonb) AS paths
  FROM params
`;

export async function extractGraph(db: pg.PoolClient, event: FraudEvent): Promise<GraphSnapshot> {
  const { rows: [result] } = await db.query<Row>(graphQuery, [
    event.accountId, event.timestamp, event.id, event.kind, event.deviceId, event.networkId,
    'payeeId' in event ? event.payeeId : null, event.sessionId ?? null,
  ]);
  if (!result) throw new Error('Graph query returned no snapshot');
  const directAccounts = { device: new Set<string>(), network: new Set<string>(),
    payee: new Set<string>(), session: new Set<string>() };
  const paths = result.paths.map((path, index) => {
    const link = path.links[0];
    const neighbour = path.accounts[1];
    if (path.links.length === 1 && link && neighbour) directAccounts[link.via.type].add(neighbour);
    return { pathId: 'path-' + (index + 1), ...path };
  });
  return {
    root: { type: 'account', id: event.accountId }, eventKind: event.kind, eventTime: event.timestamp,
    observedAt: result.observed_at.toISOString(), limits, paths,
    directAccountCounts: {
      device: directAccounts.device.size, network: directAccounts.network.size,
      payee: directAccounts.payee.size, session: directAccounts.session.size,
    },
  };
}
export function graphAssessment(snapshot: GraphSnapshot) {
  const evidence: Evidence[] = [];
  const topics: string[] = [];
  const supportingPaths = new Map<string, GraphPath>();
  function add(id: string, description: string, topic: string, paths: GraphPath[]) {
    if (!paths.length) return;
    const witnesses = paths.slice(0, 3);
    for (const path of witnesses) supportingPaths.set(path.pathId, path);
    evidence.push({
      id, detail: description + ' (' + witnesses.map(({ pathId }) => pathId).join(', ') + ')',
      points: 0, provenance: 'postgres_features',
    });
    topics.push(topic);
  }

  const deviceOrSession = (type: LinkType | undefined) => type === 'device' || type === 'session';
  const authentication = snapshot.eventKind === 'login' || snapshot.eventKind === 'login_failed' ||
    snapshot.eventKind === 'password_reset';
  const payment = snapshot.eventKind === 'payee_added' || snapshot.eventKind === 'transfer';
  const resetOrFailure = snapshot.paths.filter((path) => path.links.length === 1 &&
    deviceOrSession(path.links[0]?.via.type) && path.recentAuthenticationRiskEvents >= 2);
  const potentiallyRelated = new Set(resetOrFailure.map((path) => path.accounts.at(-1)));
  const corroboratedRecipients = snapshot.paths.filter((path) => path.links.length === 1 &&
    path.links[0]?.via.type === 'payee' && potentiallyRelated.has(path.accounts.at(-1)));
  const confirmedConnections = snapshot.paths.filter((path) => {
    if (!path.priorConfirmedCase) return false;
    if (path.links.length === 1) return resetOrFailure.includes(path);
    const types = new Set(path.links.map((link) => link.via.type));
    return (types.has('device') || types.has('session')) && types.size >= 2 && !types.has('network');
  });

  if (authentication) add('graph_coordinated_authentication',
    'A linked account on a shared device or session had at least two recent failed logins or resets',
    'corroborated multi-account authentication activity', resetOrFailure);
  if (payment) add('graph_coordinated_payment',
    'A shared recipient also links to an account with device or session overlap and recent authentication risk',
    'corroborated multi-account recipient activity', corroboratedRecipients);
  add('graph_confirmed_connection',
    'A corroborated relationship reaches a separate account with recorded analyst confirmation',
    'bounded path to an earlier analyst-confirmed case', confirmedConnections);

  return {
    evidence,
    input: {
      eventKind: snapshot.eventKind,
      eventTime: snapshot.eventTime,
      paths: [...supportingPaths.values()].map((path) => ({
        pathId: path.pathId,
        hops: path.links.map((link) => ({
          relationship: link.edges[0].relationship,
          observations: link.edges.map(({ eventKind, occurredAt }) => ({ eventKind, occurredAt })),
        })),
        recentAuthenticationRiskEvents: path.recentAuthenticationRiskEvents,
        confirmedAt: path.priorConfirmedCase?.confirmedAt ?? null,
      })),
    },
    query: 'ContextCon provisional graph evidence ' + topics.join(' '),
  };
}
