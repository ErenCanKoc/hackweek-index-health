import pg from 'pg';

let cachePool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!cachePool) {
    cachePool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_CACHE_POOL_MAX ?? 1),
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10000),
      idleTimeoutMillis: 10000
    });
  }
  return cachePool;
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
      is_manually_excluded BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      next_inspection_due_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      source_sitemaps JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_text TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dashboard_properties (
      id BIGINT PRIMARY KEY,
      property_url TEXT NOT NULL,
      row_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_priority
      ON dashboard_urls (current_priority_tier, id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_category
      ON dashboard_urls (category, locale, id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_urls_scaled
      ON dashboard_urls (is_scaled_content, id);
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
    await client.query('TRUNCATE dashboard_urls, dashboard_properties');
    const urlsResult = await client.query(
      `
        INSERT INTO dashboard_urls (
          id, normalized_url, url, category, locale, current_priority_tier,
          current_index_state, current_health_state, is_scaled_content,
          is_manually_excluded, is_active, next_inspection_due_at,
          first_seen_at, last_seen_at, source_sitemaps, source_text, updated_at
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
              is_manually_excluded = EXCLUDED.is_manually_excluded,
              is_active = EXCLUDED.is_active,
              next_inspection_due_at = EXCLUDED.next_inspection_due_at,
              first_seen_at = EXCLUDED.first_seen_at,
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
    await client.query('COMMIT');
    return {
      urls: urlsResult.rowCount,
      properties: propertiesResult.rowCount
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
