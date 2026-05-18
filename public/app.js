const state = {
  view: 'overview',
  scaledTab: 'adcraft',
  gscSites: [],
  openUrlId: null,
  openUrlDetail: null
};

const titleMap = {
  overview: ['Overview', 'Property-aware index monitoring'],
  urls: ['URL Explorer', 'URL state, priority, source, and alert review'],
  scaled: ['Scaled Content', 'Adcraft index journey and delayed indexing'],
  quota: ['Property Quota', 'Daily and monthly URL Inspection API usage'],
  alerts: ['Alerts', 'Active and resolved index health events'],
  settings: ['Settings', 'Manual overrides and property management']
};

function splitBulkUrls(value) {
  return [...new Set(String(value ?? '')
    .split(/[\n,\r\t ]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
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

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
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

async function loadOverview() {
  const [data, jobs] = await Promise.all([api('/api/overview'), api('/api/jobs')]);
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
}

async function loadUrls() {
  const params = new URLSearchParams();
  const q = document.querySelector('#url-search').value;
  const tier = document.querySelector('#tier-filter').value;
  const scaled = document.querySelector('#scaled-filter').value;
  if (q) params.set('q', q);
  if (tier) params.set('priorityTier', tier);
  if (scaled) params.set('scaled', scaled);
  const urls = await api(`/api/urls?${params}`);
  if (state.openUrlId && !state.openUrlDetail) {
    state.openUrlDetail = await api(`/api/urls/${state.openUrlId}`);
  }
  document.querySelector('#url-table').innerHTML = table(
    ['URL', 'Tier', 'State', 'Health', 'Category', 'Locale', 'Scaled', 'Next Due', 'Actions'],
    urls.flatMap((url) => [`
      <tr>
        <td><code>${url.normalizedUrl}</code></td>
        <td>${pill(url.currentPriorityTier)}</td>
        <td>${url.currentIndexState}</td>
        <td>${pill(url.health?.currentSeverity ?? url.currentHealthState)}</td>
        <td>${url.category}</td>
        <td>${url.locale ?? '-'}</td>
        <td>${url.isScaledContent ? 'yes' : 'no'}</td>
        <td>${fmtDate(url.nextInspectionDueAt)}</td>
        <td>
          <div class="row-actions">
            <button class="small-button" data-detail="${url.id}">${Number(state.openUrlId) === Number(url.id) ? 'Close' : 'Open'}</button>
            <button class="small-button" data-exclude="${url.id}">${url.isManuallyExcluded ? 'Include' : 'Exclude'}</button>
          </div>
        </td>
      </tr>
    `, Number(state.openUrlId) === Number(url.id) && state.openUrlDetail ? detailRow(state.openUrlDetail) : ''])
  );
}

function detailRow(detail) {
  const latest = detail.inspections[0];
  return `
    <tr class="accordion-row">
      <td colspan="9">
        <div class="detail-drawer inline-detail">
          <div class="detail-head">
            <div>
              <h2>${detail.url.normalizedUrl}</h2>
              <p>${detail.url.category} · ${detail.url.locale ?? 'default'} · ${detail.url.currentIndexState}</p>
            </div>
          </div>
          <div class="detail-body">
            <section class="detail-section">
              <h2>Inspection Timeline</h2>
              ${table(['When', 'Coverage', 'Property'], detail.inspections.map((item) => `
                <tr>
                  <td>${fmtDate(item.inspectedAt)}</td>
                  <td>${item.coverageState}</td>
                  <td>${item.propertyId}</td>
                </tr>
              `))}
              <details>
                <summary>Raw JSON</summary>
                <pre>${latest ? JSON.stringify(latest.rawJson ?? {}, null, 2) : 'No inspection result yet. Run Scheduler or Force GSC Test first.'}</pre>
              </details>
            </section>
            <section class="detail-section">
              <h2>Diagnosis and Alerts</h2>
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
    ['Delayed', data.kpis.delayedIndexCount],
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

async function loadQuota() {
  const properties = await api('/api/properties');
  const markup = table(
    ['Property', 'Type', 'Daily Used', 'Daily Remaining', 'Monthly Used', 'Fallback', 'Auth', 'Last Success'],
    properties.map((property) => `
      <tr>
        <td><code>${property.propertyUrl}</code></td>
        <td>${property.propertyType}</td>
        <td>${property.dailyQuotaUsed}</td>
        <td>${property.dailyQuotaLimit - property.dailyQuotaUsed}</td>
        <td>${property.monthlyQuotaUsed}</td>
        <td>${property.fallbackEnabled ? 'enabled' : 'disabled'}</td>
        <td>${pill(property.authStatus)}</td>
        <td>${fmtDate(property.lastSuccessfulInspectionAt)}</td>
      </tr>
    `)
  );
  document.querySelector('#property-table').innerHTML = markup;
  document.querySelector('#property-management').innerHTML = markup;
}

async function loadAlerts() {
  const alerts = await api('/api/alerts');
  document.querySelector('#alerts-table').innerHTML = table(
    ['Type', 'Severity', 'Status', 'URL', 'Current', 'Created', 'Recommendation'],
    alerts.map((alert) => `
      <tr>
        <td>${alert.alertType}</td>
        <td>${pill(alert.severity)}</td>
        <td>${alert.status}</td>
        <td>${alert.urlId}</td>
        <td>${alert.currentState ?? '-'}</td>
        <td>${fmtDate(alert.createdAt)}</td>
        <td>${alert.recommendedAction ?? '-'}</td>
      </tr>
    `)
  );
}

async function loadSettings() {
  const [urls, settings] = await Promise.all([api('/api/urls'), api('/api/settings')]);
  const auth = settings.googleAuth;
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
  document.querySelector('#source-summary').innerHTML = `
    <strong>Sitemap indexes:</strong> ${(settings.sources.sitemapIndexUrls ?? []).length}<br>
    <div class="source-list">${(settings.sources.sitemapIndexUrls ?? []).map((url) => `<code>${esc(url)}</code>`).join('') || 'none'}</div>
    <strong>Child sitemaps:</strong> ${(settings.sources.childSitemapUrls ?? []).length}<br>
    <div class="source-list">${(settings.sources.childSitemapUrls ?? []).map((url) => `<code>${esc(url)}</code>`).join('') || 'none'}</div>
    <strong>Manual URL files:</strong> ${(settings.sources.manualUrlFiles ?? []).map(esc).join(', ') || 'none'}
  `;

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

  document.querySelector('#manual-overrides').innerHTML = table(
    ['URL', 'Tier', 'Active', 'Manual', 'Action'],
    urls.map((url) => `
      <tr>
        <td><code>${url.normalizedUrl}</code></td>
        <td>${pill(url.currentPriorityTier)}</td>
        <td>${url.isActive ? 'yes' : 'no'}</td>
        <td>${url.isManuallyExcluded ? 'excluded' : '-'}</td>
        <td><button class="small-button" data-exclude="${url.id}">${url.isManuallyExcluded ? 'Include' : 'Exclude'}</button></td>
      </tr>
    `)
  );
  await loadQuota();
}

async function refresh() {
  setStatus('Refreshing...');
  if (state.view === 'overview') await loadOverview();
  if (state.view === 'urls') await loadUrls();
  if (state.view === 'scaled') await loadScaled();
  if (state.view === 'quota') await loadQuota();
  if (state.view === 'alerts') await loadAlerts();
  if (state.view === 'settings') await loadSettings();
  setStatus(`Updated ${new Date().toLocaleTimeString()}`);
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
  if (nav) setView(nav.dataset.view);

  const tab = event.target.closest('[data-scaled-tab]');
  if (tab) {
    state.scaledTab = tab.dataset.scaledTab;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    await loadScaled();
  }

  const detail = event.target.closest('[data-detail]');
  if (detail) await openDetail(detail.dataset.detail);

  const exclude = event.target.closest('[data-exclude]');
  if (exclude) {
    const row = await api(`/api/urls/${exclude.dataset.exclude}`);
    const action = row.url.isManuallyExcluded ? 'include' : 'exclude';
    await api(`/api/urls/${exclude.dataset.exclude}/${action}`, { method: 'POST', body: '{}' });
    await refresh();
  }
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
  setStatus('Saving sources...');
  const result = await api('/api/settings/sources', {
    method: 'POST',
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
  setStatus(`Saved sources. Added ${addedCount}, skipped ${skippedCount}.`);
  await refresh();
});

document.querySelector('#fetch-sitemaps').addEventListener('click', async () => {
  setStatus('Fetching sitemap URLs...');
  const result = await api('/api/actions/fetch-sitemaps', { method: 'POST', body: '{}' });
  await refresh();
  setStatus(`Fetched ${result.counts.sitemapCount} sitemaps and imported ${result.counts.urlCount} URL entries. URL list is now ${result.urlsAfter}.`);
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
  await api('/api/actions/seed', { method: 'POST', body: JSON.stringify({ reset: false }) });
  await refresh();
});

['#url-search', '#tier-filter', '#scaled-filter'].forEach((selector) => {
  document.querySelector(selector).addEventListener('input', () => {
    if (state.view === 'urls') loadUrls().catch((error) => setStatus(error.message));
  });
});

if (location.hash === '#settings') setView('settings');
else refresh().catch((error) => setStatus(error.message));
