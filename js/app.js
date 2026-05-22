import { loadConfig, applyWidgetVisibility } from './config.js';
import { initAuth }            from './auth.js';
import { cache }               from './utils/cache.js';
import { timeAgo, formatDate } from './utils/helpers.js';
import { fetchWeatherData }    from './api/weather-api.js';
import { loadDataFile }        from './api/data-loader.js';
import { initClock }           from './widgets/clock-widget.js';
import { renderWeather }       from './widgets/weather-widget.js';
import { renderBriefing }      from './widgets/briefing-widget.js';
import { renderNews }          from './widgets/news-widget.js';
import { renderSports }        from './widgets/sports-widget.js';
import { renderProductivity }  from './widgets/productivity-widget.js';

// ─── STATE ───────────────────────────────────────────────────────────────────
let appConfig = null;
let isRefreshing = false;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  appConfig = await loadConfig();
  applyWidgetVisibility(appConfig);
  initClock();
  initAuth(appConfig);
  attachTopbarHandlers();
  attachSettingsPanel(appConfig);

  // Load all data in parallel, don't let one failure block others
  const [briefing, hrNews, techNews, science, sports, metadata] = await Promise.allSettled([
    loadDataFile('data/briefing.json'),
    loadDataFile('data/hr-news.json'),
    loadDataFile('data/tech-news.json'),
    loadDataFile('data/science-news.json'),
    loadDataFile('data/sports.json'),
    loadDataFile('data/metadata.json'),
  ]);

  renderBriefing(briefing.status === 'fulfilled' ? briefing.value : null);

  renderNews('widget-hr-news', {
    title: '🇭🇷 Hrvatske vijesti',
    label: 'HR VIJESTI',
    data: hrNews.status === 'fulfilled' ? hrNews.value : null,
    config: appConfig.news,
  });

  renderNews('widget-tech', {
    title: '💻 Tech & AI',
    label: 'TECH / AI',
    data: techNews.status === 'fulfilled' ? techNews.value : null,
    config: appConfig.news,
  });

  renderNews('widget-science', {
    title: '🔬 Znanost',
    label: 'ZNANOST',
    data: science.status === 'fulfilled' ? science.value : null,
    config: appConfig.news,
  });

  renderSports(sports.status === 'fulfilled' ? sports.value : null);
  renderProductivity();

  if (metadata.status === 'fulfilled' && metadata.value) {
    updateLastUpdateBadge(metadata.value.last_updated);
  }

  // Weather is fetched live from Open-Meteo
  initWeather(appConfig.location);
}

// ─── WEATHER ──────────────────────────────────────────────────────────────────
async function initWeather(location) {
  const CACHE_KEY = 'weather_data';
  const CACHE_TTL = (appConfig.refresh?.weather_interval_min ?? 30) * 60 * 1000;

  const cached = cache.get(CACHE_KEY);
  if (cached) {
    renderWeather(cached, location);
    updateTopbarWeather(cached);
    return;
  }

  try {
    let lat = location.lat;
    let lon = location.lon;
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

    const data = await fetchWeatherData(lat, lon);
    data._city = city;
    cache.set(CACHE_KEY, data, CACHE_TTL);
    renderWeather(data, { ...location, _city: city });
    updateTopbarWeather(data);
  } catch (err) {
    console.error('Weather fetch failed:', err);
    document.getElementById('widget-weather').innerHTML = `
      <div class="widget-header">
        <span class="widget-label">WEATHER</span>
      </div>
      <div class="error-state">⚠ Nije moguće dohvatiti podatke o vremenu. Provjeri internet vezu.</div>`;
  }
}

// ─── TOPBAR WEATHER SUMMARY ───────────────────────────────────────────────────
function updateTopbarWeather(data) {
  const el = document.getElementById('topbar-weather');
  if (!el || !data?.current) return;
  const { temperature_2m, weathercode } = data.current;
  const icon = weatherCodeToEmoji(weathercode);
  el.innerHTML = `
    <span class="topbar-weather-icon">${icon}</span>
    <span class="topbar-weather-temp">${Math.round(temperature_2m)}°C</span>
    <span class="topbar-weather-desc">${weatherCodeToText(weathercode)}</span>`;
}

// ─── LAST UPDATE BADGE ────────────────────────────────────────────────────────
function updateLastUpdateBadge(isoStr) {
  const el = document.getElementById('last-update-badge');
  if (!el || !isoStr) return;
  el.textContent = `Updated ${timeAgo(new Date(isoStr))}`;
  el.removeAttribute('hidden');
}

// ─── REFRESH ALL ──────────────────────────────────────────────────────────────
async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('refresh-all-btn');
  btn?.classList.add('spinning');

  cache.remove('weather_data');
  await initWeather(appConfig.location);

  showToast('Dashboard refreshed', 'success');

  btn?.classList.remove('spinning');
  isRefreshing = false;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function attachSettingsPanel(cfg) {
  const panel   = document.getElementById('settings-panel');
  const overlay = document.getElementById('settings-overlay');
  const body    = document.getElementById('settings-body');
  const openBtn = document.getElementById('settings-btn');
  const closeBtn= document.getElementById('close-settings-btn');

  const open  = () => { panel.classList.remove('hidden'); overlay.classList.remove('hidden'); renderSettingsBody(cfg, body); };
  const close = () => { panel.classList.add('hidden'); overlay.classList.add('hidden'); };

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function renderSettingsBody(cfg, container) {
  const widgetNames = {
    briefing: 'Jutarnji pregled',
    weather: 'Vrijeme',
    hr_news: 'Hrvatske vijesti',
    tech_news: 'Tech / AI',
    science: 'Znanost',
    sports: 'Sport',
    productivity: 'Produktivnost',
  };

  const savedPrefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');

  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Widgeti</div>
      ${Object.entries(widgetNames).map(([key, name]) => {
        const enabled = savedPrefs[key] !== undefined ? savedPrefs[key] : (cfg.widgets[key]?.enabled !== false);
        return `
        <div class="settings-row">
          <div>
            <div class="settings-row-label">${name}</div>
          </div>
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
          <div class="settings-row-label">Automatski detekcija</div>
          <div class="settings-row-sublabel">Koristi GPS za lokaciju</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="pref-geolocation" ${cfg.location.auto_detect ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">O dashboardu</div>
      <div class="settings-row">
        <div class="settings-row-label">Verzija</div>
        <span style="font-size:12px;color:var(--text-muted)">1.0.0</span>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Podaci se osvježavaju</div>
        <span style="font-size:12px;color:var(--text-muted)">Svako jutro u 7:00</span>
      </div>
    </div>`;

  container.querySelectorAll('[data-widget-key]').forEach(input => {
    input.addEventListener('change', () => {
      const prefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');
      prefs[input.dataset.widgetKey] = input.checked;
      localStorage.setItem('dashboard_prefs', JSON.stringify(prefs));

      const sectionId = `section-${input.dataset.widgetKey.replace('_', '-')}`;
      const section = document.getElementById(sectionId) ||
        document.querySelector(`[data-widget="${input.dataset.widgetKey}"]`);
      if (section) section.style.display = input.checked ? '' : 'none';
    });
  });
}

// ─── EVENT HANDLERS ───────────────────────────────────────────────────────────
function attachTopbarHandlers() {
  document.getElementById('refresh-all-btn')?.addEventListener('click', refreshAll);

  // Apply saved widget visibility on load
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

// ─── WEATHER HELPERS (shared with topbar) ─────────────────────────────────────
export function weatherCodeToEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  if (code <= 99) return '⛈️';
  return '🌡️';
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

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
