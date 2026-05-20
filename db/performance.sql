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
