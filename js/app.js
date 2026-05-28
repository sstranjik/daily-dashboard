import { loadConfig, applyWidgetVisibility } from './config.js';
import { initAuth }                          from './auth.js';
import { cache }                             from './utils/cache.js';
import { timeAgo }                           from './utils/helpers.js';
import { fetchWeatherData }                  from './api/weather-api.js';
import { getAccessToken }                    from './api/google-api.js';
import { initClock }                         from './widgets/clock-widget.js';
import { renderWeather }                     from './widgets/weather-widget.js';
import { renderBriefing }                    from './widgets/briefing-widget.js';
import { renderUnifiedNews }                 from './widgets/news-widget.js';
import { renderCalendar }                    from './widgets/calendar-widget.js';
import { renderTasks }                       from './widgets/tasks-widget.js';
import { loadDataFile, bustCache }            from './api/data-loader.js';

let appConfig    = null;
let isRefreshing = false;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  appConfig = await loadConfig();
  applyWidgetVisibility(appConfig);
  initClock();
  initAuth(appConfig);
  attachTopbarHandlers();
  attachSettingsPanel(appConfig);

  const [briefing, hrNews, techNews, science, sports, metadata] = await Promise.allSettled([
    loadDataFile('data/briefing.json'),
    loadDataFile('data/hr-news.json'),
    loadDataFile('data/tech-news.json'),
    loadDataFile('data/science-news.json'),
    loadDataFile('data/sports.json'),
    loadDataFile('data/metadata.json'),
  ]);

  renderBriefing(briefing.status === 'fulfilled' ? briefing.value : null);

  renderUnifiedNews({
    hrNews:   hrNews.status   === 'fulfilled' ? hrNews.value   : null,
    techNews: techNews.status === 'fulfilled' ? techNews.value : null,
    science:  science.status  === 'fulfilled' ? science.value  : null,
    sports:   sports.status   === 'fulfilled' ? sports.value   : null,
    config:   appConfig.news,
  });

  if (metadata.status === 'fulfilled' && metadata.value) {
    updateLastUpdateBadge(metadata.value.last_updated);
  }

  initWeather(appConfig.location);

  // Render Google widgets (will show connect prompts if no token yet)
  renderCalendar(appConfig);
  renderTasks(appConfig);

  // Re-render Google widgets after successful token acquisition (auto-reconnect on reload)
  window.addEventListener('auth:token', () => {
    renderCalendar(appConfig);
    renderTasks(appConfig);
  });

  // Re-render Google widgets after sign-in (first time, before API access granted)
  window.addEventListener('auth:signin', () => {
    renderCalendar(appConfig);
    renderTasks(appConfig);
  });

  // Re-render Google widgets after sign-out
  window.addEventListener('auth:signout', () => {
    renderCalendar(appConfig);
    renderTasks(appConfig);
  });
}

// ─── WEATHER ──────────────────────────────────────────────────────────────────
async function initWeather(location) {
  const CACHE_KEY = 'weather_data';
  const CACHE_TTL = (appConfig.refresh?.weather_interval_min ?? 30) * 60 * 1000;

  const cached = cache.get(CACHE_KEY);
  if (cached) {
    renderWeather(cached, location);
    updateTopbarForecast(cached);
    return;
  }

  try {
    let lat  = location.lat;
    let lon  = location.lon;
    let city = location.default_city;

    if (location.auto_detect && navigator.geolocation) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
        );
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
        const geo = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
          { headers: { 'Accept-Language': 'hr' } }
        );
        if (geo.ok) {
          const g = await geo.json();
          city = g.address?.city || g.address?.town || g.address?.village || city;
        }
      } catch { /* fall back to default coords */ }
    }

    const data  = await fetchWeatherData(lat, lon);
    data._city      = city;
    data._fetchedAt = Date.now();
    cache.set(CACHE_KEY, data, CACHE_TTL);
    renderWeather(data, { ...location, _city: city });
    updateTopbarForecast(data);
  } catch (err) {
    console.error('Weather fetch failed:', err);
    const el = document.getElementById('widget-weather');
    if (el) {
      el.classList.remove('loading');
      el.innerHTML = `
        <div class="widget-header"><span class="widget-label">WEATHER</span></div>
        <div class="error-state">⚠ Nije moguće dohvatiti podatke o vremenu.</div>`;
    }
  }
}

