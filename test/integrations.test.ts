import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HostedMekoReader, mekoMemoryGateway, parseMemorySearch } from '../src/integrations/meko.js';

const id = '5a6e415a-7b39-425d-a23e-d406e3e61980';

describe('Meko boundary with standalone payload fixtures', () => {
  it('accepts direct structured content or one JSON block and bounds the results', () => {
    const results = [{ id, score: 0.81, text: 'untrusted' }, { memory_id: id, score: 0.7 }, {}, {}];
    const expected = { matches: [{ id, score: 0.81 }, { id, score: 0.7 }, { id: null, score: null }] };
    expect(parseMemorySearch({ structuredContent: { results }, content: [] })).toEqual(expected);
    expect(parseMemorySearch({ content: [{ type: 'text', text: JSON.stringify({ results }) }] })).toEqual(expected);
  });

  it('decodes the hosted structured result before handling empty or populated search results', () => {
    expect(parseMemorySearch({ structuredContent: { result: '{"results":[]}' }, content: [] })).toEqual({ matches: [] });
    const rows = { results: [{ memory_id: id, score: 0.91, text: 'not exposed' }] };
    const result = parseMemorySearch({ structuredContent: { result: JSON.stringify(rows) }, content: [] });
    expect(result).toEqual({ matches: [{ id, score: 0.91 }] });
  });

  it('rejects wrapped tool errors, malformed JSON and unfamiliar shapes', () => {
    expect(() => parseMemorySearch({ isError: true, content: [] })).toThrow('meko_tool_error');
    expect(() => parseMemorySearch({ structuredContent: { results: [], detail: 'failure' }, content: [] })).toThrow('meko_tool_error');
    expect(() => parseMemorySearch({ structuredContent: { result: '{"error":{"code":"FORBIDDEN"}}' }, content: [] })).toThrow('meko_tool_error');
    expect(() => parseMemorySearch({ structuredContent: { result: 'bad JSON' }, content: [] })).toThrow('meko_unrecognized_response');
    expect(() => parseMemorySearch({ content: [{ type: 'text', text: 'no results' }] })).toThrow('meko_unrecognized_response');
  });
});

const fakeKey = 'fixture-key-private';
const fakeQuery = 'fixture-query-private';
const fakeSession = 'fixture-session-private';
const protocol = '2025-11-25';

