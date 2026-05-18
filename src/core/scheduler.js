import { maybeCreateResultAlerts, upsertActiveAlert } from './alerts.js';
import { createInspectionProvider } from './inspectionProvider.js';
import { chooseBestProperty, incrementQuota, resolveEligibleProperties } from './propertyResolver.js';
import { recalculatePriorities } from './priority.js';
import {
  calculateNextDueAt,
  nextStateFromInspection,
  saveTransitionIfChanged,
  upsertHealthStatus
} from './stateMachine.js';
import { runTechnicalDiagnosis, shouldRunTechnicalDiagnosis } from './technicalDiagnosis.js';
import { dateKey, monthBucketDay, nowIso } from './utils.js';

const JOB_PRIORITY = {
  index_loss_suspected: 1,
  active_scaled_content: 3,
  first_scaled_inspection: 4,
  new_landing_daily: 5,
  manual_force: 5,
  url_due: 6,
  monthly_coverage: 8,
  retry_needed: 9,
  random_audit_sample: 10
};

function jobSort(a, b) {
  const priorityA = JOB_PRIORITY[a.reason] ?? 99;
  const priorityB = JOB_PRIORITY[b.reason] ?? 99;
  if (priorityA !== priorityB) return priorityA - priorityB;
  const tierOrder = { P0: 0, P1: 1, P2: 2, P3: 3, Excluded: 9 };
  return (tierOrder[a.priorityTier] ?? 8) - (tierOrder[b.priorityTier] ?? 8);
}

export function alreadyInspectedToday(store, urlRecord, now = new Date()) {
  const today = dateKey(now);
  return store.state.inspectionResults.some((result) => (
    result.urlId === urlRecord.id
    && dateKey(result.inspectedAt) === today
  ));
}

export function ensureJobsForDueUrls(store, policy, now = new Date(), options = {}) {
  const nowIsoValue = now.toISOString();
  const today = dateKey(now);
  const force = Boolean(options.force);
  let created = 0;

  for (const url of store.state.urls) {
    if (!url.isActive || url.isManuallyExcluded || url.currentPriorityTier === 'Excluded') continue;
    if (!force && alreadyInspectedToday(store, url, now)) continue;

    const dueAt = url.nextInspectionDueAt ?? url.firstSeenAt ?? nowIsoValue;
    const due = new Date(dueAt) <= now;
    const bucketDue = url.currentPriorityTier === 'P3' && monthBucketDay(url.normalizedUrl) <= Number(today.slice(-2));
    if (!force && !due && !bucketDue) continue;

    let reason = force ? 'manual_force' : 'url_due';
    if (!force) {
      if (url.currentIndexState === 'index_loss_suspected') reason = 'index_loss_suspected';
      else if (url.isScaledContent && !url.lastInspectedAt) reason = 'first_scaled_inspection';
      else if (url.isScaledContent) reason = 'active_scaled_content';
      else if (url.currentPriorityTier === 'P3') reason = 'monthly_coverage';
    }

    const duplicate = store.state.inspectionJobs.some((job) => (
      job.urlId === url.id
      && job.reason === reason
      && dateKey(job.dueAt) === today
      && (force ? ['pending', 'running'].includes(job.status) : ['pending', 'running', 'completed'].includes(job.status))
    ));
    if (duplicate) continue;

    store.insert('inspectionJobs', {
      urlId: url.id,
      normalizedUrl: url.normalizedUrl,
      propertyId: null,
      queueType: 'inspection',
      priorityTier: url.currentPriorityTier,
      reason,
      dueAt: nowIsoValue,
      deadlineAt: null,
      status: 'pending',
      attemptCount: 0,
      lastError: null,
      lockedBy: null,
      lockedAt: null,
      createdAt: nowIsoValue,
      updatedAt: nowIsoValue
    });
    created += 1;
  }

  return created;
}

function saveInspectionResult(store, job, property, result) {
  return store.insert('inspectionResults', {
    urlId: job.urlId,
    jobId: job.id,
    propertyId: property.id,
    normalizedUrl: job.normalizedUrl,
    inspectedAt: result.inspectedAt,
    inspectionDate: dateKey(result.inspectedAt),
    rawJson: result.rawJson,
    verdict: result.verdict,
    coverageState: result.coverageState,
    indexingState: result.indexingState,
    robotsTxtState: result.robotsTxtState,
    pageFetchState: result.pageFetchState,
    lastCrawlTime: result.lastCrawlTime,
    googleCanonical: result.googleCanonical,
    userCanonical: result.userCanonical,
    referringUrls: result.referringUrls,
    sitemapUrls: result.sitemapUrls,
    isSubmittedAndIndexed: result.isSubmittedAndIndexed,
    isIndexed: result.isIndexed,
    isNotIndexed: result.isNotIndexed,
    isCanonicalMismatch: result.isCanonicalMismatch,
    isRedirected: result.isRedirected,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    createdAt: nowIso()
  });
}

