import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { ingestAllConfiguredSources, ingestBusinessWideCsvText, ingestGscCsvText } from '../src/core/ingestion.js';
import { ensureProperties, resolveEligibleProperties } from '../src/core/propertyResolver.js';
import { recalculatePriorities } from '../src/core/priority.js';
import { jobDiagnostics, sitemapFetchLog, urlDetail } from '../src/core/reporting.js';
import { runScheduler } from '../src/core/scheduler.js';
import { expandSitemapSources } from '../src/core/sitemap.js';
import { Store } from '../src/core/store.js';
import { normalizeUrl } from '../src/core/utils.js';

const tmpStorePath = path.join(process.cwd(), 'data/runtime/smoke-state.json');
const config = await loadConfig();
const store = new Store(tmpStorePath);
await store.reset();
ensureProperties(store, config.propertyMappings, config.policy);
await ingestAllConfiguredSources(store, config, (relativePath) => path.join(process.cwd(), relativePath));

const directUrlsetSources = await expandSitemapSources(
  { sitemapIndexUrls: ['data/imports/sample-urlset.xml'], childSitemapUrls: [] },
  (relativePath) => path.join(process.cwd(), relativePath),
  { includeLocal: false }
);
assert.deepEqual(directUrlsetSources, ['data/imports/sample-urlset.xml']);

const childIndexSources = await expandSitemapSources(
  { sitemapIndexUrls: [], childSitemapUrls: ['data/imports/sample-sitemap-index.xml'] },
  (relativePath) => path.join(process.cwd(), relativePath),
  { includeLocal: false }
);
assert.equal(childIndexSources.includes('https://www.jotform.com/sitemaps/blog/sitemap.xml'), true);

const excludedChildIndexSources = await expandSitemapSources(
  {
    sitemapIndexUrls: [],
    childSitemapUrls: ['data/imports/sample-sitemap-index.xml'],
    excludedSitemapUrls: ['https://www.jotform.com/sitemaps/blog/sitemap.xml']
  },
  (relativePath) => path.join(process.cwd(), relativePath),
  { includeLocal: false }
);
assert.equal(excludedChildIndexSources.includes('https://www.jotform.com/sitemaps/blog/sitemap.xml'), false);

const gscImportRows = ingestGscCsvText(
  store,
  'url,click,impression,avg_position\nhttps://www.jotform.com/dashboard-csv-test/,25,400,7.2',
  'smoke:gsc'
);
assert.equal(gscImportRows, 1);
assert.ok(store.state.urls.find((url) => url.normalizedUrl === 'https://www.jotform.com/dashboard-csv-test/'));

const p30ImportRows = ingestBusinessWideCsvText(
  store,
  'path,2026-05-01\n/dashboard-p30-test/,18',
  'p30_users',
  'smoke:p30'
);
assert.equal(p30ImportRows, 1);
assert.ok(store.state.businessMetrics.find((metric) => metric.path === '/dashboard-p30-test/' && metric.metricType === 'p30_users'));

const signupImportRows = ingestBusinessWideCsvText(
  store,
  'URL;2026-05-01;2026-06-01\nhttps://www.jotform.com/dashboard-signup-test/;1,234;5',
  'signup_count',
  'smoke:signup'
);
assert.equal(signupImportRows, 2);
assert.ok(store.state.businessMetrics.find((metric) => metric.path === '/dashboard-signup-test/' && metric.metricMonth === '2026-05-01' && metric.metricValue === 1234));
assert.equal(store.state.businessMetrics.some((metric) => metric.metricMonth.toLowerCase() === 'url'), false);

assert.equal(normalizeUrl('http://WWW.JOTFORM.com/blog/test/?utm_source=x&b=2&a=1#top'), 'https://www.jotform.com/blog/test/?a=1&b=2');
assert.equal(normalizeUrl('https://www.jotform.com/tr/'), 'https://www.jotform.com/tr/');
assert.equal(normalizeUrl('https://www.jotform.com/blog/test/'), 'https://www.jotform.com/blog/test/');
assert.equal(store.state.urls.length > 0, true);

const scaled = store.state.urls.find((url) => url.isScaledContent);
assert.ok(scaled, 'expected a scaled content URL');
assert.equal(scaled.scaledContentType, 'adcraft');
assert.equal(scaled.normalizedUrl.includes('adcraft'), false);
assert.ok(
  store.state.urlSources.some((source) => source.urlId === scaled.id && source.sourceSitemapUrl?.includes('adcraft')),
  'expected scaled content URL to inherit adcraft from source sitemap'
);
const eligible = resolveEligibleProperties(store, scaled);
assert.equal(eligible[0].propertyUrl, 'https://www.jotform.com/form-templates/');

const trUrl = store.state.urls.find((url) => url.locale === 'tr');
assert.ok(trUrl, 'expected a Turkish URL');
assert.equal(resolveEligibleProperties(store, trUrl)[0].propertyUrl, 'https://www.jotform.com/tr/');

const summary = await runScheduler(store, config, { limit: 50 });
assert.equal(summary.inspected > 0, true);
assert.equal(store.state.inspectionResults.length, summary.inspected);
const sitemapLog = sitemapFetchLog(store);
assert.equal(sitemapLog.length > 0, true);
assert.equal(sitemapLog.some((row) => row.urlCount > 0), true);
const detail = urlDetail(store, store.state.urls[0].id);
assert.ok(detail.inspections[0].property?.propertyUrl, 'expected URL detail inspections to include property metadata');
const diagnostics = jobDiagnostics(store);
assert.equal(diagnostics.summary.completed, summary.inspected);
assert.equal(diagnostics.byStatus.some((row) => row.name === 'completed'), true);

const duplicateSummary = await runScheduler(store, config, { limit: 50 });
assert.equal(duplicateSummary.inspected, 0);

const manualOverrideUrl = store.state.urls.find((url) => url.currentPriorityTier === 'P3');
assert.ok(manualOverrideUrl, 'expected a P3 URL for manual priority override check');
manualOverrideUrl.currentPriorityTier = 'P0';
manualOverrideUrl.manualPriorityTier = 'P0';
manualOverrideUrl.nextInspectionDueAt = new Date().toISOString();
recalculatePriorities(store);
assert.equal(manualOverrideUrl.currentPriorityTier, 'P0');
assert.equal(manualOverrideUrl.manualPriorityTier, 'P0');

const beforeSingleInspectResults = store.state.inspectionResults.length;
const singleInspectSummary = await runScheduler(store, config, { limit: 1, force: true, urlId: manualOverrideUrl.id });
assert.equal(singleInspectSummary.inspected, 1);
assert.equal(store.state.inspectionResults.length, beforeSingleInspectResults + 1);
assert.equal(store.state.inspectionResults.at(-1).urlId, manualOverrideUrl.id);

console.log(JSON.stringify({
  ok: true,
  urls: store.state.urls.length,
  inspected: summary.inspected,
  alerts: store.state.alerts.length
}, null, 2));
