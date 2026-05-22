import { escapeHtml, truncate, stripHtml, timeAgo } from '../utils/helpers.js';

const DEFAULT_TABS = [
  { key: 'hr',      label: 'HR Vijesti', file: 'data/hr-news.json'      },
  { key: 'tech',    label: 'Tech / AI',  file: 'data/tech-news.json'    },
  { key: 'science', label: 'Znanost',    file: 'data/science-news.json' },
  { key: 'sport',   label: 'Sport',      file: 'data/sports.json'       },
  { key: 'ostalo',  label: 'Ostalo',     files: [],  catch_all: true    },
];

const MAX_ITEMS      = 20;
const AUTOREFRESH_IV = 60 * 60 * 1000; // check every hour

let _tabs      = DEFAULT_TABS;
let _tabItems  = {};        // key → items[] | null (not yet loaded)
let _activeTab = null;
let _activeSub = null;      // null = all sources
let _config    = {};
let _lastFetch = {};

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
export function renderUnifiedNews({ hrNews, techNews, science, sports, config }) {
  _config = config ?? {};
  _tabs   = (_config.tabs?.length ? _config.tabs : DEFAULT_TABS)
              .filter(t => !(t.catch_all && !t.files?.length) || t.catch_all);

  // Pre-load data for static tabs
  const fileMap = {
    'data/hr-news.json':      hrNews?.items      ?? null,
    'data/tech-news.json':    techNews?.items    ?? null,
    'data/science-news.json': science?.items     ?? null,
    'data/sports.json':       sportsToItems(sports),
  };

  _tabItems = {};
  for (const tab of _tabs) {
    if (tab.file && fileMap[tab.file] !== undefined) {
      _tabItems[tab.key] = fileMap[tab.file];
    } else if (tab.files) {
      // Multi-file tab (Ostalo): merged on first activation
      _tabItems[tab.key] = null;
    } else {
      _tabItems[tab.key] = null;
    }
  }

  const el = document.getElementById('widget-news');
  if (!el) return;
  el.classList.remove('loading');

  _activeTab = _tabs[0]?.key ?? null;
  _activeSub = null;

  buildWidget(el);
  scheduleAutoRefresh();
}

// ─── BUILD WIDGET ─────────────────────────────────────────────────────────────
function buildWidget(el) {
  const tabsHtml = _tabs.map(t => `
    <button class="unified-news-tab${t.key === _activeTab ? ' active' : ''}" data-tab="${t.key}">
      ${escapeHtml(t.label)}
    </button>`).join('');

  const panelsHtml = _tabs.map(t => `
    <div class="unified-news-panel${t.key === _activeTab ? ' active' : ''}"
         id="news-panel-${t.key}">
      <div class="unified-news-list" id="news-list-${t.key}">
        ${_tabItems[t.key] !== null ? renderItems(_tabItems[t.key]) : skeletonHtml()}
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">VIJESTI</span>
      <div class="widget-actions">
        <button class="btn-icon" id="news-refresh-btn" title="Osvježi vijesti">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M11 2A5.5 5.5 0 1 1 5.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            <path d="M8 1l3 1-1 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="unified-news-tabs" id="news-main-tabs">${tabsHtml}</div>
    <div class="unified-news-subtabs" id="news-subtabs" style="display:none"></div>
    <div class="unified-news-panels">${panelsHtml}</div>
    <div class="unified-news-footer">
      <span id="news-updated-label">Osvježeno pri učitavanju</span>
      <span>GitHub Actions · svako jutro</span>
    </div>`;

  attachMainTabHandlers(el);
  attachRefreshHandler(el);
  renderSubTabs(el, _activeTab);
  maybeLoadTab(_activeTab);
}

// ─── MAIN TAB SWITCHING ───────────────────────────────────────────────────────
function attachMainTabHandlers(el) {
  el.querySelector('#news-main-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.unified-news-tab');
    if (!btn) return;
    const key = btn.dataset.tab;
    if (key === _activeTab) return;

    _activeTab = key;
    _activeSub = null;

    el.querySelectorAll('.unified-news-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === key)
    );
    el.querySelectorAll('.unified-news-panel').forEach(p =>
      p.classList.toggle('active', p.id === `news-panel-${key}`)
    );

    renderSubTabs(el, key);
    maybeLoadTab(key);
  });
}