export async function runScheduler(store, config, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const limit = options.limit ?? 100;
  const force = Boolean(options.force);
  const provider = options.provider ?? createInspectionProvider(config.policy);
  const summary = {
    thresholds: recalculatePriorities(store),
    createdJobs: ensureJobsForDueUrls(store, config.policy, now, { force }),
    inspected: 0,
    skipped: 0,
    alertsCreated: 0,
    technicalChecks: 0,
    errors: []
  };

  const pendingJobs = store.state.inspectionJobs
    .filter((job) => job.status === 'pending' && new Date(job.dueAt) <= now)
    .sort(jobSort)
    .slice(0, limit);

  for (const job of pendingJobs) {
    const urlRecord = store.findById('urls', job.urlId);
    if (!urlRecord || !urlRecord.isActive || urlRecord.isManuallyExcluded) {
      job.status = 'skipped';
      job.lastError = 'url_not_active';
      job.updatedAt = nowIso();
      summary.skipped += 1;
      continue;
    }

    if (!force && alreadyInspectedToday(store, urlRecord, now)) {
      job.status = 'skipped';
      job.lastError = 'already_inspected_today';
      job.updatedAt = nowIso();
      summary.skipped += 1;
      continue;
    }

    const eligibleProperties = resolveEligibleProperties(store, urlRecord);
    const property = chooseBestProperty(store, eligibleProperties, config.policy);
    if (!property) {
      job.status = 'skipped';
      job.lastError = 'no_available_property_quota';
      job.updatedAt = nowIso();
      summary.skipped += 1;
      upsertActiveAlert(store, {
        urlId: urlRecord.id,
        alertType: 'all_properties_quota_exhausted',
        severity: 'incident',
        message: `No eligible property has available quota for ${urlRecord.normalizedUrl}.`,
        previousState: urlRecord.currentIndexState,
        currentState: urlRecord.currentIndexState,
        coverageState: null,
        propertyId: null
      });
      summary.alertsCreated += 1;
      continue;
    }

    job.status = 'running';
    job.lockedBy = workerId;
    job.lockedAt = nowIso();
    job.propertyId = property.id;
    job.attemptCount += 1;

    try {
      const previousState = urlRecord.currentIndexState;
      const result = await provider.inspect(urlRecord, property);
      const savedResult = saveInspectionResult(store, job, property, result);

      incrementQuota(property);
      if (property.dailyQuotaUsed >= config.policy.quota.stopAtPerProperty) {
        property.lastQuotaExceededAt = nowIso();
        upsertActiveAlert(store, {
          urlId: urlRecord.id,
          alertType: 'property_quota_exhausted',
          severity: 'critical',
          message: `${property.propertyUrl} reached the protected daily quota stop line.`,
          previousState,
          currentState: previousState,
          coverageState: result.coverageState,
          propertyId: property.id,
          result
        });
      }

      urlRecord.currentIndexState = nextStateFromInspection(urlRecord, result);
      if (result.isSubmittedAndIndexed && !urlRecord.firstIndexedAt) {
        urlRecord.firstIndexedAt = result.inspectedAt;
      }
      urlRecord.lastInspectedAt = result.inspectedAt;
      urlRecord.nextInspectionDueAt = calculateNextDueAt(urlRecord, result, config.policy);
      urlRecord.updatedAt = nowIso();

      saveTransitionIfChanged(store, urlRecord, previousState, savedResult.id);
      const alerts = maybeCreateResultAlerts(store, urlRecord, result, previousState, property.id, config.policy);
      summary.alertsCreated += alerts.length;

      if (shouldRunTechnicalDiagnosis(urlRecord, result, config.policy)) {
        const check = await runTechnicalDiagnosis(urlRecord, config.policy);
        store.insert('technicalChecks', check);
        summary.technicalChecks += 1;
      }

      upsertHealthStatus(store, urlRecord, result);

      job.status = 'completed';
      job.lastError = null;
      job.lockedBy = null;
      job.lockedAt = null;
      job.updatedAt = nowIso();
      summary.inspected += 1;
    } catch (error) {
      job.status = job.attemptCount >= 3 ? 'failed' : 'pending';
      job.lastError = error.message;
      job.lockedBy = null;
      job.lockedAt = null;
      job.updatedAt = nowIso();
      summary.errors.push({ jobId: job.id, error: error.message });
    }
  }

  return summary;
}

export function releaseStaleLocks(store) {
  const cutoff = Date.now() - (30 * 60 * 1000);
  let released = 0;
  for (const job of store.state.inspectionJobs) {
    if (job.status === 'running' && job.lockedAt && new Date(job.lockedAt).getTime() < cutoff) {
      job.status = 'pending';
      job.lockedBy = null;
      job.lockedAt = null;
      job.updatedAt = nowIso();
      released += 1;
    }
  }
  return released;
}
