import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { normalizeUrl } from './utils.js';

const CATEGORY_DICTIONARY = [
  ['/sitemaps/workflows-features/', 'pages/workflows-features'],
  ['/sitemaps/form-templates/', 'form-templates'],
  ['/sitemaps/app-templates/', 'app-templates'],
  ['/sitemaps/workflow-templates/', 'workflow-templates'],
  ['/sitemaps/table-templates/', 'table-templates'],
  ['/sitemaps/pdf-templates/', 'pdf-templates'],
  ['/sitemaps/agent-templates/', 'agent-templates'],
  ['/sitemaps/presentation-agent/', 'presentation-agent'],
  ['/sitemaps/integrations/', 'pages/integrations'],
  ['/sitemaps/qr-codes/', 'qr-codes'],
  ['/sitemaps/blog/', 'blog'],
  ['/sitemaps/help/', 'help'],
  ['/sitemaps/pages/', 'pages']
];

export const CATEGORY_PRIORITY_PROPERTIES = new Set([
  'blog',
  'help',
  'form-templates',
  'app-templates',
  'workflow-templates',
  'table-templates',
  'pdf-templates',
  'agent-templates',
  'presentation-agent',
  'qr-codes'
]);

export function extractXmlLocs(xmlText) {
  return [...xmlText.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1].trim());
}

export function extractSitemapUrlEntries(xmlText) {
  const entries = [...xmlText.matchAll(/<url\b[\s\S]*?<\/url>/gi)].map((block) => {
    const loc = block[0].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]?.trim();
    const lastmod = block[0].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() ?? null;
    return { loc, lastmod };
  }).filter((entry) => entry.loc);

  if (entries.length) return entries;
  return extractXmlLocs(xmlText).map((loc) => ({ loc, lastmod: null }));
}

export function extractSitemapIndexEntries(xmlText) {
  return [...xmlText.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)].map((block) => {
    const loc = block[0].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]?.trim();
    const lastmod = block[0].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() ?? null;
    return { loc, lastmod };
  }).filter((entry) => entry.loc);
}

export function isSitemapLikeUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return path.includes('/sitemaps/')
      || /(?:^|\/)sitemap[^/]*\.xml(?:\.gz)?$/.test(path)
      || /\/[^/]*sitemap[^/]*\.xml(?:\.gz)?$/.test(path);
  } catch {
    return false;
  }
}

export function classifySitemap(sitemapUrl, policy) {
  const parsed = new URL(sitemapUrl);
  const path = parsed.pathname;
  const fileName = path.split('/').pop() || 'sitemap.xml';
  const category = CATEGORY_DICTIONARY.find(([prefix]) => path.includes(prefix))?.[1] ?? 'unknown';
  const localeMatch = fileName.match(/(?:^|\/|\.)([a-z]{2})(?:[.-]|$)/i);
  const detectedLocale = localeMatch ? localeMatch[1].toLowerCase() : null;
  const lowerUrl = sitemapUrl.toLowerCase();
  const scaledKeyword = policy.scaledContent.enabledKeywords.find((keyword) => lowerUrl.includes(keyword));

  return {
    sitemapPathGroup: path.split('/').slice(0, -1).join('/') || '/',
    sitemapFileName: fileName,
    detectedCategory: category,
    detectedSubcategory: category.includes('/') ? category.split('/')[1] : null,
    detectedLocale,
    isScaledContent: Boolean(scaledKeyword),
    scaledContentType: scaledKeyword || null
  };
}

function decodeSitemapBuffer(buffer, source) {
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (isGzip || source.toLowerCase().endsWith('.gz')) {
    try {
      return gunzipSync(buffer).toString('utf8');
    } catch (error) {
      if (isGzip) throw error;
    }
  }
  return buffer.toString('utf8');
}

export async function fetchText(source, timeoutMs = 15000) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(source, {
        signal: controller.signal,
        headers: { 'user-agent': 'IndexHealthMonitoringEngine/0.1' }
      });
      if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${source}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return decodeSitemapBuffer(buffer, source);
    } finally {
      clearTimeout(timeout);
    }
  }
  return decodeSitemapBuffer(await fs.readFile(source), source);
}

export async function expandSitemapSources(sources, resolvePath, options = {}) {
  const includeLocal = options.includeLocal ?? true;
  const sitemapUrls = [];

  async function expandSource(source) {
    const text = await fetchText(source);
    const childEntries = extractSitemapIndexEntries(text);
    if (!childEntries.length) return [source];
    return childEntries.map((entry) => entry.loc);
  }

  if (includeLocal) {
    const expanded = await Promise.all((sources.localSitemapIndexFiles ?? []).map((file) => expandSource(resolvePath(file))));
    sitemapUrls.push(...expanded.flat());
  }

  const expandedIndexes = await Promise.all((sources.sitemapIndexUrls ?? []).map((indexUrl) => expandSource(indexUrl)));
  sitemapUrls.push(...expandedIndexes.flat());

  const expandedChildren = await Promise.all((sources.childSitemapUrls ?? []).map((childSitemapUrl) => expandSource(childSitemapUrl)));
  sitemapUrls.push(...expandedChildren.flat());

  const excluded = new Set(sources.excludedSitemapUrls ?? []);
  return [...new Set(sitemapUrls)].filter((url) => !excluded.has(url));
}

export function generateDemoUrlsForSitemap(sitemapUrl) {
  const info = classifySitemap(sitemapUrl, {
    scaledContent: { enabledKeywords: ['adcraft'] }
  });

  if (info.detectedCategory === 'form-templates' && info.isScaledContent) {
    return [
      'https://www.jotform.com/form-templates/agency-brief-form',
      'https://www.jotform.com/form-templates/ad-campaign-request-form',
      'https://www.jotform.com/form-templates/marketing-asset-intake-form'
    ];
  }

  if (info.detectedCategory === 'blog') {
    return [
      'https://www.jotform.com/blog/google-indexing-guide',
      'https://www.jotform.com/blog/technical-seo-checklist'
    ];
  }

  if (info.detectedCategory === 'pages' && info.detectedLocale === 'tr') {
    return [
      'https://www.jotform.com/tr/form-templates/is-basvuru-formu',
      'https://www.jotform.com/tr/online-form-builder'
    ];
  }

  if (info.detectedCategory === 'pages/workflows-features') {
    return [
      'https://www.jotform.com/workflows/features/approval-flow',
      'https://www.jotform.com/workflows/features/conditional-logic'
    ];
  }

  return [normalizeUrl(`https://www.jotform.com${new URL(sitemapUrl).pathname.replace('/sitemaps', '').replace(/\.xml$/, '')}`)];
}
