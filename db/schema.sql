CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS properties (
  id BIGSERIAL PRIMARY KEY,
  property_name TEXT NOT NULL,
  property_url TEXT NOT NULL UNIQUE,
  property_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  auth_status TEXT NOT NULL DEFAULT 'ok',
  fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  daily_quota_limit INTEGER NOT NULL DEFAULT 2000,
  daily_quota_used INTEGER NOT NULL DEFAULT 0,
  monthly_quota_used INTEGER NOT NULL DEFAULT 0,
  quota_reset_at TIMESTAMPTZ,
  last_successful_inspection_at TIMESTAMPTZ,
  last_quota_exceeded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS property_mappings (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id),
  property_name TEXT NOT NULL,
  property_url TEXT NOT NULL,
  match_type TEXT NOT NULL,
  prefix TEXT,
  path_prefix TEXT,
  locale TEXT,
  category TEXT,
  priority_order INTEGER NOT NULL DEFAULT 0,
  fallback_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_mappings_lookup
  ON property_mappings (is_active, category, locale, priority_order DESC);

CREATE TABLE IF NOT EXISTS urls (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  canonical_identity_url TEXT NOT NULL,
  category TEXT NOT NULL,
  sub_category TEXT,
  locale TEXT,
  is_scaled_content BOOLEAN NOT NULL DEFAULT FALSE,
  scaled_content_type TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_manually_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  current_priority_tier TEXT NOT NULL DEFAULT 'P3',
  current_index_state TEXT NOT NULL DEFAULT 'discovered',
  current_health_state TEXT NOT NULL DEFAULT 'unknown',
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_sitemap_seen_at TIMESTAMPTZ,
  last_business_metric_seen_at TIMESTAMPTZ,
  first_indexed_at TIMESTAMPTZ,
  last_inspected_at TIMESTAMPTZ,
  next_inspection_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_urls_due
  ON urls (is_active, is_manually_excluded, current_priority_tier, next_inspection_due_at);

CREATE INDEX IF NOT EXISTS idx_urls_category_locale
  ON urls (category, locale);

CREATE TABLE IF NOT EXISTS sitemaps (
  id BIGSERIAL PRIMARY KEY,
  sitemap_url TEXT NOT NULL UNIQUE,
  sitemap_path_group TEXT,
  sitemap_file_name TEXT,
  detected_locale TEXT,
  detected_category TEXT,
  detected_subcategory TEXT,
  is_scaled_content BOOLEAN NOT NULL DEFAULT FALSE,
  scaled_content_type TEXT,
  preferred_property_id BIGINT REFERENCES properties(id),
  fallback_property_ids BIGINT[] NOT NULL DEFAULT '{}',
  last_fetch_status TEXT,
  last_successful_fetch_at TIMESTAMPTZ,
  url_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS url_sources (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  source_type TEXT NOT NULL,
  source_identifier TEXT NOT NULL,
  source_sitemap_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url_id, source_type, source_identifier)
);

CREATE TABLE IF NOT EXISTS gsc_performance_metrics (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  url TEXT NOT NULL,
  click INTEGER NOT NULL DEFAULT 0,
  impression INTEGER NOT NULL DEFAULT 0,
  avg_position NUMERIC(8,2),
  source_property TEXT,
  imported_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_metrics (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  path TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('p30_users', 'signup_count')),
  metric_month DATE NOT NULL,
  metric_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  source_file TEXT,
  imported_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url_id, metric_type, metric_month)
);

CREATE TABLE IF NOT EXISTS url_priority_snapshots (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  calculated_at TIMESTAMPTZ NOT NULL,
  priority_tier TEXT NOT NULL,
  organic_flag BOOLEAN NOT NULL DEFAULT FALSE,
  signup_flag BOOLEAN NOT NULL DEFAULT FALSE,
  p30_flag BOOLEAN NOT NULL DEFAULT FALSE,
  scaled_flag BOOLEAN NOT NULL DEFAULT FALSE,
  manual_flag BOOLEAN NOT NULL DEFAULT FALSE,
  combined_business_flag BOOLEAN NOT NULL DEFAULT FALSE,
  score_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inspection_jobs (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  normalized_url TEXT NOT NULL,
  property_id BIGINT REFERENCES properties(id),
  queue_type TEXT NOT NULL,
  priority_tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  deadline_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url_id, reason, due_date)
);

CREATE INDEX IF NOT EXISTS idx_inspection_jobs_pending
  ON inspection_jobs (status, due_at, priority_tier);

CREATE TABLE IF NOT EXISTS inspection_results (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  job_id BIGINT REFERENCES inspection_jobs(id),
  property_id BIGINT NOT NULL REFERENCES properties(id),
  normalized_url TEXT NOT NULL,
  inspected_at TIMESTAMPTZ NOT NULL,
  inspection_date DATE NOT NULL,
  raw_json JSONB NOT NULL,
  verdict TEXT,
  coverage_state TEXT,
  indexing_state TEXT,
  robots_txt_state TEXT,
  page_fetch_state TEXT,
  last_crawl_time TIMESTAMPTZ,
  google_canonical TEXT,
  user_canonical TEXT,
  referring_urls TEXT[] NOT NULL DEFAULT '{}',
  sitemap_urls TEXT[] NOT NULL DEFAULT '{}',
  is_submitted_and_indexed BOOLEAN NOT NULL DEFAULT FALSE,
  is_indexed BOOLEAN NOT NULL DEFAULT FALSE,
  is_not_indexed BOOLEAN NOT NULL DEFAULT FALSE,
  is_canonical_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  is_redirected BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url_id, inspection_date),
  UNIQUE (normalized_url, inspection_date)
);

CREATE TABLE IF NOT EXISTS url_state_transitions (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  transition_reason TEXT NOT NULL,
  inspection_result_id BIGINT REFERENCES inspection_results(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technical_checks (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  checked_at TIMESTAMPTZ NOT NULL,
  http_status INTEGER,
  final_url TEXT,
  redirect_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta_robots TEXT,
  canonical_url TEXT,
  self_canonical BOOLEAN,
  fetch_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_status (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL UNIQUE REFERENCES urls(id),
  current_health_status TEXT NOT NULL,
  current_severity TEXT NOT NULL,
  current_index_status TEXT NOT NULL,
  current_coverage_state TEXT,
  current_priority_tier TEXT NOT NULL,
  has_active_alert BOOLEAN NOT NULL DEFAULT FALSE,
  last_healthy_at TIMESTAMPTZ,
  last_warning_at TIMESTAMPTZ,
  last_critical_at TIMESTAMPTZ,
  last_incident_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  message TEXT NOT NULL,
  previous_state TEXT,
  current_state TEXT,
  coverage_state TEXT,
  property_id BIGINT REFERENCES properties(id),
  recommended_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  owner TEXT,
  slack_channel TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_dedupe
  ON alerts (url_id, alert_type)
  WHERE status = 'active';
