import { addDays, daysBetween, nowIso } from './utils.js';

export function nextStateFromInspection(urlRecord, result) {
  if (urlRecord.isManuallyExcluded) return 'manually_excluded';
  if (result.isRedirected) return 'redirected';
  if (result.isCanonicalMismatch && !result.isSubmittedAndIndexed) return 'canonical_mismatch';

  if (result.isSubmittedAndIndexed) {
    if (urlRecord.isScaledContent) {
      const indexedDays = urlRecord.firstIndexedAt ? daysBetween(urlRecord.firstIndexedAt) : 0;
      return indexedDays >= 2 ? 'stable_indexed' : 'submitted_and_indexed';
    }
    return urlRecord.currentIndexState === 'submitted_and_indexed' ? 'stable_indexed' : 'submitted_and_indexed';
  }

  if (['submitted_and_indexed', 'stable_indexed'].includes(urlRecord.currentIndexState)) {
    return 'index_loss_suspected';
  }

  if (urlRecord.currentIndexState === 'index_loss_suspected') {
    return 'index_lost_confirmed';
  }

  if (result.coverageState === 'Discovered currently not indexed') return 'discovered_not_indexed';
  return 'not_indexed';
}

export function calculateHealth(urlRecord, result) {
  if (urlRecord.isManuallyExcluded) return { status: 'Excluded', severity: 'excluded' };
  if (result.isSubmittedAndIndexed) return { status: 'Healthy', severity: 'healthy' };
  if (urlRecord.currentIndexState === 'index_lost_confirmed') return { status: 'Index lost', severity: 'incident' };
  if (urlRecord.currentPriorityTier === 'P0') return { status: 'Critical issue', severity: 'critical' };
  if (result.coverageState === 'Crawled currently not indexed') return { status: 'Not indexed / problematic', severity: 'critical' };
  if (result.isCanonicalMismatch && ['P0', 'P1'].includes(urlRecord.currentPriorityTier)) return { status: 'Technical issue', severity: 'critical' };
  if (result.isCanonicalMismatch || result.isRedirected) return { status: 'Technical issue', severity: 'warning' };
  if (['P1', 'P2'].includes(urlRecord.currentPriorityTier)) return { status: 'Index loss suspected', severity: 'critical' };
  return { status: 'Not indexed', severity: 'warning' };
}

export function calculateNextDueAt(urlRecord, result, policy) {
  const now = nowIso();
  if (urlRecord.isManuallyExcluded || urlRecord.currentPriorityTier === 'Excluded') return null;
  if (urlRecord.currentIndexState === 'index_loss_suspected' || urlRecord.currentIndexState === 'index_lost_confirmed') return addDays(now, 1);

  if (urlRecord.isScaledContent) {
    if (!result.isSubmittedAndIndexed) return addDays(now, 1);
    if (urlRecord.currentIndexState !== 'stable_indexed') return addDays(now, 1);
    const span = policy.scaledContent.stableFrequencyMaxDays - policy.scaledContent.stableFrequencyMinDays + 1;
    const days = policy.scaledContent.stableFrequencyMinDays + (urlRecord.id % span);
    return addDays(now, days);
  }

  if (urlRecord.currentPriorityTier === 'P0') return addDays(now, policy.tiers.P0.frequencyDays);
  if (urlRecord.currentPriorityTier === 'P1') return addDays(now, policy.tiers.P1.minFrequencyDays);
  if (urlRecord.currentPriorityTier === 'P2') return addDays(now, policy.tiers.P2.frequencyDays);
  return addDays(now, policy.tiers.P3.frequencyDays);
}

export function saveTransitionIfChanged(store, urlRecord, previousState, resultId) {
  if (previousState === urlRecord.currentIndexState) return null;
  return store.insert('stateTransitions', {
    urlId: urlRecord.id,
    fromState: previousState,
    toState: urlRecord.currentIndexState,
    transitionReason: 'inspection_result',
    inspectionResultId: resultId,
    createdAt: nowIso()
  });
}

export function upsertHealthStatus(store, urlRecord, result) {
  const now = nowIso();
  const health = calculateHealth(urlRecord, result);
  urlRecord.currentHealthState = health.status;
  const existing = store.state.healthStatuses.find((row) => row.urlId === urlRecord.id);
  const timestamps = {};
  if (health.severity === 'healthy') timestamps.lastHealthyAt = now;
  if (health.severity === 'warning') timestamps.lastWarningAt = now;
  if (health.severity === 'critical') timestamps.lastCriticalAt = now;
  if (health.severity === 'incident') timestamps.lastIncidentAt = now;

  const values = {
    urlId: urlRecord.id,
    currentHealthStatus: health.status,
    currentSeverity: health.severity,
    currentIndexStatus: urlRecord.currentIndexState,
    currentCoverageState: result.coverageState,
    currentPriorityTier: urlRecord.currentPriorityTier,
    hasActiveAlert: store.state.alerts.some((alert) => alert.urlId === urlRecord.id && alert.status === 'active'),
    updatedAt: now,
    ...timestamps
  };

  if (existing) {
    Object.assign(existing, values);
    return existing;
  }

  return store.insert('healthStatuses', {
    ...values,
    lastHealthyAt: values.lastHealthyAt ?? null,
    lastWarningAt: values.lastWarningAt ?? null,
    lastCriticalAt: values.lastCriticalAt ?? null,
    lastIncidentAt: values.lastIncidentAt ?? null
  });
}
