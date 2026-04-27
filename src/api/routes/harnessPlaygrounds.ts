import { Hono } from 'hono'

interface HarnessPlaygroundDependencies {
  version: string
}

export function createHarnessPlaygroundRouter(
  dependencies: HarnessPlaygroundDependencies,
): Hono {
  const app = new Hono()

  app.get('/playgrounds', (c) => c.html(renderIndexPage(dependencies.version)))
  app.get('/playgrounds/harness/16-fullstack-webapp', (c) =>
    c.html(renderFullstackPage(dependencies.version)),
  )
  app.get('/playgrounds/harness/36-design-system', (c) =>
    c.html(renderDesignSystemPage(dependencies.version)),
  )
  app.get('/playgrounds/harness/42-bi-dashboard', (c) =>
    c.html(renderBiDashboardPage(dependencies.version)),
  )

  return app
}

function renderIndexPage(version: string): string {
  return wrapPage({
    title: 'Coreline Harness Playgrounds',
    subtitle: `Runnable frontend previews for the applied harness topics · v${version}`,
    body: `
      <section class="grid cards">
        ${previewCard(
          '16-fullstack-webapp',
          '/playgrounds/harness/16-fullstack-webapp',
          'Control-plane web app shell that talks to the live orchestrator API.',
        )}
        ${previewCard(
          '36-design-system',
          '/playgrounds/harness/36-design-system',
          'Operator-facing visual token and component system preview.',
        )}
        ${previewCard(
          '42-bi-dashboard',
          '/playgrounds/harness/42-bi-dashboard',
          'Telemetry dashboard over health, capacity, metrics, readiness, and audit signals.',
        )}
      </section>
    `,
    script: '',
  })
}

function renderFullstackPage(version: string): string {
  return wrapPage({
    title: '16-fullstack-webapp Playground',
    subtitle:
      'Live control-plane shell over the current orchestrator API. Frontend is intentionally lightweight and operator-focused.',
    body: `
      ${renderApiToolbar()}
      <section class="grid columns-3">
        <article class="panel metric"><h3>Health</h3><pre id="healthView">loading…</pre></article>
        <article class="panel metric"><h3>Capacity</h3><pre id="capacityView">loading…</pre></article>
        <article class="panel metric"><h3>Distributed Readiness</h3><pre id="readinessView">loading…</pre></article>
      </section>
      <section class="grid columns-2">
        <article class="panel"><div class="panel-head"><h3>Jobs</h3><button data-action="refresh">Refresh</button></div><pre id="jobsView">loading…</pre></article>
        <article class="panel"><div class="panel-head"><h3>Workers</h3><button data-action="refresh">Refresh</button></div><pre id="workersView">loading…</pre></article>
      </section>
      <section class="grid columns-2">
        <article class="panel"><h3>Sessions</h3><pre id="sessionsHint">Use CLI/API to create a live session, then inspect transcript/diagnostics here.</pre></article>
        <article class="panel"><h3>Notes</h3><ul class="notes"><li>This preview is executable and fetches live API data.</li><li>When API auth is enabled, paste a token in the toolbar.</li><li>The original harness topic assumed a richer end-user frontend; this page is an honest operator shell for the current project.</li></ul></article>
      </section>
    `,
    script: commonScript(version, `
      async function refresh() {
        await renderJsonInto('#healthView', '/health');
        await renderJsonInto('#capacityView', '/capacity');
        await renderJsonInto('#readinessView', '/distributed/readiness');
        await renderJsonInto('#jobsView', '/jobs');
        await renderJsonInto('#workersView', '/workers');
      }
      bindToolbar(refresh);
      refresh();
    `),
  })
}

function renderDesignSystemPage(version: string): string {
  return wrapPage({
    title: '36-design-system Playground',
    subtitle:
      'Runnable design-system preview for an operator console, created because the repository previously had no browser UI surface.',
    body: `
      ${renderApiToolbar(false)}
      <section class="grid cards token-grid">
        <article class="panel token-card"><h3>Surface</h3><div class="swatch surface"></div><code>#0f172a / slate-900</code></article>
        <article class="panel token-card"><h3>Accent</h3><div class="swatch accent"></div><code>#3b82f6 / blue-500</code></article>
        <article class="panel token-card"><h3>Success</h3><div class="swatch success"></div><code>#10b981 / emerald-500</code></article>
        <article class="panel token-card"><h3>Warning</h3><div class="swatch warning"></div><code>#f59e0b / amber-500</code></article>
        <article class="panel token-card"><h3>Danger</h3><div class="swatch danger"></div><code>#ef4444 / red-500</code></article>
        <article class="panel token-card"><h3>Muted</h3><div class="swatch muted"></div><code>#334155 / slate-700</code></article>
      </section>
      <section class="grid columns-2">
        <article class="panel">
          <h3>Components</h3>
          <div class="component-stack">
            <button class="btn btn-primary">Primary action</button>
            <button class="btn btn-secondary">Secondary action</button>
            <button class="btn btn-danger">Danger action</button>
            <div class="badge-row"><span class="badge badge-ok">running</span><span class="badge badge-warn">warning</span><span class="badge badge-danger">failed</span></div>
            <div class="input-row"><label>API Token</label><input id="designTokenMirror" placeholder="toolbar value mirrors here" /></div>
          </div>
        </article>
        <article class="panel">
          <h3>Accessibility / Usage Notes</h3>
          <ul class="notes">
            <li>High-contrast palette targeted at operator dashboards.</li>
            <li>Buttons and badges use semantic colors tied to orchestrator state.</li>
            <li>Spacing scale uses compact density for log/metrics heavy screens.</li>
            <li>This is now an executable preview page, not just a paper-only design-system pack.</li>
          </ul>
        </article>
      </section>
      <section class="grid columns-2">
        <article class="panel"><h3>Live Health Sample</h3><pre id="designHealthView">loading…</pre></article>
        <article class="panel"><h3>Live Metrics Sample</h3><pre id="designMetricsView">loading…</pre></article>
      </section>
    `,
    script: commonScript(version, `
      async function refresh() {
        await renderJsonInto('#designHealthView', '/health');
        await renderJsonInto('#designMetricsView', '/metrics');
        const token = getToken();
        const mirror = document.querySelector('#designTokenMirror');
        if (mirror instanceof HTMLInputElement) {
          mirror.value = token;
        }
      }
      bindToolbar(refresh);
      refresh();
    `),
  })
}

