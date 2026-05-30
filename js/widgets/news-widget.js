import { escapeHtml, truncate, stripHtml, timeAgo } from '../utils/helpers.js';
import { showToast } from '../app.js';

// ─── EVENTS (ZBIVANJA) HELPERS ────────────────────────────────────────────────

const ZBV_SUB_TABS = [
  { key: 'koncerti',    label: 'Koncerti',    field: 'concerts'  },
  { key: 'kazaliste',   label: 'Kazalište',   field: 'theater'   },
  { key: 'novo',        label: 'Novo',        field: '_new'      },
  { key: 'inozemstvo',  label: 'Inozemstvo',  field: 'abroad'    },
];
const ZBV_SHOW_INIT = 15; // cards shown before "Prikaži više"

let _zbvData     = null;  // raw events.json
let _zbvSub      = 'koncerti';
let _zbvFiltered = new Set();  // set of event IDs hidden by filter
let _zbvPerformerFilter = new Set(); // performer names filtered globally

const MONTH_SHORT = ['sij','velj','ožu','tra','svi','lip','srp','kol','ruj','lis','stu','pro'];
const COUNTRY_FLAG = { HR:'🇭🇷', RS:'🇷🇸', AT:'🇦🇹', HU:'🇭🇺', SI:'🇸🇮', DE:'🇩🇪', GB:'🇬🇧', BA:'🇧🇦', EU:'🇪🇺' };

function loadZbvFilter() {
  try {
    const d = JSON.parse(localStorage.getItem('zbv_filter') || '{}');
    _zbvFiltered        = new Set(d.ids        ?? []);
    _zbvPerformerFilter = new Set(d.performers ?? []);
  } catch { /* ignore */ }
}

function saveZbvFilter() {
  localStorage.setItem('zbv_filter', JSON.stringify({
    ids:        [..._zbvFiltered],
    performers: [..._zbvPerformerFilter],
  }));
}

function isZbvVisible(ev) {
  if (_zbvFiltered.has(ev.id)) return false;
  if (_zbvPerformerFilter.size > 0) {
    const titleL = ev.title.toLowerCase();
    for (const p of _zbvPerformerFilter) {
      if (titleL.includes(p.toLowerCase())) return false;
    }
  }
  return true;
}

function zbvItemsForSub(sub) {
  if (!_zbvData) return [];
  if (sub === '_new') {
    const allNew = [
      ...(_zbvData.concerts ?? []),
      ...(_zbvData.theater  ?? []),
      ...(_zbvData.abroad   ?? []),
    ].filter(e => e.is_new);
    return allNew.sort((a, b) => a.date_iso.localeCompare(b.date_iso));
  }
  const field = ZBV_SUB_TABS.find(t => t.key === sub)?.field;
  return _zbvData[field] ?? [];
}

function renderZbvCard(ev) {
  const d   = new Date(ev.date_iso);
  const day = d.getDate();
  const mon = MONTH_SHORT[d.getMonth()] ?? '';
  const timeStr = ev.time ?? '';
  const flag    = ev.country && ev.country !== 'HR' ? (COUNTRY_FLAG[ev.country] ?? '🌍') : '';

  return `
    <div class="zbv-card" data-evid="${escapeHtml(ev.id)}" data-title="${escapeHtml(ev.title)}">
      <div class="zbv-date">
        <span class="zbv-date-day">${day}</span>
        <span class="zbv-date-mon">${mon}</span>
        ${timeStr ? `<span class="zbv-date-time">${timeStr}</span>` : ''}
      </div>
      <div class="zbv-body">
        ${ev.link
          ? `<a href="${escapeHtml(ev.link)}" class="zbv-title" target="_blank" rel="noopener">${escapeHtml(ev.title)}</a>`
          : `<span class="zbv-title">${escapeHtml(ev.title)}</span>`
        }
        <div class="zbv-meta">
          ${ev.venue ? `<span class="zbv-venue">${escapeHtml(ev.venue)}</span>` : ''}
          ${flag     ? `<span class="zbv-country-flag" title="${escapeHtml(ev.city ?? '')}">${flag}</span>` : ''}
          ${ev.source ? `<span class="zbv-source">${escapeHtml(ev.source)}</span>` : ''}
          ${ev.is_new ? `<span class="zbv-new-badge">novo</span>` : ''}
        </div>
      </div>
      <button class="zbv-menu-btn" aria-label="Opcije" title="Opcije">⋮</button>
    </div>`;
}

