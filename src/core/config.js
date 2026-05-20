import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();

export async function readJson(relativePath) {
  const text = await fs.readFile(path.join(rootDir, relativePath), 'utf8');
  return JSON.parse(text);
}

export async function writeJson(relativePath, value) {
  await fs.writeFile(path.join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadConfig() {
  const [policy, propertyMappings, sources] = await Promise.all([
    readJson('config/policy.json'),
    readJson('config/property-mappings.json'),
    readJson('config/sources.json')
  ]);

  return { policy, propertyMappings, sources };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function deriveSourcesFromState(config, store) {
  const sitemaps = unique((store?.state?.sitemaps ?? []).map((sitemap) => sitemap.sitemapUrl));
  const sourceSitemaps = unique((store?.state?.urlSources ?? []).map((source) => source.sourceSitemapUrl));
  const childSitemapUrls = unique([...sitemaps, ...sourceSitemaps]);
  if (!childSitemapUrls.length) return null;
  return {
    ...config.sources,
    sitemapIndexUrls: config.sources.sitemapIndexUrls ?? [],
    childSitemapUrls,
    fetchChildSitemaps: true,
    useDemoUrlsWhenChildFetchIsOff: false,
    useDemoUrlsWhenChildFetchFails: config.sources.useDemoUrlsWhenChildFetchFails ?? true
  };
}

export function withStoredSources(config, store) {
  const storedSources = store?.state?.configSources ?? deriveSourcesFromState(config, store);
  if (!storedSources) return config;
  return {
    ...config,
    sources: {
      ...config.sources,
      ...storedSources,
      sitemapIndexUrls: storedSources.sitemapIndexUrls ?? config.sources.sitemapIndexUrls ?? [],
      childSitemapUrls: storedSources.childSitemapUrls ?? config.sources.childSitemapUrls ?? [],
      localSitemapIndexFiles: storedSources.localSitemapIndexFiles ?? config.sources.localSitemapIndexFiles ?? [],
      manualUrlFiles: storedSources.manualUrlFiles ?? config.sources.manualUrlFiles ?? [],
      gscCsvFiles: storedSources.gscCsvFiles ?? config.sources.gscCsvFiles ?? [],
      p30CsvFiles: storedSources.p30CsvFiles ?? config.sources.p30CsvFiles ?? [],
      signupCsvFiles: storedSources.signupCsvFiles ?? config.sources.signupCsvFiles ?? [],
      excludedSitemapUrls: storedSources.excludedSitemapUrls ?? config.sources.excludedSitemapUrls ?? []
    }
  };
}

export function resolvePath(relativePath) {
  return path.join(rootDir, relativePath);
}