function renderBiDashboardPage(version: string): string {
  return wrapPage({
    title: '42-bi-dashboard Playground',
    subtitle:
      'Runnable telemetry dashboard over orchestrator metrics. This turns the BI mapping pack into an actual live dashboard shell.',
    body: `
      ${renderApiToolbar()}
      <section class="grid cards">
        <article class="panel metric"><h3>Jobs Total</h3><strong id="metricJobsTotal">—</strong></article>
        <article class="panel metric"><h3>Jobs Running</h3><strong id="metricJobsRunning">—</strong></article>
        <article class="panel metric"><h3>Jobs Failed</h3><strong id="metricJobsFailed">—</strong></article>
        <article class="panel metric"><h3>Active Workers</h3><strong id="metricActiveWorkers">—</strong></article>
        <article class="panel metric"><h3>Queue Depth</h3><strong id="metricQueueDepth">—</strong></article>
        <article class="panel metric"><h3>Readiness Alerts</h3><strong id="metricReadinessAlerts">—</strong></article>
      </section>
      <section class="grid columns-2">
        <article class="panel"><h3>Metrics Snapshot</h3><pre id="metricsView">loading…</pre></article>
        <article class="panel"><h3>Readiness Snapshot</h3><pre id="dashboardReadinessView">loading…</pre></article>
      </section>
      <section class="grid columns-2">
        <article class="panel"><h3>Capacity Snapshot</h3><pre id="dashboardCapacityView">loading…</pre></article>
        <article class="panel"><h3>Recent Audit Entries</h3><pre id="auditView">loading…</pre></article>
      </section>
    `,
    script: commonScript(version, `
      async function refresh() {
        const metrics = await requestJson('/metrics');
        const readiness = await requestJson('/distributed/readiness');
        const capacity = await requestJson('/capacity');
        const audit = await requestJson('/audit');
        renderJson('#metricsView', metrics);
        renderJson('#dashboardReadinessView', readiness);
        renderJson('#dashboardCapacityView', capacity);
        renderJson('#auditView', audit);
        setMetric('#metricJobsTotal', metrics.jobs_total);
        setMetric('#metricJobsRunning', metrics.jobs_running);
        setMetric('#metricJobsFailed', metrics.jobs_failed);
        setMetric('#metricActiveWorkers', capacity.active_workers);
        setMetric('#metricQueueDepth', capacity.queued_jobs);
        setMetric('#metricReadinessAlerts', Array.isArray(readiness.alerts) ? readiness.alerts.length : 0);
      }
      bindToolbar(refresh);
      refresh();
    `),
  })
}

function renderApiToolbar(showBaseInput = true): string {
  return `
    <section class="panel toolbar">
      <div class="toolbar-grid">
        ${showBaseInput ? '<label>API Base URL<input id="apiBaseInput" /></label>' : '<div class="toolbar-spacer"></div>'}
        <label>API Token<input id="apiTokenInput" placeholder="optional bearer token" /></label>
        <div class="toolbar-actions"><button id="applyToolbarButton">Apply / Refresh</button></div>
      </div>
    </section>
  `
}

function previewCard(title: string, href: string, description: string): string {
  return `
    <a class="panel card-link" href="${href}">
      <h3>${title}</h3>
      <p>${description}</p>
      <span>Open preview →</span>
    </a>
  `
}

