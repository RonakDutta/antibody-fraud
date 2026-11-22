import { z } from 'zod';
import type { Config } from '../config.js';
import { DependencyError, type ModelUsage, type StructuredModel } from './ports.js';

const count = z.int().nonnegative().nullish();
const geminiResponse = z.object({
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({
      parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })),
    }).optional(),
  })).optional(),
  usageMetadata: z.object({
    promptTokenCount: count, candidatesTokenCount: count, thoughtsTokenCount: count, totalTokenCount: count,
  }).optional(),
});
const ollamaResponse = z.object({
  message: z.object({ content: z.string() }),
  done: z.literal(true),
  done_reason: z.string().optional(),
  prompt_eval_count: count,
  eval_count: count,
});

export class ModelHttpError extends DependencyError {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super('model_http_' + status);
  }
}

async function post(url: string, data: object, signal: AbortSignal, headers?: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    const wait = response.headers.get('retry-after');
    const seconds = wait !== null && /^\d+(?:\.\d+)?$/.test(wait) ? Number(wait) * 1000 : null;
    const date = wait !== null && seconds === null ? Date.parse(wait) : NaN;
    throw new ModelHttpError(response.status, seconds ?? (Number.isFinite(date) ? Math.max(0, date - Date.now()) : null));
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new DependencyError('model_invalid_envelope');
  }
}

class GeminiModel implements StructuredModel {
  readonly provider = 'gemini';
  constructor(readonly model: string, private readonly key: string) {}

  async generate(instruction: string, data: string, schema: object, signal: AbortSignal) {
    const payload = await post(
      'https://generativelanguage.googleapis.com/v1beta/models/' + this.model + ':generateContent',
      {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: 'user', parts: [{ text: data }] }],
        generationConfig: {
          responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 1024, temperature: 0,
        },
      },
      signal, { 'x-goog-api-key': this.key },
    );
    const parsed = geminiResponse.safeParse(payload);
    if (!parsed.success) throw new DependencyError('model_invalid_envelope');
    const candidate = parsed.data.candidates?.[0];
    const usage = parsed.data.usageMetadata;
    return {
      text: candidate?.finishReason === 'STOP'
        ? candidate.content?.parts.filter((part) => !part.thought).map((part) => part.text ?? '').join('') ?? ''
        : '',
      usage: {
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: usage?.candidatesTokenCount ?? null,
        reasoningTokens: usage?.thoughtsTokenCount ?? null,
        totalTokens: usage?.totalTokenCount ?? null,
      } satisfies ModelUsage,
    };
  }
}

export class OllamaModel implements StructuredModel {
  readonly provider = 'ollama';
  constructor(readonly model: string) {}

  async generate(instruction: string, data: string, schema: object, signal: AbortSignal) {
    const payload = await post('http://127.0.0.1:11434/api/chat', {
      model: this.model,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, num_predict: 384 },
      messages: [{ role: 'system', content: instruction + '\\nExact JSON schema: ' + JSON.stringify(schema) }, { role: 'user', content: data }],
    }, signal);
    const parsed = ollamaResponse.safeParse(payload);
    if (!parsed.success) throw new DependencyError('model_invalid_envelope');
    return {
      text: parsed.data.done_reason === 'length' ? '' : parsed.data.message.content,
      usage: {
        inputTokens: parsed.data.prompt_eval_count ?? null,
        outputTokens: parsed.data.eval_count ?? null,
        reasoningTokens: null,
        totalTokens: null,
      } satisfies ModelUsage,
    };
  }
}

const groqResponse = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ content: z.string().nullable().optional() }),
  })),
  usage: z.object({
    prompt_tokens: count, completion_tokens: count, total_tokens: count,
    completion_tokens_details: z.object({ reasoning_tokens: count }).nullish(),
  }).optional(),
});

class GroqModel implements StructuredModel {
  readonly provider = 'groq';
  constructor(readonly model: string, private readonly key: string, private readonly mode: Config['GROQ_JSON_MODE']) {}

  async generate(instruction: string, data: string, schema: object, signal: AbortSignal) {
    const constrained = this.mode !== 'json_object';
    const payload = await post('https://api.groq.com/openai/v1/chat/completions', {
      model: this.model,
      temperature: 0,
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: instruction + (constrained ? '' : '\\nExact JSON schema: ' + JSON.stringify(schema)) },
        { role: 'user', content: data },
      ],
      response_format: constrained
        ? { type: 'json_schema', json_schema: { name: 'assessment', strict: this.mode === 'strict', schema } }
        : { type: 'json_object' },
    }, signal, { Authorization: 'Bearer ' + this.key });
    const parsed = groqResponse.safeParse(payload);
    if (!parsed.success) throw new DependencyError('model_invalid_envelope');
    const choice = parsed.data.choices[0];
    const usage = parsed.data.usage;
    return {
      text: choice?.finish_reason === 'stop' ? choice.message.content ?? '' : '',
      usage: {
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
      },
    };
  }
}

export function createModel(config: Config, investigator = false): StructuredModel | undefined {
  if (config.LLM_PROVIDER === 'gemini' && config.GEMINI_API_KEY) {
    return new GeminiModel(config.GEMINI_MODEL, config.GEMINI_API_KEY);
  }
  if (config.LLM_PROVIDER === 'groq' && config.GROQ_API_KEY) {
    return new GroqModel(investigator ? config.GROQ_INVESTIGATOR_MODEL ?? config.GROQ_MODEL : config.GROQ_MODEL,
      config.GROQ_API_KEY, config.GROQ_JSON_MODE);
  }
  if (config.LLM_PROVIDER === 'ollama') return new OllamaModel(config.OLLAMA_MODEL);
}

export function createFallbackModel(config: Config) {
  return config.LLM_OLLAMA_FALLBACK === 'on' && config.LLM_PROVIDER !== 'ollama'
    ? new OllamaModel(config.OLLAMA_MODEL) : undefined;
}
