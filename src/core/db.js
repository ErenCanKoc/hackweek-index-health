import pg from 'pg';

let databasePool = null;

function isWorkerProcess() {
  const command = process.argv.join(' ');
  return /run-(csv-import-tasks|csv-import-job|sitemap-fetch-job|scheduler)\.mjs/.test(command);
}

function numericEnv(...names) {
  for (const name of names) {
    const value = Number(process.env[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function poolMax() {
  const configured = numericEnv('DATABASE_POOL_MAX');
  if (configured) return configured;
  const command = process.argv.join(' ');
  if (/run-csv-import-(tasks|job)\.mjs/.test(command)) {
    return numericEnv('DATABASE_CSV_JOB_POOL_MAX', 'DATABASE_WORKER_POOL_MAX') ?? 1;
  }
  if (/run-sitemap-fetch-job\.mjs/.test(command)) {
    return numericEnv('DATABASE_SITEMAP_JOB_POOL_MAX', 'DATABASE_WORKER_POOL_MAX') ?? 1;
  }
  if (isWorkerProcess()) {
    return numericEnv('DATABASE_WORKER_POOL_MAX') ?? 1;
  }
  return numericEnv('DATABASE_LITE_POOL_MAX', 'DATABASE_WEB_POOL_MAX') ?? 4;
}

function connectionTimeoutMillis() {
  const configured = numericEnv('DATABASE_CONNECTION_TIMEOUT_MS');
  if (configured) return configured;
  return isWorkerProcess() ? 10000 : 2500;
}

function queryTimeoutMillis() {
  const configured = numericEnv('DATABASE_QUERY_TIMEOUT_MS');
  if (configured) return configured;
  return isWorkerProcess() ? null : 8000;
}

export function getDatabasePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!databasePool) {
    const queryTimeout = queryTimeoutMillis();
    databasePool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: poolMax(),
      connectionTimeoutMillis: connectionTimeoutMillis(),
      idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 10000),
      ...(queryTimeout ? { query_timeout: queryTimeout } : {})
    });
  }
  return databasePool;
}

export function isConnectionCapacityError(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'EMAXCONNSESSION'
    || message.includes('max clients reached')
    || message.includes('remaining connection slots')
    || message.includes('too many clients');
}