function renderZbvList(items, listEl, showAll = false) {
  const visible   = items.filter(isZbvVisible);
  const truncated = showAll ? visible : visible.slice(0, ZBV_SHOW_INIT);
  const hasMore   = !showAll && visible.length > ZBV_SHOW_INIT;

  if (!visible.length) {
    listEl.innerHTML = `<div class="zbv-empty">Nema događaja</div>`;
    return;
  }

  listEl.innerHTML = truncated.map(renderZbvCard).join('')
    + (hasMore ? `<button class="zbv-show-more" data-showall>Prikaži sve (${visible.length}) →</button>` : '');

  listEl.querySelector('[data-showall]')?.addEventListener('click', () => {
    renderZbvList(items, listEl, true);
  });

  // ⋮ menu handlers
  listEl.querySelectorAll('.zbv-menu-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openZbvMenu(btn, listEl, items);
    });
  });
}

function openZbvMenu(btn, listEl, items) {
  // Close any existing dropdown
  document.querySelectorAll('.zbv-dropdown').forEach(d => d.remove());
  document.removeEventListener('click', _closeDropdowns, true);

  const card  = btn.closest('.zbv-card');
  const evId  = card?.dataset.evid;
  const title = card?.dataset.title ?? '';
  const ev    = items.find(e => e.id === evId);
  if (!ev) return;

  const dropdown = document.createElement('div');
  dropdown.className = 'zbv-dropdown';
  dropdown.innerHTML = `
    ${ev.link ? `
    <div class="zbv-dropdown-item" data-action="open">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 10L10 2M10 2H5M10 2v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      Otvori link
    </div>` : ''}
    <div class="zbv-dropdown-item" data-action="hide-event">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      Sakrij ovaj događaj
    </div>
    <div class="zbv-dropdown-item" data-action="hide-performer">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="4" r="2.5" stroke="currentColor" stroke-width="1.2"/>
        <path d="M1 10c0-2.2 2.2-4 5-4s5 1.8 5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M9 1l2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
      Filtriraj izvođača
    </div>`;

  card.style.position = 'relative';
  card.appendChild(dropdown);

  dropdown.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    dropdown.remove();

    if (action === 'open' && ev.link) {
      window.open(ev.link, '_blank', 'noopener');
    } else if (action === 'hide-event') {
      _zbvFiltered.add(evId);
      saveZbvFilter();
      renderZbvList(items, listEl);
      showToast(`"${title.slice(0, 30)}" sakriven`, 'info', 3000);
    } else if (action === 'hide-performer') {
      _zbvPerformerFilter.add(title);
      saveZbvFilter();
      renderZbvList(items, listEl);
      showToast(`Izvođač "${title.slice(0, 30)}" filtriran`, 'info', 3000);
    }
  });

  setTimeout(() => {
    document.addEventListener('click', _closeDropdowns, true);
  }, 0);
}

function _closeDropdowns() {
  document.querySelectorAll('.zbv-dropdown').forEach(d => d.remove());
  document.removeEventListener('click', _closeDropdowns, true);
}

