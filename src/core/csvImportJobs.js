import { getDatabasePool } from './db.js';
import {
  ingestBusinessRows,
  ingestBusinessWideCsvText,
  ingestGscCsvText,
  ingestGscRows
} from './ingestion.js';
import { recalculatePriorities } from './priority.js';
import { Store } from './store.js';
import { nowIso, parseCsv } from './utils.js';
import { refreshDashboardCache } from './dashboardCache.js';
import { withStateMutationLock } from './jobLocks.js';

function getJobPool() {
  return getDatabasePool();
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

export async function ensureCsvImportTaskTable() {
  const pool = getJobPool();
  if (!pool) return false;
  await ensureCsvImportJobTable();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS csv_import_tasks (
      id BIGSERIAL PRIMARY KEY,
      app_state_key TEXT NOT NULL,
      job_id BIGINT NOT NULL REFERENCES csv_import_jobs(id) ON DELETE CASCADE,
      task_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (app_state_key, job_id, task_index)
    );

    CREATE INDEX IF NOT EXISTS idx_csv_import_tasks_job_status
      ON csv_import_tasks (app_state_key, job_id, status, task_index);
  `);
  return true;
}

function chunkRows(rows, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || 1000);
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function taskToObject(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    appStateKey: row.app_state_key,
    jobId: Number(row.job_id),
    taskIndex: Number(row.task_index),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    payload: row.payload ?? {},
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    startedAt: row.started_at?.toISOString?.() ?? row.started_at,
    finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
  };
}

function queuedProgress({ totalRows = 0, totalTasks = 0, chunkSize = 0 } = {}) {
  return {
    ...defaultCsvImportProgress(),
    phase: 'queued',
    totalRows,
    totalTasks,
    chunkSize,
    completedTasks: 0,
    failedTasks: 0
  };
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

export async function createChunkedCsvImportJob(options = {}, triggerMode = 'queued_worker') {
  const pool = getJobPool();
  if (!pool) return createCsvImportJob(options, triggerMode);

  const csvText = String(options.csvText ?? options.csv ?? '').trim();
  const importType = String(options.importType ?? options.type ?? '').trim();
  if (!csvText) throw new Error('csvText is required');
  if (!['gsc', 'p30_users', 'signup_count'].includes(importType)) {
    throw new Error('importType must be gsc, p30_users, or signup_count');
  }

  const rows = parseCsv(csvText);
  const chunkSize = Math.max(50, Number(options.chunkSize ?? process.env.CSV_IMPORT_CHUNK_SIZE ?? 1000) || 1000);
  const chunks = chunkRows(rows, chunkSize);
  const sourceName = `dashboard:${importType}:${nowIso()}`;
  const sanitizedOptions = {
    ...options,
    csvText: undefined,
    csv: undefined,
    importType,
    sourceName,
    totalRows: rows.length,
    totalTasks: chunks.length,
    chunkSize,
    chunked: true
  };

  await ensureCsvImportTaskTable();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `
        INSERT INTO csv_import_jobs (app_state_key, status, trigger_mode, options, progress)
        VALUES ($1, 'queued', $2, $3::jsonb, $4::jsonb)
        RETURNING *
      `,
      [
        appStateKey(),
        triggerMode,
        JSON.stringify(sanitizedOptions),
        JSON.stringify(queuedProgress({ totalRows: rows.length, totalTasks: chunks.length, chunkSize }))
      ]
    );
    const job = toJob(jobResult.rows[0]);
    for (const [taskIndex, taskRows] of chunks.entries()) {
      await client.query(
        `
          INSERT INTO csv_import_tasks (app_state_key, job_id, task_index, payload)
          VALUES ($1, $2, $3, $4::jsonb)
        `,
        [
          appStateKey(),
          job.id,
          taskIndex,
          JSON.stringify({
            rows: taskRows,
            importType,
            sourceName,
            rowOffset: taskIndex * chunkSize
          })
        ]
      );
    }
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

async function claimNextCsvImportTask(jobId) {
  const pool = getJobPool();
  if (!pool) return null;
  await ensureCsvImportTaskTable();
  const runningTaskTimeout = minutesEnv('CSV_IMPORT_TASK_RUNNING_TIMEOUT_MINUTES', 20);
  await pool.query(
    `
      UPDATE csv_import_tasks
      SET status = 'queued',
          error = 'Task heartbeat expired; requeued for retry.',
          updated_at = now()
      WHERE app_state_key = $1
        AND job_id = $2
        AND status = 'running'
        AND updated_at < now() - ($3::text || ' minutes')::interval
    `,
    [appStateKey(), Number(jobId), String(runningTaskTimeout)]
  );
  const result = await pool.query(
    `
      WITH next_task AS (
        SELECT id
        FROM csv_import_tasks
        WHERE app_state_key = $1
          AND job_id = $2
          AND status = 'queued'
        ORDER BY task_index
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE csv_import_tasks AS task
      SET status = 'running',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, now()),
          updated_at = now(),
          error = NULL
      FROM next_task
      WHERE task.id = next_task.id
      RETURNING task.*
    `,
    [appStateKey(), Number(jobId)]
  );
  return taskToObject(result.rows[0]);
}

async function updateCsvImportTask(taskId, patch = {}) {
  const pool = getJobPool();
  if (!pool) return null;
  await ensureCsvImportTaskTable();
  const existingResult = await pool.query(
    'SELECT * FROM csv_import_tasks WHERE app_state_key = $1 AND id = $2',
    [appStateKey(), Number(taskId)]
  );
  const existing = taskToObject(existingResult.rows[0]);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  const result = await pool.query(
    `
      UPDATE csv_import_tasks
      SET status = $3,
          attempts = $4,
          payload = $5::jsonb,
          result = $6::jsonb,
          error = $7,
          started_at = $8,
          finished_at = $9,
          updated_at = now()
      WHERE app_state_key = $1 AND id = $2
      RETURNING *
    `,
    [
      appStateKey(),
      Number(taskId),
      next.status,
      next.attempts,
      JSON.stringify(next.payload ?? {}),
      next.result ? JSON.stringify(next.result) : null,
      next.error ?? null,
      next.startedAt ?? null,
      next.finishedAt ?? null
    ]
  );
  return taskToObject(result.rows[0]);
}

async function csvImportTaskStats(jobId) {
  const pool = getJobPool();
  if (!pool) return null;
  await ensureCsvImportTaskTable();
  const result = await pool.query(
    `
      SELECT
        COUNT(*)::int AS total_tasks,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_tasks,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running_tasks,
        COALESCE(SUM((result ->> 'importedRows')::int) FILTER (WHERE status = 'completed'), 0)::int AS imported_rows,
        COALESCE(SUM((result ->> 'urlsAdded')::int) FILTER (WHERE status = 'completed'), 0)::int AS urls_added
      FROM csv_import_tasks
      WHERE app_state_key = $1 AND job_id = $2
    `,
    [appStateKey(), Number(jobId)]
  );
  return {
    totalTasks: Number(result.rows[0]?.total_tasks ?? 0),
    completedTasks: Number(result.rows[0]?.completed_tasks ?? 0),
    failedTasks: Number(result.rows[0]?.failed_tasks ?? 0),
    runningTasks: Number(result.rows[0]?.running_tasks ?? 0),
    importedRows: Number(result.rows[0]?.imported_rows ?? 0),
    urlsAdded: Number(result.rows[0]?.urls_added ?? 0)
  };
}

async function requeueFailedCsvImportTasks(jobId) {
  const pool = getJobPool();
  if (!pool) return 0;
  await ensureCsvImportTaskTable();
  const result = await pool.query(
    `
      UPDATE csv_import_tasks
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          finished_at = NULL,
          updated_at = now()
      WHERE app_state_key = $1
        AND job_id = $2
        AND status = 'failed'
      RETURNING id
    `,
    [appStateKey(), Number(jobId)]
  );
  return result.rowCount ?? 0;
}

function isTransientDbConnectionError(error) {
  const message = String(error?.message ?? error ?? '');
  return error?.code === 'ESTATELOCKTIMEOUT'
    || message.includes('EMAXCONNSESSION')
    || message.includes('max clients reached')
    || message.includes('too many clients')
    || message.includes('remaining connection slots');
}

async function updateChunkedProgress(jobId, phase = 'importing_chunks') {
  const job = await getCsvImportJob(jobId);
  const stats = await csvImportTaskStats(jobId);
  if (!job || !stats) return null;
  const totalTasks = Number(job.options?.totalTasks ?? stats.totalTasks ?? 0);
  const percent = totalTasks
    ? Math.min(59, Math.round((stats.completedTasks / totalTasks) * 55) + 5)
    : 5;
  return updateCsvImportJob(jobId, {
    status: 'running',
    progress: {
      ...(job.progress ?? defaultCsvImportProgress()),
      phase,
      percent,
      importedRows: stats.importedRows,
      urlsAdded: stats.urlsAdded,
      totalTasks,
      completedTasks: stats.completedTasks,
      failedTasks: stats.failedTasks,
      updatedAt: nowIso()
    }
  });
}

export async function processCsvImportJobTasks(jobId, options = {}) {
  const pool = getJobPool();
  if (!pool) return executeCsvImportJob(jobId, options);
  await ensureCsvImportTaskTable();

  let job = await getCsvImportJob(jobId);
  if (!job) throw new Error(`CSV import job ${jobId} not found.`);
  if (job.status === 'completed') return job.result;
  if (job.status === 'failed' && options.resumeFailed !== true) {
    throw new Error(`CSV import job ${jobId} is failed: ${job.error ?? 'unknown error'}`);
  }
  if (job.status === 'failed' && options.resumeFailed === true) {
    await requeueFailedCsvImportTasks(jobId);
  }

  const startedAt = job.startedAt ?? nowIso();
  job = await updateCsvImportJob(jobId, {
    status: 'running',
    startedAt,
    error: null,
    progress: {
      ...(job.progress ?? defaultCsvImportProgress()),
      phase: 'importing_chunks',
      updatedAt: nowIso()
    }
  });

  const maxTasks = Math.max(1, Number(options.maxTasks ?? process.env.CSV_IMPORT_WORKER_MAX_TASKS ?? 25) || 25);
  const maxRuntimeMs = Math.max(10000, Number(options.maxRuntimeMs ?? process.env.CSV_IMPORT_WORKER_MAX_RUNTIME_MS ?? 240000) || 240000);
  const lockMaxWaitMs = Math.max(5000, Number(options.lockMaxWaitMs ?? process.env.CSV_IMPORT_LOCK_MAX_WAIT_MS ?? 90000) || 90000);
  const started = Date.now();
  let processedTasks = 0;

  while (processedTasks < maxTasks && Date.now() - started < maxRuntimeMs) {
    const task = await claimNextCsvImportTask(jobId);
    if (!task) break;

    try {
      const taskResult = await withStateMutationLock('csv_import_task', async () => {
        const store = options.store ?? await new Store().load();
        const beforeUrls = store.state.urls.length;
        const rows = Array.isArray(task.payload?.rows) ? task.payload.rows : [];
        const importType = String(task.payload?.importType ?? job.options?.importType ?? '').trim();
        const sourceName = String(task.payload?.sourceName ?? job.options?.sourceName ?? `dashboard:${importType}`);
        const importedRows = importType === 'gsc'
          ? ingestGscRows(store, rows, sourceName)
          : ingestBusinessRows(store, rows, importType, sourceName);
        await store.save();
        if (typeof options.afterStateSave === 'function') await options.afterStateSave();
        return {
          importedRows,
          urlsBefore: beforeUrls,
          urlsAfter: store.state.urls.length,
          urlsAdded: store.state.urls.length - beforeUrls
        };
      }, {
        maxWaitMs: lockMaxWaitMs,
        onWait: async () => {
          await updateCsvImportTask(task.id, { status: 'running' });
          await updateChunkedProgress(jobId, 'waiting_for_state_lock');
        }
      });

      await updateCsvImportTask(task.id, {
        status: 'completed',
        result: taskResult,
        finishedAt: nowIso()
      });
      processedTasks += 1;
      await updateChunkedProgress(jobId, 'importing_chunks');
    } catch (error) {
      if (isTransientDbConnectionError(error)) {
        await updateCsvImportTask(task.id, {
          status: 'queued',
          error: `Transient database connection error; requeued: ${error.message}`,
          startedAt: null,
          finishedAt: null
        });
        await updateChunkedProgress(jobId, 'waiting_for_database_connections');
        break;
      }
      await updateCsvImportTask(task.id, {
        status: 'failed',
        error: error.message,
        finishedAt: nowIso()
      });
      const currentJob = await getCsvImportJob(jobId);
      await updateCsvImportJob(jobId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: `CSV task ${task.taskIndex} failed: ${error.message}`,
        progress: {
          ...(currentJob?.progress ?? defaultCsvImportProgress()),
          phase: 'failed',
          updatedAt: nowIso()
        }
      });
      throw error;
    }
  }

  const stats = await csvImportTaskStats(jobId);
  job = await getCsvImportJob(jobId);
  const totalTasks = Number(job?.options?.totalTasks ?? stats?.totalTasks ?? 0);
  if (stats && totalTasks && stats.completedTasks < totalTasks) {
    return {
      ok: true,
      partial: true,
      processedTasks,
      stats
    };
  }

  const currentJob = await updateCsvImportJob(jobId, {
    progress: {
      ...(job?.progress ?? defaultCsvImportProgress()),
      phase: 'recalculating_priorities',
      percent: 70,
      updatedAt: nowIso()
    }
  });
  let thresholds = null;
  if (currentJob?.options?.recalculatePriorities !== false && currentJob?.progress?.priorityRecalculated !== true) {
    thresholds = await withStateMutationLock('csv_import_recalculate', async () => {
      const store = options.store ?? await new Store().load();
      const value = recalculatePriorities(store);
      createImportBatch(store, {
        importType: currentJob.options?.importType,
        sourceName: currentJob.options?.sourceName,
        importedRows: stats.importedRows,
        urlsBefore: null,
        urlsAfter: store.state.urls.length,
        urlsAdded: stats.urlsAdded,
        createdUrlIds: [],
        touchedGscMetricCount: currentJob.options?.importType === 'gsc' ? stats.importedRows : 0,
        touchedBusinessMetricCount: currentJob.options?.importType === 'gsc' ? 0 : stats.importedRows
      });
      await store.save();
      if (typeof options.afterStateSave === 'function') await options.afterStateSave();
      return value;
    }, {
      maxWaitMs: lockMaxWaitMs,
      onWait: async () => updateChunkedProgress(jobId, 'waiting_for_state_lock')
    }).catch(async (error) => {
      if (!isTransientDbConnectionError(error)) throw error;
      await updateChunkedProgress(jobId, 'waiting_for_state_lock');
      return null;
    });
    if (thresholds === null) {
      return {
        ok: true,
        partial: true,
        processedTasks,
        waitingFor: 'state_lock',
        stats
      };
    }
  }

  await updateCsvImportJob(jobId, {
    progress: {
      ...(currentJob?.progress ?? defaultCsvImportProgress()),
      phase: 'syncing_cache',
      percent: 90,
      importedRows: stats?.importedRows ?? 0,
      urlsAdded: stats?.urlsAdded ?? 0,
      completedTasks: stats?.completedTasks ?? 0,
      totalTasks,
      priorityRecalculated: true,
      updatedAt: nowIso()
    }
  });
  const cache = currentJob?.options?.syncDashboardCache === false ? null : await refreshDashboardCache();
  const result = {
    ok: true,
    chunked: true,
    importType: currentJob?.options?.importType,
    importedRows: stats?.importedRows ?? 0,
    urlsAdded: stats?.urlsAdded ?? 0,
    totalTasks,
    thresholds,
    cache
  };
  await updateCsvImportJob(jobId, {
    status: 'completed',
    finishedAt: nowIso(),
    result,
    progress: {
      ...(currentJob?.progress ?? defaultCsvImportProgress()),
      phase: 'complete',
      percent: 100,
      importedRows: result.importedRows,
      urlsAdded: result.urlsAdded,
      completedTasks: totalTasks,
      totalTasks,
      updatedAt: nowIso()
    }
  });
  return result;
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
        phase: 'recalculating_priorities',
        percent: 60,
        importedRows,
        urlsAdded: store.state.urls.length - beforeUrls,
        updatedAt: nowIso()
      }
    });
    const thresholds = jobOptions.recalculatePriorities === false ? null : recalculatePriorities(store);
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
    const currentJob = await getCsvImportJob(jobId);
    await updateCsvImportJob(jobId, {
      status: 'failed',
      finishedAt: nowIso(),
      error: error.message,
      progress: {
        ...(currentJob?.progress ?? job.progress ?? defaultCsvImportProgress()),
        phase: 'failed',
        updatedAt: nowIso()
      }
    });
    throw error;
  }
  }, {
    onWait: async () => {
      const currentJob = await getCsvImportJob(jobId);
      await updateCsvImportJob(jobId, {
        progress: {
          ...(currentJob?.progress ?? defaultCsvImportProgress()),
          phase: 'waiting_for_state_lock',
          updatedAt: nowIso()
        }
      });
    },
    onAcquired: async () => {
      const currentJob = await getCsvImportJob(jobId);
      await updateCsvImportJob(jobId, {
        progress: {
          ...(currentJob?.progress ?? defaultCsvImportProgress()),
          phase: 'importing',
          updatedAt: nowIso()
        }
      });
    }
  });
}
