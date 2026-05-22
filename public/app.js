const state = {
  view: 'overview',
  scaledTab: 'adcraft',
  gscSites: [],
  openUrlId: null,
  openUrlDetail: null,
  selectedUrlIds: new Set(),
  pendingCsvImport: null,
  urlPage: 1,
  urlLimit: 150,
  urlCursorStack: [null],
  lastUrlFilterKey: ''
};

const titleMap = {
  overview: ['Overview', 'Property-aware index monitoring'],
  urls: ['URL Explorer', 'URL state, priority, source, and alert review'],
  scaled: ['Scaled Content', 'Adcraft index journey and delayed indexing'],
  quota: ['Property Quota', 'Daily and monthly URL Inspection API usage'],
  alerts: ['Alerts', 'Active and resolved index health events'],
  roadmap: ['Roadmap', 'MVP readiness and next implementation focus'],
  settings: ['Settings', 'Manual overrides and property management']
};

function splitBulkUrls(value) {
  return [...new Set(String(value ?? '')
    .split(/[\n,\r\t ]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function api(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 20000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  let response;
  try {
    response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      ...fetchOptions
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error ?? text;
    } catch {
      const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/is);
      const headingMatch = text.match(/<h1[^>]*>(.*?)<\/h1>/is);
      const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
      const heading = headingMatch?.[1]?.replace(/\s+/g, ' ').trim();
      if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
        message = [title, heading].filter(Boolean).join(' - ') || 'HTML error page returned';
      } else {
        message = text.length > 500 ? `${text.slice(0, 500)}...` : text;
      }
    }
    throw new Error(`${path}: ${message}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
    throw new Error(`${path}: expected JSON, got ${title || contentType || 'non-JSON response'}`);
  }
  return response.json();
}

function setStatus(message) {
  document.querySelector('#status-line').textContent = message;
}

function pill(value) {
  return `<span class="pill ${String(value).replaceAll(' ', '_')}">${value ?? 'unknown'}</span>`;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function urlPreviewLink(url, label = url) {
  return `<a class="url-preview-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function sitemapProgressText(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent ?? 0)));
  const completed = Number(progress.completed ?? 0);
  const total = Number(progress.total ?? 0);
  const failed = Number(progress.failed ?? 0);
  const imported = Number(progress.importedUrls ?? 0);
  const phase = String(progress.phase ?? 'fetching_sitemaps').replaceAll('_', ' ');
  const importedText = imported ? `, imported ${imported} URLs` : '';
  return `${percent}% - ${completed}/${total} ${phase}, failed ${failed}${importedText}`;
}

function renderSitemapProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent ?? 0)));
  return `
    <div class="setting-note">
      <strong>Sitemap fetch progress:</strong> ${esc(sitemapProgressText(progress))}
      <progress max="100" value="${percent}"></progress>
      ${progress.currentSitemapUrl ? `<div class="source-list"><code>${esc(progress.currentSitemapUrl)}</code></div>` : ''}
    </div>
  `;
}

function renderSitemapJobStatus(job = {}) {
  const result = job.result ?? {};
  const summary = result.fetchSummary ?? result.counts?.fetchSummary ?? {};
  const imported = result.counts?.urlCount ?? job.progress?.importedUrls ?? 0;
  return [
    pill(job.status ?? 'unknown'),
    job.triggerMode ? esc(job.triggerMode.replaceAll('_', ' ')) : '',
    summary.total ? `${summary.success ?? 0}/${summary.total} sitemaps` : '',
    imported ? `${imported} URLs` : '',
    job.error ? esc(job.error) : ''
  ].filter(Boolean).join('<br>');
}

function updateSitemapProgressUi(progress) {
  const summary = document.querySelector('#source-summary');
  if (!summary || !progress) return;
  const existing = summary.querySelector('[data-sitemap-progress]');
  if (existing) existing.remove();
  summary.insertAdjacentHTML('afterbegin', `<div data-sitemap-progress>${renderSitemapProgress(progress)}</div>`);
}

function table(headers, rows) {
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">No records</td></tr>`}</tbody>
    </table>
  `;
}

function kpis(items) {
  return items.map(([label, value, tone = '']) => `
    <div class="kpi">
      <span>${label}</span>
      <strong class="${tone}">${value}</strong>
    </div>
  `).join('');
}

function schedulerStatus(summary) {
  const errors = summary.errors?.length ? ` Errors ${summary.errors.length}: ${summary.errors.map((item) => item.error).join(' | ')}` : '';
  return `Scheduler created ${summary.createdJobs}, inspected ${summary.inspected}, skipped ${summary.skipped}, alerts ${summary.alertsCreated}.${errors}`;
}

function propertySource(property) {
  if (property.propertyUrl?.startsWith('sc-domain:')) return 'domain';
  if (property.propertyUrl?.includes('/tr/') || property.propertyUrl?.includes('/de/') || property.propertyUrl?.includes('/fr/')) return 'locale';
  if (property.propertyUrl === 'https://www.jotform.com/') return 'default';
  return 'url-prefix';
}

function updateSelectedCount() {
  const target = document.querySelector('#selected-url-count');
  if (target) target.textContent = `${state.selectedUrlIds.size} selected`;
}

function renderPagination(meta) {
  const total = Number.isFinite(meta.total) ? meta.total : null;
  const limit = meta.limit ?? state.urlLimit;
  const offset = meta.offset ?? ((state.urlPage - 1) * limit);
  const rowCount = meta.rowCount ?? meta.rows?.length ?? limit;
  const start = rowCount ? offset + 1 : 0;
  const end = total === null ? offset + rowCount : Math.min(offset + limit, total);
  const totalLabel = total === null ? 'many' : total;
  return `
    <span class="selection-count">${start}-${end} / ${totalLabel} URLs</span>
    <button id="prev-url-page" class="button secondary" ${state.urlPage <= 1 ? 'disabled' : ''}>Previous</button>
    <button id="next-url-page" class="button secondary" ${meta.hasMore ? '' : 'disabled'}>Next</button>
  `;
}

function sourceRows(settings) {
  return [
    ...(settings.sources.sitemapIndexUrls ?? []).map((url) => ({ type: 'sitemapIndexUrls', label: 'index', url })),
    ...(settings.sources.childSitemapUrls ?? []).map((url) => ({ type: 'childSitemapUrls', label: 'child', url }))
  ];
}

function sourceSitemapCell(url) {
  const sitemapSources = (url.sources ?? [])
    .map((source) => source.sourceSitemapUrl || source.sourceIdentifier)
    .filter(Boolean);
  if (!sitemapSources.length) return '<span class="muted">manual / unknown</span>';
  return [...new Set(sitemapSources)]
    .map((source) => `<code class="source-code">${esc(source)}</code>`)
    .join('');
}

function statusCards(detail, latest) {
  const inspectedDays = [...new Set(detail.inspections.map((item) => item.inspectionDate || String(item.inspectedAt ?? '').slice(0, 10)))];
  const cards = [
    ['Current Status', detail.health?.currentHealthStatus ?? detail.url.currentHealthState ?? '-'],
    ['Severity', detail.health?.currentSeverity ?? '-'],
    ['Coverage', detail.health?.currentCoverageState ?? latest?.coverageState ?? '-'],
    ['Last Inspected', fmtDate(detail.url.lastInspectedAt ?? latest?.inspectedAt)],
    ['Last Crawl', fmtDate(latest?.lastCrawlTime)],
    ['Inspected Days', inspectedDays.length]
  ];
  return cards.map(([label, value]) => `
    <div class="status-card">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `).join('');
}

async function deleteUrlIds(ids) {
  if (!ids.length) {
    setStatus('Select at least one URL to delete.');
    return;
  }
  const ok = window.confirm(`Delete ${ids.length} URL(s) and their history from the dashboard?`);
  if (!ok) return;
  setStatus('Deleting selected URLs...');
  const result = await api('/api/settings/delete-urls', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
  ids.forEach((id) => state.selectedUrlIds.delete(Number(id)));
  state.openUrlId = null;
  state.openUrlDetail = null;
  await refresh();
  setStatus(`Deleted ${result.deleted} URL(s). Matched ${result.matched}.`);
}

function inferMapping(siteUrl) {
  if (siteUrl.startsWith('sc-domain:')) {
    return { category: 'fallback', locale: '', pathPrefix: '', priorityOrder: 1 };
  }

  let pathname = '/';
  try {
    pathname = new URL(siteUrl).pathname || '/';
  } catch {
    return { category: 'pages', locale: '', pathPrefix: '/', priorityOrder: 10 };
  }

  if (/^\/[a-z]{2}\/$/i.test(pathname)) {
    return { category: 'locale', locale: pathname.slice(1, 3), pathPrefix: pathname, priorityOrder: 100 };
  }
  if (pathname === '/') return { category: 'default_www', locale: 'en', pathPrefix: '/', priorityOrder: 10 };
  if (pathname.startsWith('/blog/')) return { category: 'blog', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/help/')) return { category: 'help', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/form-templates/')) return { category: 'form-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/app-templates/')) return { category: 'app-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/workflow-templates/')) return { category: 'workflow-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/table-templates/')) return { category: 'table-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/pdf-templates/')) return { category: 'pdf-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/agent-templates/')) return { category: 'agent-templates', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/presentation-agent/')) return { category: 'presentation-agent', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/qr-codes/')) return { category: 'qr-codes', locale: '', pathPrefix: pathname, priorityOrder: 95 };
  if (pathname.startsWith('/integrations/')) return { category: 'pages/integrations', locale: '', pathPrefix: pathname, priorityOrder: 10 };
  if (pathname.startsWith('/workflows/')) return { category: 'pages/workflows-features', locale: '', pathPrefix: pathname, priorityOrder: 10 };
  return { category: 'pages', locale: '', pathPrefix: pathname, priorityOrder: 10 };
}

function categoryOptions(selected) {
  const values = [
    'default_www',
    'fallback',
    'locale',
    'pages',
    'pages/integrations',
    'pages/workflows-features',
    'blog',
    'help',
    'form-templates',
    'app-templates',
    'workflow-templates',
    'table-templates',
    'pdf-templates',
    'agent-templates',
    'presentation-agent',
    'qr-codes'
  ];
  return values.map((value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
}

function tierOptions(selected) {
  return ['P0', 'P1', 'P2', 'P3', 'Excluded']
    .map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`)
    .join('');
}

