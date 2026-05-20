import fs from 'node:fs/promises';
import {
  classifySitemap,
  expandSitemapSources,
  extractSitemapUrlEntries,
  fetchText,
  generateDemoUrlsForSitemap,
  isSitemapLikeUrl
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

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export function upsertUrl(store, values) {
  const now = nowIso();
  const normalizedUrl = normalizeUrl(values.url);
  const deleted = store.state.deletedUrls?.find((row) => row.normalizedUrl === normalizedUrl);
  if (deleted && !values.restoreIfDeleted) {
    return null;
  }
  if (deleted && values.restoreIfDeleted) {
    store.state.deletedUrls = store.state.deletedUrls.filter((row) => row.normalizedUrl !== normalizedUrl);
  }
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

function upsertUrlWithIndex(store, urlIndex, deletedIndex, values) {
  const now = nowIso();
  const normalizedUrl = normalizeUrl(values.url);
  const deleted = deletedIndex.get(normalizedUrl);
  if (deleted && !values.restoreIfDeleted) return null;
  if (deleted && values.restoreIfDeleted) {
    store.state.deletedUrls = store.state.deletedUrls.filter((row) => row.normalizedUrl !== normalizedUrl);
    deletedIndex.delete(normalizedUrl);
  }

  const urlPath = pathFromUrl(normalizedUrl);
  const createCategory = values.category ?? categoryFromPath(urlPath);
  const createLocale = values.locale ?? detectLocaleFromPath(urlPath);
  const existing = urlIndex.get(normalizedUrl);

  if (existing) {
    const updateValues = compact({
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
    });
    if (values.currentPriorityTier && !existing.manualPriorityTier) {
      updateValues.currentPriorityTier = values.currentPriorityTier;
    }
    Object.assign(existing, updateValues);
    return existing;
  }

  const record = store.insert('urls', {
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
  });
  urlIndex.set(normalizedUrl, record);
  return record;
}

export async function ingestConfiguredSitemaps(store, config, resolvePath, options = {}) {
  const now = nowIso();
  const sources = {
    ...config.sources,
    fetchChildSitemaps: options.fetchChildSitemaps ?? config.sources.fetchChildSitemaps,
    useDemoUrlsWhenChildFetchIsOff: options.useDemoUrlsWhenChildFetchIsOff ?? config.sources.useDemoUrlsWhenChildFetchIsOff,
    useDemoUrlsWhenChildFetchFails: options.useDemoUrlsWhenChildFetchFails ?? config.sources.useDemoUrlsWhenChildFetchFails
  };
  const allSitemapUrls = await expandSitemapSources(sources, resolvePath, { includeLocal: options.includeLocal });
  const sitemapBatchSize = Math.max(0, Number(options.sitemapBatchSize ?? options.maxSitemapsPerRun ?? 0) || 0);
  const requestedSitemapBatchOffset = Math.max(0, Number(options.sitemapBatchOffset ?? 0) || 0);
  const sitemapBatchOffset = sitemapBatchSize && requestedSitemapBatchOffset >= allSitemapUrls.length
    ? 0
    : requestedSitemapBatchOffset;
  const sitemapUrls = sitemapBatchSize
    ? allSitemapUrls.slice(sitemapBatchOffset, sitemapBatchOffset + sitemapBatchSize)
    : allSitemapUrls;
  const totalSitemaps = sitemapUrls.length;
  const nextSitemapBatchOffset = sitemapBatchOffset + totalSitemaps;
  const hasMoreSitemaps = nextSitemapBatchOffset < allSitemapUrls.length;
  let urlCount = 0;
  const reportProgress = (progress) => {
    if (typeof options.onProgress !== 'function') return;
    options.onProgress({
      total: totalSitemaps,
      updatedAt: nowIso(),
      ...progress
    });
  };
  reportProgress({
    phase: 'fetching_sitemaps',
    completed: 0,
    success: 0,
    failed: 0,
    percent: totalSitemaps ? 0 : 100
  });
  const urlIndex = new Map(store.state.urls.map((url) => [url.normalizedUrl, url]));
  const deletedIndex = new Map((store.state.deletedUrls ?? []).map((url) => [url.normalizedUrl, url]));
  const urlSourceIndex = new Map(
    store.state.urlSources.map((source) => [`${source.urlId}|${source.sourceType}|${source.sourceIdentifier}`, source])
  );

  const fetchConcurrency = Math.max(1, Math.min(Number(options.fetchConcurrency ?? process.env.SITEMAP_FETCH_CONCURRENCY ?? 6), 20));
  let fetchCompleted = 0;
  let fetchSuccess = 0;
  let fetchFailed = 0;
  let fetchPending = 0;
  let importCompleted = 0;

  const fetchResults = await mapWithConcurrency(sitemapUrls, fetchConcurrency, async (sitemapUrl) => {
    const sitemapInfo = classifySitemap(sitemapUrl, config.policy);
    let urlEntries = [];
    let lastFetchStatus = 'child_fetch_off';
    let lastSuccessfulFetchAt = null;

    if (sources.fetchChildSitemaps) {
      try {
        const sitemapXml = await fetchText(sitemapUrl);
        urlEntries = extractSitemapUrlEntries(sitemapXml);
        lastFetchStatus = 'success';
        lastSuccessfulFetchAt = now;
      } catch (error) {
        lastFetchStatus = `fetch_failed: ${error.message}`;
      }
    }

    if (!urlEntries.length && (sources.useDemoUrlsWhenChildFetchIsOff || sources.useDemoUrlsWhenChildFetchFails)) {
      urlEntries = generateDemoUrlsForSitemap(sitemapUrl).map((loc) => ({ loc, lastmod: null }));
      lastFetchStatus = `${lastFetchStatus}+demo_generated`;
    }

    fetchCompleted += 1;
    const fetchOk = lastFetchStatus.startsWith('success') || urlEntries.length > 0;
    const fetchFailedWithoutFallback = lastFetchStatus.startsWith('fetch_failed') && urlEntries.length === 0;
    const fetchPendingWithoutFallback = lastFetchStatus === 'child_fetch_off' && urlEntries.length === 0;
    if (fetchOk) fetchSuccess += 1;
    if (fetchFailedWithoutFallback) fetchFailed += 1;
    if (fetchPendingWithoutFallback) fetchPending += 1;
    reportProgress({
      phase: 'fetching_sitemaps',
      currentSitemapUrl: sitemapUrl,
      completed: fetchCompleted,
      success: fetchSuccess,
      failed: fetchFailed,
      percent: totalSitemaps ? Math.round((fetchCompleted / totalSitemaps) * 80) : 100
    });

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

    sitemap.lastFetchStatus = lastFetchStatus;
    if (lastSuccessfulFetchAt) sitemap.lastSuccessfulFetchAt = lastSuccessfulFetchAt;

    const skippedSitemapLocs = urlEntries.filter((entry) => isSitemapLikeUrl(entry.loc)).length;
    urlEntries = urlEntries.filter((entry) => !isSitemapLikeUrl(entry.loc));
    sitemap.urlCount = urlEntries.length;
    sitemap.skippedSitemapLocCount = skippedSitemapLocs;
    urlCount += urlEntries.length;

    for (const entry of urlEntries) {
      const record = upsertUrlWithIndex(store, urlIndex, deletedIndex, {
        url: entry.loc,
        category: sitemapInfo.detectedCategory,
        subCategory: sitemapInfo.detectedSubcategory,
        locale: sitemapInfo.detectedLocale ?? undefined,
        isScaledContent: sitemapInfo.isScaledContent,
        scaledContentType: sitemapInfo.scaledContentType,
        currentPriorityTier: sitemapInfo.isScaledContent ? 'P0' : undefined,
        lastSitemapSeenAt: now,
        firstSeenAt: now
      });
      if (!record) continue;

      const sourceKey = `${record.id}|sitemap|${sitemapUrl}`;
      const existingSource = urlSourceIndex.get(sourceKey);
      if (existingSource) {
        existingSource.lastSeenAt = now;
        existingSource.updatedAt = now;
      } else {
        const source = store.insert('urlSources', {
          urlId: record.id,
          sourceType: 'sitemap',
          sourceIdentifier: sitemapUrl,
          sourceSitemapUrl: sitemapUrl,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now
        });
        urlSourceIndex.set(sourceKey, source);
      }
    }

    importCompleted += 1;
    reportProgress({
      phase: 'importing_urls',
      currentSitemapUrl: sitemapUrl,
      completed: importCompleted,
      success: fetchSuccess,
      failed: fetchFailed,
      importedUrls: urlCount,
      percent: totalSitemaps ? 80 + Math.round((importCompleted / totalSitemaps) * 20) : 100
    });

    return {
      sitemapUrl,
      status: lastFetchStatus,
      ok: fetchOk,
      failed: fetchFailedWithoutFallback,
      pending: fetchPendingWithoutFallback,
      urlCount: urlEntries.length
    };
  });

  reportProgress({
    phase: 'complete',
    completed: totalSitemaps,
    success: fetchSuccess,
    failed: fetchFailed,
    importedUrls: urlCount,
    percent: 100
  });

  return {
    sitemapCount: sitemapUrls.length,
    sourceSitemapCount: allSitemapUrls.length,
    sitemapBatchSize,
    sitemapBatchOffset,
    nextSitemapBatchOffset: hasMoreSitemaps ? nextSitemapBatchOffset : 0,
    hasMoreSitemaps,
    urlCount,
    fetchSummary: {
      success: fetchResults.filter((item) => item.ok).length,
      failed: fetchResults.filter((item) => item.failed).length,
      pending: fetchResults.filter((item) => item.pending).length,
      total: fetchResults.length
    }
  };
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
    if (!record) continue;

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
  return ingestGscCsvText(store, text, filePath);
}

export function ingestGscCsvText(store, text, sourceName = 'dashboard') {
  const rows = parseCsv(text);
  const now = nowIso();
  let count = 0;
  const latestByUrl = new Map();

  for (const row of rows) {
    if (!row.url) continue;
    const url = normalizeUrl(row.url);
    latestByUrl.set(url, {
      url,
      click: Number(row.click ?? 0),
      impression: Number(row.impression ?? 0),
      avgPosition: Number(row.avg_position ?? row.avgPosition ?? 0),
      sourceProperty: row.property ?? row.source_property ?? null
    });
  }

  for (const metric of latestByUrl.values()) {
    const record = upsertUrl(store, {
      url: metric.url,
      lastBusinessMetricSeenAt: now
    });
    if (!record) continue;

    store.upsert(
      'gscPerformanceMetrics',
      (row) => row.urlId === record.id && row.sourceProperty === metric.sourceProperty,
      {
        urlId: record.id,
        url: metric.url,
        click: metric.click,
        impression: metric.impression,
        avgPosition: metric.avgPosition,
        sourceProperty: metric.sourceProperty,
        sourceFile: sourceName,
        importedAt: now,
        createdAt: now
      },
      {
        url: metric.url,
        click: metric.click,
        impression: metric.impression,
        avgPosition: metric.avgPosition,
        sourceFile: sourceName,
        importedAt: now
      }
    );
    count += 1;
  }

  return count;
}

export async function ingestBusinessWideCsv(store, filePath, metricType) {
  const text = await fs.readFile(filePath, 'utf8');
  return ingestBusinessWideCsvText(store, text, metricType, filePath);
}

export function ingestBusinessWideCsvText(store, text, metricType, sourceName = 'dashboard') {
  const rows = parseCsv(text);
  const now = nowIso();
  let count = 0;

  for (const row of rows) {
    const path = row.path ?? row.url;
    if (!path) continue;
    const url = urlFromPath(path);
    const record = upsertUrl(store, {
      url,
      lastBusinessMetricSeenAt: now
    });
    if (!record) continue;

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
          sourceFile: sourceName,
          importedAt: now,
          createdAt: now
        },
        {
          metricValue: Number(value || 0),
          sourceFile: sourceName,
          importedAt: now
        }
      );
      count += 1;
    }
  }

  return count;
}

export async function ingestAllConfiguredSources(store, config, resolvePath) {
  const sitemapCounts = await ingestConfiguredSitemaps(store, config, resolvePath);
  const counts = {
    sitemaps: sitemapCounts.sitemapCount,
    sitemapUrls: sitemapCounts.urlCount,
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