function buildZbivanja(panelEl) {
  loadZbvFilter();

  if (!_zbvData) {
    panelEl.innerHTML = `<div class="zbv-loading">Učitavam zbivanja…</div>`;
    return;
  }

  // Count per sub-tab
  const counts = {};
  ZBV_SUB_TABS.forEach(t => { counts[t.key] = zbvItemsForSub(t.key).filter(isZbvVisible).length; });

  const subNavHtml = ZBV_SUB_TABS.map(t => `
    <button class="zbv-tab${t.key === _zbvSub ? ' active' : ''}" data-zbvsub="${t.key}">
      ${t.label}<span class="zbv-count">${counts[t.key]}</span>
    </button>`).join('');

  // Optionally show "clear filters" if any active
  const hasFilter = _zbvFiltered.size > 0 || _zbvPerformerFilter.size > 0;
  const clearBtn = hasFilter ? `<button class="zbv-tab" id="zbv-clear-filter" style="margin-left:auto;color:var(--text-muted)">✕ Filtri</button>` : '';

  panelEl.innerHTML = `
    <div class="zbv-subnav">${subNavHtml}${clearBtn}</div>
    <div class="zbv-list" id="zbv-list"></div>`;

  const listEl = panelEl.querySelector('#zbv-list');
  renderZbvList(zbvItemsForSub(_zbvSub), listEl);

  // Sub-tab switching
  panelEl.querySelector('.zbv-subnav').addEventListener('click', e => {
    const btn = e.target.closest('[data-zbvsub]');
    if (btn) {
      _zbvSub = btn.dataset.zbvsub;
      panelEl.querySelectorAll('.zbv-tab[data-zbvsub]').forEach(b =>
        b.classList.toggle('active', b.dataset.zbvsub === _zbvSub)
      );
      renderZbvList(zbvItemsForSub(_zbvSub), listEl);
      return;
    }
    if (e.target.closest('#zbv-clear-filter')) {
      _zbvFiltered.clear();
      _zbvPerformerFilter.clear();
      saveZbvFilter();
      buildZbivanja(panelEl);
      showToast('Filteri obrisani', 'info', 2000);
    }
  });
}

const DEFAULT_TABS = [
  { key: 'hr',            label: 'HR Vijesti', file: 'data/hr-news.json'            },
  { key: 'world',         label: 'Svijet',     file: 'data/world-news.json'         },
  { key: 'finance',       label: 'Financije',  file: 'data/finance-news.json'       },
  { key: 'tech',          label: 'Tech / AI',  file: 'data/tech-news.json'          },
  { key: 'science',       label: 'Znanost',    file: 'data/science-news.json'       },
  { key: 'sport',         label: 'Sport',      file: 'data/sports.json'             },
  { key: 'entertainment', label: 'Zabava',     file: 'data/entertainment-news.json' },
  { key: 'health',        label: 'Zdravlje',   file: 'data/health-news.json'        },
  { key: 'food',          label: 'Hrana',      file: 'data/food-news.json'          },
  { key: 'zbivanja',      label: 'Zbivanja',   file: 'data/zbivanja.json'           },
  { key: 'ostalo',        label: 'Ostalo',     files: [],  catch_all: true          },
];

const PAGE_SIZE      = 20;
const AUTOREFRESH_IV = 60 * 60 * 1000; // check every hour

let _tabs      = DEFAULT_TABS;
let _tabItems  = {};        // key → items[] | null (not yet loaded)
let _activeTab = null;
let _activeSub = null;      // null = all sources
let _tabPage   = {};        // key → current page index (0-based)
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
    if (tab.key === 'zbivanja') {
      _tabItems[tab.key] = 'zbivanja';  // special marker — handled separately
    } else if (tab.file && fileMap[tab.file] !== undefined) {
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
  _tabPage   = {};

  buildWidget(el);
  scheduleAutoRefresh();
  maybeLoadTab(_activeTab);

  // Eagerly pre-fetch events data in background
  _loadZbivanja();
}

