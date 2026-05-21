import pg from 'pg';
import { ingestBusinessWideCsvText, ingestGscCsvText } from './ingestion.js';
import { recalculatePriorities } from './priority.js';
import { Store } from './store.js';
import { nowIso } from './utils.js';
import { refreshDashboardCache } from './dashboardCache.js';
import { withStateMutationLock } from './jobLocks.js';

let jobPool = null;

function getJobPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!jobPool) {
    jobPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
  }
  return jobPool;
}

function appStateKey() {
  return process.env.APP_STATE_KEY || 'default';
}

function minutesEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function jobTimestamp(job) {
  return job?.updatedAt ?? job?.startedAt ?? job?.createdAt ?? null;
}

function staleReason(job, now = Date.now()) {
  if (!['queued', 'running'].includes(job?.status)) return null;
  const timestamp = Date.parse(jobTimestamp(job));
  if (!Number.isFinite(timestamp)) return null;
  const ageMinutes = (now - timestamp) / 60000;
  const queuedTimeout = minutesEnv('CSV_IMPORT_QUEUED_TIMEOUT_MINUTES', 30);
  const runningTimeout = minutesEnv('CSV_IMPORT_RUNNING_TIMEOUT_MINUTES', 120);

  if (job.status === 'queued' && ageMinutes > queuedTimeout) {
    return `Queued CSV import job exceeded ${queuedTimeout} minutes.`;
  }
  if (job.status === 'running' && ageMinutes > runningTimeout) {
    return `Running CSV import job exceeded ${runningTimeout} minutes.`;
  }
  return null;
}

export function defaultCsvImportProgress() {
  return {
    phase: 'queued',
    percent: 0,
    importedRows: 0,
    urlsAdded: 0,
    updatedAt: nowIso()
  };
}

function toJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    appStateKey: row.app_state_key,
    status: row.status,
    triggerMode: row.trigger_mode,
    options: row.options ?? {},
    progress: row.progress ?? defaultCsvImportProgress(),
    renderJob: row.render_job ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    startedAt: row.started_at?.toISOString?.() ?? row.started_at,
    finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
  };
}

export async function ensureCsvImportJobTable() {
  const pool = getJobPool();
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS csv_import_jobs (
      id BIGSERIAL PRIMARY KEY,
      app_state_key TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_mode TEXT NOT NULL DEFAULT 'local',
      options JSONB NOT NULL DEFAULT '{}'::jsonb,
      progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      render_job JSONB,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_csv_import_jobs_app_state_updated
      ON csv_import_jobs (app_state_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_csv_import_jobs_app_state_status
      ON csv_import_jobs (app_state_key, status);
  `);
  return true;
}

export async function createCsvImportJob(options = {}, triggerMode = 'local') {
  const pool = getJobPool();
  if (pool) {
    await ensureCsvImportJobTable();
    const result = await pool.query(
      `
        INSERT INTO csv_import_jobs (app_state_key, status, trigger_mode, options, progress)
        VALUES ($1, 'queued', $2, $3::jsonb, $4::jsonb)
        RETURNING *
      `,
      [appStateKey(), triggerMode, JSON.stringify(options), JSON.stringify(defaultCsvImportProgress())]
    );
    return toJob(result.rows[0]);
  }

  const store = await new Store().load();
  store.state.csvImportJobs ??= [];
  const job = store.insert('csvImportJobs', {
    status: 'queued',
    triggerMode,
    options,
    progress: defaultCsvImportProgress(),
    renderJob: null,
    result: null,
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    updatedAt: nowIso()
  });
  await store.save();
  return job;
}

export async function updateCsvImportJob(jobId, patch = {}) {
  const pool = getJobPool();
  if (pool) {
    await ensureCsvImportJobTable();
    const existing = await getCsvImportJob(jobId);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    const result = await pool.query(
      `
        UPDATE csv_import_jobs
        SET status = $3,
            trigger_mode = $4,
            options = $5::jsonb,
            progress = $6::jsonb,
            render_job = $7::jsonb,
            result = $8::jsonb,
            error = $9,
            started_at = $10,
            finished_at = $11,
            updated_at = now()
        WHERE app_state_key = $1 AND id = $2
        RETURNING *
      `,
      [
        appStateKey(),
        Number(jobId),
        next.status,
        next.triggerMode,
        JSON.stringify(next.options ?? {}),
        JSON.stringify(next.progress ?? defaultCsvImportProgress()),
        next.renderJob ? JSON.stringify(next.renderJob) : null,
        next.result ? JSON.stringify(next.result) : null,
        next.error ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null
      ]
    );
    return toJob(result.rows[0]);
  }

  const store = await new Store().load();
  const job = store.findById('csvImportJobs', Number(jobId));
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  await store.save();
  return job;
}

export async function getCsvImportJob(jobId) {
  const pool = getJobPool();
  if (pool) {
    await ensureCsvImportJobTable();
    const result = await pool.query(
      'SELECT * FROM csv_import_jobs WHERE app_state_key = $1 AND id = $2',
      [appStateKey(), Number(jobId)]
    );
    return toJob(result.rows[0]);
  }

  const store = await new Store().load();
  return store.findById('csvImportJobs', Number(jobId)) ?? null;
}

export async function listCsvImportJobs(limit = 10) {
  const pool = getJobPool();
  if (pool) {
    await ensureCsvImportJobTable();
    const result = await pool.query(
      `
        SELECT *
        FROM csv_import_jobs
        WHERE app_state_key = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [appStateKey(), Number(limit)]
    );
    return result.rows.map(toJob);
  }

  const store = await new Store().load();
  return (store.state.csvImportJobs ?? []).slice().reverse().slice(0, Number(limit));
}

