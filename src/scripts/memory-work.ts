import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool } from '../database.js';
import { createLearning } from '../wiring.js';

const { values } = parseArgs({ options: { watch: { type: 'boolean' } } });
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
try {
  const learning = createLearning(pool, config);
  if (!learning?.hasPack('confirmed') && !learning?.hasPack('risk')) {
    throw new Error('configure_memory_packs');
  }
  do {
    const job = await learning.workOne();
    if (job) console.log(JSON.stringify({
      publicationId: job.id, pack: job.pack, state: job.state, attempts: job.attempts, memoryId: job.remote_id,
      operation: job.last_operation, error: job.last_error, nextCheckAt: job.next_check_at,
    }));
    if (!job && values.watch) await pause(1500);
  } while (values.watch && !stopping);
} catch (error) {
  console.error(error instanceof Error && error.message === 'configure_memory_packs'
    ? 'Configure your Meko datapacks before running the publication worker.' : 'Publication worker failed. Check PostgreSQL and migrations.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
