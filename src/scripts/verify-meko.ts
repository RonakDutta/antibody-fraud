import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HostedMekoReader, readMekoDatapack } from '../integrations/meko.js';
import { failureCode } from '../integrations/ports.js';

function readArgs() {
  try {
    const { values } = parseArgs({
      options: {
        query: { type: 'string', default: 'Synthetic account takeover login timing' },
        'expected-memory-id': { type: 'string' },
      },
    });
    return z.object({
      query: z.string().trim().min(1).max(512),
      'expected-memory-id': z.uuid().optional(),
    }).safeParse(values).data;
  } catch {
    return undefined;
  }
}

const options = readArgs();
const key = process.env.MEKO_API_KEY;
const id = z.uuid().safeParse(process.env.MEKO_DATAPACK_ID);
if (!options) {
  console.error('Usage: npm run verify:meko -- [--query "synthetic phrase"] [--expected-memory-id <UUID>]');
  process.exitCode = 1;
} else if (!key || !id.success) {
  console.error('Set MEKO_API_KEY and a valid MEKO_DATAPACK_ID in .env. See MANUAL_SETUP.md.');
  process.exitCode = 1;
} else {
  const signal = AbortSignal.timeout(20_000);
  const log = (event: string, fields: Record<string, unknown>) => console.log(event, JSON.stringify(fields));
  try {
    await readMekoDatapack(key, id.data, signal, log);
    console.log('Authenticated Meko REST datapack read succeeded.');
    const result = await new HostedMekoReader(key, id.data).search(options.query, signal, log);
    console.log('Authenticated Meko MCP memory_search succeeded. Matches:', result.matches.length);
    console.log('Matches with an ID:', result.matches.filter((row) => row.id).length);
    const riskPack = z.uuid().safeParse(process.env.MEKO_RISK_SIGNALS_DATAPACK_ID);
    if (process.env.MEKO_RISK_SIGNALS_DATAPACK_ID && (!riskPack.success || riskPack.data.toLowerCase() === id.data.toLowerCase())) {
      throw new Error('Configure a distinct risk-signals UUID');
    }
    if (riskPack.success) {
      const riskSignal = AbortSignal.timeout(20_000);
      await readMekoDatapack(key, riskPack.data, riskSignal, log);
      const riskResult = await new HostedMekoReader(key, riskPack.data).search(options.query, riskSignal, log);
      console.log('Risk-signals REST and MCP verified with the same API key. Matches:', riskResult.matches.length);
    } else {
      console.log('Risk-signals pack unconfigured.');
    }
    const expected = options['expected-memory-id'];
    if (expected) {
      const found = result.matches.some((row) => row.id?.toLowerCase() === expected.toLowerCase());
      console.log('Expected synthetic memory found:', found ? 'yes' : 'no');
      if (!found) process.exitCode = 1;
    }
  } catch (error) {
    console.error('Meko check failed (' + failureCode(error, signal, 'connection_error') + '). See MANUAL_SETUP.md.');
    process.exitCode = 1;
  }
}
