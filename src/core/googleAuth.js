import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH_FILE = path.join(process.cwd(), 'data/runtime/google-auth.json');
const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const DEFAULT_SCOPES = ['openid', 'email', 'profile', WEBMASTERS_SCOPE];

function configuredClient(auth, origin) {
  const baseUrl = process.env.APP_BASE_URL || origin;
  const envRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
    || (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/auth/google/callback` : null);
  const envClient = process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
    ? {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: envRedirectUri,
      source: 'env'
    }
    : null;

  if (envClient) return envClient;
  if (!auth.client?.clientId || !auth.client?.clientSecret) return null;
  return {
    clientId: auth.client.clientId,
    clientSecret: auth.client.clientSecret,
    redirectUri: auth.client.redirectUri || envRedirectUri,
    source: 'dashboard'
  };
}

async function readAuthFile() {
  try {
    const text = await fs.readFile(AUTH_FILE, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeAuthFile(data) {
  await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await fs.writeFile(AUTH_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

function sanitize(auth) {
  const client = configuredClient(auth);
  return {
    hasClient: Boolean(client),
    clientSource: client?.source ?? null,
    connected: Boolean(auth.tokens?.refreshToken),
    email: auth.profile?.email ?? null,
    scopes: auth.tokens?.scope?.split(' ') ?? [],
    expiresAt: auth.tokens?.expiresAt ?? null,
    redirectUri: auth.oauthRedirectUri ?? client?.redirectUri ?? null,
    authFile: AUTH_FILE
  };
}

export async function googleAuthStatus() {
  return sanitize(await readAuthFile());
}

export async function saveOAuthClient({ clientId, clientSecret, redirectUri }) {
  const auth = await readAuthFile();
  auth.client = {
    clientId: String(clientId ?? '').trim(),
    clientSecret: String(clientSecret ?? '').trim(),
    redirectUri: String(redirectUri ?? '').trim()
  };
  if (!auth.client.clientId || !auth.client.clientSecret || !auth.client.redirectUri) {
    throw new Error('OAuth client ID, client secret, and redirect URI are required.');
  }
  await writeAuthFile(auth);
  return sanitize(auth);
}

export async function disconnectGoogle() {
  const auth = await readAuthFile();
  delete auth.tokens;
  delete auth.profile;
  delete auth.pendingState;
  await writeAuthFile(auth);
  return sanitize(auth);
}

export async function createGoogleAuthUrl(origin) {
  const auth = await readAuthFile();
  const client = configuredClient(auth, origin);
  if (!client?.clientId || !client?.clientSecret || !client?.redirectUri) {
    throw new Error('Save OAuth client settings before connecting Google.');
  }

  const redirectUri = client.redirectUri;
  auth.oauthRedirectUri = redirectUri;
  auth.pendingState = crypto.randomBytes(18).toString('hex');
  await writeAuthFile(auth);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', auth.pendingState);
  return url.toString();
}

async function tokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Google token request failed: ${json.error_description ?? json.error ?? response.status}`);
  }
  return json;
}

async function getUserProfile(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  return response.json();
}

export async function exchangeGoogleCode({ code, state }) {
  const auth = await readAuthFile();
  const client = configuredClient(auth);
  const redirectUri = auth.oauthRedirectUri ?? client?.redirectUri;
  if (!client?.clientId || !client?.clientSecret || !redirectUri) {
    throw new Error('OAuth client settings are missing.');
  }
  if (!state || state !== auth.pendingState) {
    throw new Error('Google OAuth state mismatch.');
  }

  const token = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  auth.tokens = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? auth.tokens?.refreshToken,
    scope: token.scope ?? DEFAULT_SCOPES.join(' '),
    tokenType: token.token_type,
    expiresAt: Date.now() + (Number(token.expires_in ?? 3600) * 1000)
  };
  auth.profile = await getUserProfile(token.access_token);
  delete auth.pendingState;
  await writeAuthFile(auth);
  return sanitize(auth);
}

export async function hasGoogleOAuthConnection() {
  const auth = await readAuthFile();
  return Boolean(auth.tokens?.refreshToken);
}

export async function getGoogleOAuthAccessToken() {
  const auth = await readAuthFile();
  const client = configuredClient(auth);
  if (!auth.tokens?.refreshToken) {
    throw new Error('Google account is not connected from dashboard.');
  }
  if (!client?.clientId || !client?.clientSecret) {
    throw new Error('OAuth client settings are missing.');
  }

  if (auth.tokens.accessToken && Date.now() < Number(auth.tokens.expiresAt ?? 0) - 60000) {
    return auth.tokens.accessToken;
  }

  const token = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: auth.tokens.refreshToken,
    grant_type: 'refresh_token'
  });

  auth.tokens.accessToken = token.access_token;
  auth.tokens.expiresAt = Date.now() + (Number(token.expires_in ?? 3600) * 1000);
  auth.tokens.scope = token.scope ?? auth.tokens.scope;
  await writeAuthFile(auth);
  return auth.tokens.accessToken;
}

export async function listSearchConsoleSites() {
  const token = await getGoogleOAuthAccessToken();
  const response = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Search Console sites request failed: ${json.error?.message ?? response.status}`);
  }
  return json.siteEntry ?? [];
}
