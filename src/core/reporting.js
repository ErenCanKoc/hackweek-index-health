import { dateKey, daysBetween } from './utils.js';

import { explainPropertyResolution } from './propertyResolver.js';

export function overview(store) {
  const today = dateKey();
  const urls = store.state.urls.filter((url) => url.isActive && !url.isManuallyExcluded);
  const inspectedToday = store.state.inspectionResults.filter((result) => dateKey(result.inspectedAt) === today).length;
  const quotaUsedToday = store.state.properties.reduce((sum, property) => sum + property.dailyQuotaUsed, 0);
  const indexedCount = urls.filter((url) => ['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState)).length;
  const scaled = urls.filter((url) => url.isScaledContent);
  const scaledIndexed = scaled.filter((url) => ['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState)).length;
  const p0 = urls.filter((url) => url.currentPriorityTier === 'P0');
  const p0Indexed = p0.filter((url) => ['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState)).length;
  const activeAlerts = store.state.alerts.filter((alert) => alert.status === 'active' && alert.alertType !== 'recovered');
  const monthlyCovered = urls.filter((url) => url.lastInspectedAt && daysBetween(url.lastInspectedAt) <= 30).length;
  const overdue = urls.filter((url) => url.nextInspectionDueAt && new Date(url.nextInspectionDueAt) < new Date()).length;
  const indexedScaledDurations = scaled
    .filter((url) => url.firstIndexedAt && url.firstSeenAt)
    .map((url) => daysBetween(url.firstSeenAt, url.firstIndexedAt));
  const avgTimeToIndex = indexedScaledDurations.length
    ? indexedScaledDurations.reduce((sum, days) => sum + days, 0) / indexedScaledDurations.length
    : 0;

  const categoryHealth = Object.values(urls.reduce((acc, url) => {
    acc[url.category] ??= { category: url.category, total: 0, indexed: 0, critical: 0 };
    acc[url.category].total += 1;
    if (['submitted_and_indexed', 'stable_indexed'].includes(url.currentIndexState)) acc[url.category].indexed += 1;
    if (['index_loss_suspected', 'index_lost_confirmed', 'not_indexed', 'canonical_mismatch'].includes(url.currentIndexState)) acc[url.category].critical += 1;
    return acc;
  }, {}));

  return {
    inspectedToday,
    quotaUsedToday,
    monthlyCoveragePercent: urls.length ? Math.round((monthlyCovered / urls.length) * 100) : 0,
    indexRate: urls.length ? Math.round((indexedCount / urls.length) * 100) : 0,
    indexLossCount: urls.filter((url) => ['index_loss_suspected', 'index_lost_confirmed'].includes(url.currentIndexState)).length,
    scaledContentIndexRate: scaled.length ? Math.round((scaledIndexed / scaled.length) * 100) : 0,
    p0IndexRate: p0.length ? Math.round((p0Indexed / p0.length) * 100) : 0,
    averageTimeToIndex: Number(avgTimeToIndex.toFixed(1)),
    openCriticalAlerts: activeAlerts.filter((alert) => ['critical', 'incident'].includes(alert.severity)).length,
    overdueUrlCount: overdue,
    categoryHealth
  };
}

export function urlExplorer(store, filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit || 0) || store.state.urls.length, 500));
  const offset = Math.max(0, Number(filters.offset || 0) || 0);
  const paginated = filters.limit !== undefined || filters.offset !== undefined;
  const query = String(filters.q ?? '').toLowerCase();
  const healthByUrlId = new Map(store.state.healthStatuses.map((status) => [status.urlId, status]));
  const sourcesByUrlId = new Map();
  for (const source of store.state.urlSources) {
    if (!sourcesByUrlId.has(source.urlId)) sourcesByUrlId.set(source.urlId, []);
    sourcesByUrlId.get(source.urlId).push(source);
  }
  const alertsByUrlId = new Map();
  for (const alert of store.state.alerts) {
    if (alert.status !== 'active') continue;
    if (!alertsByUrlId.has(alert.urlId)) alertsByUrlId.set(alert.urlId, []);
    alertsByUrlId.get(alert.urlId).push(alert);
  }
  const filtered = store.state.urls
    .filter((url) => {
      if (filters.priorityTier && url.currentPriorityTier !== filters.priorityTier) return false;
      if (filters.indexState && url.currentIndexState !== filters.indexState) return false;
      if (filters.category && url.category !== filters.category) return false;
      if (filters.locale && url.locale !== filters.locale) return false;
      if (filters.scaled === 'true' && !url.isScaledContent) return false;
      if (filters.scaled === 'false' && url.isScaledContent) return false;
      if (query) {
        const sourceText = (sourcesByUrlId.get(url.id) ?? [])
          .map((source) => source.sourceSitemapUrl || source.sourceIdentifier)
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!url.normalizedUrl.toLowerCase().includes(query) && !sourceText.includes(query)) return false;
      }
      return true;
    });
  const page = filtered.slice(offset, offset + limit);
  const rows = page.map((url) => ({
      ...url,
      health: healthByUrlId.get(url.id) ?? null,
      sources: sourcesByUrlId.get(url.id) ?? [],
      activeAlerts: alertsByUrlId.get(url.id) ?? []
    }));
  if (!paginated) return rows;
  return {
    rows,
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + limit < filtered.length
  };
}

export function urlDetail(store, id) {
  const url = store.findById('urls', id);
  if (!url) return null;
  const inspections = store.state.inspectionResults
    .filter((result) => result.urlId === url.id)
    .slice(-20)
    .reverse()
    .map((result) => ({
      ...result,
      property: store.findById('properties', result.propertyId) ?? null
    }));
  return {
    url,
    sources: store.state.urlSources.filter((source) => source.urlId === url.id),
    prioritySnapshots: store.state.prioritySnapshots.filter((snapshot) => snapshot.urlId === url.id).slice(-10).reverse(),
    inspections,
    transitions: store.state.stateTransitions.filter((transition) => transition.urlId === url.id).slice(-20).reverse(),
    jobs: store.state.inspectionJobs
      .filter((job) => job.urlId === url.id)
      .slice(-20)
      .reverse()
      .map((job) => ({
        ...job,
        property: job.propertyId ? store.findById('properties', job.propertyId) : null
      })),
    technicalChecks: store.state.technicalChecks.filter((check) => check.urlId === url.id).slice(-10).reverse(),
    alerts: store.state.alerts.filter((alert) => alert.urlId === url.id).slice(-20).reverse(),
    health: store.state.healthStatuses.find((status) => status.urlId === url.id) ?? null,
    propertyResolution: explainPropertyResolution(store, url, store.config?.policy ?? { quota: { stopAtPerProperty: 1999 } })
  };
}

export function scaledDashboard(store) {
  const scaled = store.state.urls.filter((url) => url.isScaledContent && !url.isManuallyExcluded);
  const today = dateKey();
  const daysToIndex = scaled
    .filter((url) => url.firstSeenAt && url.firstIndexedAt)
    .map((url) => Math.max(0, daysBetween(url.firstSeenAt, new Date(url.firstIndexedAt))));
  const sortedDaysToIndex = daysToIndex.slice().sort((a, b) => a - b);
  const percentile = (percent) => {
    if (!sortedDaysToIndex.length) return 0;
    const index = Math.min(sortedDaysToIndex.length - 1, Math.ceil((percent / 100) * sortedDaysToIndex.length) - 1);
    return sortedDaysToIndex[index];
  };
  const averageDaysToIndex = daysToIndex.length
    ? Math.round((daysToIndex.reduce((sum, value) => sum + value, 0) / daysToIndex.length) * 10) / 10
    : 0;
  const newToday = scaled.filter((url) => dateKey(url.firstSeenAt) === today).length;
  const firstInspectedWithin24h = scaled.filter((url) => {
    if (!url.lastInspectedAt) return false;
    return (new Date(url.lastInspectedAt) - new Date(url.firstSeenAt)) <= 86400000;
  }).length;
  const indexedWithinDays = (days) => scaled.filter((url) => {
    if (!url.firstIndexedAt) return false;
    return (new Date(url.firstIndexedAt) - new Date(url.firstSeenAt)) <= days * 86400000;
  }).length;

  return {
    tabs: {
      adcraft: scaled.filter((url) => url.scaledContentType === 'adcraft'),
      delayedIndexing: scaled.filter((url) => ['discovered_not_indexed', 'not_indexed'].includes(url.currentIndexState)),
      indexLost: scaled.filter((url) => ['index_loss_suspected', 'index_lost_confirmed'].includes(url.currentIndexState)),
      stableIndexed: scaled.filter((url) => url.currentIndexState === 'stable_indexed'),
      recovered: store.state.alerts.filter((alert) => alert.alertType === 'recovered')
    },
    kpis: {
      newScaledUrlsToday: newToday,
      firstInspectedWithin24hPercent: scaled.length ? Math.round((firstInspectedWithin24h / scaled.length) * 100) : 0,
      indexedWithin1DayPercent: scaled.length ? Math.round((indexedWithinDays(1) / scaled.length) * 100) : 0,
      indexedWithin3DaysPercent: scaled.length ? Math.round((indexedWithinDays(3) / scaled.length) * 100) : 0,
      averageDaysToIndex,
      medianDaysToIndex: percentile(50),
      p90DaysToIndex: percentile(90),
      delayedIndexCount: scaled.filter((url) => ['discovered_not_indexed', 'not_indexed'].includes(url.currentIndexState)).length,
      delayed3DaysCount: scaled.filter((url) => !url.firstIndexedAt && daysBetween(url.firstSeenAt) >= 3).length,
      delayed7DaysCount: scaled.filter((url) => !url.firstIndexedAt && daysBetween(url.firstSeenAt) >= 7).length,
      indexLossCount: scaled.filter((url) => ['index_loss_suspected', 'index_lost_confirmed'].includes(url.currentIndexState)).length,
      stableIndexedCount: scaled.filter((url) => url.currentIndexState === 'stable_indexed').length
    }
  };
}

export function sitemapFetchLog(store) {
  return store.state.sitemaps
    .slice()
    .sort((a, b) => new Date(b.updatedAt ?? b.lastSuccessfulFetchAt ?? 0) - new Date(a.updatedAt ?? a.lastSuccessfulFetchAt ?? 0))
    .map((sitemap) => {
      const status = sitemap.lastFetchStatus ?? 'not_fetched';
      const ok = status === 'success' || Boolean(sitemap.lastSuccessfulFetchAt) || Number(sitemap.urlCount ?? 0) > 0;
      const failed = status.startsWith('fetch_failed');
      return {
        id: sitemap.id,
        sitemapUrl: sitemap.sitemapUrl,
        status,
        health: ok ? 'success' : failed ? 'failed' : 'pending',
        urlCount: sitemap.urlCount ?? 0,
        skippedSitemapLocCount: sitemap.skippedSitemapLocCount ?? 0,
        detectedCategory: sitemap.detectedCategory ?? 'unknown',
        detectedLocale: sitemap.detectedLocale ?? null,
        isScaledContent: Boolean(sitemap.isScaledContent),
        scaledContentType: sitemap.scaledContentType ?? null,
        lastSuccessfulFetchAt: sitemap.lastSuccessfulFetchAt ?? null,
        updatedAt: sitemap.updatedAt ?? null,
        error: failed ? status.replace(/^fetch_failed:\s*/, '') : null
      };
    });
}

export function jobDiagnostics(store) {
  const now = new Date();
  const jobs = store.state.inspectionJobs ?? [];
  const countBy = (key) => Object.values(jobs.reduce((acc, job) => {
    const value = job[key] ?? 'unknown';
    acc[value] ??= { name: value, count: 0 };
    acc[value].count += 1;
    return acc;
  }, {})).sort((a, b) => b.count - a.count);

  const recentProblemJobs = jobs
    .filter((job) => ['failed', 'skipped', 'pending'].includes(job.status) && (job.lastError || new Date(job.dueAt) <= now))
    .slice()
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0) - new Date(a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, 20)
    .map((job) => ({
      ...job,
      property: job.propertyId ? store.findById('properties', job.propertyId) : null
    }));

  return {
    summary: {
      total: jobs.length,
      pending: jobs.filter((job) => job.status === 'pending').length,
      duePending: jobs.filter((job) => job.status === 'pending' && new Date(job.dueAt) <= now).length,
      running: jobs.filter((job) => job.status === 'running').length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      skipped: jobs.filter((job) => job.status === 'skipped').length,
      failed: jobs.filter((job) => job.status === 'failed').length
    },
    byStatus: countBy('status'),
    byReason: countBy('reason'),
    byError: Object.values(jobs.reduce((acc, job) => {
      if (!job.lastError) return acc;
      acc[job.lastError] ??= { name: job.lastError, count: 0 };
      acc[job.lastError].count += 1;
      return acc;
    }, {})).sort((a, b) => b.count - a.count),
    recentProblemJobs
  };
}

export function exportHealthReport(store, filters = {}) {
  const lines = [
    'url,priority_tier,index_state,health_state,category,locale,is_scaled_content,last_inspected_at,next_inspection_due_at,active_alerts'
  ];
  const urls = filters && Object.keys(filters).length
    ? urlExplorer(store, filters)
    : store.state.urls;
  for (const url of urls) {
    const activeAlerts = store.state.alerts
      .filter((alert) => alert.urlId === url.id && alert.status === 'active')
      .map((alert) => alert.alertType)
      .join('|');
    lines.push([
      url.normalizedUrl,
      url.currentPriorityTier,
      url.currentIndexState,
      url.currentHealthState,
      url.category,
      url.locale,
      url.isScaledContent,
      url.lastInspectedAt ?? '',
      url.nextInspectionDueAt ?? '',
      activeAlerts
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function statusFrom(ok, partial = false) {
  if (ok) return 'done';
  if (partial) return 'partial';
  return 'todo';
}

function countManualPriorityOverrides(store) {
  return store.state.urls.filter((url) => url.manualPriorityTier && url.manualPriorityTier !== 'Excluded').length;
}

export function roadmap(store, config) {
  const activeUrls = store.state.urls.filter((url) => url.isActive && !url.isManuallyExcluded);
  const sitemapSourceCount = (config.sources.sitemapIndexUrls ?? []).length + (config.sources.childSitemapUrls ?? []).length;
  const sitemapLog = sitemapFetchLog(store);
  const successfulSitemaps = sitemapLog.filter((sitemap) => sitemap.health === 'success');
  const gscConfigured = config.policy.inspection.provider === 'gsc';
  const connectedProperties = store.state.properties.filter((property) => property.isActive && property.authStatus === 'ok');
  const inspectedUrls = new Set(store.state.inspectionResults.map((result) => result.urlId));
  const activeInspected = activeUrls.filter((url) => inspectedUrls.has(url.id));
  const monthlyCovered = activeUrls.filter((url) => url.lastInspectedAt && daysBetween(url.lastInspectedAt) <= 30);
  const scaledUrls = activeUrls.filter((url) => url.isScaledContent);
  const p1Urls = activeUrls.filter((url) => url.currentPriorityTier === 'P1');
  const p2Urls = activeUrls.filter((url) => url.currentPriorityTier === 'P2');
  const p3Urls = activeUrls.filter((url) => url.currentPriorityTier === 'P3');
  const criticalTechnicalChecks = store.state.technicalChecks.length;
  const openAlerts = store.state.alerts.filter((alert) => alert.status === 'active');
  const hasRawJson = store.state.inspectionResults.some((result) => result.rawJson);
  const hasTransitions = store.state.stateTransitions.length > 0;
  const hasDeletedUrls = (store.state.deletedUrls ?? []).length > 0;
  const hasManualOverrides = countManualPriorityOverrides(store) > 0;

  const items = [
    {
      area: 'Discovery',
      title: 'Sitemap source setup',
      status: statusFrom(sitemapSourceCount > 0),
      metric: `${sitemapSourceCount} source(s)`,
      nextAction: sitemapSourceCount ? 'Add remaining production sitemap indexes/child sitemaps.' : 'Add sitemap indexes or child sitemaps in Settings.'
    },
    {
      area: 'Discovery',
      title: 'Sitemap fetch imports page URLs',
      status: statusFrom(successfulSitemaps.length > 0 && activeUrls.length > 0, sitemapLog.length > 0 || activeUrls.length > 0),
      metric: `${successfulSitemaps.length}/${sitemapLog.length} fetched, ${activeUrls.length} active URL(s)`,
      nextAction: successfulSitemaps.length ? 'Keep fetch running after source changes.' : 'Click Fetch Sitemap URLs after adding sitemap sources.'
    },
    {
      area: 'Discovery',
      title: 'Sitemap URLs excluded from inspection inventory',
      status: statusFrom(!activeUrls.some((url) => /sitemap.*\.xml/i.test(url.normalizedUrl))),
      metric: `${activeUrls.filter((url) => /sitemap.*\.xml/i.test(url.normalizedUrl)).length} sitemap-like active URL(s)`,
      nextAction: 'Fetcher should keep sitemap files as sources only.'
    },
    {
      area: 'GSC',
      title: 'Inspection provider set to GSC',
      status: statusFrom(gscConfigured),
      metric: config.policy.inspection.provider,
      nextAction: gscConfigured ? 'Run scheduler against a known URL/property pair.' : 'Set provider to Google GSC API in Settings.'
    },
    {
      area: 'GSC',
      title: 'Property inventory connected',
      status: statusFrom(connectedProperties.length > 0),
      metric: `${connectedProperties.length} active propert${connectedProperties.length === 1 ? 'y' : 'ies'}`,
      nextAction: connectedProperties.length ? 'Verify category/path mapping for high-value paths.' : 'Connect Google and sync/import Search Console properties.'
    },
    {
      area: 'Scheduler',
      title: 'Scheduler writes inspection results',
      status: statusFrom(store.state.inspectionResults.length > 0),
      metric: `${store.state.inspectionResults.length} result(s), ${activeInspected.length}/${activeUrls.length} active URL(s) inspected`,
      nextAction: store.state.inspectionResults.length ? 'Monitor failed/pending jobs and quota pressure.' : 'Run Scheduler or Force GSC Test.'
    },
    {
      area: 'Scheduler',
      title: 'Monthly active URL coverage',
      status: statusFrom(activeUrls.length > 0 && monthlyCovered.length === activeUrls.length, monthlyCovered.length > 0),
      metric: `${monthlyCovered.length}/${activeUrls.length} covered in 30 days`,
      nextAction: 'Use P3 hash buckets and daily runs until coverage reaches 100%.'
    },
    {
      area: 'Priority',
      title: 'Manual priority override persistence',
      status: 'done',
      metric: `${countManualPriorityOverrides(store)} override(s)`,
      nextAction: hasManualOverrides ? 'Spot-check next due after P0/P1 edits.' : 'Feature is ready; set one URL to P0/P1 when validating production data.'
    },
    {
      area: 'Priority',
      title: 'Tier distribution exists',
      status: statusFrom(p1Urls.length + p2Urls.length + p3Urls.length > 0),
      metric: `P1 ${p1Urls.length} / P2 ${p2Urls.length} / P3 ${p3Urls.length}`,
      nextAction: 'Use Settings > Business / GSC CSV Import for stronger P1/P2 scoring.'
    },
    {
      area: 'Scaled',
      title: 'Scaled content daily monitoring',
      status: statusFrom(scaledUrls.length > 0 && scaledUrls.every((url) => url.currentPriorityTier === 'P0' || url.nextInspectionDueAt), scaledUrls.length > 0),
      metric: `${scaledUrls.length} scaled URL(s)`,
      nextAction: scaledUrls.length ? 'Watch delayed indexing and stable indexed cohorts.' : 'Add/fetch adcraft sitemap sources.'
    },
    {
      area: 'Alerts',
      title: 'Alerting and deduplication',
      status: statusFrom(store.state.alerts.length > 0, openAlerts.length > 0),
      metric: `${openAlerts.length} active / ${store.state.alerts.length} total`,
      nextAction: 'Wire Slack/email after alert semantics are accepted.'
    },
    {
      area: 'Diagnosis',
      title: 'Technical diagnosis records',
      status: statusFrom(criticalTechnicalChecks > 0),
      metric: `${criticalTechnicalChecks} check(s)`,
      nextAction: 'Enable live fetch only when needed for critical URLs.'
    },
    {
      area: 'Data',
      title: 'Raw Inspection JSON stored',
      status: statusFrom(hasRawJson),
      metric: `${store.state.inspectionResults.filter((result) => result.rawJson).length} raw payload(s)`,
      nextAction: 'Use URL detail accordion to review exact API payload.'
    },
    {
      area: 'Data',
      title: 'State transition history',
      status: statusFrom(hasTransitions),
      metric: `${store.state.stateTransitions.length} transition(s)`,
      nextAction: hasTransitions ? 'Use transitions for URL-level investigation.' : 'Run multiple scheduler passes or inspect changed-state URLs.'
    },
    {
      area: 'Operations',
      title: 'Bulk delete tombstones',
      status: 'done',
      metric: `${(store.state.deletedUrls ?? []).length} deleted URL tombstone(s)`,
      nextAction: hasDeletedUrls ? 'Deleted URLs should stay out of future sitemap imports.' : 'Feature is ready; delete a test URL and refetch sitemap when validating.'
    },
    {
      area: 'Reporting',
      title: 'Exportable health report',
      status: 'done',
      metric: '/api/report.csv',
      nextAction: 'Download CSV from the top action bar for weekly review.'
    }
  ];

  const summary = {
    done: items.filter((item) => item.status === 'done').length,
    partial: items.filter((item) => item.status === 'partial').length,
    todo: items.filter((item) => item.status === 'todo').length,
    total: items.length
  };

  const nextFocus = items
    .filter((item) => item.status !== 'done')
    .slice(0, 5);

  return { summary, items, nextFocus };
}
