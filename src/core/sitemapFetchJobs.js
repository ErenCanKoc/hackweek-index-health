import pg from 'pg';
import { loadConfig, withStoredSources } from './config.js';
import { ingestConfiguredSitemaps } from './ingestion.js';
import { recalculatePriorities } from './priority.js';
import { runScheduler } from './scheduler.js';
import { Store } from './store.js';
import { isSitemapLikeUrl } from './sitemap.js';
import { nowIso } from './utils.js';
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

function isEmptyRunningJob(job) {
  const progress = job?.progress ?? {};
  return job?.status === 'running'
    && Number(progress.total ?? 0) === 0
    && Number(progress.completed ?? 0) === 0
    && !job?.result;
}

function staleReason(job, now = Date.now()) {
  if (!['queued', 'running'].includes(job?.status)) return null;
  const timestamp = Date.parse(jobTimestamp(job));
  if (!Number.isFinite(timestamp)) return null;
  const ageMinutes = (now - timestamp) / 60000;
  const queuedTimeout = minutesEnv('SITEMAP_FETCH_QUEUED_TIMEOUT_MINUTES', 30);
  const runningTimeout = minutesEnv('SITEMAP_FETCH_RUNNING_TIMEOUT_MINUTES', 120);
  const emptyRunningTimeout = minutesEnv('SITEMAP_FETCH_EMPTY_RUNNING_TIMEOUT_MINUTES', 10);

  if (job.status === 'queued' && ageMinutes > queuedTimeout) {
    return `Queued sitemap fetch job exceeded ${queuedTimeout} minutes.`;
  }
  if (isEmptyRunningJob(job) && ageMinutes > emptyRunningTimeout) {
    return `Empty sitemap fetch job had no source progress for ${emptyRunningTimeout} minutes.`;
  }
  if (job.status === 'running' && ageMinutes > runningTimeout) {
    return `Running sitemap fetch job exceeded ${runningTimeout} minutes.`;
  }
  return null;
}

export function defaultSitemapFetchProgress() {
  return {
    phase: 'queued',
    percent: 0,
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    importedUrls: 0,
    currentSitemapUrl: null,
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
    progress: row.progress ?? defaultSitemapFetchProgress(),
    renderJob: row.render_job ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    startedAt: row.started_at?.toISOString?.() ?? row.started_at,
    finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
  };
}

