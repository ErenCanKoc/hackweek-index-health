import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeCsvImportJob } from '../src/core/csvImportJobs.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

const jobId = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? process.env.CSV_IMPORT_JOB_ID);

if (!Number.isInteger(jobId) || jobId <= 0) {
  console.error('Usage: node scripts/run-csv-import-job.mjs <jobId>');
  process.exit(1);
}

try {
  const result = await executeCsvImportJob(jobId);
  console.log(JSON.stringify({ ok: true, jobId, result }, null, 2));
} catch (error) {
  console.error(`CSV import job ${jobId} failed:`, error);
  process.exit(1);
}
