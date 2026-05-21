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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withStateMutationLock(taskName, task, options = {}) {
  const pool = getPool();
  if (!pool) return task();

  const client = await pool.connect();
  const lockScope = `${appStateKey()}:state_mutation`;
  const waitIntervalMs = Math.max(1000, Number(options.waitIntervalMs ?? 15000));
  const lockLabel = taskName || 'state_mutation';
  try {
    for (;;) {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
        [lockScope, 'exclusive']
      );
      if (result.rows[0]?.acquired) break;
      if (typeof options.onWait === 'function') {
        await options.onWait({ taskName: lockLabel, waitedAt: new Date().toISOString() });
      }
      await sleep(waitIntervalMs);
    }
    if (typeof options.onAcquired === 'function') {
      await options.onAcquired({ taskName: lockLabel, acquiredAt: new Date().toISOString() });
    }
    return await task();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [lockScope, 'exclusive']);
    } finally {
      client.release();
    }
  }
}
