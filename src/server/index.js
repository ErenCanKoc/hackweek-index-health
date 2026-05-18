import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createContext, seedContext } from '../core/bootstrap.js';
import { loadConfig, readJson, writeJson } from '../core/config.js';
import {
  createGoogleAuthUrl,
  disconnectGoogle,
  exchangeGoogleCode,
  googleAuthStatus,
  listSearchConsoleSites,
  saveOAuthClient
} from '../core/googleAuth.js';
import { ensureProperties } from '../core/propertyResolver.js';
import { exportHealthReport, overview, scaledDashboard, urlDetail, urlExplorer } from '../core/reporting.js';
import { runScheduler } from '../core/scheduler.js';
import { nowIso } from '../core/utils.js';

const PORT = Number(process.env.PORT ?? 3000);
const publicDir = path.join(process.cwd(), 'public');

function publicOrigin(fallbackOrigin) {
  return (process.env.APP_BASE_URL || fallbackOrigin).replace(/\/+$/, '');
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
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function appendManualUrl(row) {
  const filePath = path.join(process.cwd(), 'data/imports/manual-urls.csv');
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, 'url,category,locale,is_scaled_content,scaled_content_type,priority_tier\n');
  }

  const line = [
    row.url,
    row.category || 'pages',
    row.locale || 'en',
    row.isScaledContent ? 'true' : 'false',
    row.scaledContentType || '',
    row.priorityTier || 'P3'
  ].map(csvEscape).join(',');
  await fs.appendFile(filePath, `${line}\n`);
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
  if (context.store.state.urls.length === 0) {
    await seedContext({ reset: false });
    return createContext();
  }
  return context;
}

let context = await createAppContext();
await context.store.save();

const server = http.createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, `http://${request.headers.host}`);
    const pathname = parsed.pathname;

    if (pathname === '/api/health') {
      sendJson(response, 200, { ok: true, now: nowIso() });
      return;
    }

    if (pathname === '/api/settings') {
      sendJson(response, 200, {
        sources: context.config.sources,
        inspection: context.config.policy.inspection,
        propertyMappings: context.config.propertyMappings,
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

      if (body.sitemapIndexUrl && !sources.sitemapIndexUrls.includes(body.sitemapIndexUrl)) {
        sources.sitemapIndexUrls.push(body.sitemapIndexUrl);
      }
      if (body.childSitemapUrl && !sources.childSitemapUrls.includes(body.childSitemapUrl)) {
        sources.childSitemapUrls.push(body.childSitemapUrl);
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
      sendJson(response, 200, { ok: true, sources });
      return;
    }

    if (pathname === '/api/settings/manual-url' && request.method === 'POST') {
      const body = await readBody(request);
      if (!body.url) {
        sendJson(response, 400, { error: 'url is required' });
        return;
      }
      await appendManualUrl(body);
      sendJson(response, 200, { ok: true });
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
      url.currentIndexState = 'manually_excluded';
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

    if (pathname === '/api/alerts') {
      sendJson(response, 200, context.store.state.alerts.slice().reverse());
      return;
    }

    if (pathname === '/api/scaled') {
      sendJson(response, 200, scaledDashboard(context.store));
      return;
    }

    if (pathname === '/api/jobs') {
      sendJson(response, 200, context.store.state.inspectionJobs.slice().reverse().slice(0, 200));
      return;
    }

    if (pathname === '/api/report.csv') {
      sendText(response, 200, exportHealthReport(context.store), 'text/csv; charset=utf-8');
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
      const summary = await runScheduler(context.store, context.config, { limit: body.limit ?? 100 });
      await context.store.save();
      sendJson(response, 200, { ok: true, summary });
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
