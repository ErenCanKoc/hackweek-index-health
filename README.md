# Index Health Monitoring Engine

Quota-aware, priority-aware, property-aware MVP for monitoring Jotform index health.

## What is built

- Sitemap + CSV ingestion from `config/sources.json`
- URL normalization and source tracking
- Category, locale, scaled content, and property resolution
- Priority tiers: `P0`, `P1`, `P2`, `P3`, `Excluded`
- Quota-aware inspection scheduler with daily duplicate prevention
- Deterministic mock URL Inspection provider
- Optional real Google URL Inspection API provider via service account
- Raw + parsed inspection result storage
- State transitions, health status, technical diagnosis records, and alert deduplication
- Dashboard: Overview, URL Explorer, Scaled Content, Property Quota, Alerts, Settings, URL Detail
- Exportable index health CSV
- Postgres schema draft in `db/schema.sql`

## Run locally

```bash
npm run seed
npm run scheduler
npm start
```

Open `http://localhost:3000`.

The MVP uses `data/runtime/state.json` as a local persistence layer so it can run without external services. The production target schema is in `db/schema.sql`.

Most setup can also be done from the dashboard:

- Settings -> Google Search Console: save OAuth client and connect Google.
- Settings -> Google Search Console: select connected GSC properties and import them into property mappings.
- Settings -> Inspection Provider: switch from `mock` to `gsc`.
- Settings -> Sitemap Sources: add sitemap indexes or child sitemap URLs.
- Settings -> Add Manual URL: add one-off URLs without editing CSV by hand.
- Settings -> Business / GSC CSV Import: paste GSC, P30, or signup CSVs and recalculate priority tiers.

## Where to connect things

## Moving off localhost

For real users, deploy the app behind a stable HTTPS URL and set:

```bash
APP_BASE_URL=https://index-health.your-domain.com
ADMIN_PASSWORD=choose-a-long-dashboard-password
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
GOOGLE_OAUTH_REDIRECT_URI=https://index-health.your-domain.com/auth/google/callback
INSPECTION_PROVIDER=gsc
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

Then add this redirect URI in Google Cloud OAuth Client:

```text
https://index-health.your-domain.com/auth/google/callback
```

With these env vars configured, the dashboard hides the OAuth setup fields and users only see **Continue with Google**. After consent, their Search Console properties appear in Settings for selection/import.

## Free Deploy: Render + Supabase

Recommended free-path setup:

1. Create a Supabase project.
2. Copy the Supabase Postgres connection string. Prefer the pooled connection string if available.
3. In Supabase SQL Editor, run:

```sql
CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

4. Push this repo to GitHub.
5. In Render, create a new Blueprint from the repo. Render will detect `render.yaml`.
6. Use Free plan.
7. Set Render env vars:

```bash
APP_BASE_URL=https://your-render-service.onrender.com
ADMIN_PASSWORD=choose-a-long-dashboard-password
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://your-render-service.onrender.com/auth/google/callback
DATABASE_URL=...
DATABASE_SSL=true
APP_STATE_KEY=production
INSPECTION_PROVIDER=gsc
RENDER_API_KEY=...
RENDER_SERVICE_ID=srv-...
SITEMAP_FETCH_CONCURRENCY=4
```

`ADMIN_PASSWORD` enables the built-in dashboard login. Without it, the app remains open for local development.
`RENDER_API_KEY` and `RENDER_SERVICE_ID` let the dashboard start sitemap fetching as a Render one-off job, so large sitemap imports do not depend on the web request staying alive. The job table is created automatically in Postgres.

8. In Google Cloud OAuth Client, add:

```text
https://your-render-service.onrender.com/auth/google/callback
```

9. Deploy on Render and open:

```text
https://your-render-service.onrender.com/#settings
```

10. Click **Continue with Google**, import GSC properties, add sitemap sources, then run scheduler from the dashboard.

Local Supabase connection test:

```bash
DATABASE_URL="postgresql://..." npm run check:supabase
```

### 1. Google URL Inspection API

Development uses the mock provider:

```json
{
  "inspection": {
    "provider": "mock"
  }
}
```

To use the real Google Search Console URL Inspection API, either edit `config/policy.json`:

```json
{
  "inspection": {
    "provider": "gsc",
    "languageCode": "en-US"
  }
}
```

or keep the file as-is and start with an environment override:

```bash
INSPECTION_PROVIDER=gsc \
GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account.json" \
npm run scheduler
```

Requirements:

