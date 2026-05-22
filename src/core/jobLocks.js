import { getDatabasePool, isConnectionCapacityError } from './db.js';

function getPool() {
  return getDatabasePool();
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

  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    if (isConnectionCapacityError(error)) {
      const busyError = new Error('Database is busy; retry this operation shortly.');
      busyError.code = 'EDATABASEBUSY';
      busyError.cause = error;
      throw busyError;
    }
    throw error;
  }
  const lockScope = `${appStateKey()}:state_mutation`;
  const waitIntervalMs = Math.max(1000, Number(options.waitIntervalMs ?? 15000));
  const maxWaitMs = Number.isFinite(Number(options.maxWaitMs)) && Number(options.maxWaitMs) > 0
    ? Number(options.maxWaitMs)
    : null;
  const lockLabel = taskName || 'state_mutation';
  const startedAt = Date.now();
  let acquired = false;
  try {
    for (;;) {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
        [lockScope, 'exclusive']
      );
      if (result.rows[0]?.acquired) {
        acquired = true;
        break;
      }
      if (maxWaitMs && Date.now() - startedAt >= maxWaitMs) {
        const error = new Error(`State mutation lock wait exceeded ${maxWaitMs}ms for ${lockLabel}.`);
        error.code = 'ESTATELOCKTIMEOUT';
        throw error;
      }
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
      if (acquired) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [lockScope, 'exclusive']);
      }
    } finally {
      client.release();
    }
  }
}