async function loadOverview() {
  const data = await api('/api/overview');
  document.querySelector('#kpi-grid').innerHTML = kpis([
    ['Inspected Today', data.inspectedToday],
    ['Quota Used Today', data.quotaUsedToday],
    ['Monthly Coverage', `${data.monthlyCoveragePercent}%`],
    ['Index Rate', `${data.indexRate}%`],
    ['Index Loss Count', data.indexLossCount],
    ['Scaled Index Rate', `${data.scaledContentIndexRate}%`],
    ['P0 Index Rate', `${data.p0IndexRate}%`],
    ['Open Critical Alerts', data.openCriticalAlerts]
  ]);

  document.querySelector('#category-health').innerHTML = data.categoryHealth.map((row) => {
    const rate = row.total ? Math.round((row.indexed / row.total) * 100) : 0;
    return `
      <div class="bar-row">
        <span>${row.category}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${rate}%"></div></div>
        <strong>${rate}%</strong>
      </div>
    `;
  }).join('');

  document.querySelector('#recent-jobs').innerHTML = '<div class="empty-state">Loading queue...</div>';
  document.querySelector('#queue-diagnostics').innerHTML = '';
  document.querySelector('#queue-problem-jobs').innerHTML = '<div class="empty-state">Loading diagnostics...</div>';
  loadOverviewQueue().catch((error) => {
    document.querySelector('#recent-jobs').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    document.querySelector('#queue-problem-jobs').innerHTML = '';
  });
}

