import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { ingestAllConfiguredSources } from '../src/core/ingestion.js';
import { ensureProperties, resolveEligibleProperties } from '../src/core/propertyResolver.js';
import { runScheduler } from '../src/core/scheduler.js';
import { Store } from '../src/core/store.js';
import { normalizeUrl } from '../src/core/utils.js';

const tmpStorePath = path.join(process.cwd(), 'data/runtime/smoke-state.json');
const config = await loadConfig();
const store = new Store(tmpStorePath);
await store.reset();
ensureProperties(store, config.propertyMappings, config.policy);
await ingestAllConfiguredSources(store, config, (relativePath) => path.join(process.cwd(), relativePath));

assert.equal(normalizeUrl('http://WWW.JOTFORM.com/blog/test/?utm_source=x&b=2&a=1#top'), 'https://www.jotform.com/blog/test/?a=1&b=2');
assert.equal(normalizeUrl('https://www.jotform.com/tr/'), 'https://www.jotform.com/tr/');
assert.equal(normalizeUrl('https://www.jotform.com/blog/test/'), 'https://www.jotform.com/blog/test/');
assert.equal(store.state.urls.length > 0, true);

const scaled = store.state.urls.find((url) => url.isScaledContent);
assert.ok(scaled, 'expected a scaled content URL');
const eligible = resolveEligibleProperties(store, scaled);
assert.equal(eligible[0].propertyUrl, 'https://www.jotform.com/form-templates/');

const trUrl = store.state.urls.find((url) => url.locale === 'tr');
assert.ok(trUrl, 'expected a Turkish URL');
assert.equal(resolveEligibleProperties(store, trUrl)[0].propertyUrl, 'https://www.jotform.com/tr/');

const summary = await runScheduler(store, config, { limit: 50 });
assert.equal(summary.inspected > 0, true);
assert.equal(store.state.inspectionResults.length, summary.inspected);

const duplicateSummary = await runScheduler(store, config, { limit: 50 });
assert.equal(duplicateSummary.inspected, 0);

console.log(JSON.stringify({
  ok: true,
  urls: store.state.urls.length,
  inspected: summary.inspected,
  alerts: store.state.alerts.length
}, null, 2));
