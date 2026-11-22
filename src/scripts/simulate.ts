import { parseArgs } from 'node:util';
import { z } from 'zod';
import { generateScenario, scenarios } from '../simulator.js';
import { actionSchema } from '../risk.js';

const { values } = parseArgs({ options: {
  seed: { type: 'string', default: '22' }, scenario: { type: 'string', default: 'all' },
  emit: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
} });
const seed = z.coerce.number().int().min(0).max(999_999_999).parse(values.seed);
const selection = z.enum(['all', ...scenarios]).parse(values.scenario);
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 3001);
const responseSchema = z.object({
  duplicate: z.boolean(),
  case: z.object({
    action: actionSchema.nullable(), status: z.enum(['pending', 'decided']),
    trace: z.object({
      path: z.string(), risk: z.object({ score: z.number() }), modelCalls: z.number(),
    }),
  }),
});
const rows = [];

for (const scenario of selection === 'all' ? scenarios : [selection]) {
  const run = generateScenario(seed, scenario);
  for (const event of run.events) {
    if (values.emit) {
      console.log(JSON.stringify(event));
      continue;
    }
    const response = await fetch('http://127.0.0.1:' + port + '/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
      signal: AbortSignal.timeout(1_000_000),
    });
    if (!response.ok) throw new Error('Ingestion failed with HTTP ' + response.status + ' for ' + event.id);
    const result = responseSchema.parse(await response.json());
    if (result.case.status === 'pending') throw new Error('Case ' + event.id + ' is pending. Retry the same seed after it finishes.');
    rows.push({
      eventId: event.id, kind: event.kind, ...run.labels.get(event.id),
      action: result.case.action, score: result.case.trace.risk.score, path: result.case.trace.path,
      providerCalls: result.case.trace.modelCalls, duplicate: result.duplicate,
    });
  }
}

if (!values.emit && values.json) console.log(JSON.stringify({ seed, rows }, null, 2));
else if (!values.emit) {
  console.table(rows.filter((row) => row.fraud || row.path !== 'fast').map((row) => ({
    scenario: row.scenario, kind: row.kind, label: row.fraud ? 'fraud' : 'legitimate',
    action: row.action, score: row.score, path: row.path, calls: row.providerCalls, caseId: row.eventId,
  })));
  console.log('Processed', rows.length, 'events, including', rows.filter((row) => row.duplicate).length, 'duplicates.');
}
