import { loadConfig, resolvePath, withStoredSources } from './config.js';
import { ingestAllConfiguredSources } from './ingestion.js';
import { ensureProperties } from './propertyResolver.js';
import { recalculatePriorities } from './priority.js';
import { loadStore } from './store.js';

export async function createContext(options = {}) {
  const store = await loadStore(options.storePath);
  const config = withStoredSources(await loadConfig(), store);
  store.config = config;
  ensureProperties(store, config.propertyMappings, config.policy);
  return { config, store, resolvePath };
}

export async function seedContext(options = {}) {
  const context = await createContext(options);
  if (options.reset) {
    await context.store.reset();
    ensureProperties(context.store, context.config.propertyMappings, context.config.policy);
  }
  const counts = await ingestAllConfiguredSources(context.store, context.config, context.resolvePath);
  const thresholds = recalculatePriorities(context.store);
  await context.store.save();
  return { ...context, counts, thresholds };
}
