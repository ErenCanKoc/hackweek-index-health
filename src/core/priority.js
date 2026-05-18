import { nowIso, pickPercentile, trimmedMean } from './utils.js';

function latestMetricByUrl(metrics, metricType) {
  const filtered = metricType
    ? metrics.filter((metric) => metric.metricType === metricType)
    : metrics;
  const latest = new Map();

  for (const metric of filtered) {
    const previous = latest.get(metric.urlId);
    if (!previous || String(metric.metricMonth) > String(previous.metricMonth)) {
      latest.set(metric.urlId, metric);
    }
  }

  return latest;
}

export function calculateThresholds(store) {
  const clicks = store.state.gscPerformanceMetrics.map((row) => Number(row.click || 0));
  const p30 = store.state.businessMetrics
    .filter((row) => row.metricType === 'p30_users')
    .map((row) => Number(row.metricValue || 0));
  const signups = store.state.businessMetrics
    .filter((row) => row.metricType === 'signup_count')
    .map((row) => Number(row.metricValue || 0));

  return {
    minimumClickCount: Math.max(50, Math.round(Math.max(trimmedMean(clicks), pickPercentile(clicks, 70)))),
    minimumP30Count: Math.max(20, Math.round(Math.max(trimmedMean(p30), pickPercentile(p30, 70)))),
    minimumSignupCount: Math.max(5, Math.round(Math.max(trimmedMean(signups), pickPercentile(signups, 70))))
  };
}

export function recalculatePriorities(store) {
  const now = nowIso();
  const thresholds = calculateThresholds(store);
  const latestP30 = latestMetricByUrl(store.state.businessMetrics, 'p30_users');
  const latestSignup = latestMetricByUrl(store.state.businessMetrics, 'signup_count');
  const latestGsc = latestMetricByUrl(store.state.gscPerformanceMetrics);

  for (const url of store.state.urls) {
    const gsc = latestGsc.get(url.id);
    const p30 = latestP30.get(url.id);
    const signup = latestSignup.get(url.id);

    const organicFlag = Number(gsc?.click ?? 0) >= thresholds.minimumClickCount;
    const p30Flag = Number(p30?.metricValue ?? 0) >= thresholds.minimumP30Count;
    const signupFlag = Number(signup?.metricValue ?? 0) >= thresholds.minimumSignupCount;
    const scaledFlag = Boolean(url.isScaledContent);
    const manualFlag = url.currentPriorityTier === 'P1' && url.manualPriority;
    const combinedBusinessFlag = [organicFlag, p30Flag, signupFlag].filter(Boolean).length >= 2;

    let tier = 'P3';
    if (url.isManuallyExcluded) {
      tier = 'Excluded';
    } else if (scaledFlag && url.currentIndexState !== 'stable_indexed') {
      tier = 'P0';
    } else if (combinedBusinessFlag || manualFlag) {
      tier = 'P1';
    } else if (organicFlag || p30Flag || signupFlag || (scaledFlag && url.currentIndexState === 'stable_indexed')) {
      tier = 'P2';
    }

    url.currentPriorityTier = tier;
    url.updatedAt = now;

    store.insert('prioritySnapshots', {
      urlId: url.id,
      calculatedAt: now,
      priorityTier: tier,
      organicFlag,
      signupFlag,
      p30Flag,
      scaledFlag,
      manualFlag,
      combinedBusinessFlag,
      scoreJson: {
        thresholds,
        click: Number(gsc?.click ?? 0),
        p30: Number(p30?.metricValue ?? 0),
        signup: Number(signup?.metricValue ?? 0)
      },
      policyVersion: 'mvp-v1',
      createdAt: now
    });
  }

  return thresholds;
}
