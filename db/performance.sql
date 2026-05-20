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
  is_manually_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  next_inspection_due_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  row_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.dashboard_urls ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_priority
  ON dashboard_urls (current_priority_tier, id);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_category
  ON dashboard_urls (category, locale, id);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_scaled
  ON dashboard_urls (is_scaled_content, id);

CREATE INDEX IF NOT EXISTS idx_dashboard_urls_normalized
  ON dashboard_urls (normalized_url);

CREATE TABLE IF NOT EXISTS dashboard_properties (
  id BIGINT PRIMARY KEY,
  property_url TEXT NOT NULL,
  row_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.dashboard_properties ENABLE ROW LEVEL SECURITY;

-- Optional one-time backfill. Keep this id aligned with APP_STATE_KEY.
-- Render uses APP_STATE_KEY=production in render.yaml.
TRUNCATE dashboard_urls, dashboard_properties;

INSERT INTO dashboard_urls (
  id, normalized_url, url, category, locale, current_priority_tier,
  current_index_state, current_health_state, is_scaled_content,
  is_manually_excluded, is_active, next_inspection_due_at,
  first_seen_at, last_seen_at, row_json, updated_at
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
  COALESCE((elem ->> 'isManuallyExcluded')::boolean, false),
  COALESCE((elem ->> 'isActive')::boolean, true),
  NULLIF(elem ->> 'nextInspectionDueAt', '')::timestamptz,
  NULLIF(elem ->> 'firstSeenAt', '')::timestamptz,
  NULLIF(elem ->> 'lastSeenAt', '')::timestamptz,
  elem,
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
    is_manually_excluded = EXCLUDED.is_manually_excluded,
    is_active = EXCLUDED.is_active,
    next_inspection_due_at = EXCLUDED.next_inspection_due_at,
    first_seen_at = EXCLUDED.first_seen_at,
    last_seen_at = EXCLUDED.last_seen_at,
    row_json = EXCLUDED.row_json,
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

ANALYZE dashboard_urls;
ANALYZE dashboard_properties;
