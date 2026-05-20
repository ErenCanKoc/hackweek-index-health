import { executeSitemapFetchJob } from '../src/core/sitemapFetchJobs.js';

const jobId = Number(process.argv[2] ?? process.env.SITEMAP_FETCH_JOB_ID);

if (!Number.isInteger(jobId) || jobId <= 0) {
  console.error('Usage: node scripts/run-sitemap-fetch-job.mjs <jobId>');
  process.exit(1);
}

try {
  const result = await executeSitemapFetchJob(jobId);
  console.log(JSON.stringify({ ok: true, jobId, result }, null, 2));
} catch (error) {
  console.error(`Sitemap fetch job ${jobId} failed:`, error);
  process.exit(1);
}
