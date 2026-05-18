import { CATEGORY_PRIORITY_PROPERTIES } from './sitemap.js';
import { nowIso, unique } from './utils.js';

export function ensureProperties(store, propertyMappings, policy) {
  const now = nowIso();
  for (const mapping of propertyMappings) {
    const property = store.upsert(
      'properties',
      (row) => row.propertyUrl === mapping.propertyUrl,
      {
        propertyName: mapping.propertyName,
        propertyUrl: mapping.propertyUrl,
        propertyType: mapping.propertyType,
        isActive: mapping.isActive,
        authStatus: 'ok',
        fallbackEnabled: mapping.fallbackAllowed,
        dailyQuotaLimit: policy.quota.perPropertyDailyLimit,
        dailyQuotaUsed: 0,
        monthlyQuotaUsed: 0,
        quotaResetAt: null,
        lastSuccessfulInspectionAt: null,
        lastQuotaExceededAt: null,
        createdAt: now,
        updatedAt: now
      },
      {
        propertyName: mapping.propertyName,
        propertyType: mapping.propertyType,
        isActive: mapping.isActive,
        fallbackEnabled: mapping.fallbackAllowed,
        dailyQuotaLimit: policy.quota.perPropertyDailyLimit,
        updatedAt: now
      }
    );

    store.upsert(
      'propertyMappings',
      (row) => row.propertyUrl === mapping.propertyUrl && row.pathPrefix === mapping.pathPrefix && row.category === mapping.category,
      {
        propertyId: property.id,
        propertyName: mapping.propertyName,
        propertyUrl: mapping.propertyUrl,
        matchType: mapping.matchType,
        prefix: mapping.pathPrefix,
        pathPrefix: mapping.pathPrefix,
        locale: mapping.locale,
        category: mapping.category,
        priorityOrder: mapping.priorityOrder,
        fallbackAllowed: mapping.fallbackAllowed,
        isActive: mapping.isActive,
        createdAt: now,
        updatedAt: now
      },
      {
        propertyId: property.id,
        propertyName: mapping.propertyName,
        matchType: mapping.matchType,
        prefix: mapping.pathPrefix,
        locale: mapping.locale,
        priorityOrder: mapping.priorityOrder,
        fallbackAllowed: mapping.fallbackAllowed,
        isActive: mapping.isActive,
        updatedAt: now
      }
    );
  }
}

function byPropertyUrl(store, propertyUrl) {
  return store.state.properties.find((property) => property.propertyUrl === propertyUrl && property.isActive);
}

function propertyForCategory(store, category) {
  return store.state.propertyMappings
    .filter((mapping) => mapping.isActive && mapping.category === category)
    .sort((a, b) => b.priorityOrder - a.priorityOrder)
    .map((mapping) => byPropertyUrl(store, mapping.propertyUrl))
    .find(Boolean);
}

function propertyForLocale(store, locale) {
  return store.state.propertyMappings
    .filter((mapping) => mapping.isActive && mapping.locale === locale && mapping.category === 'locale')
    .sort((a, b) => b.priorityOrder - a.priorityOrder)
    .map((mapping) => byPropertyUrl(store, mapping.propertyUrl))
    .find(Boolean);
}

export function resolveEligibleProperties(store, urlRecord) {
  const candidates = [];
  const category = urlRecord.category;
  const locale = urlRecord.locale;

  if (urlRecord.isScaledContent && CATEGORY_PRIORITY_PROPERTIES.has(category)) {
    candidates.push(propertyForCategory(store, category));
  }

  if (CATEGORY_PRIORITY_PROPERTIES.has(category)) {
    candidates.push(propertyForCategory(store, category));
  }

  if (locale && locale !== 'en') {
    candidates.push(propertyForLocale(store, locale));
  }

  candidates.push(byPropertyUrl(store, 'https://www.jotform.com/'));
  candidates.push(byPropertyUrl(store, 'sc-domain:jotform.com'));

  return unique(candidates.map((property) => property?.id)).map((id) => store.findById('properties', id));
}

export function chooseBestProperty(store, eligibleProperties, policy) {
  const stopAt = policy.quota.stopAtPerProperty;
  return eligibleProperties
    .filter((property) => property?.isActive && property.authStatus === 'ok')
    .filter((property) => property.dailyQuotaUsed < stopAt)
    .sort((a, b) => {
      const remainingA = a.dailyQuotaLimit - a.dailyQuotaUsed;
      const remainingB = b.dailyQuotaLimit - b.dailyQuotaUsed;
      return remainingB - remainingA;
    })[0] ?? null;
}

export function incrementQuota(property) {
  property.dailyQuotaUsed += 1;
  property.monthlyQuotaUsed += 1;
  property.lastSuccessfulInspectionAt = nowIso();
  property.updatedAt = nowIso();
}
