import { createContext } from '../src/core/bootstrap.js';
import { runScheduler } from '../src/core/scheduler.js';

const context = await createContext();
const summary = await runScheduler(context.store, context.config, { limit: Number(process.argv[2] ?? 100) });
await context.store.save();
console.log(JSON.stringify({ ok: true, summary }, null, 2));
