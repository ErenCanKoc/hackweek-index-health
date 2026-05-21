import pg from 'pg';

let lockPool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!lockPool) {
    lockPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10000),
      idleTimeoutMillis: 10000
    });
  }
  return lockPool;
}

function appStateKey() {
  return process.env.APP_STATE_KEY || 'default';
}

export async function withStateMutationLock(taskName, task) {
  const pool = getPool();
  if (!pool) return task();

  const client = await pool.connect();
  const lockScope = `${appStateKey()}:state_mutation`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [lockScope, 'exclusive']);
    return await task();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [lockScope, 'exclusive']);
    } finally {
      client.release();
    }
  }
}