function wrapPage({
  title,
  subtitle,
  body,
  script,
}: {
  title: string
  subtitle: string
  body: string
  script: string
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #020617;
      --surface: #0f172a;
      --surface-2: #111827;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --radius: 18px;
      --shadow: 0 20px 45px rgba(2, 6, 23, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #0f172a, var(--bg) 55%);
      color: var(--text);
    }
    main { max-width: 1240px; margin: 0 auto; padding: 32px 20px 64px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    h2, h3 { margin-top: 0; }
    p, li, code, pre, label, input, button, span, strong { font-size: 14px; }
    .subtitle { color: var(--muted); max-width: 840px; line-height: 1.6; }
    .grid { display: grid; gap: 16px; margin-top: 16px; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .columns-2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .columns-3 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .panel {
      background: linear-gradient(180deg, rgba(15,23,42,0.92), rgba(15,23,42,0.82));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .card-link { text-decoration: none; color: inherit; display: block; }
    .card-link span { color: var(--accent); font-weight: 600; }
    .toolbar-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: end; }
    label { display: grid; gap: 8px; color: var(--muted); }
    input {
      width: 100%; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
      padding: 10px 12px;
    }
    button, .btn {
      appearance: none; border: 0; border-radius: 12px; padding: 10px 14px; cursor: pointer;
      background: var(--accent); color: white; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; justify-content: center;
    }
    .btn-secondary { background: #475569; }
    .btn-danger { background: var(--danger); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    pre {
      margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 1.55; color: #cbd5e1;
      background: rgba(2,6,23,0.55); border: 1px solid rgba(51,65,85,0.75); border-radius: 12px; padding: 12px;
      min-height: 92px;
    }
    .metric strong { font-size: 30px; display: block; margin-top: 8px; }
    .notes { margin: 0; padding-left: 18px; color: var(--muted); line-height: 1.7; }
    .swatch { height: 80px; border-radius: 14px; margin-bottom: 10px; border: 1px solid rgba(255,255,255,0.08); }
    .surface { background: #0f172a; }
    .accent { background: #3b82f6; }
    .success { background: #10b981; }
    .warning { background: #f59e0b; }
    .danger { background: #ef4444; }
    .muted { background: #334155; }
    .component-stack { display: grid; gap: 12px; }
    .badge-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 6px 10px; border-radius: 999px; font-weight: 600; }
    .badge-ok { background: rgba(16,185,129,0.18); color: #6ee7b7; }
    .badge-warn { background: rgba(245,158,11,0.18); color: #fcd34d; }
    .badge-danger { background: rgba(239,68,68,0.18); color: #fca5a5; }
    .input-row { display: grid; gap: 8px; }
    .footer-note { margin-top: 24px; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Coreline Orchestrator · Harness Preview</p>
      <h1>${title}</h1>
      <p class="subtitle">${subtitle}</p>
    </header>
    ${body}
    <p class="footer-note">These pages are executable previews backed by the current server. Default API base: <code>/api/v1</code>.</p>
  </main>
  <script>
    ${script}
  </script>
</body>
</html>`
}

function commonScript(version: string, body: string): string {
  return `
    const DEFAULT_API_BASE = window.location.origin + '/api/v1';
    const STORAGE_KEYS = { base: 'coreline.playground.apiBase', token: 'coreline.playground.apiToken' };
    function getStored(key, fallback) { return window.localStorage.getItem(key) ?? fallback; }
    function getApiBase() {
      const input = document.querySelector('#apiBaseInput');
      if (input instanceof HTMLInputElement && input.value.trim() !== '') return input.value.trim();
      return getStored(STORAGE_KEYS.base, DEFAULT_API_BASE);
    }
    function getToken() {
      const input = document.querySelector('#apiTokenInput');
      if (input instanceof HTMLInputElement) return input.value.trim();
      return getStored(STORAGE_KEYS.token, '');
    }
    function persistToolbar() {
      const baseInput = document.querySelector('#apiBaseInput');
      if (baseInput instanceof HTMLInputElement) window.localStorage.setItem(STORAGE_KEYS.base, baseInput.value.trim() || DEFAULT_API_BASE);
      const tokenInput = document.querySelector('#apiTokenInput');
      if (tokenInput instanceof HTMLInputElement) window.localStorage.setItem(STORAGE_KEYS.token, tokenInput.value.trim());
    }
    async function requestJson(path) {
      persistToolbar();
      const headers = {};
      const token = getToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const response = await fetch(getApiBase() + path, { headers });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      if (!response.ok) {
        return { error: true, status: response.status, payload };
      }
      return payload;
    }
    function renderJson(selector, payload) {
      const target = document.querySelector(selector);
      if (target) target.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    }
    async function renderJsonInto(selector, path) {
      const payload = await requestJson(path);
      renderJson(selector, payload);
      return payload;
    }
    function setMetric(selector, value) {
      const target = document.querySelector(selector);
      if (target) target.textContent = String(value ?? '—');
    }
    function bindToolbar(refresh) {
      const baseInput = document.querySelector('#apiBaseInput');
      if (baseInput instanceof HTMLInputElement) baseInput.value = getStored(STORAGE_KEYS.base, DEFAULT_API_BASE);
      const tokenInput = document.querySelector('#apiTokenInput');
      if (tokenInput instanceof HTMLInputElement) tokenInput.value = getStored(STORAGE_KEYS.token, '');
      document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => refresh()));
      const applyButton = document.querySelector('#applyToolbarButton');
      if (applyButton) applyButton.addEventListener('click', () => refresh());
      console.info('Coreline Harness Playground v${version}');
    }
    ${body}
  `
}
