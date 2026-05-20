import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, seedContext } from '../core/bootstrap.js';
import { loadConfig, readJson, writeJson } from '../core/config.js';
import {
  ingestBusinessWideCsvText,
  ingestConfiguredSitemaps,
  ingestGscCsvText,
  upsertUrl
} from '../core/ingestion.js';
import {
  createGoogleAuthUrl,
  disconnectGoogle,
  exchangeGoogleCode,
  googleAuthStatus,
  listSearchConsoleSites,
  saveOAuthClient
} from '../core/googleAuth.js';
import { ensureProperties } from '../core/propertyResolver.js';
import { recalculatePriorities } from '../core/priority.js';
import {
  exportHealthReport,
  jobDiagnostics,
  overview,
  roadmap,
  scaledDashboard,
  sitemapFetchLog,
  urlDetail,
  urlExplorer
} from '../core/reporting.js';
import { runScheduler } from '../core/scheduler.js';
import { calculateNextDueAt } from '../core/stateMachine.js';
import { isSitemapLikeUrl } from '../core/sitemap.js';
import { getSearchConsoleAccessToken } from '../core/inspectionProvider.js';
import { normalizeUrl, nowIso } from '../core/utils.js';

const PORT = Number(process.env.PORT ?? 3000);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(serverDir, '../../public');
const SESSION_COOKIE = 'ih_session';

function publicOrigin(fallbackOrigin) {
  return (process.env.APP_BASE_URL || fallbackOrigin).replace(/\/+$/, '');
}

function authPassword() {
  return String(process.env.ADMIN_PASSWORD ?? '').trim();
}

function isAuthEnabled() {
  return authPassword().length > 0;
}

function cronSecret() {
  return String(process.env.CRON_SECRET ?? '').trim();
}

function isCronAuthorized(parsed, request) {
  const expected = cronSecret();
  if (!expected) return false;
  const supplied = request.headers['x-cron-secret'] || parsed.searchParams.get('secret');
  return safeEqual(String(supplied ?? ''), expected);
}

function authSecret() {
  return process.env.AUTH_SESSION_SECRET || process.env.SESSION_SECRET || authPassword();
}