export async function hasActiveCsvImportJob() {
  await recoverStaleCsvImportJobs().catch((error) => {
    console.error('Failed to recover stale CSV import jobs:', error.message);
  });
  const jobs = await listCsvImportJobs(5);
  return jobs.find((job) => ['queued', 'running'].includes(job.status)) ?? null;
}

export async function recoverStaleCsvImportJobs(limit = 10) {
  const jobs = await listCsvImportJobs(limit);
  const staleJobs = jobs
    .map((job) => ({ job, reason: staleReason(job) }))
    .filter((item) => item.reason);
  for (const { job, reason } of staleJobs) {
    await updateCsvImportJob(job.id, {
      status: 'failed',
      finishedAt: nowIso(),
      error: reason,
      progress: {
        ...(job.progress ?? defaultCsvImportProgress()),
        phase: 'failed',
        updatedAt: nowIso()
      }
    });
  }
  return staleJobs.map(({ job, reason }) => ({ id: job.id, reason }));
}

function createImportBatch(store, payload) {
  return store.insert('importBatches', {
    ...payload,
    status: 'applied',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

export async function executeCsvImportJob(jobId, options = {}) {
  let job = await getCsvImportJob(jobId);
  if (!job) throw new Error(`CSV import job ${jobId} not found.`);
  if (job.status === 'completed') return job.result;

  const startedAt = nowIso();
  job = await updateCsvImportJob(jobId, {
    status: 'running',
    startedAt,
    error: null,
    progress: { ...defaultCsvImportProgress(), phase: 'importing', updatedAt: startedAt }
  });

  return await withStateMutationLock('csv_import', async () => {
  try {
    const jobOptions = job.options ?? {};
    const csvText = String(jobOptions.csvText ?? jobOptions.csv ?? '').trim();
    const importType = String(jobOptions.importType ?? jobOptions.type ?? '').trim();
    if (!csvText) throw new Error('csvText is required');
    if (!['gsc', 'p30_users', 'signup_count'].includes(importType)) {
      throw new Error('importType must be gsc, p30_users, or signup_count');
    }

    const store = options.store ?? await new Store().load();
    const beforeUrls = store.state.urls.length;
    const beforeUrlIds = new Set(store.state.urls.map((url) => Number(url.id)));
    const sourceName = `dashboard:${importType}:${nowIso()}`;
    const importedRows = importType === 'gsc'
      ? ingestGscCsvText(store, csvText, sourceName)
      : ingestBusinessWideCsvText(store, csvText, importType, sourceName);
    const createdUrlIds = store.state.urls
      .filter((url) => !beforeUrlIds.has(Number(url.id)))
      .map((url) => url.id);
    const touchedGscMetricCount = store.state.gscPerformanceMetrics
      .reduce((count, metric) => count + (metric.sourceFile === sourceName ? 1 : 0), 0);
    const touchedBusinessMetricCount = store.state.businessMetrics
      .reduce((count, metric) => count + (metric.sourceFile === sourceName ? 1 : 0), 0);

    await updateCsvImportJob(jobId, {
      progress: {
        phase: 'recalculating_priorities',
        percent: 60,
        importedRows,
        urlsAdded: store.state.urls.length - beforeUrls,
        updatedAt: nowIso()
      }
    });
    const thresholds = jobOptions.recalculatePriorities === false ? null : recalculatePriorities(store);
    const batch = createImportBatch(store, {
      importType,
      sourceName,
      importedRows,
      urlsBefore: beforeUrls,
      urlsAfter: store.state.urls.length,
      urlsAdded: store.state.urls.length - beforeUrls,
      createdUrlIds,
      touchedGscMetricCount,
      touchedBusinessMetricCount
    });
    await store.save();

    await updateCsvImportJob(jobId, {
      progress: {
        phase: 'syncing_cache',
        percent: 85,
        importedRows,
        urlsAdded: store.state.urls.length - beforeUrls,
        updatedAt: nowIso()
      }
    });
    const cache = jobOptions.syncDashboardCache === false ? null : await refreshDashboardCache();
    if (typeof options.afterStateSave === 'function') await options.afterStateSave();

    const result = {
      ok: true,
      importBatch: batch,
      importType,
      importedRows,
      urlsBefore: beforeUrls,
      urlsAfter: store.state.urls.length,
      urlsAdded: store.state.urls.length - beforeUrls,
      thresholds,
      cache
    };
    await updateCsvImportJob(jobId, {
      status: 'completed',
      finishedAt: nowIso(),
      result,
      progress: {
        phase: 'complete',
        percent: 100,
        importedRows,
        urlsAdded: store.state.urls.length - beforeUrls,
        updatedAt: nowIso()
      }
    });
    return result;
  } catch (error) {
    await updateCsvImportJob(jobId, {
      status: 'failed',
      finishedAt: nowIso(),
      error: error.message,
      progress: {
        ...(job.progress ?? defaultCsvImportProgress()),
        phase: 'failed',
        updatedAt: nowIso()
      }
    });
    throw error;
  }
  });
}
