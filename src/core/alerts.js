import { nowIso } from './utils.js';

export function recommendationFor(alertType, result) {
  const map = {
    index_loss_suspected: 'Run next-day confirmation; check sitemap presence, canonical, noindex, and internal linking.',
    index_lost_confirmed: 'Prioritize technical diagnosis, sitemap freshness, canonical status, and internal links.',
    delayed_indexing: 'Check sitemap freshness, crawl discovery, internal links, and content uniqueness.',
    sitemap_missing: 'Add the important URL back to sitemap or confirm source mapping.',
    canonical_mismatch: 'If self-canonical is expected, fix canonical tag or inspect canonical target manually.',
    technical_noindex: 'Remove unexpected noindex at source or mark URL as expected noindex.',
    technical_redirect: 'Remove source URL from sitemap and monitor final URL separately.',
    property_quota_exhausted: 'Shift eligible URLs to fallback property or split mapping pressure.',
    all_properties_quota_exhausted: 'Pause low-priority jobs and add property capacity before retrying.',
    recovered: 'URL is indexed again; keep normal monitoring cadence.'
  };
  return map[alertType] ?? `Review coverage state: ${result?.coverageState ?? 'unknown'}.`;
}

export function upsertActiveAlert(store, payload) {
  const now = nowIso();
  const existing = store.state.alerts.find((alert) => (
    alert.urlId === payload.urlId
    && alert.alertType === payload.alertType
    && alert.status === 'active'
  ));

  if (existing) {
    Object.assign(existing, {
      severity: payload.severity,
      message: payload.message,
      previousState: payload.previousState,
      currentState: payload.currentState,
      coverageState: payload.coverageState,
      propertyId: payload.propertyId,
      updatedAt: now
    });
    return existing;
  }

  return store.insert('alerts', {
    urlId: payload.urlId,
    alertType: payload.alertType,
    severity: payload.severity,
    status: 'active',
    message: payload.message,
    previousState: payload.previousState ?? null,
    currentState: payload.currentState ?? null,
    coverageState: payload.coverageState ?? null,
    propertyId: payload.propertyId ?? null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    owner: payload.owner ?? 'SEO / Growth',
    slackChannel: payload.slackChannel ?? '#seo-alerts',
    recommendedAction: recommendationFor(payload.alertType, payload.result)
  });
}

export function resolveUrlAlerts(store, urlId, reason = 'Submitted and indexed') {
  const now = nowIso();
  const resolved = [];
  for (const alert of store.state.alerts.filter((item) => item.urlId === urlId && item.status === 'active')) {
    alert.status = 'resolved';
    alert.resolvedAt = now;
    alert.updatedAt = now;
    alert.message = `${alert.message} Resolved: ${reason}.`;
    resolved.push(alert);
  }
  return resolved;
}

export function maybeCreateResultAlerts(store, urlRecord, result, previousState, propertyId, policy) {
  const alerts = [];

  if (result.isSubmittedAndIndexed) {
    resolveUrlAlerts(store, urlRecord.id, 'Submitted and indexed');
    if (policy.alerts.resolvedNotifications && previousState && previousState !== 'submitted_and_indexed') {
      alerts.push(store.insert('alerts', {
        urlId: urlRecord.id,
        alertType: 'recovered',
        severity: 'resolved',
        status: 'resolved',
        message: `${urlRecord.normalizedUrl} recovered and is submitted/indexed again.`,
        previousState,
        currentState: urlRecord.currentIndexState,
        coverageState: result.coverageState,
        propertyId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        resolvedAt: nowIso(),
        owner: 'SEO / Growth',
        slackChannel: '#seo-alerts',
        recommendedAction: recommendationFor('recovered', result)
      }));
    }
    return alerts;
  }

  if (previousState === 'submitted_and_indexed' || previousState === 'stable_indexed') {
    alerts.push(upsertActiveAlert(store, {
      urlId: urlRecord.id,
      alertType: 'index_loss_suspected',
      severity: urlRecord.currentPriorityTier === 'P0' || urlRecord.isScaledContent ? 'critical' : 'critical',
      message: `${urlRecord.normalizedUrl} was indexed and is now ${result.coverageState}.`,
      previousState,
      currentState: urlRecord.currentIndexState,
      coverageState: result.coverageState,
      propertyId,
      result
    }));
  }

  if (urlRecord.currentIndexState === 'index_lost_confirmed') {
    alerts.push(upsertActiveAlert(store, {
      urlId: urlRecord.id,
      alertType: 'index_lost_confirmed',
      severity: 'incident',
      message: `${urlRecord.normalizedUrl} has confirmed index loss after a second negative inspection.`,
      previousState,
      currentState: urlRecord.currentIndexState,
      coverageState: result.coverageState,
      propertyId,
      result
    }));
  }

  if (urlRecord.isScaledContent && result.isNotIndexed) {
    alerts.push(upsertActiveAlert(store, {
      urlId: urlRecord.id,
      alertType: 'delayed_indexing',
      severity: 'critical',
      message: `${urlRecord.normalizedUrl} scaled content is not indexed yet.`,
      previousState,
      currentState: urlRecord.currentIndexState,
      coverageState: result.coverageState,
      propertyId,
      result
    }));
  }

  if (result.isCanonicalMismatch) {
    alerts.push(upsertActiveAlert(store, {
      urlId: urlRecord.id,
      alertType: 'canonical_mismatch',
      severity: ['P0', 'P1'].includes(urlRecord.currentPriorityTier) ? 'critical' : 'warning',
      message: `${urlRecord.normalizedUrl} canonical does not match inspected URL.`,
      previousState,
      currentState: urlRecord.currentIndexState,
      coverageState: result.coverageState,
      propertyId,
      result
    }));
  }

  if (result.isRedirected) {
    alerts.push(upsertActiveAlert(store, {
      urlId: urlRecord.id,
      alertType: 'technical_redirect',
      severity: 'warning',
      message: `${urlRecord.normalizedUrl} appears redirected in inspection result.`,
      previousState,
      currentState: urlRecord.currentIndexState,
      coverageState: result.coverageState,
      propertyId,
      result
    }));
  }

  return alerts;
}
