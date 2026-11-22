import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DEVICE_AGENT } from './device-evidence.js';
import { inTransaction } from './database.js';
import type { ContextSearch } from './integrations/ports.js';
import { failureCode } from './integrations/ports.js';
import { MekoRateLimit, MekoWriteNotSent } from './integrations/meko.js';
import type { AgentTrace, Investigation } from './investigation.js';
import type { RiskAssessment } from './risk.js';

export const LOGIN_AGENT = 'contextcon-behaviour-login';
export const GRAPH_AGENT = 'contextcon-graph';
export const TRANSFER_AGENT = 'contextcon-transactions';
export const FINGERPRINT_QUERY = 'ContextCon suspicious transfer interaction timing shift recently registered payee unusual amount';
const signature = ['behaviour_shift', 'fresh_payee', 'amount_spike'] as const;
const ruleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const documentSchema = z.strictObject({
  format: z.literal('contextcon-learning-v1'),
  publicationId: z.uuid(),
  kind: z.enum(['observation', 'fingerprint']),
  originCase: z.uuid(),
  originAgent: z.enum([LOGIN_AGENT, TRANSFER_AGENT, DEVICE_AGENT, GRAPH_AGENT]),
  feedbackCase: z.uuid().nullable(),
  verification: z.enum(['provisional', 'analyst_confirmed']),
  version: z.int().positive(),
  supersedes: z.uuid().nullable(),
  evidence: z.array(ruleSchema).min(1).max(12),
  required: z.array(ruleSchema).max(12),
});
export type LearningDocument = z.infer<typeof documentSchema>;
export type Pack = 'risk' | 'confirmed';
type RecordHit = { id: string | null; text: string | null };
export interface MemoryGateway {
  search(query: string, agentId: string, signal: AbortSignal): Promise<ContextSearch & { records: RecordHit[] }>;
  recent(agentId: string, signal: AbortSignal): Promise<RecordHit[]>;
  read(id: string, agentId: string, signal: AbortSignal): Promise<RecordHit | null>;
  write(text: string, agentId: string, signal: AbortSignal): Promise<string | null>;
}

export const feedbackSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.literal('fraud_confirmed') }),
  z.strictObject({ verdict: z.literal('legitimate_correction'), publicationId: z.uuid(), require: z.literal('recent_reset') }),
]);
export type Feedback = z.infer<typeof feedbackSchema>;
export const fingerprintRevocationSchema = z.strictObject({
  reason: z.enum(['invalid_confirmation', 'incorrect_generalization']),
});
type FingerprintRevocation = z.infer<typeof fingerprintRevocationSchema>;
type Publication = {
  id: string; pack: Pack; document: LearningDocument;
  state: 'pending' | 'sending' | 'indexing' | 'uncertain' | 'published' | 'failed';
  remote_id: string | null; attempts: number; superseded_at: Date | null;
  next_check_at: Date; last_error: string | null; last_operation: string | null;
  write_acknowledged_at: Date | null; last_checked_at: Date | null; verified_at: Date | null;
  revoked_at: Date | null; revocation_reason: FingerprintRevocation['reason'] | null;
};
type CaseEvidence = {
  status: string;
  trace: { risk: RiskAssessment; eventKind: string; team?: Investigation['team']; reuse?: Reuse | null };
};
export type Reuse = {
  publicationId: string; memoryId: string; originCase: string; originAgent: string;
  retrievingAgent: string; version: number; evidence: string[]; skippedAgent: string;
};
export type ProvisionalSignal = {
  memoryId: string; originCase: string; originAgent: string; receivingAgent: string;
  evidenceIds: string[]; crossSession: boolean; sourceOccurredAt: string;
};
export class FeedbackError extends Error {
  constructor(readonly code: string) { super(code); }
}

function encode(document: LearningDocument) {
  const heading = document.kind === 'fingerprint' ? FINGERPRINT_QUERY : 'ContextCon provisional specialist observation';
  return heading + '\nContextCon publication ' + document.publicationId + '\n' + JSON.stringify(document);
}

function decode(text: string | null) {
  if (!text || text.length > 6000) return;
  const json = text.split('\n').at(-1);
  if (!json) return;
  try {
    return documentSchema.safeParse(JSON.parse(json)).data;
  } catch {
    return undefined;
  }
}

function matches(risk: RiskAssessment, required: readonly string[]) {
  const current = new Set(risk.evidence.map((item) => item.id));
  return required.every((id) => current.has(id));
}