async function loadOverviewQueue() {
  const [jobs, diagnostics] = await Promise.all([api('/api/jobs'), api('/api/job-diagnostics')]);

  document.querySelector('#recent-jobs').innerHTML = table(
    ['URL', 'Tier', 'Reason', 'Status', 'Last Error', 'Updated'],
    jobs.slice(0, 8).map((job) => `
      <tr>
        <td><code>${job.normalizedUrl}</code></td>
        <td>${pill(job.priorityTier)}</td>
        <td>${job.reason}</td>
        <td>${pill(job.status)}</td>
        <td>${esc(job.lastError ?? '-')}</td>
        <td>${fmtDate(job.updatedAt)}</td>
      </tr>
    `)
  );

  document.querySelector('#queue-diagnostics').innerHTML = [
    ['Total Jobs', diagnostics.summary.total],
    ['Due Pending', diagnostics.summary.duePending],
    ['Running', diagnostics.summary.running],
    ['Failed', diagnostics.summary.failed],
    ['Skipped', diagnostics.summary.skipped],
    ['Completed', diagnostics.summary.completed]
  ].map(([label, value]) => `
    <div class="diagnostic-tile">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');

  const errorRows = diagnostics.byError.slice(0, 4).map((item) => `
    <tr>
      <td>${esc(item.name)}</td>
      <td>${item.count}</td>
    </tr>
  `);

  const problemRows = diagnostics.recentProblemJobs.slice(0, 8).map((job) => `
    <tr>
      <td><code>${esc(job.normalizedUrl)}</code></td>
      <td>${pill(job.status)}</td>
      <td>${esc(job.reason)}</td>
      <td>${esc(job.lastError ?? '-')}</td>
      <td><code>${esc(job.property?.propertyUrl ?? '-')}</code></td>
      <td>${fmtDate(job.updatedAt)}</td>
    </tr>
  `);

  document.querySelector('#queue-problem-jobs').innerHTML = `
    <div class="diagnostics-split">
      <div>
        ${table(['Top Error', 'Count'], errorRows)}
      </div>
      <div>
        ${table(['URL', 'Status', 'Reason', 'Last Error', 'Property', 'Updated'], problemRows)}
      </div>
    </div>
  `;
}

async function loadUrls() {
  const params = new URLSearchParams();
  const q = document.querySelector('#url-search').value;
  const tier = document.querySelector('#tier-filter').value;
  const scaled = document.querySelector('#scaled-filter').value;
  if (q) params.set('q', q);
  if (tier) params.set('priorityTier', tier);
  if (scaled) params.set('scaled', scaled);
  const filterKey = params.toString();
  if (filterKey !== state.lastUrlFilterKey) {
    state.urlPage = 1;
    state.urlCursorStack = [null];
    state.lastUrlFilterKey = filterKey;
  }
  const exportParams = new URLSearchParams(params);
  document.querySelector('#export-filtered-urls').href = `/api/report.csv${exportParams.toString() ? `?${exportParams}` : ''}`;
  params.set('limit', state.urlLimit);
  params.set('includeTotal', 'false');
  const afterId = state.urlCursorStack[state.urlPage - 1];
  if (afterId) params.set('afterId', afterId);
  const result = await api(`/api/urls?${params}`);
  const urls = result.rows ?? result;
  const meta = result.rows ? result : {
    total: urls.length,
    limit: urls.length,
    offset: 0,
    hasMore: false
  };
  if (state.openUrlId && !state.openUrlDetail) {
    state.openUrlDetail = await api(`/api/urls/${state.openUrlId}`);
  }
  document.querySelector('#url-pagination').innerHTML = renderPagination(meta);
  document.querySelector('#url-table').innerHTML = table(
    ['<label class="select-all-control"><input id="select-all-urls" type="checkbox"> All</label>', 'URL', 'Tier', 'State', 'Health', 'Category', 'Locale', 'Scaled', 'Next Due', 'Actions'],
    urls.flatMap((url) => [`
      <tr>
        <td><input type="checkbox" data-select-url="${url.id}" ${state.selectedUrlIds.has(Number(url.id)) ? 'checked' : ''}></td>
        <td><code>${urlPreviewLink(url.normalizedUrl)}</code></td>
        <td><select class="inline-select" data-url-field="priorityTier" data-url-id="${url.id}">${tierOptions(url.currentPriorityTier)}</select></td>
        <td>${url.currentIndexState}</td>
        <td>${pill(url.health?.currentSeverity ?? url.currentHealthState)}</td>
        <td><select class="inline-select wide" data-url-field="category" data-url-id="${url.id}">${categoryOptions(url.category)}</select></td>
        <td><input class="inline-input tiny" type="text" value="${esc(url.locale ?? '')}" data-url-field="locale" data-url-id="${url.id}" placeholder="-"></td>
        <td>
          <select class="inline-select tiny" data-url-field="isScaledContent" data-url-id="${url.id}">
            <option value="false" ${url.isScaledContent ? '' : 'selected'}>no</option>
            <option value="true" ${url.isScaledContent ? 'selected' : ''}>yes</option>
          </select>
        </td>
        <td>${fmtDate(url.nextInspectionDueAt)}</td>
        <td>
          <div class="row-actions">
            <a class="small-button" href="${esc(url.normalizedUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
            <button class="small-button" data-detail="${url.id}">${Number(state.openUrlId) === Number(url.id) ? 'Close' : 'Details'}</button>
            <button class="small-button" data-inspect-now="${url.id}">Inspect</button>
            <button class="small-button" data-exclude="${url.id}">${url.isManuallyExcluded ? 'Include' : 'Exclude'}</button>
          </div>
        </td>
      </tr>
    `, Number(state.openUrlId) === Number(url.id) && state.openUrlDetail ? detailRow(state.openUrlDetail) : ''])
  );
  const visibleUrlIds = urls.map((url) => Number(url.id));
  const selectAllUrls = document.querySelector('#select-all-urls');
  if (selectAllUrls && visibleUrlIds.length) {
    selectAllUrls.checked = visibleUrlIds.every((id) => state.selectedUrlIds.has(id));
  }
  updateSelectedCount();
}

function detailRow(detail) {
  const latest = detail.inspections[0];
  const latestProperty = latest?.property?.propertyUrl ?? latest?.propertyId ?? '-';
  return `
    <tr class="accordion-row">
      <td colspan="10">
        <div class="detail-drawer inline-detail">
          <div class="detail-head">
            <div>
              <h2>${urlPreviewLink(detail.url.normalizedUrl)}</h2>
              <p>${detail.url.category} · ${detail.url.locale ?? 'default'} · ${detail.url.currentIndexState}</p>
            </div>
            <div class="detail-head-status">
              ${pill(detail.health?.currentSeverity ?? detail.url.currentHealthState ?? 'unknown')}
            </div>
          </div>
          <div class="status-grid">
            ${statusCards(detail, latest)}
          </div>
          <div class="detail-body">
            <section class="detail-section">
              <h2>Inspection Log</h2>
              ${table(['Date', 'Coverage', 'Verdict', 'Crawl', 'Property', 'JSON'], detail.inspections.map((item, index) => `
                <tr>
                  <td>${fmtDate(item.inspectedAt)}</td>
                  <td>${esc(item.coverageState ?? '-')}</td>
                  <td>${esc(item.verdict ?? '-')}</td>
                  <td>${fmtDate(item.lastCrawlTime)}</td>
                  <td><code>${esc(item.property?.propertyUrl ?? item.propertyId ?? '-')}</code></td>
                  <td>
                    <details class="inline-json">
                      <summary>View</summary>
                      <pre>${JSON.stringify(item.rawJson ?? {}, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              `))}
              <details open>
                <summary>Latest Raw JSON · ${esc(latestProperty)}</summary>
                <pre>${latest ? JSON.stringify(latest.rawJson ?? {}, null, 2) : 'No inspection result yet. Run Scheduler or Force GSC Test first.'}</pre>
              </details>
            </section>
            <section class="detail-section">
              <h2>Status, Diagnosis and Alerts</h2>
              ${table(['Field', 'Value'], [
                ['Index State', detail.url.currentIndexState],
                ['Health Status', detail.health?.currentHealthStatus ?? detail.url.currentHealthState ?? '-'],
                ['Severity', detail.health?.currentSeverity ?? '-'],
                ['Selected Property', detail.propertyResolution?.selectedPropertyUrl ?? '-'],
                ['Google Canonical', latest?.googleCanonical ?? '-'],
                ['User Canonical', latest?.userCanonical ?? '-'],
                ['Page Fetch', latest?.pageFetchState ?? '-'],
                ['Robots', latest?.robotsTxtState ?? '-'],
                ['Submitted', latest?.isSubmittedAndIndexed ? 'yes' : 'no']
              ].map(([label, value]) => `
                <tr>
                  <td>${esc(label)}</td>
                  <td><code>${esc(value)}</code></td>
                </tr>
              `))}
              <h2>Property Resolver</h2>
              ${table(['Property', 'Reason', 'Quota Left', 'Eligible'], (detail.propertyResolution?.candidates ?? []).map((candidate) => `
                <tr>
                  <td><code>${esc(candidate.property?.propertyUrl ?? '-')}</code></td>
                  <td>${esc(candidate.reason)}</td>
                  <td>${candidate.quotaRemaining}</td>
                  <td>${candidate.eligible ? 'yes' : 'no'}</td>
                </tr>
              `))}
              <h2>Scheduler Jobs</h2>
              ${table(['Status', 'Reason', 'Due', 'Attempts', 'Property', 'Error'], (detail.jobs ?? []).map((job) => `
                <tr>
                  <td>${pill(job.status)}</td>
                  <td>${esc(job.reason)}</td>
                  <td>${fmtDate(job.dueAt)}</td>
                  <td>${job.attemptCount ?? 0}</td>
                  <td><code>${esc(job.property?.propertyUrl ?? job.propertyId ?? '-')}</code></td>
                  <td>${esc(job.lastError ?? '-')}</td>
                </tr>
              `))}
              ${table(['Type', 'Severity', 'Status', 'Action'], detail.alerts.map((alert) => `
                <tr>
                  <td>${alert.alertType}</td>
                  <td>${pill(alert.severity)}</td>
                  <td>${alert.status}</td>
                  <td>${alert.recommendedAction ?? '-'}</td>
                </tr>
              `))}
              <details open>
                <summary>Technical diagnosis</summary>
                <pre>${JSON.stringify(detail.technicalChecks[0] ?? {}, null, 2)}</pre>
              </details>
            </section>
          </div>
        </div>
      </td>
    </tr>
  `;
}

async function openDetail(id) {
  if (Number(state.openUrlId) === Number(id)) {
    state.openUrlId = null;
    state.openUrlDetail = null;
  } else {
    state.openUrlId = Number(id);
    state.openUrlDetail = await api(`/api/urls/${id}`);
  }
  await loadUrls();
}

async function loadScaled() {
  const data = await api('/api/scaled');
  document.querySelector('#scaled-kpis').innerHTML = kpis([
    ['New Today', data.kpis.newScaledUrlsToday],
    ['First Inspected 24h', `${data.kpis.firstInspectedWithin24hPercent}%`],
    ['Indexed 1 Day', `${data.kpis.indexedWithin1DayPercent}%`],
    ['Indexed 3 Days', `${data.kpis.indexedWithin3DaysPercent}%`],
    ['Avg Days', data.kpis.averageDaysToIndex],
    ['Median Days', data.kpis.medianDaysToIndex],
    ['P90 Days', data.kpis.p90DaysToIndex],
    ['Delayed', data.kpis.delayedIndexCount],
    ['Delayed 3d', data.kpis.delayed3DaysCount],
    ['Delayed 7d', data.kpis.delayed7DaysCount],
    ['Index Loss', data.kpis.indexLossCount],
    ['Stable Indexed', data.kpis.stableIndexedCount]
  ]);
  const rows = data.tabs[state.scaledTab] ?? [];
  document.querySelector('#scaled-table').innerHTML = table(
    ['URL', 'Tier', 'State', 'First Seen', 'First Indexed', 'Next Due'],
    rows.map((url) => `
      <tr>
        <td><code>${url.normalizedUrl ?? url.message}</code></td>
        <td>${pill(url.currentPriorityTier ?? url.severity)}</td>
        <td>${url.currentIndexState ?? url.status}</td>
        <td>${fmtDate(url.firstSeenAt ?? url.createdAt)}</td>
        <td>${fmtDate(url.firstIndexedAt ?? url.resolvedAt)}</td>
        <td>${fmtDate(url.nextInspectionDueAt ?? url.updatedAt)}</td>
      </tr>
    `)
  );
}

async function loadQuota(options = {}) {
  const properties = await api('/api/properties', { timeoutMs: options.target === 'settings' ? 6000 : 20000 });
  const markup = table(
    ['Property', 'Active', 'Type', 'Source', 'Daily Used', 'Daily Remaining', 'Monthly Used', 'Fallback', 'Auth', 'Last Success'],
    properties.map((property) => `
      <tr>
        <td><code>${property.propertyUrl}</code></td>
        <td>
          <select class="inline-select tiny" data-property-field="isActive" data-property-id="${property.id}">
            <option value="true" ${property.isActive ? 'selected' : ''}>yes</option>
            <option value="false" ${property.isActive ? '' : 'selected'}>no</option>
          </select>
        </td>
        <td>${property.propertyType}</td>
        <td>${propertySource(property)}</td>
        <td>${property.dailyQuotaUsed}</td>
        <td>${property.dailyQuotaLimit - property.dailyQuotaUsed}</td>
        <td>${property.monthlyQuotaUsed}</td>
        <td>
          <select class="inline-select" data-property-field="fallbackEnabled" data-property-id="${property.id}">
            <option value="true" ${property.fallbackEnabled ? 'selected' : ''}>enabled</option>
            <option value="false" ${property.fallbackEnabled ? '' : 'selected'}>disabled</option>
          </select>
        </td>
        <td>
          <select class="inline-select" data-property-field="authStatus" data-property-id="${property.id}">
            <option value="ok" ${property.authStatus === 'ok' ? 'selected' : ''}>ok</option>
            <option value="needs_auth" ${property.authStatus === 'needs_auth' ? 'selected' : ''}>needs_auth</option>
            <option value="disabled" ${property.authStatus === 'disabled' ? 'selected' : ''}>disabled</option>
          </select>
        </td>
        <td>${fmtDate(property.lastSuccessfulInspectionAt)}</td>
      </tr>
    `)
  );
  const quotaTable = document.querySelector('#property-table');
  const managementTable = document.querySelector('#property-management');
  if (quotaTable && options.target !== 'settings') quotaTable.innerHTML = markup;
  if (managementTable) managementTable.innerHTML = markup;
}

async function loadAlerts() {
  const alerts = await api('/api/alerts');
  document.querySelector('#alerts-table').innerHTML = table(
    ['Type', 'Severity', 'Status', 'URL', 'Current', 'Created', 'Recommendation', 'Actions'],
    alerts.map((alert) => `
      <tr>
        <td>${alert.alertType}</td>
        <td>${pill(alert.severity)}</td>
        <td>${alert.status}</td>
        <td>${alert.urlId}</td>
        <td>${alert.currentState ?? '-'}</td>
        <td>${fmtDate(alert.createdAt)}</td>
        <td>${alert.recommendedAction ?? '-'}</td>
        <td>
          <div class="row-actions">
            ${alert.status === 'active' ? `<button class="small-button" data-alert-action="acknowledge" data-alert-id="${alert.id}">Ack</button>` : ''}
            ${alert.status !== 'resolved' ? `<button class="small-button" data-alert-action="resolve" data-alert-id="${alert.id}">Resolve</button>` : ''}
            ${alert.status !== 'active' ? `<button class="small-button" data-alert-action="reopen" data-alert-id="${alert.id}">Reopen</button>` : ''}
          </div>
        </td>
      </tr>
    `)
  );
}

async function loadRoadmap() {
  const data = await api('/api/roadmap');
  document.querySelector('#roadmap-kpis').innerHTML = kpis([
    ['Done', data.summary.done, 'healthy'],
    ['Partial', data.summary.partial, 'warning'],
    ['Todo', data.summary.todo, 'critical'],
    ['Total Checks', data.summary.total]
  ]);

  document.querySelector('#roadmap-focus').innerHTML = data.nextFocus.length
    ? data.nextFocus.map((item) => `
      <article class="roadmap-card">
        ${pill(item.status)}
        <strong>${esc(item.title)}</strong>
        <span>${esc(item.metric)}</span>
        <p>${esc(item.nextAction)}</p>
      </article>
    `).join('')
    : '<div class="empty-state">MVP checklist is green. Time to polish the demo story.</div>';

  document.querySelector('#roadmap-table').innerHTML = table(
    ['Area', 'Status', 'Check', 'Metric', 'Next Action'],
    data.items.map((item) => `
      <tr>
        <td>${esc(item.area)}</td>
        <td>${pill(item.status)}</td>
        <td>${esc(item.title)}</td>
        <td>${esc(item.metric)}</td>
        <td>${esc(item.nextAction)}</td>
      </tr>
    `)
  );
}

async function loadSettings() {
  const manualSearch = document.querySelector('#manual-overrides-search')?.value?.trim() ?? '';
  const manualParams = new URLSearchParams({ limit: '200' });
  if (manualSearch) manualParams.set('q', manualSearch);
  const [settings, sitemaps] = await Promise.all([api('/api/settings'), api('/api/sitemaps')]);
  let urlData = { rows: [] };
  let manualUrlError = null;
  try {
    urlData = await api(`/api/urls?${manualParams}`);
  } catch (error) {
    manualUrlError = error;
  }
  const urls = urlData.rows ?? urlData;
  const auth = settings.googleAuth;
  const manualCategory = document.querySelector('#manual-category');
  if (manualCategory && !manualCategory.innerHTML) manualCategory.innerHTML = categoryOptions('pages');
  document.querySelector('#google-connect-title').textContent = auth.connected
    ? 'Google account connected'
    : 'Connect your Google account';

  document.querySelector('#google-auth-status').innerHTML = auth.connected
    ? `Connected as <strong>${esc(auth.email ?? 'Google account')}</strong>.`
    : auth.hasClient
      ? `Choose the Google account that has access to your Search Console properties.${auth.clientSource === 'env' ? ' OAuth is configured for this deployment.' : ''}`
      : 'Add OAuth setup once, then this button opens the Google account chooser.';
  document.querySelector('#google-advanced-setup').open = !auth.hasClient && auth.clientSource !== 'env';
  document.querySelector('#google-advanced-setup').style.display = auth.clientSource === 'env' ? 'none' : 'block';
  document.querySelector('#disconnect-google').style.display = auth.connected ? 'inline-flex' : 'none';
  document.querySelector('#connect-google').innerHTML = `
    <span class="google-g">G</span>
    <span>${auth.connected ? 'Reconnect Google' : 'Continue with Google'}</span>
  `;
  document.querySelector('#google-redirect-uri').value = auth.redirectUri ?? settings.oauthRedirectUri;
  document.querySelector('#inspection-provider').value = settings.inspection.provider ?? 'mock';
  document.querySelector('#inspection-language').value = settings.inspection.languageCode ?? 'en-US';
  document.querySelector('#fetch-child-sitemaps').checked = Boolean(settings.sources.fetchChildSitemaps);
  document.querySelector('#ai-classification-status').innerHTML = settings.openAI?.hasKey
    ? `OpenAI classifier ready. Model: <code>${esc(settings.openAI.model)}</code>`
    : 'OpenAI classifier is disabled. Add OPENAI_API_KEY to enable AI category/priority suggestions.';
  document.querySelector('#import-history').innerHTML = table(
    ['Import', 'Type', 'Rows', 'New URLs', 'Status', 'Created', 'Action'],
    (settings.importBatches ?? []).map((batch) => `
      <tr>
        <td>#${batch.id}</td>
        <td>${esc(batch.importType)}</td>
        <td>${batch.importedRows}</td>
        <td>${batch.urlsAdded}</td>
        <td>${pill(batch.status)}</td>
        <td>${fmtDate(batch.createdAt)}</td>
        <td>
          <button class="small-button" data-rollback-import="${batch.id}" ${batch.status === 'rolled_back' ? 'disabled' : ''}>Rollback</button>
        </td>
      </tr>
    `)
  );
  const csvImportJobs = settings.csvImportJobs ?? [];
  if (csvImportJobs.length) {
    document.querySelector('#import-history').innerHTML += table(
      ['Job', 'Type', 'Status', 'Progress', 'Started', 'Finished'],
      csvImportJobs.map((job) => `
        <tr>
          <td>#${job.id}</td>
          <td>${esc(job.options?.importType ?? '-')}</td>
          <td>${pill(job.status)}</td>
          <td>${esc(job.progress?.phase ?? 'queued')} ${job.progress?.percent ?? 0}%</td>
          <td>${fmtDate(job.startedAt ?? job.createdAt)}</td>
          <td>${fmtDate(job.finishedAt)}</td>
        </tr>
      `)
    );
  }
  document.querySelector('#source-summary').innerHTML = `
    ${settings.sitemapFetch?.running || settings.sitemapFetch?.lastResult ? renderSitemapProgress(settings.sitemapFetch.progress ?? settings.sitemapFetch.lastResult?.progress ?? {}) : ''}
    <strong>How this works:</strong> Fetching now runs as a durable job. On Render, set <code>RENDER_API_KEY</code> and <code>RENDER_SERVICE_ID</code> to run it as a one-off job; otherwise it uses the same job table with a local fallback.<br>
    <strong>Daily cron:</strong> ${settings.cron?.dailySitemapFetchEnabled ? 'enabled' : 'disabled'}${settings.cron?.lastRunAt ? `, last run ${fmtDate(settings.cron.lastRunAt)}` : ''}${settings.cron?.lastError ? `, last error: ${esc(settings.cron.lastError)}` : ''}<br>
    <strong>Sitemap indexes:</strong> ${(settings.sources.sitemapIndexUrls ?? []).length}<br>
    <div class="source-list">${(settings.sources.sitemapIndexUrls ?? []).map((url) => `<code>${esc(url)}</code>`).join('') || 'none'}</div>
    <strong>Child sitemaps:</strong> ${(settings.sources.childSitemapUrls ?? []).length}<br>
    <div class="source-list">${(settings.sources.childSitemapUrls ?? []).map((url) => `<code>${esc(url)}</code>`).join('') || 'none'}</div>
    <strong>Manual URL files:</strong> ${(settings.sources.manualUrlFiles ?? []).map(esc).join(', ') || 'none'}
  `;
  document.querySelector('#sitemap-fetch-jobs').innerHTML = table(
    ['Job', 'Status', 'Progress', 'Started', 'Finished'],
    (settings.sitemapFetchJobs ?? []).map((job) => `
      <tr>
        <td>#${job.id}</td>
        <td>${renderSitemapJobStatus(job)}</td>
        <td>${esc(sitemapProgressText(job.progress ?? {}))}</td>
        <td>${fmtDate(job.startedAt ?? job.createdAt)}</td>
        <td>${fmtDate(job.finishedAt)}</td>
      </tr>
    `)
  );
  document.querySelector('#source-management').innerHTML = table(
    ['<label class="select-all-control"><input id="select-all-sources" type="checkbox"> All</label>', 'Type', 'Source URL'],
    sourceRows(settings).map((source) => `
      <tr>
        <td><input type="checkbox" data-source-type="${source.type}" data-source-url="${esc(source.url)}"></td>
        <td>${esc(source.label)}</td>
        <td><code>${esc(source.url)}</code></td>
      </tr>
    `)
  );
  document.querySelector('#sitemap-fetch-log').innerHTML = table(
    ['<label class="select-all-control"><input id="select-all-fetched-sitemaps" type="checkbox"> All</label>', 'Sitemap', 'Status', 'URLs', 'Skipped', 'Category', 'Locale', 'Scaled', 'Last Success', 'Error'],
    sitemaps.map((sitemap) => `
      <tr>
        <td><input type="checkbox" data-fetched-sitemap-url="${esc(sitemap.sitemapUrl)}"></td>
        <td><code>${esc(sitemap.sitemapUrl)}</code></td>
        <td>${pill(sitemap.health)}</td>
        <td>${sitemap.urlCount}</td>
        <td>${sitemap.skippedSitemapLocCount}</td>
        <td>${esc(sitemap.detectedCategory)}</td>
        <td>${esc(sitemap.detectedLocale ?? '-')}</td>
        <td>${sitemap.isScaledContent ? esc(sitemap.scaledContentType ?? 'yes') : 'no'}</td>
        <td>${fmtDate(sitemap.lastSuccessfulFetchAt)}</td>
        <td>${esc(sitemap.error ?? '-')}</td>
      </tr>
    `)
  );

  if (auth.connected) {
    try {
      const siteData = await api('/api/settings/gsc-sites');
      state.gscSites = siteData.sites;
      document.querySelector('#gsc-sites').innerHTML = table(
        ['Select', 'GSC Property', 'Permission', 'Category', 'Locale', 'Path Prefix'],
        siteData.sites.map((site, index) => {
          const inferred = inferMapping(site.siteUrl);
          return `
          <tr>
            <td><input type="checkbox" data-gsc-select="${index}"></td>
            <td><code>${esc(site.siteUrl)}</code></td>
            <td>${esc(site.permissionLevel)}</td>
            <td>
              <select data-gsc-category="${index}">
                ${categoryOptions(inferred.category)}
              </select>
            </td>
            <td><input type="text" value="${esc(inferred.locale)}" data-gsc-locale="${index}" placeholder="en"></td>
            <td><input type="text" value="${esc(inferred.pathPrefix)}" data-gsc-path="${index}" placeholder="/"></td>
          </tr>
        `;
        })
      );
    } catch (error) {
      state.gscSites = [];
      document.querySelector('#gsc-sites').innerHTML = `<div class="settings-panel">${esc(error.message)}</div>`;
    }
  } else {
    state.gscSites = [];
    document.querySelector('#gsc-sites').innerHTML = '';
  }

  const manualSearchLower = manualSearch.toLowerCase();
  const manualRows = urls.filter((url) => {
    const sourceText = (url.sources ?? [])
      .map((source) => source.sourceSitemapUrl || source.sourceIdentifier)
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return !manualSearchLower || url.normalizedUrl.toLowerCase().includes(manualSearchLower) || sourceText.includes(manualSearchLower);
  });
  document.querySelector('#manual-overrides').innerHTML = manualUrlError
    ? `<div class="empty-state">Manual override URL preview skipped: ${esc(manualUrlError.message)}</div>`
    : table(
    ['URL', 'Source Sitemap', 'Tier', 'Active', 'Manual', 'Action'],
    manualRows.map((url) => `
      <tr>
        <td><code>${urlPreviewLink(url.normalizedUrl)}</code></td>
        <td>${sourceSitemapCell(url)}</td>
        <td>${pill(url.currentPriorityTier)}</td>
        <td>${url.isActive ? 'yes' : 'no'}</td>
        <td>${url.isManuallyExcluded ? 'excluded' : '-'}</td>
        <td><button class="small-button" data-exclude="${url.id}">${url.isManuallyExcluded ? 'Include' : 'Exclude'}</button></td>
      </tr>
    `)
  );
  document.querySelector('#property-management').innerHTML = '<div class="empty-state">Property data loads separately.</div>';
  loadQuota({ target: 'settings' }).catch((error) => {
    document.querySelector('#property-management').innerHTML = `<div class="empty-state">Property data skipped: ${esc(error.message)}</div>`;
  });
}

async function refresh() {
  setStatus('Refreshing...');
  try {
    if (state.view === 'overview') await loadOverview();
    if (state.view === 'urls') await loadUrls();
    if (state.view === 'scaled') await loadScaled();
    if (state.view === 'quota') await loadQuota();
    if (state.view === 'alerts') await loadAlerts();
    if (state.view === 'roadmap') await loadRoadmap();
    if (state.view === 'settings') await loadSettings();
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`);
  }
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`));
  document.querySelector('#view-title').textContent = titleMap[view][0];
  document.querySelector('#view-subtitle').textContent = titleMap[view][1];
  refresh().catch((error) => setStatus(error.message));
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    event.preventDefault();
    setView(nav.dataset.view);
    return;
  }

  const tab = event.target.closest('[data-scaled-tab]');
  if (tab) {
    event.preventDefault();
    state.scaledTab = tab.dataset.scaledTab;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    await loadScaled();
    return;
  }

  const detail = event.target.closest('[data-detail]');
  if (detail) {
    event.preventDefault();
    await openDetail(detail.dataset.detail);
    return;
  }

  if (event.target.closest('#prev-url-page')) {
    event.preventDefault();
    if (event.target.closest('#prev-url-page').disabled) return;
    setStatus('Loading previous page...');
    state.urlPage = Math.max(1, state.urlPage - 1);
    state.openUrlId = null;
    state.openUrlDetail = null;
    await loadUrls();
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    return;
  }

  if (event.target.closest('#next-url-page')) {
    event.preventDefault();
    if (event.target.closest('#next-url-page').disabled) return;
    setStatus('Loading next page...');
    state.urlPage += 1;
    const rows = [...document.querySelectorAll('[data-select-url]')];
    const lastVisibleId = rows.map((row) => Number(row.dataset.selectUrl)).filter(Boolean).at(-1);
    if (lastVisibleId) state.urlCursorStack[state.urlPage - 1] = lastVisibleId;
    state.openUrlId = null;
    state.openUrlDetail = null;
    await loadUrls();
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    return;
  }

  const inspectNow = event.target.closest('[data-inspect-now]');
  if (inspectNow) {
    event.preventDefault();
    const id = Number(inspectNow.dataset.inspectNow);
    setStatus('Inspecting selected URL...');
    const result = await api('/api/actions/run-scheduler', {
      method: 'POST',
      body: JSON.stringify({ limit: 1, force: true, urlId: id })
    });
    state.openUrlId = id;
    state.openUrlDetail = await api(`/api/urls/${id}`);
    await refresh();
    setStatus(schedulerStatus(result.summary));
    return;
  }

  const exclude = event.target.closest('[data-exclude]');
  if (exclude) {
    event.preventDefault();
    const row = await api(`/api/urls/${exclude.dataset.exclude}`);
    const action = row.url.isManuallyExcluded ? 'include' : 'exclude';
    await api(`/api/urls/${exclude.dataset.exclude}/${action}`, { method: 'POST', body: '{}' });
    await refresh();
    return;
  }

  const rollbackImport = event.target.closest('[data-rollback-import]');
  if (rollbackImport) {
    event.preventDefault();
    const ok = window.confirm(`Rollback import #${rollbackImport.dataset.rollbackImport}? URLs created only by this import will be deleted and previous metric values will be restored when available.`);
    if (!ok) return;
    setStatus('Rolling back import...');
    const result = await api(`/api/settings/imports/${rollbackImport.dataset.rollbackImport}/rollback`, {
      method: 'POST',
      body: '{}'
    });
    await refresh();
    setStatus(`Rolled back import #${result.batch.id}. Deleted ${result.deletedUrls} URL(s), restored ${result.restoredMetrics} metric(s).`);
    return;
  }

  const alertAction = event.target.closest('[data-alert-action]');
  if (alertAction) {
    event.preventDefault();
    const action = alertAction.dataset.alertAction;
    setStatus(`Updating alert ${alertAction.dataset.alertId}...`);
    await api(`/api/alerts/${alertAction.dataset.alertId}/${action}`, {
      method: 'POST',
      body: '{}'
    });
    await refresh();
    setStatus(`Alert ${action} complete.`);
    return;
  }

  const selectedUrl = event.target.closest('[data-select-url]');
  if (selectedUrl) {
    const id = Number(selectedUrl.dataset.selectUrl);
    if (selectedUrl.checked) state.selectedUrlIds.add(id);
    else state.selectedUrlIds.delete(id);
    updateSelectedCount();
    return;
  }

});

