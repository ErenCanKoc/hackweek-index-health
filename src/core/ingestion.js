import fs from 'node:fs/promises';
import {
  classifySitemap,
  expandSitemapSources,
  extractSitemapUrlEntries,
  fetchText,
  generateDemoUrlsForSitemap
} from './sitemap.js';
import { compact, parseCsv, nowIso, normalizeUrl, pathFromUrl, urlFromPath } from './utils.js';

function detectLocaleFromPath(path) {
  const match = path.match(/^\/([a-z]{2})(?:\/|$)/i);
  return match ? match[1].toLowerCase() : 'en';
}

function categoryFromPath(path) {
  if (path.startsWith('/blog/')) return 'blog';
  if (path.startsWith('/help/')) return 'help';
  if (path.includes('/form-templates/') || path.startsWith('/form-templates/')) return 'form-templates';
  if (path.includes('/app-templates/') || path.startsWith('/app-templates/')) return 'app-templates';
  if (path.startsWith('/workflows/')) return 'pages/workflows-features';
  if (path.startsWith('/integrations/')) return 'pages/integrations';
  return 'pages';
}

export function upsertUrl(store, values) {
  const now = nowIso();
  const normalizedUrl = normalizeUrl(values.url);
  const urlPath = pathFromUrl(normalizedUrl);
  const createCategory = values.category ?? categoryFromPath(urlPath);
  const createLocale = values.locale ?? detectLocaleFromPath(urlPath);

  return store.upsert(
    'urls',
    (row) => row.normalizedUrl === normalizedUrl,
    {
      url: values.url,
      normalizedUrl,
      canonicalIdentityUrl: normalizedUrl,
      category: createCategory,
      subCategory: values.subCategory ?? null,
      locale: createLocale,
      isScaledContent: Boolean(values.isScaledContent),
      scaledContentType: values.scaledContentType ?? null,
      isActive: values.isActive ?? true,
      isManuallyExcluded: false,
      currentPriorityTier: values.currentPriorityTier ?? 'P3',
      currentIndexState: 'discovered',
      currentHealthState: 'unknown',
      firstSeenAt: values.firstSeenAt ?? now,
      lastSeenAt: now,
      lastSitemapSeenAt: values.lastSitemapSeenAt ?? null,
      lastBusinessMetricSeenAt: values.lastBusinessMetricSeenAt ?? null,
      lastInspectedAt: null,
      nextInspectionDueAt: values.nextInspectionDueAt ?? now,
      createdAt: now,
      updatedAt: now
    },
    compact({
      category: values.category,
      subCategory: values.subCategory,
      locale: values.locale,
      isScaledContent: values.isScaledContent,
      scaledContentType: values.scaledContentType,
      isActive: values.isActive ?? true,
      lastSeenAt: now,
      lastSitemapSeenAt: values.lastSitemapSeenAt ?? undefined,
      lastBusinessMetricSeenAt: values.lastBusinessMetricSeenAt ?? undefined,
      updatedAt: now
    })
  );
}

export async function ingestConfiguredSitemaps(store, config, resolvePath) {
  const now = nowIso();
  const sitemapUrls = await expandSitemapSources(config.sources, resolvePath);

  for (const sitemapUrl of sitemapUrls) {
    const sitemapInfo = classifySitemap(sitemapUrl, config.policy);
    const sitemap = store.upsert(
      'sitemaps',
      (row) => row.sitemapUrl === sitemapUrl,
      {
        sitemapUrl,
        ...sitemapInfo,
        preferredPropertyId: null,
        fallbackPropertyIds: [],
        lastFetchStatus: 'pending',
        lastSuccessfulFetchAt: null,
        urlCount: 0,
        checksum: null,
        createdAt: now,
        updatedAt: now
      },
      {
        ...sitemapInfo,
        updatedAt: now
      }
    );

    let urlEntries = [];
    if (config.sources.fetchChildSitemaps) {
      try {
        const sitemapXml = await fetchText(sitemapUrl);
        urlEntries = extractSitemapUrlEntries(sitemapXml);
        sitemap.lastFetchStatus = 'success';
        sitemap.lastSuccessfulFetchAt = now;
      } catch (error) {
        sitemap.lastFetchStatus = `fetch_failed: ${error.message}`;
        if (!config.sources.useDemoUrlsWhenChildFetchFails) {
          throw error;
        }
      }
    } else {
      sitemap.lastFetchStatus = 'child_fetch_off';
    }

    if (!urlEntries.length && (config.sources.useDemoUrlsWhenChildFetchIsOff || config.sources.useDemoUrlsWhenChildFetchFails)) {
      urlEntries = generateDemoUrlsForSitemap(sitemapUrl).map((loc) => ({ loc, lastmod: null }));
      sitemap.lastFetchStatus = `${sitemap.lastFetchStatus}+demo_generated`;
    }

    sitemap.urlCount = urlEntries.length;

    for (const entry of urlEntries) {
      const record = upsertUrl(store, {
        url: entry.loc,
        category: sitemapInfo.detectedCategory,
        subCategory: sitemapInfo.detectedSubcategory,
        locale: sitemapInfo.detectedLocale ?? undefined,
        isScaledContent: sitemapInfo.isScaledContent,
        scaledContentType: sitemapInfo.scaledContentType,
        lastSitemapSeenAt: now,
        firstSeenAt: now
      });

      store.upsert(
        'urlSources',
        (row) => row.urlId === record.id && row.sourceType === 'sitemap' && row.sourceIdentifier === sitemapUrl,
        {
          urlId: record.id,
          sourceType: 'sitemap',
          sourceIdentifier: sitemapUrl,
          sourceSitemapUrl: sitemapUrl,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now
        },
        {
          lastSeenAt: now,
          updatedAt: now
        }
      );
    }
  }

  return sitemapUrls.length;
}

