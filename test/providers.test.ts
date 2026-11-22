import { afterEach, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import type { Features } from '../src/features.js';
import { createModel, ModelHttpError } from '../src/integrations/models.js';
import type { StructuredModel } from '../src/integrations/ports.js';
import { investigate } from '../src/investigation.js';

afterEach(() => vi.unstubAllGlobals());

it('uses native Groq strict JSON and reports provider usage without reasoning text', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}', reasoning: 'do not expose' } }],
    usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35, completion_tokens_details: { reasoning_tokens: 5 } },
  }));
  vi.stubGlobal('fetch', fetcher);
  const config = configSchema.parse({
    DATABASE_URL: 'postgresql://localhost/db', LLM_PROVIDER: 'groq', GROQ_API_KEY: 'fixture',
    GROQ_INVESTIGATOR_MODEL: 'openai/gpt-oss-120b',
  });
  const schema = { type: 'object', properties: { status: { enum: ['ok'] } }, required: ['status'], additionalProperties: false };
  const model = createModel(config, true)!;
  expect(await model.generate('health check', 'synthetic', schema, AbortSignal.timeout(2000))).toEqual({
    text: '{"status":"ok"}', usage: { inputTokens: 15, outputTokens: 20, totalTokens: 35, reasoningTokens: 5 },
  });
  const [url, request] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  expect(JSON.parse(String(request.body))).toMatchObject({
    model: 'openai/gpt-oss-120b', response_format: { type: 'json_schema', json_schema: { strict: true, schema } },
  });
});

it('reads a provider Retry-After and preserves bounded Ollama fallback telemetry', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } })));
  const config = configSchema.parse({ DATABASE_URL: 'postgresql://localhost/db', LLM_PROVIDER: 'groq', GROQ_API_KEY: 'fixture' });
  await expect(createModel(config)!.generate('health', 'synthetic', {}, AbortSignal.timeout(2000))).rejects.toMatchObject({
    code: 'model_http_429', retryAfterMs: 12000,
  });
  const primary: StructuredModel = { provider: 'groq-fixture', model: 'cloud', generate: vi.fn(async () => { throw new ModelHttpError(429, 12_000); }) };
  const fallback: StructuredModel = { provider: 'ollama-fixture', model: 'local', generate: vi.fn(async () => ({
    text: JSON.stringify({ riskScore: 25, confidence: 0.6, evidenceIds: ['behaviour_shift'], missingContext: [],
      recommendedAction: 'ALLOW', rationale: 'A synthetic timing shift occurred.' }),
    usage: { inputTokens: 12, outputTokens: 9, reasoningTokens: null, totalTokens: 21 },
  })) };
  const features = { failedLogins15m: 0, passwordResets30m: 0, behaviourSamples: 6, behaviourDeviations: {} } as Features;
  const risk = {
    evidence: [{ id: 'behaviour_shift', detail: 'Synthetic', points: 18, provenance: 'postgres_features' as const }],
    score: 30, thresholds: { challenge: 25, block: 72 }, hardBlock: false, needsInvestigation: true,
    preliminaryAction: 'STEP_UP_VERIFICATION' as const,
  };
  const result = await investigate('fixture', features, risk, {
    mode: 'agents', model: primary, fallbackModel: fallback, memoryTimeoutMs: 100, modelTimeoutMs: 100,
  });
  expect(result.agent?.attempts).toMatchObject([
    { provider: 'groq-fixture', status: 'rejected', error: 'model_http_429', fallback: false },
    { provider: 'ollama-fixture', status: 'accepted', fallback: true, usage: { outputTokens: 9 } },
  ]);
  expect(primary.generate).toHaveBeenCalledTimes(1);
  expect(fallback.generate).toHaveBeenCalledTimes(1);
});