export async function ensureSitemapFetchJobTable() {
  const pool = getJobPool();
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sitemap_fetch_jobs (
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

    CREATE INDEX IF NOT EXISTS idx_sitemap_fetch_jobs_app_state_updated
      ON sitemap_fetch_jobs (app_state_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sitemap_fetch_jobs_app_state_status
      ON sitemap_fetch_jobs (app_state_key, status);
  `);
  return true;
}

export async function createSitemapFetchJob(options = {}, triggerMode = 'local') {
  const normalizedOptions = await withAutoSitemapBatchOffset(options);
  const progress = defaultSitemapFetchProgress();
  const pool = getJobPool();
  if (pool) {
    await ensureSitemapFetchJobTable();
    const result = await pool.query(
      `
        INSERT INTO sitemap_fetch_jobs (app_state_key, status, trigger_mode, options, progress)
        VALUES ($1, 'queued', $2, $3::jsonb, $4::jsonb)
        RETURNING *
      `,
      [appStateKey(), triggerMode, JSON.stringify(normalizedOptions), JSON.stringify(progress)]
    );
    return toJob(result.rows[0]);
  }

  const store = await new Store().load();
  store.state.sitemapFetchJobs ??= [];
  const job = store.insert('sitemapFetchJobs', {
    status: 'queued',
    triggerMode,
    options: normalizedOptions,
    progress,
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

async function withAutoSitemapBatchOffset(options = {}) {
  const sitemapBatchSize = Math.max(0, Number(options.sitemapBatchSize ?? options.maxSitemapsPerRun ?? 0) || 0);
  if (!sitemapBatchSize) return options;
  if (options.sitemapBatchOffset !== undefined && options.sitemapBatchOffset !== null) {
    return {
      ...options,
      sitemapBatchSize,
      sitemapBatchOffset: Math.max(0, Number(options.sitemapBatchOffset) || 0)
    };
  }

  const jobs = await listSitemapFetchJobs(20).catch(() => []);
  const lastCompleted = jobs.find((job) => job.status === 'completed' && job.result?.counts?.sourceSitemapCount);
  const lastCounts = lastCompleted?.result?.counts;
  const sitemapBatchOffset = lastCounts?.hasMoreSitemaps
    ? Math.max(0, Number(lastCounts.nextSitemapBatchOffset) || 0)
    : 0;

  return {
    ...options,
    sitemapBatchSize,
    sitemapBatchOffset
  };
}

export async function updateSitemapFetchJob(jobId, patch = {}) {
  const pool = getJobPool();
  if (pool) {
    await ensureSitemapFetchJobTable();
    const existing = await getSitemapFetchJob(jobId);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    const result = await pool.query(
      `
        UPDATE sitemap_fetch_jobs
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
        JSON.stringify(next.progress ?? defaultSitemapFetchProgress()),
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
  const job = store.findById('sitemapFetchJobs', Number(jobId));
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  await store.save();
  return job;
}

export async function getSitemapFetchJob(jobId) {
  const pool = getJobPool();
  if (pool) {
    await ensureSitemapFetchJobTable();
    const result = await pool.query(
      'SELECT * FROM sitemap_fetch_jobs WHERE app_state_key = $1 AND id = $2',
      [appStateKey(), Number(jobId)]
    );
    return toJob(result.rows[0]);
  }

  const store = await new Store().load();
  return store.findById('sitemapFetchJobs', Number(jobId)) ?? null;
}

export async function listSitemapFetchJobs(limit = 10) {
  const pool = getJobPool();
  if (pool) {
    await ensureSitemapFetchJobTable();
    const result = await pool.query(
      `
        SELECT *
        FROM sitemap_fetch_jobs
        WHERE app_state_key = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [appStateKey(), Number(limit)]
    );
    return result.rows.map(toJob);
  }

  const store = await new Store().load();
  return (store.state.sitemapFetchJobs ?? []).slice().reverse().slice(0, Number(limit));
}

export async function latestSitemapFetchJob() {
  await recoverStaleSitemapFetchJobs().catch((error) => {
    console.error('Failed to recover stale sitemap fetch jobs:', error.message);
  });
  return (await listSitemapFetchJobs(1))[0] ?? null;
}

export async function hasActiveSitemapFetchJob() {
  await recoverStaleSitemapFetchJobs().catch((error) => {
    console.error('Failed to recover stale sitemap fetch jobs:', error.message);
  });
  const jobs = await listSitemapFetchJobs(5);
  return jobs.find((job) => ['queued', 'running'].includes(job.status)) ?? null;
}

export async function recoverStaleSitemapFetchJobs(limit = 10) {
  const jobs = await listSitemapFetchJobs(limit);
  const staleJobs = jobs
    .map((job) => ({ job, reason: staleReason(job) }))
    .filter((item) => item.reason);
  for (const { job, reason } of staleJobs) {
    await updateSitemapFetchJob(job.id, {
      status: 'failed',
      finishedAt: nowIso(),
      error: reason,
      progress: {
        ...(job.progress ?? defaultSitemapFetchProgress()),
        phase: 'failed',
        updatedAt: nowIso()
      }
    });
  }
  return staleJobs.map(({ job, reason }) => ({ id: job.id, reason }));
}

function removeUrlData(store, urlIds) {
  const idSet = new Set(urlIds.map(Number));
  const before = store.state.urls.length;
  store.state.urls = store.state.urls.filter((url) => !idSet.has(Number(url.id)));
  for (const key of [
    'urlSources',
    'prioritySnapshots',
    'inspectionJobs',
    'inspectionResults',
    'stateTransitions',
    'technicalChecks',
    'healthStatuses',
    'alerts',
    'gscPerformanceMetrics',
    'businessMetrics'
  ]) {
    store.state[key] = store.state[key].filter((row) => !idSet.has(Number(row.urlId)));
  }
  return before - store.state.urls.length;
}

function removeSitemapUrlRecords(store) {
  const ids = store.state.urls
    .filter((url) => isSitemapLikeUrl(url.normalizedUrl) || isSitemapLikeUrl(url.url))
    .map((url) => url.id);
  return removeUrlData(store, ids);
}

function resolvePath(filePath) {
  return new URL(`../../${filePath}`, import.meta.url).pathname;
}

export async function executeSitemapFetchJob(jobId, options = {}) {
  let job = await getSitemapFetchJob(jobId);
  if (!job) throw new Error(`Sitemap fetch job ${jobId} not found.`);
  if (job.status === 'completed') return job.result;

  const startedAt = nowIso();
  job = await updateSitemapFetchJob(jobId, {
    status: 'running',
    startedAt,
    error: null,
    progress: {
      ...defaultSitemapFetchProgress(),
      phase: 'starting',
      updatedAt: startedAt
    }
  });

  return await withStateMutationLock('sitemap_fetch', async () => {
  const store = options.store ?? await new Store().load();
  const config = options.config ?? withStoredSources(await loadConfig(), store);
  const fetchOptions = job.options ?? {};
  let lastProgressWrite = 0;

  try {
    const beforeUrls = store.state.urls.length;
    const cleanedBefore = removeSitemapUrlRecords(store);
    const counts = await ingestConfiguredSitemaps(store, config, resolvePath, {
      includeLocal: false,
      fetchChildSitemaps: fetchOptions.fetchChildSitemaps ?? config.sources.fetchChildSitemaps,
      useDemoUrlsWhenChildFetchIsOff: fetchOptions.useDemoUrlsWhenChildFetchIsOff ?? config.sources.useDemoUrlsWhenChildFetchIsOff,
      useDemoUrlsWhenChildFetchFails: fetchOptions.useDemoUrlsWhenChildFetchFails ?? config.sources.useDemoUrlsWhenChildFetchFails,
      fetchConcurrency: fetchOptions.fetchConcurrency,
      sitemapBatchSize: fetchOptions.sitemapBatchSize ?? fetchOptions.maxSitemapsPerRun,
      sitemapBatchOffset: fetchOptions.sitemapBatchOffset,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgressWrite < 1000 && progress.phase !== 'complete') return;
        lastProgressWrite = now;
        updateSitemapFetchJob(jobId, { progress }).catch((error) => {
          console.error('Failed to update sitemap fetch job progress:', error.message);
        });
      }
    });
    const cleanedAfter = removeSitemapUrlRecords(store);
    const hasSitemapSources = Number(counts.sourceSitemapCount ?? counts.sitemapCount ?? 0) > 0;
    const shouldRecalculatePriorities = hasSitemapSources && fetchOptions.recalculatePriorities === true;
    const thresholds = shouldRecalculatePriorities ? recalculatePriorities(store) : null;
    await store.save();

    let schedulerSummary = null;
    if (hasSitemapSources && fetchOptions.runSchedulerAfterFetch === true) {
      schedulerSummary = await runScheduler(store, config, {
        limit: Number(fetchOptions.schedulerLimit ?? process.env.DAILY_CRON_SCHEDULER_LIMIT ?? 500),
        force: Boolean(fetchOptions.schedulerForce)
      });
      await store.save();
    }

    if (typeof options.afterStateSave === 'function') await options.afterStateSave();

    const result = {
      ok: true,
      counts,
      fetchSummary: counts.fetchSummary,
      cleanedSitemapUrlRecords: cleanedBefore + cleanedAfter,
      urlsBefore: beforeUrls,
      urlsAfter: store.state.urls.length,
      urlsAddedOrUpdated: counts.urlCount,
      priorityRecalculated: shouldRecalculatePriorities,
      skippedPostFetchWork: !hasSitemapSources,
      schedulerSummary,
      thresholds
    };
    await updateSitemapFetchJob(jobId, {
      status: 'completed',
      finishedAt: nowIso(),
      result,
      progress: {
        phase: 'complete',
        percent: 100,
        total: counts.fetchSummary?.total ?? counts.sitemapCount,
        completed: counts.fetchSummary?.total ?? counts.sitemapCount,
        success: counts.fetchSummary?.success ?? 0,
        failed: counts.fetchSummary?.failed ?? 0,
        importedUrls: counts.urlCount,
        currentSitemapUrl: null,
        updatedAt: nowIso()
      }
    });
    return result;
  } catch (error) {
    await updateSitemapFetchJob(jobId, {
      status: 'failed',
      finishedAt: nowIso(),
      error: error.message,
      progress: {
        ...(job.progress ?? defaultSitemapFetchProgress()),
        phase: 'failed',
        updatedAt: nowIso()
      }
    });
    throw error;
  }
  }, {
    onWait: async () => {
      const currentJob = await getSitemapFetchJob(jobId);
      await updateSitemapFetchJob(jobId, {
        progress: {
          ...(currentJob?.progress ?? defaultSitemapFetchProgress()),
          phase: 'waiting_for_state_lock',
          updatedAt: nowIso()
        }
      });
    },
    onAcquired: async () => {
      const currentJob = await getSitemapFetchJob(jobId);
      await updateSitemapFetchJob(jobId, {
        progress: {
          ...(currentJob?.progress ?? defaultSitemapFetchProgress()),
          phase: 'starting',
          updatedAt: nowIso()
        }
      });
    }
  });
}