export async function ingestManualUrlCsv(store, filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const rows = parseCsv(text);
  const now = nowIso();

  for (const row of rows) {
    if (!row.url) continue;
    const record = upsertUrl(store, {
      url: row.url,
      category: row.category || undefined,
      locale: row.locale || undefined,
      isScaledContent: ['true', '1', 'yes'].includes(String(row.is_scaled_content ?? '').toLowerCase()),
      scaledContentType: row.scaled_content_type || null,
      currentPriorityTier: row.priority_tier || undefined,
      lastBusinessMetricSeenAt: now
    });

    store.upsert(
      'urlSources',
      (source) => source.urlId === record.id && source.sourceType === 'manual' && source.sourceIdentifier === filePath,
      {
        urlId: record.id,
        sourceType: 'manual',
        sourceIdentifier: filePath,
        sourceSitemapUrl: null,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now
      },
      {
        lastSeenAt: now,
        updatedAt: now
      }
    );
  }

  return rows.length;
}

export async function ingestGscCsv(store, filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const rows = parseCsv(text);
  const now = nowIso();

  for (const row of rows) {
    const url = normalizeUrl(row.url);
    const record = upsertUrl(store, {
      url,
      lastBusinessMetricSeenAt: now
    });

    store.upsert(
      'gscPerformanceMetrics',
      (metric) => metric.urlId === record.id && metric.importedAt === now,
      {
        urlId: record.id,
        url,
        click: Number(row.click ?? 0),
        impression: Number(row.impression ?? 0),
        avgPosition: Number(row.avg_position ?? row.avgPosition ?? 0),
        sourceProperty: row.property ?? null,
        importedAt: now,
        createdAt: now
      }
    );
  }

  return rows.length;
}

export async function ingestBusinessWideCsv(store, filePath, metricType) {
  const text = await fs.readFile(filePath, 'utf8');
  const rows = parseCsv(text);
  const now = nowIso();
  let count = 0;

  for (const row of rows) {
    const path = row.path;
    const url = urlFromPath(path);
    const record = upsertUrl(store, {
      url,
      lastBusinessMetricSeenAt: now
    });

    for (const [key, value] of Object.entries(row)) {
      if (key === 'path') continue;
      store.upsert(
        'businessMetrics',
        (metric) => metric.urlId === record.id && metric.metricType === metricType && metric.metricMonth === key,
        {
          urlId: record.id,
          path,
          metricType,
          metricMonth: key,
          metricValue: Number(value || 0),
          sourceFile: filePath,
          importedAt: now,
          createdAt: now
        },
        {
          metricValue: Number(value || 0),
          importedAt: now
        }
      );
      count += 1;
    }
  }

  return count;
}

export async function ingestAllConfiguredSources(store, config, resolvePath) {
  const counts = {
    sitemaps: await ingestConfiguredSitemaps(store, config, resolvePath),
    manualRows: 0,
    gscRows: 0,
    p30Rows: 0,
    signupRows: 0
  };

  for (const file of config.sources.manualUrlFiles ?? []) {
    counts.manualRows += await ingestManualUrlCsv(store, resolvePath(file));
  }
  for (const file of config.sources.gscCsvFiles ?? []) {
    counts.gscRows += await ingestGscCsv(store, resolvePath(file));
  }
  for (const file of config.sources.p30CsvFiles ?? []) {
    counts.p30Rows += await ingestBusinessWideCsv(store, resolvePath(file), 'p30_users');
  }
  for (const file of config.sources.signupCsvFiles ?? []) {
    counts.signupRows += await ingestBusinessWideCsv(store, resolvePath(file), 'signup_count');
  }

  return counts;
}