// ─── BUILD WIDGET ─────────────────────────────────────────────────────────────
function buildWidget(el) {
  const tabsHtml = _tabs.map(t => `
    <button class="unified-news-tab${t.key === _activeTab ? ' active' : ''}" data-tab="${t.key}">
      ${escapeHtml(t.label)}
    </button>`).join('');

  const panelsHtml = _tabs.map(t => {
    const isZbv = t.key === 'zbivanja';
    const inner = isZbv
      ? `<div class="zbv-loading">Učitavam zbivanja…</div>`
      : (_tabItems[t.key] !== null && _tabItems[t.key] !== 'zbivanja'
          ? renderItems(_tabItems[t.key], t.key)
          : skeletonHtml());
    return `
      <div class="unified-news-panel${t.key === _activeTab ? ' active' : ''}"
           id="news-panel-${t.key}">
        ${isZbv ? inner : `<div class="unified-news-list" id="news-list-${t.key}">${inner}</div>`}
      </div>`;
  }).join('');

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
  attachPagerDelegation(el);
  renderSubTabs(el, _activeTab);
  // Note: maybeLoadTab is called from renderUnifiedNews after buildWidget
}

// ─── ZBIVANJA LOADER ──────────────────────────────────────────────────────────
async function _loadZbivanja() {
  try {
    const { loadDataFile } = await import('../api/data-loader.js');
    _zbvData = await loadDataFile('data/zbivanja.json');
    // If Zbivanja tab is currently active, render it now
    if (_activeTab === 'zbivanja') {
      const el  = document.getElementById('widget-news');
      const pan = el?.querySelector('#news-panel-zbivanja');
      if (pan) buildZbivanja(pan);
    }
  } catch (err) {
    console.warn('Events data not available:', err.message);
    // Leave zbvData null — panel shows "Nema događaja"
  }
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
    _tabPage[key] = 0;

    el.querySelectorAll('.unified-news-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === key)
    );
    el.querySelectorAll('.unified-news-panel').forEach(p =>
      p.classList.toggle('active', p.id === `news-panel-${key}`)
    );

    renderSubTabs(el, key);

    if (key === 'zbivanja') {
      const pan = el.querySelector('#news-panel-zbivanja');
      if (pan) buildZbivanja(pan);
    } else {
      maybeLoadTab(key);
    }
  });
}

// ─── SUB-TABS ─────────────────────────────────────────────────────────────────
function renderSubTabs(el, tabKey) {
  const subtabsEl = el.querySelector('#news-subtabs');
  if (!subtabsEl) return;

  // Zbivanja manages its own internal sub-nav; hide the generic subtabs bar
  if (tabKey === 'zbivanja') { subtabsEl.style.display = 'none'; return; }

  const items = _tabItems[tabKey];
  if (!items?.length || items === 'zbivanja') { subtabsEl.style.display = 'none'; return; }

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
  _tabPage[tabKey] = 0;  // reset to first page when filter changes
  const items    = _tabItems[tabKey] ?? [];
  const filtered = _activeSub ? items.filter(i => i.source === _activeSub) : items;
  const listEl   = el.querySelector(`#news-list-${tabKey}`);
  if (listEl) listEl.innerHTML = renderItems(filtered, tabKey, el);
}

function getUniqueSources(items) {
  const seen = new Set();
  return items.map(i => i.source).filter(s => s && !seen.has(s) && seen.add(s));
}

// ─── LAZY LOAD MULTI-FILE TABS ────────────────────────────────────────────────
async function maybeLoadTab(key) {
  if (key === 'zbivanja') return;       // Zbivanja has its own loader
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
    if (listEl) listEl.innerHTML = renderItems(_tabItems[key], key, el);
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
          showToast('GitHub Actions workflow pokrenut · vijesti će biti osvježene za ~2 minute', 'success', 6000);
          // After ~2.5 min automatically reload news data
          setTimeout(async () => {
            await refreshAllTabs(el);
            updateFooterLabel();
          }, 150_000);
        } else {
          const body = await res.json().catch(() => ({}));
          showToast(`Greška ${res.status}: ${body.message ?? 'Provjeri PAT token u postavkama'}`, 'error', 5000);
        }
      } catch (err) {
        showToast('Nije moguće pokrenuti workflow · provjeri internetsku vezu', 'error', 4000);
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
        showToast(`Vijesti osvježene · Podaci od ${label} · Dodaj GitHub PAT u postavkama za live refresh`, 'info', 6000);
      }
    } catch { /* no metadata */ }
  });
}

