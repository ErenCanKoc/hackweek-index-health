import { nowIso } from './utils.js';

function extractMetaRobots(html) {
  const match = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']robots["'][^>]*>/i);
  return match?.[1]?.trim() ?? null;
}

function extractCanonical(html) {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  return match?.[1]?.trim() ?? null;
}

export function shouldRunTechnicalDiagnosis(urlRecord, result, policy) {
  if (!policy.technicalDiagnosis.enabled) return false;
  if (urlRecord.currentPriorityTier === 'P0' && result.isNotIndexed) return true;
  if (urlRecord.isScaledContent && result.isNotIndexed) return true;
  if (['P1', 'P2'].includes(urlRecord.currentPriorityTier) && result.isNotIndexed) return true;
  if (result.isCanonicalMismatch || result.isRedirected) return true;
  return false;
}

export async function runTechnicalDiagnosis(urlRecord, policy) {
  const checkedAt = nowIso();
  if (!policy.technicalDiagnosis.liveFetch) {
    return {
      urlId: urlRecord.id,
      checkedAt,
      httpStatus: null,
      finalUrl: urlRecord.normalizedUrl,
      redirectChain: [],
      metaRobots: null,
      canonicalUrl: urlRecord.normalizedUrl,
      selfCanonical: true,
      fetchError: 'live_fetch_disabled',
      createdAt: checkedAt
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.technicalDiagnosis.timeoutMs);

  try {
    const response = await fetch(urlRecord.normalizedUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'IndexHealthMonitoringEngine/0.1' }
    });
    const html = await response.text();
    const canonicalUrl = extractCanonical(html);
    return {
      urlId: urlRecord.id,
      checkedAt,
      httpStatus: response.status,
      finalUrl: response.url,
      redirectChain: [],
      metaRobots: extractMetaRobots(html),
      canonicalUrl,
      selfCanonical: canonicalUrl ? canonicalUrl.replace(/\/$/, '') === urlRecord.normalizedUrl.replace(/\/$/, '') : null,
      fetchError: null,
      createdAt: checkedAt
    };
  } catch (error) {
    return {
      urlId: urlRecord.id,
      checkedAt,
      httpStatus: null,
      finalUrl: null,
      redirectChain: [],
      metaRobots: null,
      canonicalUrl: null,
      selfCanonical: null,
      fetchError: error.message,
      createdAt: checkedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}
