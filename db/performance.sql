-- Dashboard performance cache for the PoC.
-- Run this in Supabase SQL Editor if the app has not created the cache yet.

CREATE TABLE IF NOT EXISTS dashboard_urls (
  id BIGINT PRIMARY KEY,
  normalized_url TEXT NOT NULL,
  url TEXT,
  category TEXT,
  locale TEXT,
  current_priority_tier TEXT,
  current_index_state TEXT,
  current_health_state TEXT,
  is_scaled_content BOOLEAN NOT NULL DEFAULT FALSE,
  scaled_content_type TEXT,
  is_manually_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  next_inspection_due_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ,
  first_indexed_at TIMESTAMPTZ,
  last_inspected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  source_sitemaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.dashboard_urls ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_urls DROP COLUMN IF EXISTS row_json;
ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS source_sitemaps JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS source_text TEXT NOT NULL DEFAULT '';
ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS first_indexed_at TIMESTAMPTZ;
ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS last_inspected_at TIMESTAMPTZ;
ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS scaled_content_type TEXT;
DROP INDEX IF EXISTS idx_dashboard_urls_normalized;
DROP INDEX IF EXISTS idx_dashboard_urls_source_text;

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_normalized_url
  ON dashboard_urls (normalized_url text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_priority
  ON dashboard_urls (current_priority_tier, id);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_category
  ON dashboard_urls (category, locale, id);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_scaled
  ON dashboard_urls (is_scaled_content, id);

CREATE TABLE IF NOT EXISTS dashboard_properties (
  id BIGINT PRIMARY KEY,
  property_url TEXT NOT NULL,
  row_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.dashboard_properties ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS dashboard_inspection_jobs (
  id BIGINT PRIMARY KEY,
  url_id BIGINT,
  property_id BIGINT,
  status TEXT,
  reason TEXT,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_error TEXT,
  row_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_inspection_results (
  id BIGINT PRIMARY KEY,
  url_id BIGINT,
  property_id BIGINT,
  inspected_at TIMESTAMPTZ,
  row_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_alerts (
  id BIGINT PRIMARY KEY,
  url_id BIGINT,
  status TEXT,
  alert_type TEXT,
  severity TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  row_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_technical_checks (
  id BIGINT PRIMARY KEY,
  url_id BIGINT,
  created_at TIMESTAMPTZ,
  row_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_health_statuses (
  url_id BIGINT PRIMARY KEY,
  row_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_url_details (
  url_id BIGINT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_inspection_jobs_url
  ON dashboard_inspection_jobs (url_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_inspection_jobs_status
  ON dashboard_inspection_jobs (status, due_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_inspection_results_url
  ON dashboard_inspection_results (url_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_inspection_results_inspected_at
  ON dashboard_inspection_results (inspected_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_alerts_url
  ON dashboard_alerts (url_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_alerts_status_severity
  ON dashboard_alerts (status, severity);
CREATE INDEX IF NOT EXISTS idx_dashboard_technical_checks_url
  ON dashboard_technical_checks (url_id, id DESC);

-- Optional one-time backfill. Keep this id aligned with APP_STATE_KEY.
-- Render uses APP_STATE_KEY=production in render.yaml.
TRUNCATE dashboard_urls, dashboard_properties, dashboard_inspection_jobs, dashboard_inspection_results, dashboard_alerts, dashboard_technical_checks, dashboard_health_statuses, dashboard_snapshots, dashboard_url_details;

INSERT INTO dashboard_urls (
  id, normalized_url, url, category, locale, current_priority_tier,
  current_index_state, current_health_state, is_scaled_content,
  scaled_content_type, is_manually_excluded, is_active, next_inspection_due_at,
  first_seen_at, first_indexed_at, last_inspected_at, last_seen_at,
  source_sitemaps, source_text, updated_at
)
SELECT
  (elem ->> 'id')::bigint,
  COALESCE(elem ->> 'normalizedUrl', elem ->> 'url'),
  elem ->> 'url',
  elem ->> 'category',
  elem ->> 'locale',
  elem ->> 'currentPriorityTier',
  elem ->> 'currentIndexState',
  elem ->> 'currentHealthState',
  COALESCE((elem ->> 'isScaledContent')::boolean, false),
  elem ->> 'scaledContentType',
  COALESCE((elem ->> 'isManuallyExcluded')::boolean, false),
  COALESCE((elem ->> 'isActive')::boolean, true),
  NULLIF(elem ->> 'nextInspectionDueAt', '')::timestamptz,
  NULLIF(elem ->> 'firstSeenAt', '')::timestamptz,
  NULLIF(elem ->> 'firstIndexedAt', '')::timestamptz,
  NULLIF(elem ->> 'lastInspectedAt', '')::timestamptz,
  NULLIF(elem ->> 'lastSeenAt', '')::timestamptz,
  '[]'::jsonb,
  '',
  now()
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'urls', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET normalized_url = EXCLUDED.normalized_url,
    url = EXCLUDED.url,
    category = EXCLUDED.category,
    locale = EXCLUDED.locale,
    current_priority_tier = EXCLUDED.current_priority_tier,
    current_index_state = EXCLUDED.current_index_state,
    current_health_state = EXCLUDED.current_health_state,
    is_scaled_content = EXCLUDED.is_scaled_content,
    scaled_content_type = EXCLUDED.scaled_content_type,
    is_manually_excluded = EXCLUDED.is_manually_excluded,
    is_active = EXCLUDED.is_active,
    next_inspection_due_at = EXCLUDED.next_inspection_due_at,
    first_seen_at = EXCLUDED.first_seen_at,
    first_indexed_at = EXCLUDED.first_indexed_at,
    last_inspected_at = EXCLUDED.last_inspected_at,
    last_seen_at = EXCLUDED.last_seen_at,
    source_sitemaps = EXCLUDED.source_sitemaps,
    source_text = EXCLUDED.source_text,
    updated_at = now();

INSERT INTO dashboard_properties (id, property_url, row_json, updated_at)
SELECT
  (elem ->> 'id')::bigint,
  COALESCE(elem ->> 'propertyUrl', elem ->> 'property_url', ''),
  elem,
  now()
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'properties', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET property_url = EXCLUDED.property_url,
    row_json = EXCLUDED.row_json,
    updated_at = now();

INSERT INTO dashboard_inspection_jobs (
  id, url_id, property_id, status, reason, due_at, created_at, updated_at, last_error, row_json
)
SELECT
  (elem ->> 'id')::bigint,
  NULLIF(elem ->> 'urlId', '')::bigint,
  NULLIF(elem ->> 'propertyId', '')::bigint,
  elem ->> 'status',
  elem ->> 'reason',
  NULLIF(elem ->> 'dueAt', '')::timestamptz,
  NULLIF(elem ->> 'createdAt', '')::timestamptz,
  NULLIF(elem ->> 'updatedAt', '')::timestamptz,
  elem ->> 'lastError',
  elem
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'inspectionJobs', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET url_id = EXCLUDED.url_id,
    property_id = EXCLUDED.property_id,
    status = EXCLUDED.status,
    reason = EXCLUDED.reason,
    due_at = EXCLUDED.due_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    last_error = EXCLUDED.last_error,
    row_json = EXCLUDED.row_json;

INSERT INTO dashboard_inspection_results (id, url_id, property_id, inspected_at, row_json)
SELECT
  (elem ->> 'id')::bigint,
  NULLIF(elem ->> 'urlId', '')::bigint,
  NULLIF(elem ->> 'propertyId', '')::bigint,
  NULLIF(elem ->> 'inspectedAt', '')::timestamptz,
  elem
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'inspectionResults', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET url_id = EXCLUDED.url_id,
    property_id = EXCLUDED.property_id,
    inspected_at = EXCLUDED.inspected_at,
    row_json = EXCLUDED.row_json;

INSERT INTO dashboard_alerts (id, url_id, status, alert_type, severity, created_at, updated_at, row_json)
SELECT
  (elem ->> 'id')::bigint,
  NULLIF(elem ->> 'urlId', '')::bigint,
  elem ->> 'status',
  elem ->> 'alertType',
  elem ->> 'severity',
  NULLIF(elem ->> 'createdAt', '')::timestamptz,
  NULLIF(elem ->> 'updatedAt', '')::timestamptz,
  elem
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'alerts', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET url_id = EXCLUDED.url_id,
    status = EXCLUDED.status,
    alert_type = EXCLUDED.alert_type,
    severity = EXCLUDED.severity,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    row_json = EXCLUDED.row_json;

INSERT INTO dashboard_technical_checks (id, url_id, created_at, row_json)
SELECT
  (elem ->> 'id')::bigint,
  NULLIF(elem ->> 'urlId', '')::bigint,
  NULLIF(COALESCE(elem ->> 'checkedAt', elem ->> 'createdAt'), '')::timestamptz,
  elem
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'technicalChecks', '[]'::jsonb)) AS rows(elem)
WHERE app_state.id = 'production'
  AND elem ? 'id'
ON CONFLICT (id) DO UPDATE
SET url_id = EXCLUDED.url_id,
    created_at = EXCLUDED.created_at,
    row_json = EXCLUDED.row_json;

INSERT INTO dashboard_health_statuses (url_id, row_json)
SELECT DISTINCT ON ((elem ->> 'urlId')::bigint)
  (elem ->> 'urlId')::bigint,
  elem
FROM app_state,
  jsonb_array_elements(COALESCE(state -> 'healthStatuses', '[]'::jsonb)) WITH ORDINALITY AS rows(elem, ord)
WHERE app_state.id = 'production'
  AND elem ? 'urlId'
ORDER BY (elem ->> 'urlId')::bigint, ord DESC
ON CONFLICT (url_id) DO UPDATE
SET row_json = EXCLUDED.row_json;

ANALYZE dashboard_urls;
ANALYZE dashboard_properties;
ANALYZE dashboard_inspection_jobs;
ANALYZE dashboard_inspection_results;
ANALYZE dashboard_alerts;
ANALYZE dashboard_technical_checks;
ANALYZE dashboard_health_statuses;
