import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCsvImportJobTasks } from '../src/core/csvImportJobs.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

const jobId = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? process.env.CSV_IMPORT_JOB_ID);

if (!Number.isInteger(jobId) || jobId <= 0) {
  console.error('Usage: node scripts/run-csv-import-tasks.mjs <jobId>');
  process.exit(1);
}

try {
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
