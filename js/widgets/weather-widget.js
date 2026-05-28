import { weatherCodeToEmoji, weatherCodeToText } from '../app.js';
import { formatTimeShort, dayName } from '../utils/helpers.js';

export function renderWeather(data, location) {
  const el = document.getElementById('widget-weather');
  if (!el) return;

  if (!data?.current) {
    el.innerHTML = emptyState();
    return;
  }

  const c    = data.current;
  const d    = data.daily;
  const h    = data.hourly;
  const city = location?._city || location?.default_city || 'Zagreb';

  const icon      = weatherCodeToEmoji(c.weathercode);
  const condition = weatherCodeToText(c.weathercode);
  const temp      = Math.round(c.temperature_2m);
  const feelsLike = Math.round(c.apparent_temperature);
  const windDir   = degreesToArrow(c.wind_direction_10m);
  const windSpd   = Math.round(c.wind_speed_10m);
  const humidity  = c.relative_humidity_2m;

  const sunrise = d?.sunrise?.[0] ? formatTimeShort(new Date(d.sunrise[0])) : '--:--';
  const sunset  = d?.sunset?.[0]  ? formatTimeShort(new Date(d.sunset[0]))  : '--:--';

  // "osvježeno:" timestamp
  const fetchedAt  = data._fetchedAt ? new Date(data._fetchedAt) : new Date();
  const updatedStr = fetchedAt.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });

  // ── Hourly strip (next 12 h from current hour) ─────────────────────────────
  const hourlyHtml = buildHourlyStrip(h);

  // ── 7-day forecast ─────────────────────────────────────────────────────────
  const shortDays = ['Ned','Pon','Uto','Sri','Čet','Pet','Sub'];
  const dailyHtml = (d?.time ?? []).slice(0, 7).map((dateStr, i) => {
    const date    = new Date(dateStr + 'T12:00:00');
    const name    = i === 0 ? 'Danas' : shortDays[date.getDay()];
    const dayIcon = weatherCodeToEmoji(d.weathercode[i]);
    const max     = Math.round(d.temperature_2m_max[i]);
    const min     = Math.round(d.temperature_2m_min[i]);
    const rain    = d.precipitation_probability_max?.[i] ?? 0;
    return `
      <div class="weather-7day-row">
        <span class="weather-7day-name${i === 0 ? ' is-today' : ''}">${name}</span>
        <span class="weather-7day-icon">${dayIcon}</span>
        ${rain >= 25 ? `<span class="weather-7day-rain">${rain}%</span>` : '<span class="weather-7day-rain"></span>'}
        <span class="weather-7day-temps">
          <span class="weather-7day-max">${max}°</span>
          <span class="weather-7day-min">${min}°</span>
        </span>
      </div>`;
  }).join('');

  el.classList.remove('loading');
  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label widget-label-icon">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="2.5" fill="currentColor"/>
          <path d="M6 1V0M6 12v-1M1 6H0M12 6h-1M2.1 2.1l-.7-.7M10.6 10.6l-.7-.7M2.1 9.9l-.7.7M10.6 1.4l-.7.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        VRIJEME
      </span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="weather-updated">(osvježeno: ${updatedStr})</span>
        <button class="btn-icon" id="weather-refresh-btn" title="Osvježi">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 2A5.5 5.5 0 1 1 5.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 1l3 1-1 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>

    <div class="weather-body">
      <div class="weather-compact-top">
        <span class="weather-compact-icon">${icon}</span>
        <div class="weather-compact-info">
          <div class="weather-compact-temp">${temp}<span class="weather-compact-temp-unit">°</span></div>
          <div class="weather-compact-condition">${condition}</div>
          <div class="weather-compact-loc">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M5 1C3.3 1 2 2.3 2 4c0 2.5 3 5 3 5s3-2.5 3-5c0-1.7-1.3-3-3-3zm0 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" fill="currentColor"/></svg>
            ${city}
          </div>
        </div>
        <div class="weather-compact-stats">
          <span class="weather-stat-pill"><span class="weather-stat-pill-icon">🌡️</span> ${feelsLike}°</span>
          <span class="weather-stat-pill"><span class="weather-stat-pill-icon">💧</span> ${humidity}%</span>
          <span class="weather-stat-pill"><span class="weather-stat-pill-icon">💨</span> ${windSpd} km/h ${windDir}</span>
        </div>
      </div>

      ${hourlyHtml ? `
      <div class="weather-section-label" style="margin-top:var(--sp-3)">Narednih 12 h</div>
      <div class="weather-hourly">${hourlyHtml}</div>` : ''}

      <div class="weather-sun-compact" style="margin-top:var(--sp-3)">
        <div class="weather-sun-compact-item">☀️ ${sunrise}</div>
        <div class="weather-sun-compact-item">🌇 ${sunset}</div>
      </div>

      <div class="weather-section-label">7 dana</div>
      <div class="weather-7day">${dailyHtml}</div>
    </div>`;

  el.querySelector('#weather-refresh-btn')?.addEventListener('click', async () => {
    el.innerHTML = headerHtmlOnly() + '<div class="sk sk-block" style="height:200px"></div>';
    el.classList.add('loading');
    const { cache }           = await import('../utils/cache.js');
    const { fetchWeatherData } = await import('../api/weather-api.js');
    cache.remove('weather_data');
    try {
      const fresh      = await fetchWeatherData(location.lat ?? location.lat, location.lon ?? location.lon);
      fresh._city      = city;
      fresh._fetchedAt = Date.now();
      cache.set('weather_data', fresh, 30 * 60 * 1000);
      renderWeather(fresh, { ...location, _city: city });
    } catch {
      el.classList.remove('loading');
      el.innerHTML = headerHtmlOnly() + '<div class="error-state">⚠ Greška pri osvježavanju</div>';
    }
  });
}

// ── Hourly strip — next 12 hours from current local hour ──────────────────────
function buildHourlyStrip(hourly) {
  if (!hourly?.time?.length) return '';

  // Match current local hour to Open-Meteo time strings (local tz)
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const curStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  const start  = hourly.time.indexOf(curStr);
  if (start < 0) return '';  // current hour not found in data

  return hourly.time.slice(start, start + 12).map((t, i) => {
    const idx  = start + i;
    const code = hourly.weathercode[idx];
    const temp = Math.round(hourly.temperature_2m[idx]);
    const rain = hourly.precipitation_probability?.[idx] ?? 0;
    const hhmm = t.slice(11, 16);          // "HH:MM"
    const icon = weatherCodeToEmoji(code);
    const now_ = i === 0;
    return `
      <div class="weather-hour-item${now_ ? ' is-now' : ''}">
        <span class="weather-hour-time">${now_ ? 'sad' : hhmm}</span>
        <span class="weather-hour-icon">${icon}</span>
        <span class="weather-hour-temp">${temp}°</span>
        ${rain >= 30 ? `<span class="weather-hour-rain">${rain}%</span>` : ''}
      </div>`;
  }).join('');
}

function degreesToArrow(deg) {
  if (deg === undefined) return '';
  const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
  return arrows[Math.round(deg / 45) % 8];
}

function headerHtmlOnly() {
  return `
    <div class="widget-header">
      <span class="widget-label">VRIJEME</span>
    </div>`;
}

function emptyState() {
  return `
    ${headerHtmlOnly()}
    <div class="empty-state">
      <div class="empty-state-icon">🌤️</div>
      <div class="empty-state-title">Nema podataka</div>
      <div class="empty-state-desc">Provjera internetske veze...</div>
    </div>`;
}
