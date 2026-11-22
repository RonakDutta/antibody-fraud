import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

export function createPool(connectionString: string, options?: string) {
  return new pg.Pool({ connectionString, options, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
}

export async function inTransaction<T>(pool: pg.Pool, work: (db: pg.PoolClient) => Promise<T>) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export async function migrate(pool: pg.Pool) {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No migrations found');

  return inTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':contextcon-migrations', 0))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const applied = new Map(
      (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations'))
        .rows.map((row) => [row.name, row.checksum]),
    );
    const newlyApplied: string[] = [];
    for (const name of files) {
      const sql = (await readFile(new URL(name, directory), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error('Applied migration changed: ' + name);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      newlyApplied.push(name);
    }
    return newlyApplied;
  });
}
