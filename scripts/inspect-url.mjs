import { loadConfig } from '../src/core/config.js';
import { createInspectionProvider } from '../src/core/inspectionProvider.js';
import { normalizeUrl } from '../src/core/utils.js';

function propertyForUrl(config, normalizedUrl, explicitPropertyUrl) {
  if (explicitPropertyUrl) {
    return {
      propertyName: explicitPropertyUrl,
      propertyUrl: explicitPropertyUrl,
      propertyType: explicitPropertyUrl.startsWith('sc-domain:') ? 'domain' : 'url-prefix'
    };
  }
  const mappings = [...(config.propertyMappings ?? [])]
    .filter((mapping) => mapping.isActive !== false)
    .filter((mapping) => {
      if (!mapping.pathPrefix || mapping.pathPrefix === '/') return true;
      return new URL(normalizedUrl).pathname.startsWith(mapping.pathPrefix);
    })
    .sort((a, b) => String(b.pathPrefix ?? '').length - String(a.pathPrefix ?? '').length);
  return mappings[0] ?? { propertyName: 'Default property', propertyUrl: 'https://www.jotform.com/', propertyType: 'url-prefix' };
}

const urlArg = process.argv[2] ?? process.env.INSPECT_URL;
const propertyArg = process.argv[3] ?? process.env.INSPECT_PROPERTY_URL;

if (!urlArg) {
  console.error('Usage: node scripts/inspect-url.mjs <url> [propertyUrl]');
  process.exit(1);
}

const config = await loadConfig();
const normalizedUrl = normalizeUrl(urlArg);
const property = propertyForUrl(config, normalizedUrl, propertyArg);
const provider = createInspectionProvider(config.policy);
const result = await provider.inspect(
  {
    id: null,
    normalizedUrl,
    url: normalizedUrl,
    category: 'manual',
    locale: 'en',
    isScaledContent: false
  },
  property
);

console.log(JSON.stringify({
  ok: !result.errorCode,
  url: normalizedUrl,
  propertyUrl: property.propertyUrl,
  coverageState: result.coverageState,
  verdict: result.verdict,
  indexingState: result.indexingState,
  pageFetchState: result.pageFetchState,
  lastCrawlTime: result.lastCrawlTime,
  googleCanonical: result.googleCanonical,
  userCanonical: result.userCanonical,
  errorCode: result.errorCode,
  errorMessage: result.errorMessage,
  rawJson: result.rawJson
}, null, 2));
