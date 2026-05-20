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

function latestPrioritySnapshot(store, urlId) {
  for (let index = store.state.prioritySnapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = store.state.prioritySnapshots[index];
    if (Number(snapshot.urlId) === Number(urlId)) return snapshot;
  }
  return null;
}

function savePrioritySnapshotIfChanged(store, url, snapshot) {
  const previous = latestPrioritySnapshot(store, url.id);
  const changed = !previous
    || previous.priorityTier !== snapshot.priorityTier
    || Boolean(previous.organicFlag) !== Boolean(snapshot.organicFlag)
    || Boolean(previous.signupFlag) !== Boolean(snapshot.signupFlag)
    || Boolean(previous.p30Flag) !== Boolean(snapshot.p30Flag)
    || Boolean(previous.scaledFlag) !== Boolean(snapshot.scaledFlag)
    || Boolean(previous.manualFlag) !== Boolean(snapshot.manualFlag)
    || Boolean(previous.combinedBusinessFlag) !== Boolean(snapshot.combinedBusinessFlag);
  if (changed) store.insert('prioritySnapshots', snapshot);
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
    const previousTier = url.currentPriorityTier;
    if (url.manualPriorityTier) {
      url.currentPriorityTier = url.manualPriorityTier;
      url.isManuallyExcluded = url.manualPriorityTier === 'Excluded';
      url.isActive = url.manualPriorityTier !== 'Excluded';
      if (previousTier !== url.currentPriorityTier) url.updatedAt = now;
      savePrioritySnapshotIfChanged(store, url, {
        urlId: url.id,
        calculatedAt: now,
        priorityTier: url.manualPriorityTier,
        organicFlag: false,
        signupFlag: false,
        p30Flag: false,
        scaledFlag: Boolean(url.isScaledContent),
        manualFlag: true,
        combinedBusinessFlag: false,
        scoreJson: { thresholds, manualPriorityTier: url.manualPriorityTier },
        policyVersion: 'mvp-v1',
        createdAt: now
      });
      continue;
    }

    const gsc = latestGsc.get(url.id);
    const p30 = latestP30.get(url.id);
    const signup = latestSignup.get(url.id);

    const organicFlag = Number(gsc?.click ?? 0) >= thresholds.minimumClickCount;
    const p30Flag = Number(p30?.metricValue ?? 0) >= thresholds.minimumP30Count;
    const signupFlag = Number(signup?.metricValue ?? 0) >= thresholds.minimumSignupCount;
    const scaledFlag = Boolean(url.isScaledContent);
    const manualFlag = false;
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
    if (previousTier !== tier) url.updatedAt = now;

    savePrioritySnapshotIfChanged(store, url, {
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
