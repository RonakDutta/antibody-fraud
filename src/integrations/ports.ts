export type ContextMatch = { id: string | null; score: number | null };
export type ContextSearch = { matches: ContextMatch[] };

export interface MemoryReader {
  search(query: string, signal: AbortSignal): Promise<ContextSearch>;
}

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export interface StructuredModel {
  readonly provider: string;
  readonly model: string;
  generate(
    instruction: string, data: string, schema: object, signal: AbortSignal,
  ): Promise<{ text: string; usage: ModelUsage }>;
}

export class DependencyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DependencyError';
  }
}

export function failureCode(error: unknown, signal: AbortSignal, defaultCode: string) {
  if (signal.aborted) return 'timeout';
  return error instanceof DependencyError ? error.code : defaultCode;
}