document.addEventListener('change', async (event) => {
  if (event.target.matches('#select-all-urls')) {
    document.querySelectorAll('[data-select-url]').forEach((item) => {
      const id = Number(item.dataset.selectUrl);
      item.checked = event.target.checked;
      if (event.target.checked) state.selectedUrlIds.add(id);
      else state.selectedUrlIds.delete(id);
    });
    updateSelectedCount();
    return;
  }

  if (event.target.matches('#select-all-sources')) {
    document.querySelectorAll('[data-source-url]').forEach((item) => {
      item.checked = event.target.checked;
    });
    return;
  }

  if (event.target.matches('#select-all-fetched-sitemaps')) {
    document.querySelectorAll('[data-fetched-sitemap-url]').forEach((item) => {
      item.checked = event.target.checked;
    });
    return;
  }

  const propertyEditable = event.target.closest('[data-property-field]');
  if (propertyEditable) {
    const id = propertyEditable.dataset.propertyId;
    const field = propertyEditable.dataset.propertyField;
    const rawValue = propertyEditable.value;
    const payload = {};
    if (field === 'isActive') payload.isActive = rawValue === 'true';
    if (field === 'fallbackEnabled') payload.fallbackEnabled = rawValue === 'true';
    if (field === 'authStatus') payload.authStatus = rawValue;
    setStatus('Updating property...');
    await api(`/api/properties/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await refresh();
    setStatus('Property updated.');
    return;
  }

  const editable = event.target.closest('[data-url-field]');
  if (!editable) return;
  const id = editable.dataset.urlId;
  const field = editable.dataset.urlField;
  const value = editable.value;
  const payload = {};
  if (field === 'priorityTier') payload.priorityTier = value;
  if (field === 'category') payload.category = value;
  if (field === 'locale') payload.locale = value || null;
  if (field === 'isScaledContent') payload.isScaledContent = value === 'true';
  setStatus('Updating URL labels...');
  await api(`/api/urls/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  state.openUrlDetail = null;
  await refresh();
  setStatus('URL labels updated.');
});

document.querySelector('#seed-button').addEventListener('click', async () => {
  setStatus('Seeding data...');
  await api('/api/actions/seed', { method: 'POST', body: JSON.stringify({ reset: true }) });
  await refresh();
});

document.querySelector('#scheduler-button').addEventListener('click', async () => {
  setStatus('Running scheduler...');
  const result = await api('/api/actions/run-scheduler', { method: 'POST', body: JSON.stringify({ limit: 100 }) });
  await refresh();
  setStatus(schedulerStatus(result.summary));
});

document.querySelector('#force-scheduler-button').addEventListener('click', async () => {
  setStatus('Running forced GSC test...');
  const result = await api('/api/actions/run-scheduler', { method: 'POST', body: JSON.stringify({ limit: 50, force: true }) });
  await refresh();
  setStatus(schedulerStatus(result.summary));
});

document.querySelector('#save-google-client').addEventListener('click', async () => {
  setStatus('Saving Google OAuth client...');
  await api('/api/settings/google-oauth-client', {
    method: 'POST',
    body: JSON.stringify({
      clientId: document.querySelector('#google-client-id').value,
      clientSecret: document.querySelector('#google-client-secret').value,
      redirectUri: document.querySelector('#google-redirect-uri').value
    })
  });
  document.querySelector('#google-client-secret').value = '';
  await refresh();
});

document.querySelector('#disconnect-google').addEventListener('click', async () => {
  setStatus('Disconnecting Google...');
  await api('/api/settings/google-disconnect', { method: 'POST', body: '{}' });
  await refresh();
});

document.querySelector('#import-gsc-properties').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('[data-gsc-select]:checked')].map((checkbox) => {
    const index = checkbox.dataset.gscSelect;
    const site = state.gscSites[Number(index)];
    return {
      siteUrl: site.siteUrl,
      propertyName: `GSC ${site.siteUrl}`,
      category: document.querySelector(`[data-gsc-category="${index}"]`).value,
      locale: document.querySelector(`[data-gsc-locale="${index}"]`).value || null,
      pathPrefix: document.querySelector(`[data-gsc-path="${index}"]`).value || null,
      fallbackAllowed: true,
      isActive: true
    };
  });

  if (!selected.length) {
    setStatus('Select at least one GSC property.');
    return;
  }

  setStatus('Importing selected GSC properties...');
  const result = await api('/api/settings/gsc-properties/import', {
    method: 'POST',
    body: JSON.stringify({ properties: selected })
  });
  setStatus(`Imported ${result.imported.length}, skipped ${result.skipped.length}.`);
  await refresh();
});

