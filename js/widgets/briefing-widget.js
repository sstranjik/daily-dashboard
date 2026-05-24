import { escapeHtml, formatDate } from '../utils/helpers.js';
import { bustCache, loadDataFile } from '../api/data-loader.js';

const GITHUB_REPO    = 'sstranjik/daily-dashboard';
const WORKFLOW_FILE  = 'daily-update.yml';

export function renderBriefing(data) {
  const el = document.getElementById('widget-briefing');
  if (!el) return;
  el.classList.remove('loading');

  if (!data) { el.innerHTML = emptyState(); return; }

  // Version 2 = new structured format; anything else = legacy
  if (data.version === 2) {
    renderV2(el, data);
  } else {
    renderV1(el, data);
  }
}

// ─── V2 RENDER ────────────────────────────────────────────────────────────────

function renderV2(el, d) {
  const genTime = d.generated_at
    ? new Date(d.generated_at).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })
    : null;

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label widget-label-icon">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" stroke-width="1.1"/>
          <path d="M5.5 3v3l2 1.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
        </svg>
        JUTARNJI PREGLED
      </span>
      <div style="display:flex;align-items:center;gap:var(--sp-2)">
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${d.date_hr ?? formatDate(new Date(d.date))}</span>
        ${genTime ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">· ${genTime}</span>` : ''}
        <button class="brf-refresh-btn" id="brf-refresh-btn" title="Pokreni ručni refresh (GitHub Actions)">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M9.5 5.5A4 4 0 1 1 6.8 1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M6.5 1h2.5v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="briefing-v2 briefing-scroll">
      ${weatherSection(d.weather)}
      ${fuelSection(d.fuel)}
      ${marketSection(d.market)}
      ${aiNewsSection(d.ai_news)}
      ${microTipsSection(d.micro_tips)}
    </div>`;

  el.querySelector('#brf-refresh-btn')?.addEventListener('click', () => triggerBriefingJob(
    el.querySelector('#brf-refresh-btn')
  ));
}

// ─── SECTION: WEATHER ─────────────────────────────────────────────────────────

function weatherSection(w) {
  if (!w) return '';
  const alertsHtml = (w.alerts ?? []).map(a => `
    <div class="brf-alert brf-alert-${a.level}">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M5 1L9 8.5H1L5 1Z" stroke="currentColor" stroke-width="1.2"/>
        <path d="M5 4.5v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="5" cy="7.5" r="0.5" fill="currentColor"/>
      </svg>
      ${escapeHtml(a.text)}
    </div>`).join('');

  return `
    <div class="brf-section brf-weather-row">
      <span class="brf-weather-icon">${w.icon ?? '🌡️'}</span>
      <div style="flex:1;min-width:0">
        <span class="brf-weather-text">${escapeHtml(w.summary ?? '')}</span>
        ${alertsHtml}
      </div>
    </div>`;
}

// ─── SECTION: FUEL PRICES ─────────────────────────────────────────────────────

function formatPriceList(items) {
  if (!items?.length) return '—';
  return items.map(p =>
    `<span class="brf-fuel-company">${escapeHtml(p.company)}</span> <span class="brf-fuel-price">${String(p.price?.toFixed(3) ?? '?').replace('.', ',')}</span>`
  ).join('<span class="brf-fuel-sep"> · </span>');
}

function fuelBlock(label, items) {
  return `
    <div class="brf-fuel-row">
      <span class="brf-fuel-type">${label}</span>
      <div class="brf-fuel-prices">${formatPriceList(items)}</div>
    </div>`;
}

function fuelSection(f) {
  if (!f || f.error === 'no_api_key') {
    return `
      <div class="brf-section">
        <div class="brf-label">⛽ Cijene goriva u HR</div>
        <div class="brf-muted">Nije dostupno (potreban GEMINI_API_KEY u GitHub Secrets)</div>
      </div>`;
  }
  if (f.error) {
    return `
      <div class="brf-section">
        <div class="brf-label">⛽ Cijene goriva u HR</div>
        <div class="brf-muted">Greška pri dohvaćanju: ${escapeHtml(f.error)}</div>
      </div>`;
  }

  const dateLabel   = f.current_date ? ` <span class="brf-muted">od ${escapeHtml(f.current_date)}</span>` : '';
  const currentHtml = `
    <div class="brf-section">
      <div class="brf-label">⛽ Cijene goriva u HR${dateLabel}</div>
      ${fuelBlock('Eurodiesel', f.eurodiesel)}
      ${fuelBlock('Premium', f.premium_eurodiesel)}
    </div>`;

  const hasUpcoming = f.upcoming_date && (f.upcoming_eurodiesel?.length || f.upcoming_premium?.length);
  const upcomingHtml = hasUpcoming ? `
    <div class="brf-section">
      <div class="brf-label">⛽ Nove cijene goriva u HR od <strong>${escapeHtml(f.upcoming_date)}</strong></div>
      ${f.upcoming_eurodiesel?.length ? fuelBlock('Eurodiesel', f.upcoming_eurodiesel) : ''}
      ${f.upcoming_premium?.length    ? fuelBlock('Premium',   f.upcoming_premium)    : ''}
    </div>` : '';

  return currentHtml + upcomingHtml;
}

// ─── SECTION: MARKET ──────────────────────────────────────────────────────────

function marketSection(m) {
  if (!m) return '';

  const btcHtml = m.btc_usd
    ? (() => {
        const change     = m.btc_change_24h ?? 0;
        const changeDir  = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
        const changeSign = change > 0 ? '▲' : change < 0 ? '▼' : '–';
        const btcFmt     = new Intl.NumberFormat('en-US').format(m.btc_usd);
        return `<div class="brf-market-item">
          <span class="brf-market-label">Bitcoin</span>
          <span class="brf-market-val">$${btcFmt}</span>
          <span class="brf-market-change ${changeDir}">${changeSign}${Math.abs(change)}%</span>
        </div>`;
      })()
    : '';

  const eurHtml = m.usd_eur
    ? `<div class="brf-market-item">
        <span class="brf-market-label">USD/EUR</span>
        <span class="brf-market-val">${m.usd_eur}</span>
       </div>`
    : '';

  if (!btcHtml && !eurHtml) return '';

  return `
    <div class="brf-section brf-market-row">
      ${btcHtml}
      ${btcHtml && eurHtml ? '<span class="brf-market-divider">·</span>' : ''}
      ${eurHtml}
    </div>`;
}

// ─── SECTION: AI NEWS ─────────────────────────────────────────────────────────

function aiNewsSection(news) {
  if (!news?.length) return '';
  const items = news.map(n => `
    <li class="brf-news-item">
      ${n.link
        ? `<a href="${escapeHtml(n.link)}" class="brf-news-title" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>`
        : `<span class="brf-news-title">${escapeHtml(n.title)}</span>`
      }
      ${n.source ? `<span class="brf-news-source">${escapeHtml(n.source)}</span>` : ''}
    </li>`).join('');

  return `
    <div class="brf-section">
      <div class="brf-label">🤖 AI novosti</div>
      <ul class="brf-news-list">${items}</ul>
    </div>`;
}

// ─── SECTION: MICRO TIPS ──────────────────────────────────────────────────────

function tipCard(category, icon, data) {
  if (!data) return '';
  const isVscode  = category === 'vscode' && typeof data === 'object';
  const keys      = isVscode ? data.keys : null;
  const text      = isVscode ? data.tip  : String(data);
  return `
    <div class="brf-tip-card">
      <div class="brf-tip-header">
        <span class="brf-tip-icon">${icon}</span>
        <span class="brf-tip-cat">${category}</span>
        ${keys ? `<span class="brf-tip-keys">${escapeHtml(keys)}</span>` : ''}
      </div>
      <div class="brf-tip-text">${escapeHtml(text)}</div>
    </div>`;
}

function microTipsSection(tips) {
  if (!tips) return '';
  return `
    <div class="brf-section">
      <div class="brf-label">💡 Mikro-savjeti</div>
      <div class="brf-tips-grid">
        ${tipCard('vscode',  '⌨️', tips.vscode)}
        ${tipCard('sql',     '🗄️', tips.sql)}
        ${tipCard('oracle',  '🔶', tips.oracle)}
        ${tipCard('regex',   '🔍', tips.regex)}
      </div>
    </div>`;
}

// ─── V1 LEGACY RENDER ─────────────────────────────────────────────────────────

function renderV1(el, data) {
  const ICONS = { hr:'🇭🇷', tech:'💻', ai:'🤖', science:'🔬', weather:'☀️', world:'🌍', default:'•' };
  const genTime = data.generated_at
    ? new Date(data.generated_at).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })
    : null;

  const bulletsHtml = (data.bullets ?? []).map(b => {
    const icon = b.icon || ICONS[b.category] || ICONS.default;
    return `<li class="briefing-bullet">
      <span class="briefing-bullet-icon">${icon}</span>
      <div><span class="briefing-bullet-text">${escapeHtml(b.text)}</span></div>
    </li>`;
  }).join('');

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">JUTARNJI PREGLED</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">
        ${formatDate(new Date(data.date ?? Date.now()))}${genTime ? ' · ' + genTime : ''}
      </span>
    </div>
    ${data.summary ? `<p class="briefing-summary">${escapeHtml(data.summary)}</p>` : ''}
    ${bulletsHtml ? `<ul class="briefing-bullets">${bulletsHtml}</ul>` : ''}`;
}