// ─── TOPBAR 7-DAY FORECAST ────────────────────────────────────────────────────
function updateTopbarForecast(data) {
  const el = document.getElementById('topbar-weather');
  if (!el || !data?.daily) return;

  const days      = data.daily;
  const shortDays = ['Ned','Pon','Uto','Sri','Čet','Pet','Sub'];

  const html = (days.time ?? []).slice(0, 7).map((dateStr, i) => {
    const date    = new Date(dateStr + 'T12:00:00');
    const isToday = i === 0;
    const name    = isToday ? 'Danas' : shortDays[date.getDay()];
    const icon    = weatherCodeToEmoji(days.weathercode[i]);
    const temp    = Math.round(days.temperature_2m_max[i]);

    return `
      <div class="topbar-fc-day${isToday ? ' is-today' : ''}" title="${dateStr}: ${temp}°">
        <span class="topbar-fc-name">${name}</span>
        <span class="topbar-fc-icon">${icon}</span>
        <span class="topbar-fc-temp">${temp}°</span>
      </div>`;
  }).join('');

  el.innerHTML = html;
}

// ─── LAST UPDATE BADGE ────────────────────────────────────────────────────────
function updateLastUpdateBadge(isoStr) {
  const el = document.getElementById('last-update-badge');
  if (!el || !isoStr) return;
  el.textContent = `↻ ${timeAgo(new Date(isoStr))}`;
  el.removeAttribute('hidden');
}

