import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSitemapFetchJob, executeSitemapFetchJob } from '../src/core/sitemapFetchJobs.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

function readJsonEnv(name, fallback) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

const shouldCreateJob = process.argv.includes('--create') || process.env.SITEMAP_FETCH_CREATE_JOB === 'true';
let jobId = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? process.env.SITEMAP_FETCH_JOB_ID);

if (shouldCreateJob) {
  const options = readJsonEnv('SITEMAP_FETCH_JOB_OPTIONS', {
    reason: process.env.SITEMAP_FETCH_REASON ?? 'external_one_off',
    fetchChildSitemaps: true,
    useDemoUrlsWhenChildFetchIsOff: false,
    useDemoUrlsWhenChildFetchFails: false,
    recalculatePriorities: process.env.SITEMAP_FETCH_RECALCULATE_PRIORITIES === 'true',
    runSchedulerAfterFetch: process.env.SITEMAP_FETCH_RUN_SCHEDULER === 'true',
    schedulerLimit: Number(process.env.DAILY_CRON_SCHEDULER_LIMIT ?? 500),
    schedulerForce: false,
    fetchConcurrency: Number(process.env.SITEMAP_FETCH_CONCURRENCY ?? 4),
    sitemapBatchSize: Number(process.env.SITEMAP_FETCH_BATCH_SIZE ?? 50),
    sitemapBatchOffset: process.env.SITEMAP_FETCH_BATCH_OFFSET === undefined
      ? undefined
      : Number(process.env.SITEMAP_FETCH_BATCH_OFFSET)
  });
  const job = await createSitemapFetchJob(options, process.env.SITEMAP_FETCH_TRIGGER_MODE ?? 'render_one_off_direct');
  jobId = Number(job.id);
}

if (!Number.isInteger(jobId) || jobId <= 0) {
  console.error('Usage: node scripts/run-sitemap-fetch-job.mjs <jobId>');
  console.error('   or: SITEMAP_FETCH_CREATE_JOB=true node scripts/run-sitemap-fetch-job.mjs --create');
  process.exit(1);
}

try {
  const results = [];
  const maxBatches = Math.max(1, Number(process.env.SITEMAP_FETCH_AUTO_CONTINUE_MAX_BATCHES ?? 1) || 1);
  const autoContinue = process.env.SITEMAP_FETCH_AUTO_CONTINUE === 'true';
  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const result = await executeSitemapFetchJob(jobId);
    results.push({ jobId, result });
    if (!autoContinue || !result?.counts?.hasMoreSitemaps) break;
    const nextJob = await createSitemapFetchJob({
      ...(result.options ?? {}),
      reason: process.env.SITEMAP_FETCH_REASON ?? 'external_one_off_auto_continue',
      fetchChildSitemaps: true,
      useDemoUrlsWhenChildFetchIsOff: false,
      useDemoUrlsWhenChildFetchFails: false,
      recalculatePriorities: process.env.SITEMAP_FETCH_RECALCULATE_PRIORITIES === 'true',
      runSchedulerAfterFetch: process.env.SITEMAP_FETCH_RUN_SCHEDULER === 'true',
      schedulerLimit: Number(process.env.DAILY_CRON_SCHEDULER_LIMIT ?? 500),
      schedulerForce: false,
      fetchConcurrency: Number(process.env.SITEMAP_FETCH_CONCURRENCY ?? 4),
      sitemapBatchSize: Number(process.env.SITEMAP_FETCH_BATCH_SIZE ?? 50)
    }, process.env.SITEMAP_FETCH_TRIGGER_MODE ?? 'render_one_off_auto_continue');
    jobId = Number(nextJob.id);
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(`Sitemap fetch job ${jobId} failed:`, error);
  process.exit(1);
}