document.querySelector('#save-inspection-provider').addEventListener('click', async () => {
  setStatus('Saving inspection provider...');
  await api('/api/settings/inspection', {
    method: 'POST',
    body: JSON.stringify({
      provider: document.querySelector('#inspection-provider').value,
      languageCode: document.querySelector('#inspection-language').value
    })
  });
  await refresh();
});

document.querySelector('#save-sources').addEventListener('click', async () => {
  try {
    setStatus('Saving sources...');
    const result = await api('/api/settings/sources', {
      method: 'POST',
      timeoutMs: 30000,
      body: JSON.stringify({
        sitemapIndexUrl: document.querySelector('#sitemap-index-url').value,
        sitemapIndexUrls: splitBulkUrls(document.querySelector('#bulk-sitemap-index-urls').value),
        childSitemapUrl: document.querySelector('#child-sitemap-url').value,
        childSitemapUrls: splitBulkUrls(document.querySelector('#bulk-child-sitemap-urls').value),
        fetchChildSitemaps: document.querySelector('#fetch-child-sitemaps').checked
      })
    });
    const addedCount = result.added.sitemapIndexUrls.length + result.added.childSitemapUrls.length;
    const skippedCount = result.skipped.sitemapIndexUrls.length + result.skipped.childSitemapUrls.length;
    document.querySelector('#sitemap-index-url').value = '';
    document.querySelector('#child-sitemap-url').value = '';
    document.querySelector('#bulk-sitemap-index-urls').value = '';
    document.querySelector('#bulk-child-sitemap-urls').value = '';
    setStatus(`Saved sources. Added ${addedCount}, skipped ${skippedCount}. Refreshing...`);
    try {
      await refresh();
      setStatus(`Saved sources. Added ${addedCount}, skipped ${skippedCount}.`);
    } catch (error) {
      setStatus(`Saved sources, but refresh failed: ${error.message}`);
    }
  } catch (error) {
    setStatus(`Saving sources failed: ${error.message}`);
  }
});