// ─── REFRESH ALL ──────────────────────────────────────────────────────────────
async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('refresh-all-btn');
  btn?.classList.add('spinning');

  // Bust in-memory cache for static data files
  bustCache('data/briefing.json');
  bustCache('data/metadata.json');

  // Re-fetch briefing + metadata in parallel with weather
  const [briefingRes, metaRes] = await Promise.allSettled([
    loadDataFile('data/briefing.json'),
    loadDataFile('data/metadata.json'),
  ]);

  renderBriefing(briefingRes.status === 'fulfilled' ? briefingRes.value : null);

  if (metaRes.status === 'fulfilled' && metaRes.value) {
    updateLastUpdateBadge(metaRes.value.last_updated);
  }

  // Re-fetch weather (separate cache layer)
  cache.remove('weather_data');
  await initWeather(appConfig.location);

  showToast('Dashboard osvježen', 'success');
  btn?.classList.remove('spinning');
  isRefreshing = false;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function attachSettingsPanel(cfg) {
  const panel    = document.getElementById('settings-panel');
  const overlay  = document.getElementById('settings-overlay');
  const body     = document.getElementById('settings-body');
  const openBtn  = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('close-settings-btn');

  const open  = () => { panel.classList.remove('hidden'); overlay.classList.remove('hidden'); renderSettingsBody(cfg, body); };
  const close = () => { panel.classList.add('hidden'); overlay.classList.add('hidden'); };

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function renderSettingsBody(cfg, container) {
  const widgetNames = {
    calendar:  'Kalendar',
    tasks:     'Taskovi',
    weather:   'Vrijeme',
    briefing:  'Jutarnji pregled',
    news:      'Vijesti',
  };
  const savedPrefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');

  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Widgeti</div>
      ${Object.entries(widgetNames).map(([key, name]) => {
        const enabled = savedPrefs[key] !== undefined ? savedPrefs[key] : true;
        return `
          <div class="settings-row">
            <div><div class="settings-row-label">${name}</div></div>
            <label class="toggle">
              <input type="checkbox" data-widget-key="${key}" ${enabled ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>`;
      }).join('')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Lokacija</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Automatska detekcija</div>
          <div class="settings-row-sublabel">Koristi GPS za lokaciju</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${cfg.location?.auto_detect ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">GitHub vijesti (on-demand refresh)</div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:var(--sp-2)">
        <div>
          <div class="settings-row-label">GitHub Personal Access Token</div>
          <div class="settings-row-sublabel">Potrebno za pokretanje GitHub Actions job-a koji povuče svježe vijesti s interneta. Token treba <code style="font-size:10px;color:var(--accent)">repo</code> ili <code style="font-size:10px;color:var(--accent)">workflow</code> scope.</div>
        </div>
        <div style="display:flex;gap:var(--sp-2);margin-top:2px">
          <input type="password" id="settings-github-pat"
            class="modal-input" style="flex:1;font-size:12px"
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            value="${localStorage.getItem('dashboard_github_pat') || ''}">
          <button class="btn-secondary" id="settings-github-pat-save" style="font-size:12px;padding:6px 12px">Spremi</button>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">O dashboardu</div>
      <div class="settings-row">
        <div class="settings-row-label">Verzija</div>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">1.2.0</span>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Automatski refresh</div>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">07:00 svaki dan</span>
      </div>
    </div>`;

  container.querySelectorAll('[data-widget-key]').forEach(input => {
    input.addEventListener('change', () => {
      const prefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');
      prefs[input.dataset.widgetKey] = input.checked;
      localStorage.setItem('dashboard_prefs', JSON.stringify(prefs));
      const section = document.querySelector(`[data-widget="${input.dataset.widgetKey}"]`);
      if (section) section.style.display = input.checked ? '' : 'none';
    });
  });

  container.querySelector('#settings-github-pat-save')?.addEventListener('click', () => {
    const val = container.querySelector('#settings-github-pat')?.value?.trim() ?? '';
    if (val) {
      localStorage.setItem('dashboard_github_pat', val);
      showToast('GitHub PAT spremljen', 'success');
    } else {
      localStorage.removeItem('dashboard_github_pat');
      showToast('GitHub PAT obrisan', 'info');
    }
  });
}

// ─── TOPBAR HANDLERS ──────────────────────────────────────────────────────────
function attachTopbarHandlers() {
  document.getElementById('refresh-all-btn')?.addEventListener('click', refreshAll);

  const prefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');
  Object.entries(prefs).forEach(([key, visible]) => {
    const section = document.querySelector(`[data-widget="${key}"]`);
    if (section) section.style.display = visible ? '' : 'none';
  });
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── WEATHER HELPERS ──────────────────────────────────────────────────────────
// Inline SVG weather icons — no CDN dependency, works offline, correct colors:
//   sun=yellow/amber, clouds=gray (light→dark by severity),
//   rain drops=blue, snowflake=ice-blue, lightning=yellow, fog=gray lines.
// class="wx-emoji" + CSS height:1em → scales with parent font-size.

/* Reusable cloud paths (viewBox 0 0 32 32) */
const _CL  = 'M4,25 Q4,19 9,19 Q9,13 16,13 Q23,13 23,19 Q27,19 27,25Z'; // large
const _CM  = 'M4,23 Q4,17 9,17 Q9,11 16,11 Q23,11 23,17 Q27,17 27,23Z'; // medium (used for rain/storm)
const _CS  = 'M3,26 Q3,21 7,21 Q7,16 12,16 Q17,16 17,21 Q20.5,21 20.5,26Z'; // small (partly cloudy)

/* Sun rays helper — 8 lines from inner radius ri to outer radius ro */
function _rays(cx, cy, ri, ro, sw = 1.8) {
  return [0,45,90,135,180,225,270,315].map(deg => {
    const r = deg * Math.PI / 180;
    return `<line x1="${(cx+ri*Math.cos(r)).toFixed(1)}" y1="${(cy+ri*Math.sin(r)).toFixed(1)}" x2="${(cx+ro*Math.cos(r)).toFixed(1)}" y2="${(cy+ro*Math.sin(r)).toFixed(1)}" stroke-width="${sw}"/>`;
  }).join('');
}

/* 3 rain drops, evenly spaced below a cloud */
const _DROPS = `<g fill="#4A9EDE"><ellipse cx="9" cy="27.5" rx="1.4" ry="2.2"/><ellipse cx="16" cy="28.5" rx="1.4" ry="2.2"/><ellipse cx="23" cy="27.5" rx="1.4" ry="2.2"/></g>`;
const _DROPS_SM = `<g fill="#4A9EDE"><ellipse cx="7" cy="28" rx="1.2" ry="1.9"/><ellipse cx="12" cy="29" rx="1.2" ry="1.9"/><ellipse cx="17" cy="28" rx="1.2" ry="1.9"/></g>`;

/* 2 small snowflake marks (cross + X) below a cloud */
function _snowMark(cx, cy) {
  return `<g stroke="#A8CCDF" stroke-width="1.8" stroke-linecap="round"><line x1="${cx}" y1="${cy-3}" x2="${cx}" y2="${cy+3}"/><line x1="${cx-3}" y1="${cy}" x2="${cx+3}" y2="${cy}"/><line x1="${cx-2.1}" y1="${cy-2.1}" x2="${cx+2.1}" y2="${cy+2.1}"/><line x1="${cx+2.1}" y1="${cy-2.1}" x2="${cx-2.1}" y2="${cy+2.1}"/></g>`;
}

function _svg(body) {
  return `<svg class="wx-emoji" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/* ── Icon definitions ─────────────────────────────────────────────────────── */
const _WX_SVG = {

  /* ☀️  clear sky — amber circle + 8 rays */
  sun: _svg(
    `<circle cx="16" cy="16" r="6" fill="#FFC107"/>` +
    `<g stroke="#FFC107" stroke-linecap="round">${_rays(16,16,8.5,13)}</g>`
  ),

  /* 🌤️  partly cloudy — small yellow sun (top-right) + light gray cloud */
  pSun: _svg(
    `<circle cx="23" cy="9" r="4.5" fill="#FFC107"/>` +
    `<g stroke="#FFC107" stroke-linecap="round">${_rays(23,9,6.5,9.5,1.5)}</g>` +
    `<path d="${_CS}" fill="#D0D0D0"/>`
  ),

  /* ☁️  overcast — single light-gray cloud */
  cloud: _svg(`<path d="${_CL}" fill="#C0C0C0"/>`),

  /* 🌫️  fog — 3 gray horizontal bars */
  fog: _svg(
    `<g stroke="#A8A8A8" stroke-width="3" stroke-linecap="round">` +
    `<line x1="4" y1="10" x2="28" y2="10"/>` +
    `<line x1="4" y1="17" x2="28" y2="17"/>` +
    `<line x1="4" y1="24" x2="23" y2="24"/>` +
    `</g>`
  ),

  /* 🌦️  drizzle — sun + medium-gray cloud + light blue drops */
  dzl: _svg(
    `<circle cx="24" cy="8" r="4" fill="#FFC107"/>` +
    `<g stroke="#FFC107" stroke-linecap="round">${_rays(24,8,6,9,1.4)}</g>` +
    `<path d="${_CS}" fill="#A8A8A8"/>` +
    _DROPS_SM
  ),

  /* 🌧️  rain — medium-gray cloud + blue drops */
  rain: _svg(`<path d="${_CM}" fill="#888888"/>` + _DROPS),

  /* ❄️  snow — ice-blue snowflake */
  snow: _svg(
    `<g stroke="#7BAECB" stroke-width="2.2" stroke-linecap="round">` +
    `<line x1="16" y1="3" x2="16" y2="29"/>` +
    `<line x1="3" y1="16" x2="29" y2="16"/>` +
    `<line x1="6.5" y1="6.5" x2="25.5" y2="25.5"/>` +
    `<line x1="25.5" y1="6.5" x2="6.5" y2="25.5"/>` +
    `<line x1="16" y1="3" x2="12.5" y2="6.5"/><line x1="16" y1="3" x2="19.5" y2="6.5"/>` +
    `<line x1="16" y1="29" x2="12.5" y2="25.5"/><line x1="16" y1="29" x2="19.5" y2="25.5"/>` +
    `<line x1="3" y1="16" x2="6.5" y2="12.5"/><line x1="3" y1="16" x2="6.5" y2="19.5"/>` +
    `<line x1="29" y1="16" x2="25.5" y2="12.5"/><line x1="29" y1="16" x2="25.5" y2="19.5"/>` +
    `</g>`
  ),

  /* 🌨️  snow showers — medium-gray cloud + snowflake marks */
  snowSh: _svg(
    `<path d="${_CM}" fill="#909090"/>` +
    _snowMark(10, 27) + _snowMark(22, 27)
  ),

  /* 🌩️  thunderstorm — dark cloud + yellow lightning + blue rain drops */
  storm: _svg(
    `<path d="${_CM}" fill="#505050"/>` +
    `<path d="M17,22 L13,29 L17.5,29 L13.5,32 L22,24 L17.5,24 L20.5,22Z" fill="#FFD700"/>` +
    `<g fill="#4A9EDE">` +
    `<ellipse cx="7" cy="26" rx="1.3" ry="2"/>` +
    `<ellipse cx="7" cy="30" rx="1.3" ry="2"/>` +
    `<ellipse cx="11" cy="25" rx="1.3" ry="2"/>` +
    `<ellipse cx="11" cy="29" rx="1.3" ry="2"/>` +
    `</g>`
  ),

  /* 🌡️  thermometer — fallback */
  thermo: _svg(
    `<rect x="14" y="5" width="4" height="17" rx="2" fill="#B0B0B0"/>` +
    `<circle cx="16" cy="24" r="5" fill="#E53935"/>` +
    `<rect x="14" y="14" width="4" height="8" fill="#E53935"/>`
  ),
};

export function weatherCodeToEmoji(code) {
  if (code === 0)  return _WX_SVG.sun;
  if (code <= 2)   return _WX_SVG.pSun;
  if (code === 3)  return _WX_SVG.cloud;
  if (code <= 48)  return _WX_SVG.fog;
  if (code <= 57)  return _WX_SVG.dzl;
  if (code <= 67)  return _WX_SVG.rain;
  if (code <= 77)  return _WX_SVG.snow;
  if (code <= 82)  return _WX_SVG.rain;   // 80-82 rain showers (not drizzle)
  if (code <= 86)  return _WX_SVG.snowSh;
  if (code <= 99)  return _WX_SVG.storm;
  return _WX_SVG.thermo;
}

export function weatherCodeToText(code) {
  if (code === 0)  return 'Vedro';
  if (code === 1)  return 'Pretežno vedro';
  if (code === 2)  return 'Djelomično oblačno';
  if (code === 3)  return 'Oblačno';
  if (code <= 48)  return 'Magla';
  if (code <= 57)  return 'Rosulja';
  if (code <= 65)  return 'Kiša';
  if (code <= 67)  return 'Ledena kiša';
  if (code <= 77)  return 'Snijeg';
  if (code <= 82)  return 'Pljuskovi';
  if (code <= 86)  return 'Snježni pljuskovi';
  if (code <= 99)  return 'Grmljavina';
  return 'Nepoznato';
}

// ─── AUTO REFRESH ─────────────────────────────────────────────────────────────
// Refreshes the page at :10 past each hour from 07:10 to 22:10 (data update window).
function scheduleAutoRefresh() {
  const now   = new Date();
  const nowMs = now.getTime();

  // Try each refresh slot today (07:10 … 22:10)
  for (let h = 7; h <= 22; h++) {
    const t = new Date(now);
    t.setHours(h, 10, 0, 0);
    if (t.getTime() > nowMs) {
      const delay = t.getTime() - nowMs;
      setTimeout(() => location.reload(), delay);
      console.log(`[autoRefresh] next reload at ${t.toLocaleTimeString('hr-HR')} (in ${Math.round(delay/60000)} min)`);
      return;
    }
  }
  // All today's slots passed → schedule first slot tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 10, 0, 0);
  const delay = tomorrow.getTime() - nowMs;
  setTimeout(() => location.reload(), delay);
  console.log(`[autoRefresh] next reload at 07:10 tomorrow (in ${Math.round(delay/60000)} min)`);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { init(); scheduleAutoRefresh(); });