function attachPagerDelegation(el) {
  el.addEventListener('click', e => {
    const btn = e.target.closest('.news-pager-btn');
    if (!btn || btn.disabled) return;
    const pager  = btn.closest('.news-pager');
    const tabKey = pager?.dataset.tab;
    if (!tabKey) return;
    const dir = parseInt(btn.dataset.dir, 10);
    _tabPage[tabKey] = Math.max(0, (_tabPage[tabKey] ?? 0) + dir);
    const items    = _tabItems[tabKey] ?? [];
    const filtered = _activeSub ? items.filter(i => i.source === _activeSub) : items;
    const listEl   = el.querySelector(`#news-list-${tabKey}`);
    if (listEl) {
      listEl.innerHTML = renderItems(filtered, tabKey, el);
      // Scroll list into view smoothly
      listEl.closest('.unified-news-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}

async function refreshAllTabs(el) {
  const { bustCache, loadDataFile } = await import('../api/data-loader.js');

  for (const tab of _tabs) {
    if (tab.key === 'zbivanja') continue; // handled separately below
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
        listEl.innerHTML = renderItems(filtered, tab.key, el);
      }
    } catch { /* keep existing */ }
  }

  // Refresh events
  try {
    bustCache('data/zbivanja.json');
    _zbvData = await loadDataFile('data/zbivanja.json');
    if (_activeTab === 'zbivanja') {
      const pan = el?.querySelector('#news-panel-zbivanja');
      if (pan) buildZbivanja(pan);
    }
  } catch { /* events not yet available */ }

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

// Render a page of items + attach pagination controls
function renderItems(items, tabKey = null, widgetEl = null) {
  if (!items)        return skeletonHtml();
  if (!items.length) return emptyHtml();

  const deduped = deduplicateByTitle(items);
  const page    = tabKey ? (_tabPage[tabKey] ?? 0) : 0;
  const total   = deduped.length;
  const pages   = Math.ceil(total / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const slice   = deduped.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const cardsHtml  = slice.map(renderCard).join('');
  const pagerHtml  = pages > 1
    ? renderPager(safePage, pages, total, tabKey, widgetEl)
    : '';

  return cardsHtml + pagerHtml;
}

function renderPager(page, pages, total, tabKey, widgetEl) {
  const start = page * PAGE_SIZE + 1;
  const end   = Math.min((page + 1) * PAGE_SIZE, total);
  return `
    <div class="news-pager" data-tab="${escapeHtml(tabKey ?? '')}">
      <button class="news-pager-btn" data-dir="-1" ${page === 0 ? 'disabled' : ''}>← Prethodni</button>
      <span class="news-pager-info">${start}–${end} od ${total}</span>
      <button class="news-pager-btn" data-dir="1" ${page >= pages - 1 ? 'disabled' : ''}>Sljedeći →</button>
    </div>`;
}

// Pager clicks are handled via event delegation in attachPagerDelegation() below

function renderCard(item) {
  const timeStr = item.published ? timeAgo(new Date(item.published)) : '';
  const summary = item.summary ? truncate(stripHtml(item.summary), 120) : null;
  const img     = item.image || null;

  const imgHtml = img
    ? `<a href="${escapeHtml(item.link || '#')}" class="news-card-img-wrap" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">
         <img class="news-card-img" src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async">
       </a>`
    : '';

  return `
    <article class="news-card${img ? ' has-img' : ''}">
      ${imgHtml}
      <div class="news-card-body">
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
