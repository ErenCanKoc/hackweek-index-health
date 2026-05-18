import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { getGoogleOAuthAccessToken, hasGoogleOAuthConnection } from './googleAuth.js';
import { hashNumber, normalizeUrl, nowIso } from './utils.js';

const COVERAGE_STATES = [
  'Submitted and indexed',
  'Submitted and indexed',
  'Submitted and indexed',
  'Discovered currently not indexed',
  'Crawled currently not indexed',
  'Duplicate, Google chose different canonical than user'
];

export class MockInspectionProvider {
  async inspect(urlRecord, property) {
    const hash = hashNumber(`${urlRecord.normalizedUrl}:${property.propertyUrl}`);
    const coverageState = urlRecord.isScaledContent && hash % 5 === 0
      ? 'Discovered currently not indexed'
      : COVERAGE_STATES[hash % COVERAGE_STATES.length];
    const isRedirected = hash % 23 === 0;
    const canonicalMismatch = coverageState.includes('Duplicate') || hash % 19 === 0;
    const inspectedAt = nowIso();

    const googleCanonical = canonicalMismatch
      ? urlRecord.normalizedUrl.replace(/\/$/, '').replace('/tr/', '/')
      : urlRecord.normalizedUrl;
    const userCanonical = canonicalMismatch ? googleCanonical : urlRecord.normalizedUrl;

    return {
      inspectedAt,
      rawJson: {
        inspectionResult: {
          inspectionResultLink: `mock://${property.propertyUrl}/${encodeURIComponent(urlRecord.normalizedUrl)}`,
          indexStatusResult: {
            verdict: coverageState === 'Submitted and indexed' ? 'PASS' : 'NEUTRAL',
            coverageState,
            indexingState: coverageState === 'Submitted and indexed' ? 'INDEXING_ALLOWED' : 'INDEXING_STATE_UNSPECIFIED',
            robotsTxtState: 'ALLOWED',
            pageFetchState: isRedirected ? 'REDIRECT_ERROR' : 'SUCCESSFUL',
            lastCrawlTime: inspectedAt,
            googleCanonical,
            userCanonical,
            referringUrls: [],
            sitemap: [urlRecord.sourceSitemapUrl].filter(Boolean)
          }
        }
      },
      verdict: coverageState === 'Submitted and indexed' ? 'PASS' : 'NEUTRAL',
      coverageState,
      indexingState: coverageState === 'Submitted and indexed' ? 'INDEXING_ALLOWED' : 'INDEXING_STATE_UNSPECIFIED',
      robotsTxtState: 'ALLOWED',
      pageFetchState: isRedirected ? 'REDIRECT_ERROR' : 'SUCCESSFUL',
      lastCrawlTime: inspectedAt,
      googleCanonical,
      userCanonical,
      referringUrls: [],
      sitemapUrls: [],
      isSubmittedAndIndexed: coverageState === 'Submitted and indexed',
      isIndexed: coverageState === 'Submitted and indexed',
      isNotIndexed: coverageState !== 'Submitted and indexed',
      isCanonicalMismatch: canonicalMismatch,
      isRedirected,
      errorCode: null,
      errorMessage: null
    };
  }
}

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function readServiceAccount() {
  if (process.env.GSC_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const text = await fs.readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    return JSON.parse(text);
  }

  throw new Error('GSC provider needs GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON.');
}

function canonicalMismatch(urlRecord, indexStatus) {
  const inspected = normalizeUrl(urlRecord.normalizedUrl);
  const userCanonical = indexStatus.userCanonical ? normalizeUrl(indexStatus.userCanonical) : inspected;
  const googleCanonical = indexStatus.googleCanonical ? normalizeUrl(indexStatus.googleCanonical) : inspected;
  return userCanonical !== inspected || googleCanonical !== inspected;
}

function parseInspectionResponse(urlRecord, rawJson) {
  const indexStatus = rawJson.inspectionResult?.indexStatusResult ?? {};
  const coverageState = indexStatus.coverageState ?? 'Unknown';
  const pageFetchState = indexStatus.pageFetchState ?? null;
  const canonicalIsDifferent = canonicalMismatch(urlRecord, indexStatus);
  const isRedirected = coverageState.toLowerCase().includes('redirect') || String(pageFetchState).includes('REDIRECT');
  const isSubmittedAndIndexed = coverageState === 'Submitted and indexed';

  return {
    inspectedAt: nowIso(),
    rawJson,
    verdict: indexStatus.verdict ?? rawJson.inspectionResult?.verdict ?? null,
    coverageState,
    indexingState: indexStatus.indexingState ?? null,
    robotsTxtState: indexStatus.robotsTxtState ?? null,
    pageFetchState,
    lastCrawlTime: indexStatus.lastCrawlTime ?? null,
    googleCanonical: indexStatus.googleCanonical ?? null,
    userCanonical: indexStatus.userCanonical ?? null,
    referringUrls: indexStatus.referringUrls ?? [],
    sitemapUrls: indexStatus.sitemap ?? [],
    isSubmittedAndIndexed,
    isIndexed: isSubmittedAndIndexed,
    isNotIndexed: !isSubmittedAndIndexed,
    isCanonicalMismatch: canonicalIsDifferent,
    isRedirected,
    errorCode: null,
    errorMessage: null
  };
}

export class GoogleUrlInspectionProvider {
  constructor(policy) {
    this.policy = policy;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (await hasGoogleOAuthConnection()) {
      this.accessToken = await getGoogleOAuthAccessToken();
      this.accessTokenExpiresAt = Date.now() + 3300000;
      return this.accessToken;
    }

    const serviceAccount = await readServiceAccount();
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(serviceAccount.private_key);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(`Google OAuth token failed: ${json.error_description ?? json.error ?? response.status}`);
    }

    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + (Number(json.expires_in ?? 3600) * 1000);
    return this.accessToken;
  }

  async inspect(urlRecord, property) {
    const token = await this.getAccessToken();
    const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        inspectionUrl: urlRecord.normalizedUrl,
        siteUrl: property.propertyUrl,
        languageCode: process.env.GSC_LANGUAGE_CODE ?? this.policy.inspection.languageCode ?? 'en-US'
      })
    });

    const json = await response.json();
    if (!response.ok) {
      return {
        inspectedAt: nowIso(),
        rawJson: json,
        verdict: null,
        coverageState: 'inspection_api_error',
        indexingState: null,
        robotsTxtState: null,
        pageFetchState: null,
        lastCrawlTime: null,
        googleCanonical: null,
        userCanonical: null,
        referringUrls: [],
        sitemapUrls: [],
        isSubmittedAndIndexed: false,
        isIndexed: false,
        isNotIndexed: true,
        isCanonicalMismatch: false,
        isRedirected: false,
        errorCode: json.error?.status ?? String(response.status),
        errorMessage: json.error?.message ?? `Inspection API failed with ${response.status}`
      };
    }

    return parseInspectionResponse(urlRecord, json);
  }
}

export function createInspectionProvider(policy) {
  const provider = process.env.INSPECTION_PROVIDER ?? policy.inspection.provider;
  if (provider === 'mock') {
    return new MockInspectionProvider();
  }
  if (provider === 'gsc') {
    return new GoogleUrlInspectionProvider(policy);
  }
  throw new Error(`Unknown inspection provider: ${provider}`);
}
