import { getDatabasePool } from './db.js';

function getPool() {
  return getDatabasePool();
}

function appStateKey() {
  return process.env.APP_STATE_KEY || 'default';
}

export async function ensureDashboardCacheTables() {
  const pool = getPool();
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_urls (
      id BIGINT PRIMARY KEY,
      normalized_url TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT,
      locale TEXT,
      current_priority_tier TEXT,
      current_index_state TEXT,
      current_health_state TEXT,
      is_scaled_content BOOLEAN NOT NULL DEFAULT false,
      scaled_content_type TEXT,
      is_manually_excluded BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      next_inspection_due_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ,
      first_indexed_at TIMESTAMPTZ,
      last_inspected_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      source_sitemaps JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_text TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS first_indexed_at TIMESTAMPTZ;
    ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS last_inspected_at TIMESTAMPTZ;
    ALTER TABLE dashboard_urls ADD COLUMN IF NOT EXISTS scaled_content_type TEXT;

    CREATE TABLE IF NOT EXISTS dashboard_properties (
      id BIGINT PRIMARY KEY,
      property_url TEXT NOT NULL,
      row_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

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

    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_normalized_url
      ON dashboard_urls (normalized_url text_pattern_ops);
    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_priority
      ON dashboard_urls (current_priority_tier, id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_category
      ON dashboard_urls (category, locale, id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_scaled
      ON dashboard_urls (is_scaled_content, id);
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
  `);
  return true;
}

export async function refreshDashboardCache() {
  const pool = getPool();
  if (!pool) return null;
  await ensureDashboardCacheTables();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      TRUNCATE
        dashboard_urls,
        dashboard_properties,
        dashboard_inspection_jobs,
        dashboard_inspection_results,
        dashboard_alerts,
        dashboard_technical_checks,
        dashboard_health_statuses,
        dashboard_snapshots,
        dashboard_url_details
    `);
    const urlsResult = await client.query(
      `
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
        WHERE app_state.id = $1
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
              updated_at = now()
      `,
      [appStateKey()]
    );
    const propertiesResult = await client.query(
      `
        INSERT INTO dashboard_properties (id, property_url, row_json, updated_at)
        SELECT
          (elem ->> 'id')::bigint,
          COALESCE(elem ->> 'propertyUrl', elem ->> 'property_url', ''),
          elem,
          now()
        FROM app_state,
          jsonb_array_elements(COALESCE(state -> 'properties', '[]'::jsonb)) AS rows(elem)
        WHERE app_state.id = $1
          AND elem ? 'id'
        ON CONFLICT (id) DO UPDATE
          SET property_url = EXCLUDED.property_url,
              row_json = EXCLUDED.row_json,
              updated_at = now()
      `,
      [appStateKey()]
    );
    const jobsResult = await client.query(
      `
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
        WHERE app_state.id = $1
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
              row_json = EXCLUDED.row_json
      `,
      [appStateKey()]
    );
    const inspectionsResult = await client.query(
      `
        INSERT INTO dashboard_inspection_results (id, url_id, property_id, inspected_at, row_json)
        SELECT
          (elem ->> 'id')::bigint,
          NULLIF(elem ->> 'urlId', '')::bigint,
          NULLIF(elem ->> 'propertyId', '')::bigint,
          NULLIF(elem ->> 'inspectedAt', '')::timestamptz,
          elem
        FROM app_state,
          jsonb_array_elements(COALESCE(state -> 'inspectionResults', '[]'::jsonb)) AS rows(elem)
        WHERE app_state.id = $1
          AND elem ? 'id'
        ON CONFLICT (id) DO UPDATE
          SET url_id = EXCLUDED.url_id,
              property_id = EXCLUDED.property_id,
              inspected_at = EXCLUDED.inspected_at,
              row_json = EXCLUDED.row_json
      `,
      [appStateKey()]
    );
    const alertsResult = await client.query(
      `
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
        WHERE app_state.id = $1
          AND elem ? 'id'
        ON CONFLICT (id) DO UPDATE
          SET url_id = EXCLUDED.url_id,
              status = EXCLUDED.status,
              alert_type = EXCLUDED.alert_type,
              severity = EXCLUDED.severity,
              created_at = EXCLUDED.created_at,
              updated_at = EXCLUDED.updated_at,
              row_json = EXCLUDED.row_json
      `,
      [appStateKey()]
    );
    await client.query(
      `
        INSERT INTO dashboard_technical_checks (id, url_id, created_at, row_json)
        SELECT
          (elem ->> 'id')::bigint,
          NULLIF(elem ->> 'urlId', '')::bigint,
          NULLIF(COALESCE(elem ->> 'checkedAt', elem ->> 'createdAt'), '')::timestamptz,
          elem
        FROM app_state,
          jsonb_array_elements(COALESCE(state -> 'technicalChecks', '[]'::jsonb)) AS rows(elem)
        WHERE app_state.id = $1
          AND elem ? 'id'
        ON CONFLICT (id) DO UPDATE
          SET url_id = EXCLUDED.url_id,
              created_at = EXCLUDED.created_at,
              row_json = EXCLUDED.row_json
      `,
      [appStateKey()]
    );
    await client.query(
      `
        INSERT INTO dashboard_health_statuses (url_id, row_json)
        SELECT DISTINCT ON ((elem ->> 'urlId')::bigint)
          (elem ->> 'urlId')::bigint,
          elem
        FROM app_state,
          jsonb_array_elements(COALESCE(state -> 'healthStatuses', '[]'::jsonb)) WITH ORDINALITY AS rows(elem, ord)
        WHERE app_state.id = $1
          AND elem ? 'urlId'
        ORDER BY (elem ->> 'urlId')::bigint, ord DESC
        ON CONFLICT (url_id) DO UPDATE
          SET row_json = EXCLUDED.row_json
      `,
      [appStateKey()]
    );
    await client.query(
      `
        WITH source_rows AS (
          SELECT
            (elem ->> 'urlId')::bigint AS url_id,
            jsonb_agg(
              jsonb_build_object(
                'sourceType', elem ->> 'sourceType',
                'sourceIdentifier', elem ->> 'sourceIdentifier',
                'sourceSitemapUrl', elem ->> 'sourceSitemapUrl',
                'firstSeenAt', elem ->> 'firstSeenAt',
                'lastSeenAt', elem ->> 'lastSeenAt'
              )
              ORDER BY ord DESC
            ) AS sources,
            string_agg(
              DISTINCT COALESCE(elem ->> 'sourceSitemapUrl', elem ->> 'sourceIdentifier', ''),
              ' '
            ) AS source_text
          FROM app_state,
            jsonb_array_elements(COALESCE(state -> 'urlSources', '[]'::jsonb)) WITH ORDINALITY AS rows(elem, ord)
          WHERE app_state.id = $1
            AND elem ? 'urlId'
          GROUP BY (elem ->> 'urlId')::bigint
        )
        UPDATE dashboard_urls AS url
        SET source_sitemaps = source_rows.sources,
            source_text = COALESCE(source_rows.source_text, ''),
            updated_at = now()
        FROM source_rows
        WHERE url.id = source_rows.url_id
      `,
      [appStateKey()]
    );
    await rebuildDashboardSnapshots(client);
    await client.query('COMMIT');
    return {
      urls: urlsResult.rowCount,
      properties: propertiesResult.rowCount,
      jobs: jobsResult.rowCount,
      inspections: inspectionsResult.rowCount,
      alerts: alertsResult.rowCount
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rebuildDashboardSnapshots(client) {
  const today = new Date().toISOString().slice(0, 10);
  await client.query(
    `
      INSERT INTO dashboard_snapshots (key, payload, updated_at)
      WITH active_urls AS (
        SELECT *
        FROM dashboard_urls
        WHERE is_active = true
          AND is_manually_excluded = false
      ),
      totals AS (
        SELECT
          COUNT(*)::int AS active_total,
          COUNT(*) FILTER (WHERE current_index_state IN ('submitted_and_indexed', 'stable_indexed'))::int AS indexed_total,
          COUNT(*) FILTER (WHERE is_scaled_content = true)::int AS scaled_total,
          COUNT(*) FILTER (WHERE is_scaled_content = true AND current_index_state IN ('submitted_and_indexed', 'stable_indexed'))::int AS scaled_indexed_total,
          COUNT(*) FILTER (WHERE current_priority_tier = 'P0')::int AS p0_total,
          COUNT(*) FILTER (WHERE current_priority_tier = 'P0' AND current_index_state IN ('submitted_and_indexed', 'stable_indexed'))::int AS p0_indexed_total,
          COUNT(*) FILTER (WHERE current_index_state IN ('index_loss_suspected', 'index_lost_confirmed'))::int AS index_loss_total,
          COUNT(*) FILTER (WHERE next_inspection_due_at IS NOT NULL AND next_inspection_due_at < now())::int AS overdue_total,
          COUNT(*) FILTER (WHERE last_seen_at IS NOT NULL AND last_seen_at >= now() - interval '30 days')::int AS monthly_covered
        FROM active_urls
      ),
      categories AS (
        SELECT COALESCE(category, 'unknown') AS category,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE current_index_state IN ('submitted_and_indexed', 'stable_indexed'))::int AS indexed,
          COUNT(*) FILTER (WHERE current_index_state IN ('index_loss_suspected', 'index_lost_confirmed', 'not_indexed', 'canonical_mismatch'))::int AS critical
        FROM active_urls
        GROUP BY COALESCE(category, 'unknown')
      ),
      inspection_today AS (
        SELECT COUNT(*)::int AS inspected_today
        FROM dashboard_inspection_results
        WHERE inspected_at::date = $1::date
      ),
      quota AS (
        SELECT COALESCE(SUM(COALESCE((row_json ->> 'dailyQuotaUsed')::int, 0)), 0)::int AS quota_used_today
        FROM dashboard_properties
      ),
      critical_alerts AS (
        SELECT COUNT(*)::int AS open_critical_alerts
        FROM dashboard_alerts
        WHERE status = 'active'
          AND COALESCE(alert_type, '') <> 'recovered'
          AND severity IN ('critical', 'incident')
      ),
      overview AS (
        SELECT totals.*, inspection_today.inspected_today, quota.quota_used_today, critical_alerts.open_critical_alerts,
          COALESCE((SELECT jsonb_agg(categories ORDER BY category) FROM categories), '[]'::jsonb) AS category_health
        FROM totals, inspection_today, quota, critical_alerts
      )
      SELECT
        'overview',
        jsonb_build_object(
          'inspectedToday', COALESCE(inspected_today, 0),
          'quotaUsedToday', COALESCE(quota_used_today, 0),
          'monthlyCoveragePercent', CASE WHEN active_total > 0 THEN ROUND((monthly_covered::numeric / active_total) * 100)::int ELSE 0 END,
          'indexRate', CASE WHEN active_total > 0 THEN ROUND((indexed_total::numeric / active_total) * 100)::int ELSE 0 END,
          'indexLossCount', COALESCE(index_loss_total, 0),
          'scaledContentIndexRate', CASE WHEN scaled_total > 0 THEN ROUND((scaled_indexed_total::numeric / scaled_total) * 100)::int ELSE 0 END,
          'p0IndexRate', CASE WHEN p0_total > 0 THEN ROUND((p0_indexed_total::numeric / p0_total) * 100)::int ELSE 0 END,
          'averageTimeToIndex', 0,
          'openCriticalAlerts', COALESCE(open_critical_alerts, 0),
          'overdueUrlCount', COALESCE(overdue_total, 0),
          'categoryHealth', COALESCE(category_health, '[]'::jsonb),
          'lite', true,
          'cached', true,
          'snapshot', true
        ),
        now()
      FROM overview
      ON CONFLICT (key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = EXCLUDED.updated_at
    `,
    [today]
  );

  await client.query(`
    INSERT INTO dashboard_url_details (url_id, payload, updated_at)
    SELECT
      url.id,
      jsonb_build_object(
        'url', jsonb_build_object(
          'id', url.id,
          'normalizedUrl', url.normalized_url,
          'url', url.url,
          'category', url.category,
          'locale', url.locale,
          'currentPriorityTier', url.current_priority_tier,
          'currentIndexState', url.current_index_state,
          'currentHealthState', url.current_health_state,
          'isScaledContent', url.is_scaled_content,
          'scaledContentType', url.scaled_content_type,
          'isManuallyExcluded', url.is_manually_excluded,
          'isActive', url.is_active,
          'nextInspectionDueAt', url.next_inspection_due_at,
          'firstSeenAt', url.first_seen_at,
          'firstIndexedAt', url.first_indexed_at,
          'lastInspectedAt', url.last_inspected_at,
          'lastSeenAt', url.last_seen_at
        ),
        'sources', COALESCE(url.source_sitemaps, '[]'::jsonb),
        'prioritySnapshots', '[]'::jsonb,
        'inspections', COALESCE(inspections.rows, '[]'::jsonb),
        'transitions', '[]'::jsonb,
        'jobs', COALESCE(jobs.rows, '[]'::jsonb),
        'technicalChecks', COALESCE(checks.rows, '[]'::jsonb),
        'alerts', COALESCE(alerts.rows, '[]'::jsonb),
        'health', health.row_json,
        'propertyResolution', jsonb_build_object('selectedPropertyUrl', 'snapshot', 'candidates', '[]'::jsonb),
        'lite', true,
        'cached', true,
        'snapshot', true
      ),
      now()
    FROM dashboard_urls url
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(row_json ORDER BY inspected_at DESC NULLS LAST, id DESC) AS rows
      FROM (SELECT row_json, inspected_at, id FROM dashboard_inspection_results WHERE url_id = url.id ORDER BY inspected_at DESC NULLS LAST, id DESC LIMIT 20) limited
    ) inspections ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(row_json ORDER BY id DESC) AS rows
      FROM (SELECT row_json, id FROM dashboard_inspection_jobs WHERE url_id = url.id ORDER BY id DESC LIMIT 20) limited
    ) jobs ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(row_json ORDER BY id DESC) AS rows
      FROM (SELECT row_json, id FROM dashboard_technical_checks WHERE url_id = url.id ORDER BY id DESC LIMIT 10) limited
    ) checks ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(row_json ORDER BY id DESC) AS rows
      FROM (SELECT row_json, id FROM dashboard_alerts WHERE url_id = url.id ORDER BY id DESC LIMIT 20) limited
    ) alerts ON true
    LEFT JOIN dashboard_health_statuses health ON health.url_id = url.id
    ON CONFLICT (url_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at
  `);
}
