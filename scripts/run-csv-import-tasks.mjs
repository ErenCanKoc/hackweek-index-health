import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCsvImportJobs, processCsvImportJobTasks } from '../src/core/csvImportJobs.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

async function resolveJobId() {
  const supplied = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? process.env.CSV_IMPORT_JOB_ID);
  if (Number.isInteger(supplied) && supplied > 0) return supplied;

  const jobs = await listCsvImportJobs(10);
  const activeJob = jobs.find((job) => ['queued', 'running', 'failed'].includes(job.status));
  if (activeJob) return Number(activeJob.id);

  console.error('Usage: node scripts/run-csv-import-tasks.mjs <jobId>');
  console.error('No queued, running, or failed CSV import job was found.');
  process.exit(1);
}

try {
  const jobId = await resolveJobId();
  const result = await processCsvImportJobTasks(jobId, {
    maxTasks: process.env.CSV_IMPORT_WORKER_MAX_TASKS,
    maxRuntimeMs: process.env.CSV_IMPORT_WORKER_MAX_RUNTIME_MS,
    resumeFailed: process.env.CSV_IMPORT_RESUME_FAILED === 'true'
  });
  console.log(JSON.stringify({ ok: true, jobId, result }, null, 2));
} catch (error) {
  console.error(`CSV import task worker ${jobId} failed:`, error);
  process.exit(1);
}
