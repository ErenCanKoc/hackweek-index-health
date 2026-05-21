import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { nowIso } from './utils.js';

const DEFAULT_STATE = {
  meta: { createdAt: null, updatedAt: null },
  counters: {},
  urls: [],
  deletedUrls: [],
  sitemaps: [],
  properties: [],
  propertyMappings: [],
  urlSources: [],
  prioritySnapshots: [],
  inspectionJobs: [],
  inspectionResults: [],
  stateTransitions: [],
  technicalChecks: [],
  healthStatuses: [],
  alerts: [],
  gscPerformanceMetrics: [],
  businessMetrics: [],
  importBatches: [],
  configSources: null,
  sitemapFetchJobs: [],
  csvImportJobs: []
};

export class Store {
  constructor(filePath = path.join(process.cwd(), 'data/runtime/state.json')) {
    this.filePath = filePath;
    this.databaseUrl = process.env.DATABASE_URL || null;
    this.appStateKey = process.env.APP_STATE_KEY || 'default';
    this.pgPool = null;
    this.state = structuredClone(DEFAULT_STATE);
  }

  get usesPostgres() {
    return Boolean(this.databaseUrl);
  }

  getPool() {
    if (!this.pgPool) {
      this.pgPool = new pg.Pool({
        connectionString: this.databaseUrl,
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
        max: 3
      });
    }
    return this.pgPool;
  }

  async ensureAppStateTable() {
    await this.getPool().query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async load() {
    if (this.usesPostgres) {
      await this.ensureAppStateTable();
      const result = await this.getPool().query('SELECT state FROM app_state WHERE id = $1', [this.appStateKey]);
      if (result.rows[0]?.state) {
        this.state = { ...structuredClone(DEFAULT_STATE), ...result.rows[0].state };
      } else {
        const createdAt = nowIso();
        this.state = structuredClone(DEFAULT_STATE);
        this.state.meta.createdAt = createdAt;
        this.state.meta.updatedAt = createdAt;
        await this.save();
      }
      return this;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      this.state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(text) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const createdAt = nowIso();
      this.state = structuredClone(DEFAULT_STATE);
      this.state.meta.createdAt = createdAt;
      this.state.meta.updatedAt = createdAt;
      await this.save();
    }
    return this;
  }

  async reset() {
    const createdAt = nowIso();
    this.state = structuredClone(DEFAULT_STATE);
    this.state.meta.createdAt = createdAt;
    this.state.meta.updatedAt = createdAt;
    await this.save();
  }

  async save() {
    this.state.meta.updatedAt = nowIso();
    if (this.usesPostgres) {
      await this.ensureAppStateTable();
      await this.getPool().query(
        `
          INSERT INTO app_state (id, state, updated_at)
          VALUES ($1, $2::jsonb, now())
          ON CONFLICT (id)
          DO UPDATE SET state = EXCLUDED.state, updated_at = now()
        `,
        [this.appStateKey, JSON.stringify(this.state)]
      );
      return;
    }
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  nextId(tableName) {
    this.state.counters[tableName] = (this.state.counters[tableName] ?? 0) + 1;
    return this.state.counters[tableName];
  }

  insert(tableName, values) {
    const row = { id: this.nextId(tableName), ...values };
    this.state[tableName].push(row);
    return row;
  }

  findById(tableName, id) {
    return this.state[tableName].find((row) => Number(row.id) === Number(id));
  }

  update(tableName, id, values) {
    const row = this.findById(tableName, id);
    if (!row) return null;
    Object.assign(row, values, { updatedAt: values.updatedAt ?? nowIso() });
    return row;
  }

  upsert(tableName, predicate, createValues, updateValues = createValues) {
    const row = this.state[tableName].find(predicate);
    if (row) {
      Object.assign(row, updateValues, { updatedAt: updateValues.updatedAt ?? nowIso() });
      return row;
    }
    return this.insert(tableName, createValues);
  }
}

export async function loadStore(filePath) {
  const store = new Store(filePath);
  await store.load();
  return store;
}
