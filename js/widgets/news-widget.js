import { escapeHtml, truncate, stripHtml, timeAgo } from '../utils/helpers.js';

const TABS = [
  { key: 'hr',      label: 'HR Vijesti', file: 'data/hr-news.json'      },
  { key: 'tech',    label: 'Tech / AI',  file: 'data/tech-news.json'     },
  { key: 'science', label: 'Znanost',    file: 'data/science-news.json'  },
  { key: 'sport',   label: 'Sport',      file: 'data/sports.json'        },
];

const MAX_ITEMS      = 20;
const REFRESH_MS     = 4 * 60 * 60 * 1000; // 4 hours
const AUTOREFRESH_IV = 60 * 60 * 1000;     // check every hour

let _tabData     = {};   // key → items[]
let _lastFetched = {};   // key → timestamp
let _config      = {};
let _activeTab   = TABS[0].key;

export function renderUnifiedNews({ hrNews, techNews, science, sports, config }) {
  _config = config ?? {};

  _tabData = {
    hr:      hrNews?.items      ?? null,
    tech:    techNews?.items    ?? null,
    science: science?.items     ?? null,
    sport:   sportsToItems(sports),
  };

  const el = document.getElementById('widget-news');
  if (!el) return;
  el.classList.remove('loading');

  const tabsHtml = TABS.map(t => `
    <button class="unified-news-tab${t.key === _activeTab ? ' active' : ''}" data-tab="${t.key}">
      ${escapeHtml(t.label)}
    </button>`).join('');

  const panelsHtml = TABS.map(t => `
    <div class="unified-news-panel${t.key === _activeTab ? ' active' : ''}" id="news-panel-${t.key}">
      <div class="unified-news-list" id="news-list-${t.key}">
        ${renderItems(_tabData[t.key])}
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">VIJESTI</span>
      <div class="widget-actions">
        <button class="btn-icon" id="news-refresh-btn" title="Osvježi vijesti">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 2A5.5 5.5 0 1 1 5.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 1l3 1-1 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="unified-news-tabs">${tabsHtml}</div>
    <div class="unified-news-panels">${panelsHtml}</div>
    <div class="unified-news-footer">
      <span id="news-updated-label">Osvježeno pri učitavanju</span>
      <span>GitHub Actions · svako jutro</span>
    </div>`;

  attachTabHandlers(el);
  attachRefreshHandler(el);
  scheduleAutoRefresh();
}

function attachTabHandlers(el) {
  el.querySelectorAll('.unified-news-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      if (key === _activeTab) return;
      _activeTab = key;

      el.querySelectorAll('.unified-news-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === key)
      );
      el.querySelectorAll('.unified-news-panel').forEach(p =>
        p.classList.toggle('active', p.id === `news-panel-${key}`)
      );
    });
  });
}

function attachRefreshHandler(el) {
  el.querySelector('#news-refresh-btn')?.addEventListener('click', async () => {
    const btn = el.querySelector('#news-refresh-btn');
    btn?.classList.add('spinning');
    await refreshAllTabs();
    btn?.classList.remove('spinning');
    updateFooterLabel();
  });
}

async function refreshAllTabs() {
  const { bustCache, loadDataFile } = await import('../api/data-loader.js');

  for (const tab of TABS) {
    try {
      bustCache(tab.file);
      const data = await loadDataFile(tab.file);
      const items = tab.key === 'sport' ? sportsToItems(data) : (data?.items ?? null);
      _tabData[tab.key] = items;
      _lastFetched[tab.key] = Date.now();

      const listEl = document.getElementById(`news-list-${tab.key}`);
      if (listEl) listEl.innerHTML = renderItems(items);
    } catch { /* keep existing data */ }
  }
}

function scheduleAutoRefresh() {
  setInterval(async () => {
    try {
      const { loadDataFile } = await import('../api/data-loader.js');
      const meta = await loadDataFile('data/metadata.json');
      if (!meta?.last_updated) return;

      const lastUpdated = new Date(meta.last_updated).getTime();
      const alreadyFresh = Object.values(_lastFetched).some(t => t >= lastUpdated);
      if (!alreadyFresh) {
        await refreshAllTabs();
        updateFooterLabel();
      }
    } catch { /* silent */ }
  }, AUTOREFRESH_IV);
}

function updateFooterLabel() {
  const el = document.getElementById('news-updated-label');
  if (el) el.textContent = `Osvježeno ${new Date().toLocaleTimeString('hr-HR', {hour:'2-digit',minute:'2-digit'})}`;
}

function renderItems(items) {
  if (!items) return skeletonHtml();
  if (!items.length) return emptyHtml();

  const deduped = deduplicateByTitle(items).slice(0, MAX_ITEMS);
  return deduped.map(item => renderCard(item)).join('');
}

function renderCard(item) {
  const timeStr = item.published ? timeAgo(new Date(item.published)) : '';
  const summary = item.summary
    ? truncate(stripHtml(item.summary), 120)
    : null;

  return `
    <article class="news-card">
      <div class="news-card-meta">
        <span class="news-source">${escapeHtml(item.source || '')}</span>
        <span class="news-time">${timeStr}</span>
      </div>
      <h3 class="news-title">
        <a href="${escapeHtml(item.link || '#')}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(item.title || 'No title')}
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
  // Sports data may have matches grouped by league — flatten to items
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
  return `
    <div class="sk sk-card"></div>
    <div class="sk sk-card"></div>
    <div class="sk sk-card"></div>`;
}

function emptyHtml() {
  return `
    <div class="empty-state" style="padding:var(--sp-8) var(--sp-4)">
      <div class="empty-state-icon">📰</div>
      <div class="empty-state-title">Nema vijesti</div>
      <div class="empty-state-desc">Podaci se generiraju jednom dnevno putem GitHub Actions.</div>
    </div>`;
}