// ─── GITHUB ACTIONS TRIGGER ───────────────────────────────────────────────────

async function triggerBriefingJob(btn) {
  const pat = localStorage.getItem('dashboard_github_pat');
  if (!pat) {
    _toast('warning', 'Dodaj GitHub PAT u Postavkama (⚙) za pokretanje refresha', 5000);
    return;
  }

  btn.disabled = true;
  btn.classList.add('brf-refresh-spinning');
  _toast('info', 'Pokrećem GitHub Actions job…', 3000);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (res.status === 204) {
      _toast('success', 'Job pokrenut ✓  Osvježavam za ~2 min…', 6000);
      // Poll: after 2 min try to pull fresh briefing.json
      setTimeout(() => _pollBriefing(btn, 0), 2 * 60 * 1000);
    } else if (res.status === 401) {
      _toast('error', 'GitHub PAT nije valjan ili je istekao', 5000);
      btn.disabled = false; btn.classList.remove('brf-refresh-spinning');
    } else if (res.status === 403) {
      _toast('error', 'PAT nema "workflow" scope — generiraj novi token', 5000);
      btn.disabled = false; btn.classList.remove('brf-refresh-spinning');
    } else {
      _toast('error', `GitHub API greška: ${res.status}`, 5000);
      btn.disabled = false; btn.classList.remove('brf-refresh-spinning');
    }
  } catch {
    _toast('error', 'Nije moguće spojiti se na GitHub API', 5000);
    btn.disabled = false; btn.classList.remove('brf-refresh-spinning');
  }
}

// Poll for fresh briefing.json — retry up to 4× every 30 s
async function _pollBriefing(btn, attempt) {
  try {
    bustCache('data/briefing.json');
    const data = await loadDataFile('data/briefing.json');

    // Check if the file is newer than before (generated_at changed)
    const el = document.getElementById('widget-briefing');
    if (el) renderBriefing(data);
    _toast('success', 'Jutarnji pregled osvježen ✓', 3000);
  } catch {
    if (attempt < 3) {
      setTimeout(() => _pollBriefing(btn, attempt + 1), 30_000);
    } else {
      _toast('warning', 'Nije moguće dohvatiti novi pregled — osvježi ručno (↻)', 5000);
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('brf-refresh-spinning');
  }
}

function _toast(type, msg, duration = 4000) {
  import('../app.js').then(m => m.showToast(msg, type, duration)).catch(() => {});
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────

function emptyState() {
  return `
    <div class="widget-header"><span class="widget-label">JUTARNJI PREGLED</span></div>
    <div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-title">Sažetak još nije generiran</div>
      <div class="empty-state-desc">GitHub Actions generira sažetak svako jutro u 07:00.</div>
    </div>`;
}
