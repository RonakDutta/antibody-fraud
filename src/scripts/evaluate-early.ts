import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CaseService } from '../cases.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import { earlyScenarios, evaluateEarlyCorpus, generateEarlyCorpus, type EarlyCorpus, type EvaluationDecision } from '../early-scenarios.js';
import { createFallbackModel, createModel } from '../integrations/models.js';
import { createLearning } from '../wiring.js';

const modes = ['rules', 'agents', 'meko'] as const;
type Mode = typeof modes[number];

function readOptions() {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'evaluation' },
      seed: { type: 'string', default: '7403' },
      events: { type: 'string', default: '160' },
      scenario: { type: 'string', default: 'all' },
      mode: { type: 'string', default: 'rules' },
      profile: { type: 'string', default: 'extended' },
      json: { type: 'boolean' },
    },
  });
  return z.strictObject({
    suite: z.enum(['development', 'evaluation']),
    seed: z.coerce.number().int().min(0).max(999_999_999),
    events: z.coerce.number().int().min(20).max(50_000),
    scenario: z.enum(['all', ...earlyScenarios]),
    mode: z.enum(['all', ...modes]),
    profile: z.enum(['legacy', 'extended']),
    json: z.boolean().optional(),
  }).parse(values);
}

async function evaluateMode(mode: Mode, corpus: EarlyCorpus, schema: string, config: ReturnType<typeof loadConfig>, profile: 'legacy' | 'extended') {
  const admin = createPool(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL, '-c search_path=' + schema);
  try {
    const provider = mode === 'rules' ? undefined : createModel(config);
    if (mode !== 'rules' && !provider) {
      throw new Error('Set a live provider for agent evaluation. For example LLM_PROVIDER=ollama.');
    }
    const learning = mode === 'meko' ? createLearning(pool, config) : undefined;
    if (mode === 'meko' && !learning?.hasPack('confirmed') && !learning?.hasPack('risk')) {
      throw new Error('Configure Meko credentials and at least one datapack for Meko mode.');
    }

    // The name is generated locally from a random token and a fixed mode.
    await admin.query('CREATE SCHEMA ' + schema);
    await migrate(pool);
    console.error('Evaluating', mode, 'in', schema, 'with', corpus.events.length, 'synthetic attempts');

    const investigationOptions = {
      mode, collective: true, advanced: profile === 'extended', publishProvisional: false, learning, model: provider,
      investigatorModel: mode === 'rules' ? undefined : createModel(config, true),
      fallbackModel: mode === 'rules' ? undefined : createFallbackModel(config),
      memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
    };
    const service = new CaseService(pool, { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD }, investigationOptions);
    const decisions = new Map<string, EvaluationDecision>();
    const roleMix: Record<string, { cases: number; modelCalls: number; validatedResults: number }> = {};
    const started = performance.now();
    for (const [index, event] of corpus.events.entries()) {
      // Truth, scenario names and synthetic challenge responses remain in this CLI.
      const { case: row } = await service.ingest(event);
      if (row.status !== 'decided' || !row.action) throw new Error('Evaluation case did not settle: ' + event.id);
      const roles = row.trace.team ?? (row.trace.agent ? [row.trace.agent] : []);
      let measuredUsageCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const role of roles) {
        const mix = roleMix[role.agentId] ??= { cases: 0, modelCalls: 0, validatedResults: 0 };
        mix.cases++;
        mix.modelCalls += role.attempts.length;
        if (role.result) mix.validatedResults++;
        for (const { usage } of role.attempts) {
          if (!usage) continue;
          if (usage.inputTokens !== null || usage.outputTokens !== null) measuredUsageCalls++;
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
        }
      }
      const trace = row.trace as typeof row.trace & { provisionalSignals?: readonly unknown[] };
      const ranked = (trace.specialistContexts ?? []).flatMap(({ context }) =>
        context.status === 'ok' && context.lookup === 'search' ? [context] : [],
      );
      decisions.set(event.id, {
        action: row.action, modelCalls: row.trace.modelCalls, measuredUsageCalls, inputTokens, outputTokens,
        latencyMs: trace.durationMs, verifiedReuse: Boolean(trace.reuse),
        priorObservationCount: trace.provisionalSignals?.length,
        rankedSearches: ranked.length, rankedHits: ranked.reduce((sum, context) => sum + context.matches.length, 0),
        rejectedCandidates: trace.rejectedMemories?.length,
      });
      if ((index + 1) % 100 === 0) console.error(mode, 'processed', index + 1, 'of', corpus.events.length);
    }
    return {
      mode, profile, schema, provider: provider?.provider ?? null, model: provider?.model ?? null,
      retrievalScope: mode === 'meko' ? 'ordinary ranked. Fresh local registry. This sweep does not queue or publish new observations.' : 'disabled',
      policyThresholds: { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD },
      wallMs: Math.round(performance.now() - started), roleMix,
      ...evaluateEarlyCorpus(corpus, decisions),
    };
  } finally {
    await pool.end();
    await admin.end();
  }
}

async function main() {
  const options = readOptions();
  const config = loadConfig();
  const corpus = generateEarlyCorpus({
    split: options.suite, seed: options.seed, maxEvents: options.events,
    scenario: options.scenario === 'all' ? undefined : options.scenario,
  });
  const tag = randomBytes(8).toString('hex');
  const runs = [];
  for (const mode of options.mode === 'all' ? modes : [options.mode]) {
    runs.push(await evaluateMode(mode, corpus, 'contextcon_eval_' + tag + '_' + mode, config, options.profile));
  }
  if (options.json) {
    console.log(JSON.stringify({
      corpus: { split: corpus.split, seed: corpus.seed, requestedMaxEvents: corpus.maxEvents, scenario: options.scenario }, runs,
    }, null, 2));
    return;
  }
  console.table(runs.map((run) => ({
    mode: run.mode, profile: run.profile, events: run.eventCount,
    precision: run.classification.precision, recall: run.classification.recall, f1: run.classification.f1,
    falsePositiveRate: run.classification.falsePositiveRate, legitimateStepUpRate: run.legitimateStepUpRate,
    attacksBeforeImpact: run.attacks.alertedBeforeImpact + '/' + run.attacks.total,
    preventedBeforeImpact: run.attacks.preventedBeforeImpact, preventedAtImpact: run.attacks.preventedAtImpact,
    executed: run.attacks.executed,
    calls: run.telemetry.totalCalls, input: run.telemetry.inputTokens, output: run.telemetry.outputTokens,
  })));
  console.log('Use --json for per-scenario results, latency, gate outcomes and trace schema names.');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:Set a live provider|Configure Meko|Evaluation case did not settle|Use an integer seed)/.test(message)) console.error(message);
  else console.error('Early evaluation failed. Check arguments, PostgreSQL and provider configuration.');
  process.exitCode = 1;
});