// ─── SUB-TABS ─────────────────────────────────────────────────────────────────
function renderSubTabs(el, tabKey) {
  const subtabsEl = el.querySelector('#news-subtabs');
  if (!subtabsEl) return;

  const items = _tabItems[tabKey];
  if (!items?.length) { subtabsEl.style.display = 'none'; return; }

  const sources = getUniqueSources(items);
  if (sources.length < 2) { subtabsEl.style.display = 'none'; return; }

  const html = [`<button class="unified-news-subtab active" data-source="">Sve</button>`,
    ...sources.map(s => `<button class="unified-news-subtab" data-source="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
  ].join('');

  subtabsEl.innerHTML = html;
  subtabsEl.style.display = '';

  subtabsEl.querySelectorAll('.unified-news-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeSub = btn.dataset.source || null;
      subtabsEl.querySelectorAll('.unified-news-subtab').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      applySourceFilter(el, tabKey);
    });
  });
}

function applySourceFilter(el, tabKey) {
  const items    = _tabItems[tabKey] ?? [];
  const filtered = _activeSub ? items.filter(i => i.source === _activeSub) : items;
  const listEl   = el.querySelector(`#news-list-${tabKey}`);
  if (listEl) listEl.innerHTML = renderItems(filtered);
}

function getUniqueSources(items) {
  const seen = new Set();
  return items.map(i => i.source).filter(s => s && !seen.has(s) && seen.add(s));
}

// ─── LAZY LOAD MULTI-FILE TABS ────────────────────────────────────────────────
async function maybeLoadTab(key) {
  if (_tabItems[key] !== null) return; // already loaded or pre-populated

  const tab = _tabs.find(t => t.key === key);
  if (!tab) return;

  const files = tab.files ?? (tab.file ? [tab.file] : []);
  if (!files.length) {
    _tabItems[key] = [];
    return;
  }

  try {
    const { loadDataFile } = await import('../api/data-loader.js');
    const results = await Promise.allSettled(files.map(f => loadDataFile(f)));
    const merged  = results.flatMap(r =>
      r.status === 'fulfilled' ? (r.value?.items ?? sportsToItems(r.value) ?? []) : []
    );
    _tabItems[key] = deduplicateByTitle(merged);
    _lastFetch[key] = Date.now();

    const el = document.getElementById('widget-news');
    if (!el) return;
    const listEl = el.querySelector(`#news-list-${key}`);
    if (listEl) listEl.innerHTML = renderItems(_tabItems[key]);
    if (_activeTab === key) renderSubTabs(el, key);
  } catch (err) {
    console.error(`News load failed for tab ${key}:`, err);
  }
}

// ─── REFRESH ──────────────────────────────────────────────────────────────────
function attachRefreshHandler(el) {
  el.querySelector('#news-refresh-btn')?.addEventListener('click', async () => {
    const btn = el.querySelector('#news-refresh-btn');
    const pat = localStorage.getItem('dashboard_github_pat');

    if (pat) {
      // Trigger live RSS fetch via GitHub Actions workflow_dispatch
      btn?.classList.add('spinning');
      try {
        const res = await fetch(
          'https://api.github.com/repos/sstranjik/daily-dashboard/actions/workflows/daily-update.yml/dispatches',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${pat}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref: 'main' }),
          }
        );
        if (res.status === 204) {
          import('../app.js').then(m =>
            m.showToast('GitHub Actions workflow pokrenut · vijesti će biti osvježene za ~2 minute', 'success', 6000)
          );
          // After ~2.5 min automatically reload news data
          setTimeout(async () => {
            await refreshAllTabs(el);
            updateFooterLabel();
          }, 150_000);
        } else {
          const body = await res.json().catch(() => ({}));
          import('../app.js').then(m =>
            m.showToast(`Greška ${res.status}: ${body.message ?? 'Provjeri PAT token u postavkama'}`, 'error', 5000)
          );
        }
      } catch (err) {
        import('../app.js').then(m =>
          m.showToast('Nije moguće pokrenuti workflow · provjeri internetsku vezu', 'error', 4000)
        );
      } finally {
        btn?.classList.remove('spinning');
      }
      return;
    }

    // No PAT — reload current static JSON files (data from last morning run)
    btn?.classList.add('spinning');
    await refreshAllTabs(el);
    btn?.classList.remove('spinning');
    updateFooterLabel();
    try {
      const { loadDataFile } = await import('../api/data-loader.js');
      const meta = await loadDataFile('data/metadata.json');
      if (meta?.last_updated) {
        const age = new Date(meta.last_updated);
        const label = age.toLocaleString('hr-HR', { day:'numeric', month:'numeric', hour:'2-digit', minute:'2-digit' });
        import('../app.js').then(m =>
          m.showToast(`Vijesti osvježene · Podaci od ${label} · Dodaj GitHub PAT u postavkama za live refresh`, 'info', 6000)
        );
      }
    } catch { /* no metadata */ }
  });
}