function expectedSessionToken() {
  return crypto
    .createHmac('sha256', authSecret())
    .update(`index-health:${authPassword()}`)
    .digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isAuthenticated(request) {
  if (!isAuthEnabled()) return true;
  const cookies = parseCookies(request.headers.cookie);
  return safeEqual(cookies[SESSION_COOKIE], expectedSessionToken());
}

function cookieOptions(request) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const isSecure = forwardedProto === 'https' || publicOrigin(`http://${request.headers.host}`).startsWith('https://');
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}${isSecure ? '; Secure' : ''}`;
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { location, ...headers });
  response.end();
}

function loginPage({ error = false } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Index Health Login</title>
    <style>
      :root {
        color-scheme: dark;
        --base: rgb(12, 21, 81);
        --cyan: #10bfd3;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at 20% 14%, rgba(49, 88, 255, 0.5), transparent 34%),
          radial-gradient(circle at 84% 8%, rgba(16, 191, 211, 0.32), transparent 30%),
          linear-gradient(145deg, rgb(12, 21, 81) 0%, #111858 38%, #070c2e 100%);
        font: 300 14px/1.45 "Circular Std", "CircularXX", "Avenir Next", Inter, ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0;
      }
      main {
        width: min(420px, 100%);
        padding: 28px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.92);
        color: #12172f;
        box-shadow: 0 24px 70px rgba(6, 12, 48, 0.28);
      }
      .mark {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 8px;
        margin-bottom: 18px;
        color: var(--base);
        font-weight: 700;
        background: linear-gradient(135deg, #ffffff 0%, #dce5ff 46%, #99f1ff 100%);
      }
      h1 { margin: 0 0 6px; font-size: 28px; font-weight: 300; color: var(--base); }
      p { margin: 0 0 20px; color: #66708c; }
      label { display: grid; gap: 7px; color: #66708c; font-size: 12px; }
      input {
        min-height: 42px;
        border: 1px solid rgba(12, 21, 81, 0.16);
        border-radius: 8px;
        padding: 9px 11px;
        color: #12172f;
        background: #fff;
        font: inherit;
      }
      button {
        width: 100%;
        min-height: 42px;
        margin-top: 14px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 8px;
        color: white;
        cursor: pointer;
        background: linear-gradient(135deg, #2e55ff 0%, #14c1d1 100%);
        font: inherit;
      }
      .error {
        margin: 0 0 12px;
        padding: 9px 10px;
        border-radius: 8px;
        color: #b4243c;
        background: rgba(222, 67, 89, 0.12);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">IH</div>
      <h1>Index Health</h1>
      <p>Dashboard access is protected.</p>
      ${error ? '<div class="error">Password is incorrect.</div>' : ''}
      <form method="post" action="/auth/login">
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'content-type': contentType });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if (request.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeUrlList(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list
    .flatMap((value) => String(value ?? '').split(/[\n,\r\t ]+/))
    .map((value) => value.trim())
    .filter(Boolean))];
}

function addManualUrlToStore(store, body) {
  restoreDeletedUrl(store, body.url);
  const record = upsertUrl(store, {
    url: body.url,
    category: body.category || undefined,
    locale: body.locale || undefined,
    currentPriorityTier: body.priorityTier || undefined,
    isScaledContent: Boolean(body.isScaledContent),
    scaledContentType: body.scaledContentType || null,
    lastBusinessMetricSeenAt: nowIso(),
    restoreIfDeleted: true
  });
  if (!record) return null;
  store.upsert(
    'urlSources',
    (source) => source.urlId === record.id && source.sourceType === 'manual' && source.sourceIdentifier === 'dashboard',
    {
      urlId: record.id,
      sourceType: 'manual',
      sourceIdentifier: 'dashboard',
      sourceSitemapUrl: null,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    },
    {
      lastSeenAt: nowIso(),
      updatedAt: nowIso()
    }
  );
  return record;
}

async function reloadRuntimeConfig() {
  context.config = await loadConfig();
}

function inferCategoryFromPath(pathPrefix) {
  if (pathPrefix === '/') return 'default_www';
  if (/^\/[a-z]{2}\/$/i.test(pathPrefix)) return 'locale';
  if (pathPrefix.startsWith('/blog/')) return 'blog';
  if (pathPrefix.startsWith('/help/')) return 'help';
  if (pathPrefix.startsWith('/form-templates/')) return 'form-templates';
  if (pathPrefix.startsWith('/app-templates/')) return 'app-templates';
  if (pathPrefix.startsWith('/workflow-templates/')) return 'workflow-templates';
  if (pathPrefix.startsWith('/table-templates/')) return 'table-templates';
  if (pathPrefix.startsWith('/pdf-templates/')) return 'pdf-templates';
  if (pathPrefix.startsWith('/agent-templates/')) return 'agent-templates';
  if (pathPrefix.startsWith('/presentation-agent/')) return 'presentation-agent';
  if (pathPrefix.startsWith('/qr-codes/')) return 'qr-codes';
  if (pathPrefix.startsWith('/integrations/')) return 'pages/integrations';
  if (pathPrefix.startsWith('/workflows/')) return 'pages/workflows-features';
  return 'pages';
}

function inferLocaleFromPath(pathPrefix, category) {
  if (category !== 'locale') return null;
  return pathPrefix.match(/^\/([a-z]{2})\/$/i)?.[1]?.toLowerCase() ?? null;
}

function priorityForMapping(category, propertyType) {
  if (propertyType === 'domain') return 1;
  if (category === 'locale') return 100;
  if (category === 'default_www') return 10;
  if (category?.startsWith('pages')) return 10;
  return 95;
}

function inferPropertyMapping(input) {
  const siteUrl = String(input.siteUrl ?? input.propertyUrl ?? '').trim();
  if (!siteUrl) throw new Error('siteUrl is required');

  const isDomain = siteUrl.startsWith('sc-domain:');
  const propertyType = isDomain ? 'domain' : 'url-prefix';
  const parsed = isDomain ? null : new URL(siteUrl);
  const inferredPath = isDomain ? null : (parsed.pathname || '/');
  const pathPrefix = input.pathPrefix || inferredPath;
  const category = input.category || (isDomain ? 'fallback' : inferCategoryFromPath(pathPrefix));
  const locale = input.locale || inferLocaleFromPath(pathPrefix, category);
  const propertyName = input.propertyName || (isDomain ? siteUrl : `GSC ${parsed.hostname}${pathPrefix}`);

  return {
    propertyName,
    propertyUrl: siteUrl,
    propertyType,
    matchType: isDomain ? 'domain-fallback' : 'prefix',
    pathPrefix,
    locale,
    category,
    priorityOrder: Number(input.priorityOrder ?? priorityForMapping(category, propertyType)),
    fallbackAllowed: Boolean(input.fallbackAllowed ?? !isDomain),
    isActive: input.isActive ?? true
  };
}

async function importGscProperties(propertyInputs) {
  const mappings = await readJson('config/property-mappings.json');
  const imported = [];
  const skipped = [];

  for (const input of propertyInputs) {
    const mapping = inferPropertyMapping(input);
    const duplicate = mappings.some((item) => (
      item.propertyUrl === mapping.propertyUrl
      && item.pathPrefix === mapping.pathPrefix
      && item.category === mapping.category
      && item.locale === mapping.locale
    ));

    if (duplicate) {
      skipped.push(mapping);
    } else {
      mappings.push(mapping);
      imported.push(mapping);
    }
  }

  await writeJson('config/property-mappings.json', mappings);
  await reloadRuntimeConfig();
  ensureProperties(context.store, context.config.propertyMappings, context.config.policy);
  await context.store.save();
  return { imported, skipped, propertyMappings: mappings };
}

function removeUrlData(store, urlIds) {
  const idSet = new Set(urlIds.map(Number));
  const now = nowIso();
  for (const url of store.state.urls.filter((row) => idSet.has(Number(row.id)))) {
    store.upsert(
      'deletedUrls',
      (row) => row.normalizedUrl === url.normalizedUrl,
      {
        normalizedUrl: url.normalizedUrl,
        originalUrl: url.url,
        deletedAt: now,
        reason: 'manual_delete',
        createdAt: now,
        updatedAt: now
      },
      {
        originalUrl: url.url,
        deletedAt: now,
        reason: 'manual_delete',
        updatedAt: now
      }
    );
  }
  const before = store.state.urls.length;
  store.state.urls = store.state.urls.filter((url) => !idSet.has(Number(url.id)));
  store.state.urlSources = store.state.urlSources.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.prioritySnapshots = store.state.prioritySnapshots.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.inspectionJobs = store.state.inspectionJobs.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.inspectionResults = store.state.inspectionResults.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.stateTransitions = store.state.stateTransitions.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.technicalChecks = store.state.technicalChecks.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.healthStatuses = store.state.healthStatuses.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.alerts = store.state.alerts.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.gscPerformanceMetrics = store.state.gscPerformanceMetrics.filter((row) => !idSet.has(Number(row.urlId)));
  store.state.businessMetrics = store.state.businessMetrics.filter((row) => !idSet.has(Number(row.urlId)));
  return before - store.state.urls.length;
}

function tableCounts(store) {
  return Object.fromEntries(Object.entries(store.state)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, value.length]));
}

function pruneLatestByKey(rows, keyFn, limit, dateFn = (row) => row.updatedAt ?? row.createdAt ?? row.inspectedAt ?? 0) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap((group) => group
    .slice()
    .sort((a, b) => new Date(dateFn(b) || 0) - new Date(dateFn(a) || 0))
    .slice(0, limit));
}

function compactState(store, options = {}) {
  const before = tableCounts(store);
  const keep = {
    prioritySnapshotsPerUrl: Number(options.prioritySnapshotsPerUrl ?? 3),
    inspectionResultsPerUrl: Number(options.inspectionResultsPerUrl ?? 30),
    transitionsPerUrl: Number(options.transitionsPerUrl ?? 20),
    technicalChecksPerUrl: Number(options.technicalChecksPerUrl ?? 10),
    resolvedAlertsPerUrl: Number(options.resolvedAlertsPerUrl ?? 10),
    completedJobs: Number(options.completedJobs ?? 2000),
    deletedUrls: Number(options.deletedUrls ?? 5000)
  };

  store.state.prioritySnapshots = pruneLatestByKey(
    store.state.prioritySnapshots,
    (row) => row.urlId,
    keep.prioritySnapshotsPerUrl,
    (row) => row.calculatedAt ?? row.createdAt
  );
  store.state.inspectionResults = pruneLatestByKey(
    store.state.inspectionResults,
    (row) => row.urlId,
    keep.inspectionResultsPerUrl,
    (row) => row.inspectedAt ?? row.createdAt
  );
  store.state.stateTransitions = pruneLatestByKey(
    store.state.stateTransitions,
    (row) => row.urlId,
    keep.transitionsPerUrl,
    (row) => row.createdAt
  );
  store.state.technicalChecks = pruneLatestByKey(
    store.state.technicalChecks,
    (row) => row.urlId,
    keep.technicalChecksPerUrl,
    (row) => row.checkedAt ?? row.createdAt
  );

  const activeAlerts = store.state.alerts.filter((alert) => alert.status === 'active');
  const resolvedAlerts = pruneLatestByKey(
    store.state.alerts.filter((alert) => alert.status !== 'active'),
    (row) => row.urlId,
    keep.resolvedAlertsPerUrl,
    (row) => row.resolvedAt ?? row.updatedAt ?? row.createdAt
  );
  store.state.alerts = [...activeAlerts, ...resolvedAlerts];

  const activeJobs = store.state.inspectionJobs.filter((job) => job.status !== 'completed');
  const completedJobs = store.state.inspectionJobs
    .filter((job) => job.status === 'completed')
    .slice()
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0) - new Date(a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, keep.completedJobs);
  store.state.inspectionJobs = [...activeJobs, ...completedJobs];

  const gscByKey = new Map();
  for (const metric of store.state.gscPerformanceMetrics) {
    const key = `${metric.urlId}:${metric.sourceProperty ?? ''}`;
    const previous = gscByKey.get(key);
    if (!previous || new Date(metric.importedAt ?? metric.createdAt ?? 0) > new Date(previous.importedAt ?? previous.createdAt ?? 0)) {
      gscByKey.set(key, metric);
    }
  }
  store.state.gscPerformanceMetrics = [...gscByKey.values()];

  store.state.deletedUrls = (store.state.deletedUrls ?? [])
    .slice()
    .sort((a, b) => new Date(b.deletedAt ?? b.updatedAt ?? 0) - new Date(a.deletedAt ?? a.updatedAt ?? 0))
    .slice(0, keep.deletedUrls);

  const after = tableCounts(store);
  const removed = Object.fromEntries(Object.keys(before).map((key) => [key, before[key] - (after[key] ?? 0)]));
  return { before, after, removed, keep };
}

function gscMetricKey(metric) {
  return `${metric.urlId}:${metric.sourceProperty ?? ''}`;
}

function businessMetricKey(metric) {
  return `${metric.urlId}:${metric.metricType}:${metric.metricMonth}`;
}

function metricMap(rows, keyFn) {
  return new Map(rows.map((row) => [keyFn(row), structuredClone(row)]));
}

function createImportBatch(store, payload) {
  return store.insert('importBatches', {
    ...payload,
    status: 'applied',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

function rollbackImportBatch(store, batchId) {
  const batch = store.findById('importBatches', batchId);
  if (!batch) return null;
  if (batch.status === 'rolled_back') return { batch, alreadyRolledBack: true, deletedUrls: 0, restoredMetrics: 0 };

  const deletedUrls = removeUrlData(store, batch.createdUrlIds ?? []);
  const previousGsc = new Map((batch.previousGscMetrics ?? []).map((row) => [gscMetricKey(row), row]));
  const previousBusiness = new Map((batch.previousBusinessMetrics ?? []).map((row) => [businessMetricKey(row), row]));
  const touchedGscKeys = new Set(batch.touchedGscMetricKeys ?? []);
  const touchedBusinessKeys = new Set(batch.touchedBusinessMetricKeys ?? []);

  store.state.gscPerformanceMetrics = store.state.gscPerformanceMetrics
    .filter((metric) => !touchedGscKeys.has(gscMetricKey(metric)));
  store.state.businessMetrics = store.state.businessMetrics
    .filter((metric) => !touchedBusinessKeys.has(businessMetricKey(metric)));

  store.state.gscPerformanceMetrics.push(...previousGsc.values());
  store.state.businessMetrics.push(...previousBusiness.values());
  batch.status = 'rolled_back';
  batch.rolledBackAt = nowIso();
  batch.updatedAt = nowIso();
  const restoredMetrics = previousGsc.size + previousBusiness.size;
  return { batch, deletedUrls, restoredMetrics };
}

function openAiStatus() {
  return {
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4.1-mini'
  };
}

function urlsForAiClassification(store, limit = 20) {
  return store.state.urls
    .filter((url) => !url.manualPriorityTier && !url.isManuallyExcluded)
    .filter((url) => ['pages', 'unknown', null, undefined].includes(url.category) || url.currentPriorityTier === 'P3')
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)))
    .map((url) => ({
      id: url.id,
      normalizedUrl: url.normalizedUrl,
      category: url.category,
      locale: url.locale,
      priorityTier: url.currentPriorityTier,
      isScaledContent: url.isScaledContent,
      sources: context.store.state.urlSources
        .filter((source) => source.urlId === url.id)
        .map((source) => source.sourceSitemapUrl || source.sourceIdentifier)
        .filter(Boolean)
        .slice(0, 3)
    }));
}

async function classifyUrlsWithOpenAI(urls) {
  const status = openAiStatus();
  if (!status.hasKey) return { configured: false, model: status.model, classifications: [] };
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'number' },
            category: { type: 'string' },
            priorityTier: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            locale: { type: ['string', 'null'] },
            isScaledContent: { type: 'boolean' },
            scaledContentType: { type: ['string', 'null'] },
            confidence: { type: 'number' },
            reason: { type: 'string' }
          },
          required: ['id', 'category', 'priorityTier', 'locale', 'isScaledContent', 'scaledContentType', 'confidence', 'reason']
        }
      }
    },
    required: ['classifications']
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: status.model,
      input: [
        {
          role: 'system',
          content: 'Classify SEO monitoring URLs. Prefer deterministic path/source evidence. Do not invent metrics. Return concise reasons.'
        },
        {
          role: 'user',
          content: JSON.stringify({ urls })
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'url_classification_batch',
          schema,
          strict: true
        }
      }
    })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error?.message ?? 'OpenAI classification failed');
  const text = json.output_text
    ?? json.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
  return { configured: true, model: status.model, ...JSON.parse(text) };
}

function restoreDeletedUrl(store, url) {
  const normalized = normalizeUrl(url);
  store.state.deletedUrls = (store.state.deletedUrls ?? []).filter((row) => row.normalizedUrl !== normalized);
}

function nextDueForTier(url, policy) {
  return calculateNextDueAt(url, {
    isSubmittedAndIndexed: ['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState),
    isNotIndexed: !['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState)
  }, policy);
}

function removeSitemapUrlRecords(store) {
  const ids = store.state.urls
    .filter((url) => isSitemapLikeUrl(url.normalizedUrl) || isSitemapLikeUrl(url.url))
    .map((url) => url.id);
  return removeUrlData(store, ids);
}

function findUrlIdsForDeletion(store, values) {
  const normalized = new Set(normalizeUrlList(values).map((value) => {
    try {
      return normalizeUrl(value);
    } catch {
      return value;
    }
  }));
  const ids = [];
  for (const url of store.state.urls) {
    if (normalized.has(url.normalizedUrl) || normalized.has(url.url)) {
      ids.push(url.id);
    }
  }
  return ids;
}

function normalizeIdList(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list
    .flatMap((value) => Array.isArray(value) ? value : String(value ?? '').split(/[\n,\r\t ]+/))
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

async function serveStatic(response, requestPath) {
  const filePath = requestPath === '/'
    ? path.join(publicDir, 'index.html')
    : path.join(publicDir, requestPath.replace(/^\/+/, ''));
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(publicDir)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(normalized);
    const ext = path.extname(normalized);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') sendText(response, 404, 'Not found');
    else sendText(response, 500, error.message);
  }
}

async function createAppContext() {
  const context = await createContext();
  context.store.state.deletedUrls ??= [];
  const cleaned = removeSitemapUrlRecords(context.store);
  if (cleaned) await context.store.save();
  if (context.store.state.urls.length === 0) {
    await seedContext({ reset: false });
    const seededContext = await createContext();
    const seededCleaned = removeSitemapUrlRecords(seededContext.store);
    if (seededCleaned) await seededContext.store.save();
    return seededContext;
  }
  return context;
}

let context = null;
let contextError = null;
let contextReady = null;

function ensureContextReady() {
  if (!contextReady) {
    contextReady = createAppContext()
      .then(async (loadedContext) => {
        context = loadedContext;
        await context.store.save();
        return context;
      })
      .catch((error) => {
        contextError = error;
        console.error('Failed to initialize app context:', error);
        return null;
      });
  }
  return contextReady;
}

const cronState = {
  dailySitemapFetchEnabled: process.env.DAILY_SITEMAP_FETCH_ENABLED !== 'false',
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null
};

async function runDailySitemapFetchCron(reason = 'daily_cron') {
  if (!cronState.dailySitemapFetchEnabled || cronState.running) return null;
  cronState.running = true;
  cronState.lastRunAt = nowIso();
  try {
    await ensureContextReady();
    if (!context) throw contextError ?? new Error('App context is not ready.');
    const cleanedBefore = removeSitemapUrlRecords(context.store);
    const counts = await ingestConfiguredSitemaps(context.store, context.config, context.resolvePath, {
      includeLocal: false,
      fetchChildSitemaps: true,
      useDemoUrlsWhenChildFetchIsOff: false,
      useDemoUrlsWhenChildFetchFails: false
    });
    const cleanedAfter = removeSitemapUrlRecords(context.store);
    const thresholds = recalculatePriorities(context.store);
    await context.store.save();
    cronState.lastResult = {
      reason,
      counts,
      cleanedSitemapUrlRecords: cleanedBefore + cleanedAfter,
      thresholds
    };
    cronState.lastError = null;
    return cronState.lastResult;
  } catch (error) {
    cronState.lastError = error.message;
    return null;
  } finally {
    cronState.running = false;
  }
}

if (cronState.dailySitemapFetchEnabled) {
  setInterval(() => {
    runDailySitemapFetchCron().catch((error) => {
      cronState.lastError = error.message;
      cronState.running = false;
    });
  }, 24 * 60 * 60 * 1000);
}

const server = http.createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, `http://${request.headers.host}`);
    const pathname = parsed.pathname;

    if (pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        ready: Boolean(context),
        loading: !context && !contextError,
        error: contextError?.message ?? null,
        now: nowIso()
      });
      return;
    }

    if (pathname === '/api/cron/daily' && request.method === 'POST') {
      if (!isCronAuthorized(parsed, request)) {
        sendJson(response, 401, { error: 'Invalid or missing cron secret' });
        return;
      }
      await ensureContextReady();
      if (!context) {
        sendJson(response, 503, { error: contextError?.message ?? 'App context is not ready.' });
        return;
      }
      const body = await readBody(request);
      const fetchResult = await runDailySitemapFetchCron('external_cron');
      const schedulerSummary = await runScheduler(context.store, context.config, {
        limit: Number(body.limit ?? parsed.searchParams.get('limit') ?? process.env.DAILY_CRON_SCHEDULER_LIMIT ?? 500),
        force: Boolean(body.force)
      });
      await context.store.save();
      sendJson(response, 200, {
        ok: true,
        now: nowIso(),
        fetchResult,
        schedulerSummary,
        cron: cronState
      });
      return;
    }

    if (isAuthEnabled() && pathname === '/login') {
      if (isAuthenticated(request)) {
        redirect(response, '/');
      } else {
        sendText(response, 200, loginPage({ error: parsed.searchParams.get('error') === '1' }), 'text/html; charset=utf-8');
      }
      return;
    }

    if (isAuthEnabled() && pathname === '/auth/login' && request.method === 'POST') {
      const body = await readBody(request);
      if (safeEqual(String(body.password ?? ''), authPassword())) {
        redirect(response, '/', {
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionToken())}; ${cookieOptions(request)}`
        });
      } else {
        redirect(response, '/login?error=1');
      }
      return;
    }

    if (isAuthEnabled() && pathname === '/auth/logout') {
      redirect(response, '/login', {
        'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
      });
      return;
    }

    if (!isAuthenticated(request)) {
      if (pathname.startsWith('/api/')) {
        sendJson(response, 401, { error: 'Authentication required' });
      } else {
        redirect(response, '/login');
      }
      return;
    }

    await ensureContextReady();
    if (!context) {
      sendJson(response, 503, { error: contextError?.message ?? 'App context is not ready.' });
      return;
    }

    if (pathname === '/api/settings') {
      sendJson(response, 200, {
        sources: context.config.sources,
        inspection: context.config.policy.inspection,
        propertyMappings: context.config.propertyMappings,
        cron: cronState,
        importBatches: (context.store.state.importBatches ?? []).slice().reverse().slice(0, 20),
        openAI: openAiStatus(),
        googleAuth: await googleAuthStatus(),
        oauthRedirectUri: `${publicOrigin(parsed.origin)}/auth/google/callback`
      });
      return;
    }

    if (pathname === '/api/settings/sources' && request.method === 'POST') {
      const body = await readBody(request);
      const sources = await readJson('config/sources.json');
      sources.sitemapIndexUrls ??= [];
      sources.childSitemapUrls ??= [];
      const added = { sitemapIndexUrls: [], childSitemapUrls: [] };
      const skipped = { sitemapIndexUrls: [], childSitemapUrls: [] };

      const sitemapIndexUrls = normalizeUrlList([
        body.sitemapIndexUrl,
        body.sitemapIndexUrls,
        body.bulkSitemapIndexUrls
      ]);
      const childSitemapUrls = normalizeUrlList([
        body.childSitemapUrl,
        body.childSitemapUrls,
        body.bulkChildSitemapUrls
      ]);

      for (const url of sitemapIndexUrls) {
        if (sources.sitemapIndexUrls.includes(url)) skipped.sitemapIndexUrls.push(url);
        else {
          sources.sitemapIndexUrls.push(url);
          added.sitemapIndexUrls.push(url);
        }
      }

      for (const url of childSitemapUrls) {
        if (sources.childSitemapUrls.includes(url)) skipped.childSitemapUrls.push(url);
        else {
          sources.childSitemapUrls.push(url);
          added.childSitemapUrls.push(url);
        }
      }

      if (typeof body.fetchChildSitemaps === 'boolean') {
        sources.fetchChildSitemaps = body.fetchChildSitemaps;
      }
      if (typeof body.useDemoUrlsWhenChildFetchFails === 'boolean') {
        sources.useDemoUrlsWhenChildFetchFails = body.useDemoUrlsWhenChildFetchFails;
      }
      if (typeof body.useDemoUrlsWhenChildFetchIsOff === 'boolean') {
        sources.useDemoUrlsWhenChildFetchIsOff = body.useDemoUrlsWhenChildFetchIsOff;
      }

      await writeJson('config/sources.json', sources);
      await reloadRuntimeConfig();
      sendJson(response, 200, { ok: true, sources, added, skipped });
      return;
    }

    if (pathname === '/api/settings/sources/delete' && request.method === 'POST') {
      const body = await readBody(request);
      const sources = await readJson('config/sources.json');
      const sitemapIndexUrls = new Set(normalizeUrlList([body.sitemapIndexUrls, body.sitemapIndexUrl]));
      const childSitemapUrls = new Set(normalizeUrlList([body.childSitemapUrls, body.childSitemapUrl]));
      const before = {
        sitemapIndexUrls: sources.sitemapIndexUrls?.length ?? 0,
        childSitemapUrls: sources.childSitemapUrls?.length ?? 0
      };
      sources.sitemapIndexUrls = (sources.sitemapIndexUrls ?? []).filter((url) => !sitemapIndexUrls.has(url));
      sources.childSitemapUrls = (sources.childSitemapUrls ?? []).filter((url) => !childSitemapUrls.has(url));
      const deleted = {
        sitemapIndexUrls: before.sitemapIndexUrls - sources.sitemapIndexUrls.length,
        childSitemapUrls: before.childSitemapUrls - sources.childSitemapUrls.length
      };
      await writeJson('config/sources.json', sources);
      await reloadRuntimeConfig();
      sendJson(response, 200, { ok: true, sources, deleted });
      return;
    }

    if (pathname === '/api/settings/sitemaps/delete' && request.method === 'POST') {
      const body = await readBody(request);
      const sources = await readJson('config/sources.json');
      const sitemapUrls = new Set(normalizeUrlList([body.sitemapUrls, body.sitemapUrl]));
      const beforeSitemaps = context.store.state.sitemaps.length;
      const beforeSources = context.store.state.urlSources.length;
      const beforeExcluded = sources.excludedSitemapUrls?.length ?? 0;

      sources.excludedSitemapUrls = [
        ...new Set([...(sources.excludedSitemapUrls ?? []), ...sitemapUrls])
      ];
      sources.sitemapIndexUrls = (sources.sitemapIndexUrls ?? []).filter((url) => !sitemapUrls.has(url));
      sources.childSitemapUrls = (sources.childSitemapUrls ?? []).filter((url) => !sitemapUrls.has(url));
      context.store.state.sitemaps = context.store.state.sitemaps.filter((sitemap) => !sitemapUrls.has(sitemap.sitemapUrl));
      context.store.state.urlSources = context.store.state.urlSources.filter((source) => (
        !sitemapUrls.has(source.sourceSitemapUrl) && !sitemapUrls.has(source.sourceIdentifier)
      ));

      await writeJson('config/sources.json', sources);
      await reloadRuntimeConfig();
      await context.store.save();
      sendJson(response, 200, {
        ok: true,
        sources,
        deletedSitemaps: beforeSitemaps - context.store.state.sitemaps.length,
        deletedUrlSources: beforeSources - context.store.state.urlSources.length,
        excludedSitemapUrls: sources.excludedSitemapUrls.length - beforeExcluded
      });
      return;
    }

    if (pathname === '/api/actions/fetch-sitemaps' && request.method === 'POST') {
      const beforeUrls = context.store.state.urls.length;
      const cleanedBefore = removeSitemapUrlRecords(context.store);
      const counts = await ingestConfiguredSitemaps(context.store, context.config, context.resolvePath, {
        includeLocal: false,
        fetchChildSitemaps: true,
        useDemoUrlsWhenChildFetchIsOff: false,
        useDemoUrlsWhenChildFetchFails: false
      });
      const cleanedAfter = removeSitemapUrlRecords(context.store);
      const thresholds = recalculatePriorities(context.store);
      const fetchLog = sitemapFetchLog(context.store);
      await context.store.save();
      sendJson(response, 200, {
        ok: true,
        counts,
        fetchSummary: {
          success: fetchLog.filter((row) => row.health === 'success').length,
          failed: fetchLog.filter((row) => row.health === 'failed').length,
          pending: fetchLog.filter((row) => row.health === 'pending').length,
          total: fetchLog.length
        },
        cleanedSitemapUrlRecords: cleanedBefore + cleanedAfter,
        urlsBefore: beforeUrls,
        urlsAfter: context.store.state.urls.length,
        urlsAddedOrUpdated: counts.urlCount,
        thresholds
      });
      return;
    }

    if (pathname === '/api/settings/delete-urls' && request.method === 'POST') {
      const body = await readBody(request);
      const ids = [...new Set([
        ...normalizeIdList([body.ids, body.id]),
        ...findUrlIdsForDeletion(context.store, [body.urls, body.bulkUrls, body.url])
      ])];
      const deleted = removeUrlData(context.store, ids);
      await context.store.save();
      sendJson(response, 200, { ok: true, matched: ids.length, deleted });
      return;
    }

    if (pathname === '/api/settings/manual-url' && request.method === 'POST') {
      const body = await readBody(request);
      if (!body.url) {
        sendJson(response, 400, { error: 'url is required' });
        return;
      }
      const record = addManualUrlToStore(context.store, body);
      await context.store.save();
      sendJson(response, 200, { ok: true, url: record });
      return;
    }

    if (pathname === '/api/settings/csv-import' && request.method === 'POST') {
      const body = await readBody(request);
      const csvText = String(body.csvText ?? body.csv ?? '').trim();
      const importType = String(body.importType ?? body.type ?? '').trim();
      if (!csvText) {
        sendJson(response, 400, { error: 'csvText is required' });
        return;
      }
      if (!['gsc', 'p30_users', 'signup_count'].includes(importType)) {
        sendJson(response, 400, { error: 'importType must be gsc, p30_users, or signup_count' });
        return;
      }

      const beforeUrls = context.store.state.urls.length;
      const sourceName = `dashboard:${importType}:${nowIso()}`;
      const beforeUrlIds = new Set(context.store.state.urls.map((url) => Number(url.id)));
      const beforeGscMetrics = metricMap(context.store.state.gscPerformanceMetrics, gscMetricKey);
      const beforeBusinessMetrics = metricMap(context.store.state.businessMetrics, businessMetricKey);
      let importedRows = 0;
      if (importType === 'gsc') {
        importedRows = ingestGscCsvText(context.store, csvText, sourceName);
      } else {
        importedRows = ingestBusinessWideCsvText(context.store, csvText, importType, sourceName);
      }
      const createdUrlIds = context.store.state.urls
        .filter((url) => !beforeUrlIds.has(Number(url.id)))
        .map((url) => url.id);
      const touchedGscMetricKeys = context.store.state.gscPerformanceMetrics
        .filter((metric) => metric.sourceFile === sourceName)
        .map(gscMetricKey);
      const touchedBusinessMetricKeys = context.store.state.businessMetrics
        .filter((metric) => metric.sourceFile === sourceName)
        .map(businessMetricKey);
      const previousGscMetrics = touchedGscMetricKeys
        .map((key) => beforeGscMetrics.get(key))
        .filter(Boolean);
      const previousBusinessMetrics = touchedBusinessMetricKeys
        .map((key) => beforeBusinessMetrics.get(key))
        .filter(Boolean);
      const thresholds = recalculatePriorities(context.store);
      const batch = createImportBatch(context.store, {
        importType,
        sourceName,
        importedRows,
        urlsBefore: beforeUrls,
        urlsAfter: context.store.state.urls.length,
        urlsAdded: context.store.state.urls.length - beforeUrls,
        createdUrlIds,
        touchedGscMetricKeys,
        touchedBusinessMetricKeys,
        previousGscMetrics,
        previousBusinessMetrics
      });
      await context.store.save();
      sendJson(response, 200, {
        ok: true,
        importBatch: batch,
        importType,
        importedRows,
        urlsBefore: beforeUrls,
        urlsAfter: context.store.state.urls.length,
        urlsAdded: context.store.state.urls.length - beforeUrls,
        thresholds
      });
      return;
    }

    if (pathname === '/api/settings/csv-preview' && request.method === 'POST') {
      const body = await readBody(request);
      const csvText = String(body.csvText ?? body.csv ?? '').trim();
      const importType = String(body.importType ?? body.type ?? '').trim();
      if (!csvText) {
        sendJson(response, 400, { error: 'csvText is required' });
        return;
      }
      if (!['gsc', 'p30_users', 'signup_count'].includes(importType)) {
        sendJson(response, 400, { error: 'importType must be gsc, p30_users, or signup_count' });
        return;
      }
      const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
      const headers = lines[0]?.split(',').map((item) => item.trim().replace(/^"|"$/g, '')) ?? [];
      const warnings = [];
      if (importType === 'gsc' && !headers.includes('url')) warnings.push('GSC CSV should include a url column.');
      if (importType !== 'gsc' && !headers.includes('path')) warnings.push('P30/signup wide CSV should include a path column.');
      sendJson(response, 200, {
        ok: true,
        importType,
        rowCount: Math.max(lines.length - 1, 0),
        headers,
        sampleRows: lines.slice(1, 6),
        warnings
      });
      return;
    }

    if (pathname === '/api/settings/maintenance/compact' && request.method === 'POST') {
      const body = await readBody(request);
      const result = compactState(context.store, body);
      await context.store.save();
      sendJson(response, 200, { ok: true, result });
      return;
    }

    const rollbackMatch = pathname.match(/^\/api\/settings\/imports\/(\d+)\/rollback$/);
    if (rollbackMatch && request.method === 'POST') {
      const result = rollbackImportBatch(context.store, Number(rollbackMatch[1]));
      if (!result) {
        sendJson(response, 404, { error: 'Import batch not found' });
        return;
      }
      const thresholds = recalculatePriorities(context.store);
      await context.store.save();
      sendJson(response, 200, { ok: true, ...result, thresholds });
      return;
    }

    if (pathname === '/api/settings/inspection' && request.method === 'POST') {
      const body = await readBody(request);
      const policy = await readJson('config/policy.json');
      if (!['mock', 'gsc'].includes(body.provider)) {
        sendJson(response, 400, { error: 'provider must be mock or gsc' });
        return;
      }
      policy.inspection.provider = body.provider;
      if (body.languageCode) policy.inspection.languageCode = body.languageCode;
      await writeJson('config/policy.json', policy);
      await reloadRuntimeConfig();
      sendJson(response, 200, { ok: true, inspection: policy.inspection });
      return;
    }

    if (pathname === '/api/settings/google-oauth-client' && request.method === 'POST') {
      const body = await readBody(request);
      const status = await saveOAuthClient(body);
      sendJson(response, 200, { ok: true, googleAuth: status });
      return;
    }

    if (pathname === '/api/settings/google-disconnect' && request.method === 'POST') {
      const status = await disconnectGoogle();
      sendJson(response, 200, { ok: true, googleAuth: status });
      return;
    }

    if (pathname === '/api/settings/gsc-sites') {
      sendJson(response, 200, { sites: await listSearchConsoleSites() });
      return;
    }

    if (pathname === '/api/settings/gsc-properties/import' && request.method === 'POST') {
      const body = await readBody(request);
      const properties = body.properties ?? [];
      if (!Array.isArray(properties) || properties.length === 0) {
        sendJson(response, 400, { error: 'properties array is required' });
        return;
      }
      sendJson(response, 200, { ok: true, ...(await importGscProperties(properties)) });
      return;
    }

    if (pathname === '/api/actions/sync-gsc-properties' && request.method === 'POST') {
      const token = await getSearchConsoleAccessToken(context.config.policy);
      const siteResponse = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { authorization: `Bearer ${token}` }
      });
      const siteJson = await siteResponse.json();
      if (!siteResponse.ok) {
        sendJson(response, 502, { error: siteJson.error?.message ?? `Search Console sites request failed with ${siteResponse.status}` });
        return;
      }
      const properties = (siteJson.siteEntry ?? []).map((site) => ({
        siteUrl: site.siteUrl,
        propertyName: `GSC ${site.siteUrl}`,
        fallbackAllowed: true,
        isActive: true
      }));
      sendJson(response, 200, { ok: true, ...(await importGscProperties(properties)), sites: siteJson.siteEntry ?? [] });
      return;
    }

    if (pathname === '/auth/google/start') {
      const url = await createGoogleAuthUrl(publicOrigin(parsed.origin));
      response.writeHead(302, { location: url });
      response.end();
      return;
    }

    if (pathname === '/auth/google/callback') {
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      if (!code) {
        sendText(response, 400, 'Google OAuth callback missing code.');
        return;
      }
      const status = await exchangeGoogleCode({ code, state });
      sendText(response, 200, `
        <!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Google connected</title></head>
          <body style="font-family: system-ui; padding: 32px;">
            <h1>Google connected</h1>
            <p>${status.email ?? 'Account'} is connected. You can close this tab or return to the dashboard.</p>
            <p><a href="${publicOrigin(parsed.origin)}/#settings">Back to dashboard</a></p>
          </body>
        </html>
      `, 'text/html; charset=utf-8');
      return;
    }

    if (pathname === '/api/overview') {
      sendJson(response, 200, overview(context.store));
      return;
    }

    if (pathname === '/api/roadmap') {
      sendJson(response, 200, roadmap(context.store, context.config));
      return;
    }

    if (pathname === '/api/urls') {
      sendJson(response, 200, urlExplorer(context.store, Object.fromEntries(parsed.searchParams.entries())));
      return;
    }

    const detailMatch = pathname.match(/^\/api\/urls\/(\d+)$/);
    if (detailMatch && request.method === 'GET') {
      const detail = urlDetail(context.store, Number(detailMatch[1]));
      sendJson(response, detail ? 200 : 404, detail ?? { error: 'URL not found' });
      return;
    }

    if (detailMatch && request.method === 'PATCH') {
      const url = context.store.findById('urls', Number(detailMatch[1]));
      if (!url) {
        sendJson(response, 404, { error: 'URL not found' });
        return;
      }
      const body = await readBody(request);
      const allowedTiers = new Set(['P0', 'P1', 'P2', 'P3', 'Excluded']);
      if (body.priorityTier && !allowedTiers.has(body.priorityTier)) {
        sendJson(response, 400, { error: 'Invalid priority tier' });
        return;
      }
      if (body.category !== undefined) url.category = String(body.category || 'pages');
      if (body.locale !== undefined) url.locale = body.locale ? String(body.locale).toLowerCase() : null;
      if (body.priorityTier !== undefined) {
        url.currentPriorityTier = body.priorityTier;
        url.manualPriorityTier = body.priorityTier === 'Excluded' ? 'Excluded' : body.priorityTier;
        url.isManuallyExcluded = body.priorityTier === 'Excluded';
        url.isActive = body.priorityTier !== 'Excluded';
      }
      if (body.isScaledContent !== undefined) url.isScaledContent = Boolean(body.isScaledContent);
      if (body.scaledContentType !== undefined) url.scaledContentType = body.scaledContentType ? String(body.scaledContentType) : null;
      if (body.priorityTier !== undefined || body.isScaledContent !== undefined) {
        url.nextInspectionDueAt = url.currentPriorityTier === 'Excluded' ? null : nextDueForTier(url, context.config.policy);
      }
      url.updatedAt = nowIso();
      await context.store.save();
      sendJson(response, 200, { ok: true, url });
      return;
    }

    const excludeMatch = pathname.match(/^\/api\/urls\/(\d+)\/exclude$/);
    if (excludeMatch && request.method === 'POST') {
      const url = context.store.findById('urls', Number(excludeMatch[1]));
      if (!url) {
        sendJson(response, 404, { error: 'URL not found' });
        return;
      }
      url.isManuallyExcluded = true;
      url.isActive = false;
      url.currentPriorityTier = 'Excluded';
      url.manualPriorityTier = 'Excluded';
      url.currentIndexState = 'manually_excluded';
      url.nextInspectionDueAt = null;
      url.updatedAt = nowIso();
      await context.store.save();
      sendJson(response, 200, { ok: true, url });
      return;
    }

    const includeMatch = pathname.match(/^\/api\/urls\/(\d+)\/include$/);
    if (includeMatch && request.method === 'POST') {
      const url = context.store.findById('urls', Number(includeMatch[1]));
      if (!url) {
        sendJson(response, 404, { error: 'URL not found' });
        return;
      }
      url.isManuallyExcluded = false;
      url.isActive = true;
      if (url.manualPriorityTier === 'Excluded') delete url.manualPriorityTier;
      url.nextInspectionDueAt = nowIso();
      url.updatedAt = nowIso();
      await context.store.save();
      sendJson(response, 200, { ok: true, url });
      return;
    }

    if (pathname === '/api/properties') {
      sendJson(response, 200, context.store.state.properties);
      return;
    }

    const propertyMatch = pathname.match(/^\/api\/properties\/(\d+)$/);
    if (propertyMatch && request.method === 'PATCH') {
      const property = context.store.findById('properties', Number(propertyMatch[1]));
      if (!property) {
        sendJson(response, 404, { error: 'Property not found' });
        return;
      }
      const body = await readBody(request);
      const allowedAuthStatuses = new Set(['ok', 'needs_auth', 'disabled']);
      if (body.authStatus !== undefined && !allowedAuthStatuses.has(body.authStatus)) {
        sendJson(response, 400, { error: 'authStatus must be ok, needs_auth, or disabled' });
        return;
      }
      if (body.isActive !== undefined) property.isActive = Boolean(body.isActive);
      if (body.fallbackEnabled !== undefined) property.fallbackEnabled = Boolean(body.fallbackEnabled);
      if (body.authStatus !== undefined) property.authStatus = body.authStatus;
      property.updatedAt = nowIso();
      await context.store.save();
      sendJson(response, 200, { ok: true, property });
      return;
    }

    if (pathname === '/api/alerts') {
      sendJson(response, 200, context.store.state.alerts.slice().reverse());
      return;
    }

    const alertActionMatch = pathname.match(/^\/api\/alerts\/(\d+)\/(acknowledge|resolve|reopen)$/);
    if (alertActionMatch && request.method === 'POST') {
      const alert = context.store.findById('alerts', Number(alertActionMatch[1]));
      if (!alert) {
        sendJson(response, 404, { error: 'Alert not found' });
        return;
      }
      const action = alertActionMatch[2];
      if (action === 'acknowledge') {
        alert.status = 'acknowledged';
        alert.acknowledgedAt = nowIso();
      }
      if (action === 'resolve') {
        alert.status = 'resolved';
        alert.resolvedAt = nowIso();
      }
      if (action === 'reopen') {
        alert.status = 'active';
        alert.resolvedAt = null;
      }
      alert.updatedAt = nowIso();
      await context.store.save();
      sendJson(response, 200, { ok: true, alert });
      return;
    }

    if (pathname === '/api/scaled') {
      sendJson(response, 200, scaledDashboard(context.store));
      return;
    }

    if (pathname === '/api/sitemaps') {
      sendJson(response, 200, sitemapFetchLog(context.store));
      return;
    }

    if (pathname === '/api/jobs') {
      sendJson(response, 200, context.store.state.inspectionJobs.slice().reverse().slice(0, 200));
      return;
    }

    if (pathname === '/api/job-diagnostics') {
      sendJson(response, 200, jobDiagnostics(context.store));
      return;
    }

    if (pathname === '/api/report.csv') {
      sendText(response, 200, exportHealthReport(context.store, Object.fromEntries(parsed.searchParams.entries())), 'text/csv; charset=utf-8');
      return;
    }

    if (pathname === '/api/actions/seed' && request.method === 'POST') {
      const body = await readBody(request);
      context = await seedContext({ reset: body.reset !== false });
      sendJson(response, 200, { ok: true, counts: context.counts, thresholds: context.thresholds });
      return;
    }

    if (pathname === '/api/actions/run-scheduler' && request.method === 'POST') {
      const body = await readBody(request);
      const summary = await runScheduler(context.store, context.config, {
        limit: body.limit ?? 100,
        force: Boolean(body.force),
        urlId: body.urlId ? Number(body.urlId) : null
      });
      await context.store.save();
      sendJson(response, 200, { ok: true, summary });
      return;
    }

    if (pathname === '/api/actions/classify-urls' && request.method === 'POST') {
      const body = await readBody(request);
      const candidates = urlsForAiClassification(context.store, body.limit ?? 20);
      const result = await classifyUrlsWithOpenAI(candidates);
      let applied = 0;
      if (result.configured) {
        for (const classification of result.classifications ?? []) {
          if (Number(classification.confidence) < 0.5) continue;
          const url = context.store.findById('urls', classification.id);
          if (!url || url.manualPriorityTier) continue;
          url.category = classification.category || url.category;
          url.locale = classification.locale ?? url.locale;
          url.isScaledContent = Boolean(classification.isScaledContent);
          url.scaledContentType = classification.scaledContentType ?? url.scaledContentType;
          url.currentPriorityTier = classification.priorityTier || url.currentPriorityTier;
          url.aiClassification = {
            confidence: classification.confidence,
            reason: classification.reason,
            model: result.model,
            classifiedAt: nowIso()
          };
          url.updatedAt = nowIso();
          applied += 1;
        }
        await context.store.save();
      }
      sendJson(response, 200, { ok: true, candidates: candidates.length, applied, ...result });
      return;
    }

    await serveStatic(response, pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message, stack: error.stack });
  }
});

server.listen(PORT, () => {
  console.log(`Index Health Monitoring Engine running at http://localhost:${PORT}`);
});