document.querySelector('#delete-selected-sources').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('[data-source-url]:checked')];
  if (!selected.length) {
    setStatus('Select at least one sitemap source to delete.');
    return;
  }
  const ok = window.confirm(`Delete ${selected.length} sitemap source(s)? This removes the source, not already imported page URLs.`);
  if (!ok) return;
  const payload = {
    sitemapIndexUrls: selected.filter((item) => item.dataset.sourceType === 'sitemapIndexUrls').map((item) => item.dataset.sourceUrl),
    childSitemapUrls: selected.filter((item) => item.dataset.sourceType === 'childSitemapUrls').map((item) => item.dataset.sourceUrl)
  };
  setStatus('Deleting sitemap sources...');
  const result = await api('/api/settings/sources/delete', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  await refresh();
  setStatus(`Deleted ${result.deleted.sitemapIndexUrls + result.deleted.childSitemapUrls} sitemap source(s).`);
});

document.querySelector('#delete-selected-fetched-sitemaps').addEventListener('click', async () => {
  const sitemapUrls = [...document.querySelectorAll('[data-fetched-sitemap-url]:checked')]
    .map((item) => item.dataset.fetchedSitemapUrl);
  if (!sitemapUrls.length) {
    setStatus('Select at least one fetched sitemap to delete.');
    return;
  }
  const ok = window.confirm(`Delete ${sitemapUrls.length} fetched sitemap(s), exclude them from future fetches, and remove page URLs that only came from those sitemap(s)?`);
  if (!ok) return;
  setStatus('Deleting fetched sitemaps...');
  const result = await api('/api/settings/sitemaps/delete', {
    method: 'POST',
    body: JSON.stringify({ sitemapUrls })
  });
  await refresh();
  setStatus(`Deleted ${result.deletedSitemaps} fetched sitemap(s), ${result.deletedUrls ?? 0} page URL(s), and cleaned ${result.cleanedOrphanUrls ?? 0} orphan URL(s).`);
});