async function enqueue(db: pg.PoolClient, pack: Pack, document: LearningDocument, caseId: string) {
  await db.query(`
    INSERT INTO memory_publications (id, case_id, pack, kind, document)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [document.publicationId, caseId, pack, document.kind, JSON.stringify(document)]);
}

export class LearningService {
  private blockedUntil = 0;

  constructor(
    private readonly pool: pg.Pool, private readonly packs: Partial<Record<Pack, MemoryGateway>>,
    private readonly timeoutMs: number, private readonly scopeConfirmed = false,
  ) {}

  hasPack(pack: Pack) { return Boolean(this.packs[pack]); }

  async recordObservation(db: pg.PoolClient, caseId: string, agent: AgentTrace | undefined) {
    if (!this.packs.risk || !agent?.result?.evidence.length) return;
    const originAgent = z.enum([LOGIN_AGENT, TRANSFER_AGENT, DEVICE_AGENT, GRAPH_AGENT]).safeParse(agent.agentId).data;
    if (!originAgent) return;
    await enqueue(db, 'risk', {
      format: 'contextcon-learning-v1', publicationId: randomUUID(), kind: 'observation',
      originCase: caseId, originAgent, feedbackCase: null, verification: 'provisional',
      version: 1, supersedes: null, evidence: agent.result.evidence.map((item) => item.id), required: [],
    }, caseId);
  }

  async feedback(caseId: string, request: Feedback) {
    if (!this.packs.confirmed) throw new FeedbackError('confirmed_pack_unconfigured');
    return inTransaction(this.pool, async (db) => {
      const row = (await db.query<CaseEvidence>('SELECT status, trace FROM cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
      if (!row || row.status !== 'decided') throw new FeedbackError('decided_case_required');
      const canonical = JSON.stringify(request);
      const previous = (await db.query<{ same: boolean }>(
        'SELECT request = $2::jsonb AS same FROM analyst_feedback WHERE case_id = $1', [caseId, canonical],
      )).rows[0];
      if (previous) {
        if (!previous.same) throw new FeedbackError('feedback_conflict');
        return (await db.query<Publication>('SELECT * FROM memory_publications WHERE case_id = $1 AND kind = $2', [caseId, 'fingerprint'])).rows[0]!;
      }
      if (row.trace.eventKind !== 'transfer' || !matches(row.trace.risk, signature)) throw new FeedbackError('case_outside_supported_pattern');

      let document: LearningDocument;
      const publicationId = randomUUID();
      if (request.verdict === 'fraud_confirmed') {
        const origin = row.trace.team?.find((item) => item.agentId === LOGIN_AGENT);
        if (!origin?.result?.evidenceIds.includes('behaviour_shift')) throw new FeedbackError('verified_specialist_evidence_required');
        document = {
          format: 'contextcon-learning-v1', publicationId, kind: 'fingerprint', originCase: caseId,
          originAgent: LOGIN_AGENT, feedbackCase: caseId, verification: 'analyst_confirmed', version: 1,
          supersedes: null, evidence: row.trace.risk.evidence.map((item) => item.id), required: [...signature],
        };
      } else {
        const old = (await db.query<Publication>(`
          SELECT * FROM memory_publications WHERE id = $1 AND pack = 'confirmed'
            AND state = 'published' AND superseded_at IS NULL AND revoked_at IS NULL FOR UPDATE
        `, [request.publicationId])).rows[0];
        if (!old || row.trace.reuse?.publicationId !== old.id || old.document.originCase === caseId || old.document.required.includes(request.require) ||
            !matches(row.trace.risk, old.document.required) || matches(row.trace.risk, [request.require]) ||
            !old.document.evidence.includes(request.require)) throw new FeedbackError('correction_not_supported_by_evidence');
        await db.query('UPDATE memory_publications SET superseded_at = clock_timestamp() WHERE id = $1', [old.id]);
        document = { ...old.document, publicationId, feedbackCase: caseId, supersedes: old.id,
          version: old.document.version + 1, required: [...old.document.required, request.require] };
      }
      await db.query('INSERT INTO analyst_feedback (case_id, request) VALUES ($1, $2)', [caseId, canonical]);
      await enqueue(db, 'confirmed', document, caseId);
      return (await db.query<Publication>('SELECT * FROM memory_publications WHERE id = $1', [publicationId])).rows[0]!;
    });
  }

  async revokeFingerprint(publicationId: string, reason: FingerprintRevocation['reason']) {
    const result = await this.pool.query<Publication>(`
      UPDATE memory_publications
      SET revoked_at = COALESCE(revoked_at, clock_timestamp()), revocation_reason = $2
      WHERE id = $1 AND pack = 'confirmed' AND state = 'published' AND superseded_at IS NULL
        AND (revoked_at IS NULL OR revocation_reason = $2)
      RETURNING *
    `, [publicationId, reason]);
    const row = result.rows[0];
    if (!row) throw new FeedbackError('fingerprint_revocation_not_applicable');
    return row;
  }

  async pubs(caseId: string) {
    return (await this.pool.query<Publication>('SELECT * FROM memory_publications WHERE case_id = $1 ORDER BY kind', [caseId])).rows;
  }

  async recall(pack: Pack, query: string, agentId: string) {
    const gateway = this.packs[pack];
    if (!gateway) return;
    if (pack !== 'confirmed' || !this.scopeConfirmed) {
      return { ...await gateway.search(query, agentId, AbortSignal.timeout(this.timeoutMs)), lookup: 'search' as const };
    }

    // Demo schemas own their pointer registry. Fetch the evidence from Meko, including
    // superseded versions so the same validation path records why D rejected them.
    const pointers = (await this.pool.query<{ remote_id: string }>(`
      SELECT remote_id FROM memory_publications WHERE pack = 'confirmed' AND state = 'published'
      ORDER BY (superseded_at IS NULL AND revoked_at IS NULL) DESC, verified_at DESC LIMIT 10
    `)).rows;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const records = (await Promise.all(pointers.map(({ remote_id }) => gateway.read(remote_id, agentId, signal))))
      .filter((record) => record !== null);
    return { records, matches: records.map(({ id }) => ({ id, score: null })), lookup: 'exact_id' as const };
  }

  async previousSignals(caseId: string, receivingAgent: string): Promise<ProvisionalSignal[]> {
    const gateway = this.packs.risk;
    if (!gateway) return [];
    const candidates = await this.pool.query<{
      document: LearningDocument; remote_id: string; cross_session: boolean; occurred_at: Date;
    }>(`
      SELECT p.document, p.remote_id, COALESCE(src.payload->>'sessionId' <> target.payload->>'sessionId', false) AS cross_session,
        src.occurred_at
      FROM cases current_case
      JOIN events target ON target.id = current_case.id
      JOIN events src ON src.account_id = target.account_id
        AND src.occurred_at < LEAST(target.occurred_at, current_case.created_at)
        AND src.occurred_at >= LEAST(target.occurred_at, current_case.created_at) - interval '30 minutes'
      JOIN memory_publications p ON p.case_id = src.id AND p.pack = 'risk' AND p.kind = 'observation'
        AND p.state = 'published' AND p.superseded_at IS NULL AND p.verified_at <= current_case.created_at
      WHERE current_case.id = $1 AND p.document->>'originAgent' <> $2
      ORDER BY src.occurred_at DESC, p.id LIMIT 2
    `, [caseId, receivingAgent]);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const records = await Promise.all(candidates.rows.map(async (candidate): Promise<ProvisionalSignal | null> => {
      const record = await gateway.read(candidate.remote_id, receivingAgent, signal);
      if (record?.id !== candidate.remote_id || record.text !== encode(candidate.document)) return null;
      const document = decode(record.text);
      if (document?.kind !== 'observation' || document.verification !== 'provisional') return null;
      return {
        memoryId: record.id, originCase: document.originCase, originAgent: document.originAgent, receivingAgent,
        evidenceIds: document.evidence, crossSession: candidate.cross_session, sourceOccurredAt: candidate.occurred_at.toISOString(),
      };
    }));
    return records.filter((record) => record !== null);
  }

  async validateRecall(caseId: string, risk: RiskAssessment, result: { records: RecordHit[] }, pointInTime = false) {
    const rejected: { memoryId: string; reason: string }[] = [];
    let reuse: Reuse | null = null;
    for (const hit of result.records) {
      const document = decode(hit.text);
      if (!hit.id || !document || document.kind !== 'fingerprint' || document.verification !== 'analyst_confirmed') continue;
      const published = (await this.pool.query<{ active: boolean; revoked: boolean; exact: boolean; fresh: boolean; distinct_account: boolean; known_at_event: boolean }>(`
        SELECT m.superseded_at IS NULL AS active, m.revoked_at IS NOT NULL AS revoked, document = $3::jsonb AS exact,
          m.verified_at >= clock_timestamp() - interval '30 days' AS fresh,
          source.account_id <> target.account_id AS distinct_account,
          (source.occurred_at < LEAST(target.occurred_at, target_case.created_at)
            AND m.verified_at <= target_case.created_at) AS known_at_event
        FROM memory_publications m
        JOIN events source ON source.id = $4
        JOIN events target ON target.id = $5
        JOIN cases target_case ON target_case.id = target.id
        WHERE m.id = $1 AND remote_id = $2 AND pack = 'confirmed' AND state = 'published'
      `, [document.publicationId, hit.id, JSON.stringify(document), document.originCase, caseId])).rows[0];
      const reason = !published?.exact ? 'unverified' : published.revoked ? 'revoked' : !published.active ? 'superseded' :
        pointInTime && !published.known_at_event ? 'unavailable_at_event' :
        !published.fresh ? 'stale' : !published.distinct_account ? 'same_account' : !matches(risk, document.required) ? 'conditions_not_met' : null;
      if (reason) {
        rejected.push({ memoryId: hit.id, reason });
        continue;
      }
      reuse ??= {
        publicationId: document.publicationId, memoryId: hit.id, originCase: document.originCase,
        originAgent: document.originAgent, retrievingAgent: TRANSFER_AGENT, version: document.version,
        evidence: document.required, skippedAgent: LOGIN_AGENT,
      };
    }
    return { reuse, rejected };
  }

  async workOne(publicationId?: string, attemptLimit = 10) {
    if (Date.now() < this.blockedUntil) return null;
    const configured = (['risk', 'confirmed'] as const).filter((pack) => this.packs[pack]);
    const job = (await this.pool.query<Publication & { previous: Publication['state'] }>(`
      WITH candidate AS (
        SELECT id, state FROM memory_publications
        WHERE pack = ANY($1::text[]) AND state IN ('pending', 'sending', 'indexing', 'uncertain')
          AND attempts < $3 AND next_check_at <= clock_timestamp()
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY (state <> 'pending'), next_check_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE memory_publications m SET
        state = CASE WHEN candidate.state = 'pending' THEN 'sending' ELSE candidate.state END,
        attempts = m.attempts + 1, next_check_at = clock_timestamp() + interval '90 seconds'
      FROM candidate WHERE m.id = candidate.id RETURNING m.*, candidate.state AS previous
    `, [configured, publicationId ?? null, attemptLimit])).rows[0];
    if (!job) return null;
    const gateway = this.packs[job.pack]!;
    let remoteId = job.remote_id;
    let state: Publication['state'] = job.previous === 'indexing' ? 'indexing' : 'uncertain';
    let operation = job.previous === 'pending' ? 'write' : remoteId ? 'exact_id' : 'marker_search';
    let error: string | null = null;
    let acknowledged = false;
    let rateLimited = false;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let delayMs = Math.min(60_000, 2000 * 2 ** Math.min(5, job.attempts - 1));
    try {
      const expected = encode(job.document);
      if (operation === 'write') {
        remoteId = await gateway.write(expected, job.document.originAgent, signal);
        state = 'indexing';
        acknowledged = true;
      } else {
        let records = remoteId
          ? [await gateway.read(remoteId, job.document.originAgent, signal)]
          : (await gateway.search('ContextCon publication ' + job.id, job.document.originAgent, signal)).records;
        const findExpected = () => records.find((hit) => hit?.id && (!remoteId || hit.id === remoteId) && hit.text === expected);
        let stored = findExpected();
        if (!stored && !remoteId) {
          operation = 'recent_inventory';
          records = await gateway.recent(job.document.originAgent, signal);
          stored = findExpected();
        }
        if (stored?.id) {
          remoteId = stored.id;
          state = 'published';
        } else {
          error = remoteId && records.some((hit) => hit?.id === remoteId)
            ? 'document_mismatch' : 'not_visible';
        }
      }
    } catch (failure) {
      error = failureCode(failure, signal, 'remote_publication_error');
      if (failure instanceof MekoWriteNotSent) {
        state = /meko_http_(401|403|404)|meko_unrecognized_response/.test(failure.code) ? 'failed' : 'pending';
      }
      if (failure instanceof MekoRateLimit || failure instanceof MekoWriteNotSent && failure.retryAfterMs !== undefined) {
        delayMs = Math.max(delayMs, failure.retryAfterMs ?? 60_000);
        this.blockedUntil = Date.now() + delayMs;
        rateLimited = true;
      }
    }
    const updated = await this.pool.query<Publication>(`
      UPDATE memory_publications SET state = $2, remote_id = $3, last_error = $4,
        next_check_at = clock_timestamp() + $6::double precision * interval '1 millisecond',
        verified_at = CASE WHEN $2 = 'published' THEN clock_timestamp() ELSE verified_at END,
        write_acknowledged_at = CASE WHEN $7 THEN clock_timestamp() ELSE write_acknowledged_at END,
        last_operation = $8, last_checked_at = clock_timestamp()
      WHERE id = $1 AND attempts = $5 RETURNING *
    `, [job.id, state, remoteId, error, job.attempts, delayMs, acknowledged, operation]);
    if (rateLimited) {
      await this.pool.query(`
        UPDATE memory_publications
        SET next_check_at = GREATEST(next_check_at, clock_timestamp() + $1::double precision * interval '1 millisecond')
        WHERE pack = ANY($2::text[]) AND state IN ('pending', 'sending', 'indexing', 'uncertain')
      `, [delayMs, configured]);
    }
    return updated.rows[0] ?? null;
  }
}
