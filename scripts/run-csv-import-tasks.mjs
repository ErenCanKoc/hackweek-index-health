import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCsvImportJobs, processCsvImportJobTasks } from '../src/core/csvImportJobs.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

async function resolveJobId() {
  const supplied = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? process.env.CSV_IMPORT_JOB_ID);
  if (Number.isInteger(supplied) && supplied > 0) return supplied;

  const jobs = await listCsvImportJobs(10);
  const activeJob = jobs.find((job) => {
    if (!['queued', 'running'].includes(job.status)) return false;
    const totalTasks = Number(job.options?.totalTasks ?? job.progress?.totalTasks ?? 0);
    const completedTasks = Number(job.progress?.completedTasks ?? 0);
    return totalTasks > 0 && completedTasks < totalTasks;
  });
  if (activeJob) return Number(activeJob.id);

  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'No queued or running CSV import job was found.'
  }, null, 2));
  process.exit(0);
}

let jobId = null;
try {
  jobId = await resolveJobId();
  const result = await processCsvImportJobTasks(jobId, {
    maxTasks: process.env.CSV_IMPORT_WORKER_MAX_TASKS,
    maxRuntimeMs: process.env.CSV_IMPORT_WORKER_MAX_RUNTIME_MS,
    resumeFailed: process.env.CSV_IMPORT_RESUME_FAILED === 'true'
  });
  console.log(JSON.stringify({ ok: true, jobId, result }, null, 2));
} catch (error) {
  console.error(`CSV import task worker ${jobId ?? 'unknown'} failed:`, error);
  process.exit(1);
}
