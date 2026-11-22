import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';

const pool = createPool(loadConfig().DATABASE_URL);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? 'Applied: ' + applied.join(', ') : 'Database migrations are current.');
} catch (error) {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : 'unknown';
  console.error('Migration failed (' + String(code) + '). Check the database connection and migration checksums.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
