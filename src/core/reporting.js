import { dateKey, daysBetween } from './utils.js';

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
  return store.state.urls
    .filter((url) => {
      if (filters.priorityTier && url.currentPriorityTier !== filters.priorityTier) return false;
      if (filters.indexState && url.currentIndexState !== filters.indexState) return false;
      if (filters.category && url.category !== filters.category) return false;
      if (filters.locale && url.locale !== filters.locale) return false;
      if (filters.scaled === 'true' && !url.isScaledContent) return false;
      if (filters.scaled === 'false' && url.isScaledContent) return false;
      if (filters.q && !url.normalizedUrl.includes(filters.q)) return false;
      return true;
    })
    .map((url) => ({
      ...url,
      health: store.state.healthStatuses.find((status) => status.urlId === url.id) ?? null,
      activeAlerts: store.state.alerts.filter((alert) => alert.urlId === url.id && alert.status === 'active')
    }));
}

export function urlDetail(store, id) {
  const url = store.findById('urls', id);
  if (!url) return null;
  return {
    url,
    sources: store.state.urlSources.filter((source) => source.urlId === url.id),
    prioritySnapshots: store.state.prioritySnapshots.filter((snapshot) => snapshot.urlId === url.id).slice(-10).reverse(),
    inspections: store.state.inspectionResults.filter((result) => result.urlId === url.id).slice(-20).reverse(),
    transitions: store.state.stateTransitions.filter((transition) => transition.urlId === url.id).slice(-20).reverse(),
    technicalChecks: store.state.technicalChecks.filter((check) => check.urlId === url.id).slice(-10).reverse(),
    alerts: store.state.alerts.filter((alert) => alert.urlId === url.id).slice(-20).reverse(),
    health: store.state.healthStatuses.find((status) => status.urlId === url.id) ?? null
  };
}

export function scaledDashboard(store) {
  const scaled = store.state.urls.filter((url) => url.isScaledContent && !url.isManuallyExcluded);
  const today = dateKey();
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
      delayedIndexCount: scaled.filter((url) => ['discovered_not_indexed', 'not_indexed'].includes(url.currentIndexState)).length,
      indexLossCount: scaled.filter((url) => ['index_loss_suspected', 'index_lost_confirmed'].includes(url.currentIndexState)).length,
      stableIndexedCount: scaled.filter((url) => url.currentIndexState === 'stable_indexed').length
    }
  };
}

export function exportHealthReport(store) {
  const lines = [
    'url,priority_tier,index_state,health_state,category,locale,is_scaled_content,last_inspected_at,next_inspection_due_at,active_alerts'
  ];
  for (const url of store.state.urls) {
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
