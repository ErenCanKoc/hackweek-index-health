import { Store } from '../src/core/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const store = new Store();
await store.load();
store.state.meta.supabaseCheckAt = new Date().toISOString();
await store.save();

console.log(JSON.stringify({
  ok: true,
  backend: 'postgres-jsonb',
  appStateKey: store.appStateKey,
  updatedAt: store.state.meta.updatedAt
}, null, 2));