function stubMcp(call: (id: number) => Response) {
  const requests: { method: string; headers: Headers; args?: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    requests.push({ method: body.method, headers, args: body.params?.arguments });
    const reply = (result: unknown, headers?: HeadersInit) => Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers });
    switch (body.method) {
      case 'initialize':
        return reply({ protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
          { 'Mcp-Session-Id': fakeSession });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        const fields = ['query', 'conversation_id', 'datapack_id', 'agent_id', 'limit', 'run_id'];
        return reply({ tools: [{ name: 'memory_search', inputSchema: {
          type: 'object', required: ['query', 'conversation_id'], additionalProperties: false,
          properties: Object.fromEntries(fields.map((field) => [field, { type: field === 'limit' ? 'integer' : 'string' }])),
        } }] });
      }
      case 'tools/call':
        return call(body.id);
      default:
        throw new Error('Unexpected fixture request');
    }
  }));
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('Meko MCP contract', () => {
  it('sends a fresh trace UUID and datapack on every read without creating a conversation', async () => {
    const requests = stubMcp((requestId) => Response.json({ jsonrpc: '2.0', id: requestId, result: {
      content: [{ type: 'text', text: '{"results":[]}' }],
      structuredContent: { result: '{"results":[]}' },
    } }));
    const diagnostics = vi.fn();
    const reader = new HostedMekoReader(fakeKey, id);
    const signal = AbortSignal.timeout(5000);
    expect(await reader.search(fakeQuery, signal, diagnostics)).toEqual({ matches: [] });
    expect(await reader.search(fakeQuery, signal)).toEqual({ matches: [] });

    const calls = requests.filter((request) => request.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => z.uuid().safeParse(call.args?.conversation_id).success)).toBe(true);
    expect(calls[0]?.args?.conversation_id).not.toBe(calls[1]?.args?.conversation_id);
    expect(calls[0]?.args).toMatchObject({ query: fakeQuery, datapack_id: id, limit: 3 });
    expect(calls[0]?.headers.get('Mcp-Protocol-Version')).toBe(protocol);
    expect(calls[0]?.headers.get('Mcp-Session-Id')).toBe(fakeSession);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer ' + fakeKey);
    expect(calls[0]?.headers.get('User-Agent')).toBe('contextcon-fraud-lab/0.1');
    expect(requests.filter((request) => request.method === 'tools/list')).toHaveLength(1);
    expect(diagnostics).toHaveBeenCalledWith('memory_search schema', expect.objectContaining({ required: ['query', 'conversation_id'] }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/fixture-(?:query|key|session)-private/);
  });

  it.each([
    ['HTTP', 403, { category: 'http', status: 403 }],
    ['JSON-RPC', 200, { category: 'json-rpc', rpcCode: -32602 }],
    ['tool validation', 200, { category: 'tool', field: 'conversation_id' }],
    ['wrapped parsing', 200, { category: 'parse', reason: 'invalid_structured_result_json' }],
  ] as const)('reports sanitized %s failures', async (kind, status, details) => {
    const privateEcho = [fakeKey, fakeQuery, fakeSession, id].join(' ');
    const throwResult = (requestId: number, result: unknown) => Response.json({ jsonrpc: '2.0', id: requestId, result }, { status });
    stubMcp((requestId) => {
      if (kind === 'HTTP') return new Response(privateEcho, { status });
      if (kind === 'JSON-RPC') {
        return Response.json({ jsonrpc: '2.0', id: requestId, error: { code: -32602, message: privateEcho } });
      }
      if (kind === 'tool validation') {
        return throwResult(requestId, { isError: true, content: [
          { type: 'text', text: 'Input validation error\nconversation_id\n  Missing required argument [input_value=' + privateEcho + ']' },
        ] });
      }
      return throwResult(requestId, { content: [], structuredContent: { result: privateEcho } });
    });
    const diagnostics = vi.fn();
    const reader = new HostedMekoReader(fakeKey, id);
    await expect(reader.search(fakeQuery, AbortSignal.timeout(5000), diagnostics)).rejects.toBeInstanceOf(Error);
    expect(diagnostics).toHaveBeenCalledWith('MCP failure', expect.objectContaining({ stage: 'memory_search', ...details }));
    const log = JSON.stringify(diagnostics.mock.calls);
    expect(log).not.toContain(fakeKey);
    expect(log).not.toContain(fakeQuery);
    expect(log).not.toContain(fakeSession);
    expect(log).not.toContain(id);
  });
});


it('fetches acknowledged Meko memories by exact ID and decodes the hosted memory field', async () => {
  const requests = stubMcp((requestId) => Response.json({
    jsonrpc: '2.0', id: requestId, result: {
      content: [],
      structuredContent: { result: JSON.stringify({ id, memory: 'synthetic marker' }) },
    },
  }));
  const remote = mekoMemoryGateway(fakeKey, id);
  expect(await remote.read(id, 'contextcon-transactions', AbortSignal.timeout(5000)))
    .toEqual({ id, text: 'synthetic marker' });
  const call = requests.find((item) => item.method === 'tools/call');
  expect(call?.args).toMatchObject({ memory_id: id, datapack_id: id, agent_id: 'contextcon-transactions' });
  expect(z.uuid().safeParse(call?.args?.conversation_id).success).toBe(true);
});

it('preserves the hosted HTTP 429 retry deadline for the worker', async () => {
  stubMcp(() => new Response(null, { status: 429, headers: { 'Retry-After': '37' } }));
  const remote = mekoMemoryGateway(fakeKey, id);
  await expect(remote.read(id, 'contextcon-transactions', AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'meko_http_429', retryAfterMs: 37000 });
});