async function refreshAllTabs(el) {
  const { bustCache, loadDataFile } = await import('../api/data-loader.js');

  for (const tab of _tabs) {
    const files = tab.files ?? (tab.file ? [tab.file] : []);
    if (!files.length) continue;
    try {
      files.forEach(f => bustCache(f));
      const results = await Promise.allSettled(files.map(f => loadDataFile(f)));
      const merged  = results.flatMap(r =>
        r.status === 'fulfilled' ? (r.value?.items ?? sportsToItems(r.value) ?? []) : []
      );
      _tabItems[tab.key] = deduplicateByTitle(merged);
      _lastFetch[tab.key] = Date.now();

      const listEl = el?.querySelector(`#news-list-${tab.key}`);
      if (listEl && _activeTab === tab.key) {
        const filtered = _activeSub ? _tabItems[tab.key].filter(i => i.source === _activeSub) : _tabItems[tab.key];
        listEl.innerHTML = renderItems(filtered);
      }
    } catch { /* keep existing */ }
  }

  if (el) renderSubTabs(el, _activeTab);
}

function scheduleAutoRefresh() {
  setInterval(async () => {
    try {
      const { loadDataFile } = await import('../api/data-loader.js');
      const meta = await loadDataFile('data/metadata.json');
      if (!meta?.last_updated) return;
      const serverTs = new Date(meta.last_updated).getTime();
      const alreadyFresh = Object.values(_lastFetch).some(t => t >= serverTs);
      if (!alreadyFresh) {
        const el = document.getElementById('widget-news');
        await refreshAllTabs(el);
        updateFooterLabel();
      }
    } catch { /* silent */ }
  }, AUTOREFRESH_IV);
}

function updateFooterLabel() {
  const el = document.getElementById('news-updated-label');
  if (el) el.textContent = `Osvježeno ${new Date().toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── RENDER HELPERS ───────────────────────────────────────────────────────────
function renderItems(items) {
  if (!items)        return skeletonHtml();
  if (!items.length) return emptyHtml();

  return deduplicateByTitle(items).slice(0, MAX_ITEMS).map(renderCard).join('');
}

function renderCard(item) {
  const timeStr = item.published ? timeAgo(new Date(item.published)) : '';
  const summary = item.summary ? truncate(stripHtml(item.summary), 120) : null;

  return `
    <article class="news-card">
      <div class="news-card-meta">
        <span class="news-source">${escapeHtml(item.source || '')}</span>
        <span class="news-time">${timeStr}</span>
      </div>
      <h3 class="news-title">
        <a href="${escapeHtml(item.link || '#')}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(item.title || '')}
        </a>
      </h3>
      ${summary ? `<p class="news-summary">${escapeHtml(summary)}</p>` : ''}
      <div class="news-card-footer">
        ${item.link ? `<a href="${escapeHtml(item.link)}" class="news-read-more" target="_blank" rel="noopener noreferrer">Čitaj →</a>` : ''}
      </div>
    </article>`;
}

function sportsToItems(data) {
  if (!data) return null;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.matches)) {
    return data.matches.map(m => ({
      title:     `${m.home_team} ${m.score ?? ''} ${m.away_team}`.trim(),
      source:    m.league || 'Sport',
      link:      m.link || null,
      published: m.date || null,
      summary:   m.status || null,
    }));
  }
  return [];
}

function deduplicateByTitle(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = (item.title || '').trim().toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skeletonHtml() {
  return `<div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div>`;
}

function emptyHtml() {
  return `
    <div class="empty-state" style="padding:var(--sp-8) var(--sp-4)">
      <div class="empty-state-icon">📰</div>
      <div class="empty-state-title">Nema vijesti</div>
      <div class="empty-state-desc">Podaci se generiraju jednom dnevno putem GitHub Actions.</div>
    </div>`;
}
