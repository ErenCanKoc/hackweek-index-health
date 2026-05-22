import { createContext } from '../src/core/bootstrap.js';
import { refreshDashboardCache } from '../src/core/dashboardCache.js';
import { runScheduler } from '../src/core/scheduler.js';

const context = await createContext();
const limit = Number(process.argv[2] ?? process.env.SCHEDULER_LIMIT ?? 100);
const force = process.env.SCHEDULER_FORCE === 'true';
const urlId = process.env.SCHEDULER_URL_ID ? Number(process.env.SCHEDULER_URL_ID) : null;
const recalculatePriorities = process.env.SCHEDULER_RECALCULATE_PRIORITIES === 'true';
const summary = await runScheduler(context.store, context.config, { limit, force, urlId, recalculatePriorities });
await context.store.save();
await refreshDashboardCache().catch((error) => {
  console.error('Dashboard cache refresh failed after scheduler:', error.message);
});
console.log(JSON.stringify({ ok: true, summary, options: { limit, force, urlId, recalculatePriorities } }, null, 2));