- Enable the Google Search Console URL Inspection API in the Google Cloud project.
- For dashboard OAuth: create a Google OAuth Client ID/secret and use `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
- For service account mode: create/download a service account JSON key.
- Add the connected Google account or service account email as an owner/full user on the relevant GSC properties.
- Make sure `config/property-mappings.json` contains the same property URLs that exist in Search Console.

The adapter lives in `src/core/inspectionProvider.js`.

After connecting Google, the dashboard calls the Search Console Sites API and shows the properties available to that Google account. Select one or more properties, adjust category/path/locale if needed, and click **Import Selected Properties**. Imported properties are written to `config/property-mappings.json` and become available to the scheduler immediately.

### 2. Sitemap sources

Connect sitemap indexes in `config/sources.json`:

```json
{
  "sitemapIndexUrls": [
    "https://www.jotform.com/sitemap.xml"
  ],
  "fetchChildSitemaps": true
}
```

You can also connect direct child sitemaps:

```json
{
  "childSitemapUrls": [
    "https://www.jotform.com/sitemaps/form-templates/en.adcraft.sitemap.xml"
  ],
  "fetchChildSitemaps": true
}
```

When `fetchChildSitemaps` is `true`, the engine fetches each child sitemap and imports real `<url><loc>...</loc></url>` entries. The sample config keeps this off so the repo works offline with demo URLs.

Adcraft detection is based on the sitemap URL, not the page URL. A page URL imported from a sitemap such as `https://www.jotform.com/sitemaps/form-templates/en.adcraft.sitemap.xml` is marked as `isScaledContent=true` and `scaledContentType=adcraft` even if the page URL itself does not contain `adcraft`.

### Daily cron endpoint

For free hosting that can sleep, trigger the daily work from an external scheduler. The included GitHub Actions workflow calls Render's one-off jobs API directly, so the dashboard web service does not run the heavy cron work.

```bash
curl --request POST \
  --header "authorization: Bearer $RENDER_API_KEY" \
  --header "content-type: application/json" \
  --data '{"startCommand":"SITEMAP_FETCH_CREATE_JOB=true SITEMAP_FETCH_REASON=external_daily DAILY_CRON_SCHEDULER_LIMIT=500 node scripts/run-sitemap-fetch-job.mjs --create"}' \
  https://api.render.com/v1/services/$RENDER_SERVICE_ID/jobs
```

Set these environment/secrets:

- Render: `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `CRON_SECRET`
- GitHub Actions repository secrets: `RENDER_API_KEY` and `RENDER_SERVICE_ID`

The included `.github/workflows/daily-cron.yml` runs every day at `03:00 UTC` and can also be run manually from GitHub Actions. The one-off command creates a durable sitemap fetch job; when that job finishes, it runs the inspection scheduler with the requested limit. `/api/cron/daily` is still available as a fallback HTTP endpoint.

### 3. Manual URL entry

Put one-off URLs in `data/imports/manual-urls.csv`:

```csv
url,category,locale,is_scaled_content,scaled_content_type,priority_tier
https://www.jotform.com/example-page,pages,en,false,,P3
https://www.jotform.com/form-templates/example,form-templates,en,true,adcraft,P0
```

Then run:

```bash
npm run seed
npm run scheduler
```

### 4. Business and GSC CSVs

Fast dashboard import path:

1. Open Settings.
2. Find **Business / GSC CSV Import**.
3. Choose one import type:
   - `GSC performance`: `url,click,impression,avg_position`
   - `P30 wide CSV`: `path,YYYY-MM-01,...`
   - `Signup wide CSV`: `path,YYYY-MM-01,...`
4. Paste the CSV content and click **Import CSV**.

The dashboard import writes metrics into the app state, creates missing URLs, and recalculates priority tiers immediately.

File-based import is also supported:

Wire CSV files in `config/sources.json`:

```json
{
  "gscCsvFiles": ["data/imports/gsc.csv"],
  "p30CsvFiles": ["data/imports/p30.csv"],
  "signupCsvFiles": ["data/imports/signups.csv"]
}
```

Expected formats:

```csv
url,click,impression,avg_position
https://www.jotform.com/example,120,4000,6.2
```

```csv
path,2026-03-01,2026-04-01,2026-05-01
/example,10,20,30
```

## Key files

- `config/policy.json`: inspection cadence, quota, scaled content, alerts
- `config/property-mappings.json`: property resolver inputs
- `src/core/scheduler.js`: queue allocation and inspection flow
- `src/core/propertyResolver.js`: property-aware resolver
- `src/core/inspectionProvider.js`: mock and real GSC inspection providers
- `public/app.js`: dashboard UI

## Next production steps

1. Move `Store` from JSON persistence to Postgres using `db/schema.sql`.
2. Add Slack/email delivery for active alerts.
3. Wire authentication and manual override permissions into the dashboard.