document.querySelector('#fetch-sitemaps').addEventListener('click', async () => {
  try {
    setStatus('Creating sitemap fetch job...');
    const result = await api('/api/actions/fetch-sitemaps', { method: 'POST', timeoutMs: 10000, body: '{}' });
    if (result.sitemapFetch) {
      const jobId = result.job?.id;
      updateSitemapProgressUi(result.sitemapFetch.progress);
      setStatus(`${result.message ?? 'Sitemap fetch job created.'} ${result.triggerMode ? `Mode: ${result.triggerMode}. ` : ''}${sitemapProgressText(result.sitemapFetch.progress)}`);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        let status;
        try {
          status = await api(`/api/actions/fetch-sitemaps/status${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`, { timeoutMs: 10000 });
        } catch (error) {
          setStatus(`Sitemap fetch job started, but status check failed: ${error.message}. The job state is persisted; refresh in a minute.`);
          return;
        }
        if (status.sitemapFetch?.running) {
          updateSitemapProgressUi(status.sitemapFetch.progress);
          setStatus(`Sitemap fetch job ${status.job?.id ? `#${status.job.id} ` : ''}${sitemapProgressText(status.sitemapFetch.progress)}.`);
          continue;
        }
        if (status.sitemapFetch?.lastError) {
          setStatus(`Sitemap fetch failed: ${status.sitemapFetch.lastError}`);
          return;
        }
        if (status.sitemapFetch?.lastResult) {
          const done = status.sitemapFetch.lastResult;
          const summary = done.fetchSummary ?? { success: 0, failed: 0, pending: 0, total: done.counts?.sitemapCount ?? 0 };
          updateSitemapProgressUi(status.sitemapFetch.progress);
          await refresh();
          setStatus(`Fetched ${summary.success}/${summary.total} sitemaps, failed ${summary.failed}, imported ${done.counts.urlCount} page URLs. URL list is now ${done.urlsAfter}.`);
          return;
        }
      }
      setStatus('Sitemap fetch job is still running. Its progress is persisted in the job table; refresh again shortly.');
      return;
    }
    const summary = result.fetchSummary ?? { success: 0, failed: 0, pending: 0, total: result.counts.sitemapCount };
    await refresh();
    setStatus(`Fetched ${summary.success}/${summary.total} sitemaps, failed ${summary.failed}, imported ${result.counts.urlCount} page URLs, cleaned ${result.cleanedSitemapUrlRecords} sitemap URL records. URL list is now ${result.urlsAfter}.`);
  } catch (error) {
    setStatus(`Sitemap fetch failed to start: ${error.message}`);
  }
});

document.querySelector('#sync-gsc-properties').addEventListener('click', async () => {
  setStatus('Syncing GSC properties...');
  const result = await api('/api/actions/sync-gsc-properties', { method: 'POST', body: '{}' });
  await refresh();
  setStatus(`Synced ${result.sites.length} GSC properties. Imported ${result.imported.length}, skipped ${result.skipped.length}.`);
});

document.querySelector('#bulk-delete-urls-button').addEventListener('click', async () => {
  const urls = splitBulkUrls(document.querySelector('#bulk-delete-urls').value);
  if (!urls.length) {
    setStatus('Paste at least one URL to delete.');
    return;
  }
  const ok = window.confirm(`Delete ${urls.length} URL(s) and their history from the dashboard?`);
  if (!ok) return;
  setStatus('Deleting URLs...');
  const result = await api('/api/settings/delete-urls', {
    method: 'POST',
    body: JSON.stringify({ urls })
  });
  document.querySelector('#bulk-delete-urls').value = '';
  state.openUrlId = null;
  state.openUrlDetail = null;
  await refresh();
  setStatus(`Deleted ${result.deleted} URL(s). Matched ${result.matched}.`);
});

document.querySelector('#delete-selected-urls').addEventListener('click', async () => {
  await deleteUrlIds([...state.selectedUrlIds]);
});

document.querySelector('#add-manual-url').addEventListener('click', async () => {
  setStatus('Adding URL...');
  await api('/api/settings/manual-url', {
    method: 'POST',
    body: JSON.stringify({
      url: document.querySelector('#manual-url').value,
      category: document.querySelector('#manual-category').value,
      locale: document.querySelector('#manual-locale').value,
      priorityTier: document.querySelector('#manual-priority').value,
      isScaledContent: document.querySelector('#manual-scaled').checked,
      scaledContentType: document.querySelector('#manual-scaled-type').value
    })
  });
  document.querySelector('#manual-url').value = '';
  await refresh();
});

document.querySelector('#csv-import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  document.querySelector('#csv-import-text').value = await file.text();
  document.querySelector('#csv-import-result').value = `Loaded ${file.name}`;
  state.pendingCsvImport = null;
  document.querySelector('#import-csv').disabled = true;
  document.querySelector('#cancel-csv-import').disabled = true;
});

document.querySelector('#preview-csv').addEventListener('click', async () => {
  const importType = document.querySelector('#csv-import-type').value;
  const csvText = document.querySelector('#csv-import-text').value;
  if (!csvText.trim()) {
    setStatus('Choose a CSV file or paste CSV data before previewing.');
    return;
  }
  setStatus('Previewing CSV...');
  const preview = await api('/api/settings/csv-preview', {
    method: 'POST',
    body: JSON.stringify({ importType, csvText })
  });
  state.pendingCsvImport = { importType, csvText };
  document.querySelector('#import-csv').disabled = false;
  document.querySelector('#cancel-csv-import').disabled = false;
  document.querySelector('#csv-import-result').value = `${preview.rowCount} rows ready`;
  document.querySelector('#csv-preview').innerHTML = `
    <strong>Preview:</strong> ${preview.rowCount} row(s), columns: ${preview.headers.map(esc).join(', ') || 'none'}<br>
    ${preview.warnings.length ? `<strong>Warnings:</strong> ${preview.warnings.map(esc).join(' | ')}<br>` : ''}
    <strong>Sample:</strong>
    <div class="source-list">${preview.sampleRows.map((row) => `<code>${esc(row)}</code>`).join('') || 'none'}</div>
  `;
  setStatus('Preview ready. Apply Import to write changes, or Cancel.');
});

document.querySelector('#cancel-csv-import').addEventListener('click', () => {
  state.pendingCsvImport = null;
  document.querySelector('#import-csv').disabled = true;
  document.querySelector('#cancel-csv-import').disabled = true;
  document.querySelector('#csv-import-result').value = 'Import cancelled';
  document.querySelector('#csv-preview').innerHTML = '';
  setStatus('CSV import cancelled. No changes were written.');
});

document.querySelector('#import-csv').addEventListener('click', async () => {
  if (!state.pendingCsvImport) {
    setStatus('Preview CSV before applying import.');
    return;
  }
  document.querySelector('#import-csv').disabled = true;
  document.querySelector('#cancel-csv-import').disabled = true;
  setStatus('Starting CSV import job...');
  try {
    const result = await api('/api/settings/csv-import', {
      method: 'POST',
      body: JSON.stringify(state.pendingCsvImport)
    });
    state.pendingCsvImport = null;
    document.querySelector('#csv-import-text').value = '';
    document.querySelector('#csv-import-file').value = '';
    document.querySelector('#csv-import-result').value = `Job #${result.job?.id ?? '-'} queued`;
    document.querySelector('#csv-preview').innerHTML = '';
    await refresh();
    setStatus(`CSV import job started. Priority recalculation and cache sync will run in the worker.`);
  } catch (error) {
    document.querySelector('#import-csv').disabled = false;
    document.querySelector('#cancel-csv-import').disabled = false;
    setStatus(`CSV import failed: ${error.message}`);
  }
});

document.querySelector('#compact-state').addEventListener('click', async () => {
  const ok = window.confirm('Compact old history and duplicate metrics? Recent inspection logs and active alerts will stay.');
  if (!ok) return;
  setStatus('Compacting state...');
  document.querySelector('#compact-state').disabled = true;
  try {
    const response = await api('/api/settings/maintenance/compact', {
      method: 'POST',
      body: JSON.stringify({})
    });
    const removed = response.result.removed;
    const removedTotal = Object.values(removed).reduce((sum, value) => sum + Number(value || 0), 0);
    document.querySelector('#maintenance-result').innerHTML = `
      <strong>Compacted.</strong> Removed ${removedTotal} old record(s).<br>
      ${Object.entries(removed)
        .filter(([, value]) => Number(value) > 0)
        .map(([key, value]) => `${esc(key)}: ${value}`)
        .join(' · ') || 'Nothing needed pruning.'}
    `;
    await refresh();
    setStatus(`Compacted state. Removed ${removedTotal} old record(s).`);
  } catch (error) {
    setStatus(`Compaction failed: ${error.message}`);
  } finally {
    document.querySelector('#compact-state').disabled = false;
  }
});

document.querySelector('#cleanup-orphans').addEventListener('click', async () => {
  const ok = window.confirm('Remove URL records that no longer belong to any sitemap/manual source and clear priority snapshot history?');
  if (!ok) return;
  setStatus('Cleaning orphan URLs...');
  document.querySelector('#cleanup-orphans').disabled = true;
  try {
    const response = await api('/api/settings/maintenance/cleanup-orphans', {
      method: 'POST',
      body: JSON.stringify({ clearPrioritySnapshots: true })
    });
    const result = response.result;
    const removed = result.removed ?? {};
    const removedTotal = Object.values(removed).reduce((sum, value) => sum + Number(value || 0), 0);
    document.querySelector('#maintenance-result').innerHTML = `
      <strong>Cleaned.</strong> Removed ${response.removedOrphanUrls ?? result.deletedOrphanUrls ?? 0} orphan URL(s) and ${removedTotal} related/history record(s).<br>
      ${Object.entries(removed)
        .filter(([, value]) => Number(value) > 0)
        .map(([key, value]) => `${esc(key)}: ${value}`)
        .join(' · ') || 'Nothing needed cleaning.'}
    `;
    await refresh();
    setStatus('Orphan cleanup completed.');
  } catch (error) {
    setStatus(`Cleanup failed: ${error.message}`);
  } finally {
    document.querySelector('#cleanup-orphans').disabled = false;
  }
});

document.querySelector('#sync-dashboard-cache').addEventListener('click', async () => {
  setStatus('Syncing dashboard cache...');
  document.querySelector('#sync-dashboard-cache').disabled = true;
  try {
    const response = await api('/api/settings/maintenance/sync-cache', {
      method: 'POST',
      body: '{}',
      timeoutMs: 30000
    });
    document.querySelector('#maintenance-result').innerHTML = `
      <strong>Dashboard cache synced.</strong>
      URLs: ${response.cache?.urls ?? 0} · Properties: ${response.cache?.properties ?? 0}
    `;
    await refresh();
    setStatus('Dashboard cache synced.');
  } catch (error) {
    setStatus(`Cache sync failed: ${error.message}`);
  } finally {
    document.querySelector('#sync-dashboard-cache').disabled = false;
  }
});

document.querySelector('#classify-unknown-urls').addEventListener('click', async () => {
  setStatus('Classifying unknown URLs...');
  document.querySelector('#classify-unknown-urls').disabled = true;
  try {
    const result = await api('/api/actions/classify-urls', {
      method: 'POST',
      body: JSON.stringify({ limit: 20 })
    });
    document.querySelector('#ai-classification-result').innerHTML = result.configured
      ? `Classified ${result.candidates} candidate(s), applied ${result.applied}.`
      : `Classifier is not configured. Add <code>OPENAI_API_KEY</code> to Render env.`;
    await refresh();
    setStatus(result.configured ? `AI classification applied to ${result.applied} URL(s).` : 'OpenAI key missing.');
  } catch (error) {
    setStatus(`AI classification failed: ${error.message}`);
  } finally {
    document.querySelector('#classify-unknown-urls').disabled = false;
  }
});

document.querySelector('#manual-overrides-search').addEventListener('input', () => {
  if (state.view === 'settings') loadSettings().catch((error) => setStatus(error.message));
});

['#url-search', '#tier-filter', '#scaled-filter'].forEach((selector) => {
  document.querySelector(selector).addEventListener('input', () => {
    state.urlPage = 1;
    state.urlCursorStack = [null];
    state.openUrlId = null;
    state.openUrlDetail = null;
    if (state.view === 'urls') loadUrls().catch((error) => setStatus(error.message));
  });
});

const initialView = location.hash.replace('#', '');
if (titleMap[initialView]) setView(initialView);
else refresh().catch((error) => setStatus(error.message));
