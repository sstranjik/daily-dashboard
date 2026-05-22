import { weatherCodeToEmoji, weatherCodeToText } from '../app.js';
import { formatHour, dayName, formatTimeShort } from '../utils/helpers.js';

export function renderWeather(data, location) {
  const el = document.getElementById('widget-weather');
  if (!el) return;

  if (!data?.current) {
    el.innerHTML = emptyState();
    return;
  }

  const c   = data.current;
  const d   = data.daily;
  const h   = data.hourly;
  const now = new Date();
  const city = location?._city || location?.default_city || 'Zagreb';

  const icon       = weatherCodeToEmoji(c.weathercode);
  const condition  = weatherCodeToText(c.weathercode);
  const tempRound  = Math.round(c.temperature_2m);
  const feelsLike  = Math.round(c.apparent_temperature);
  const windDir    = degreesToArrow(c.wind_direction_10m);

  // Hourly: next 8 hours
  const currentHourIdx = now.getHours();
  const hourlyItems = [];
  for (let i = 0; i < 8; i++) {
    const idx = currentHourIdx + i;
    if (idx >= (h.time?.length ?? 0)) break;
    hourlyItems.push({
      time:  i === 0 ? 'Sada' : formatHour(h.time[idx]),
      icon:  weatherCodeToEmoji(h.weathercode[idx]),
      temp:  Math.round(h.temperature_2m[idx]),
      rain:  h.precipitation_probability[idx],
      isNow: i === 0,
    });
  }

  // Daily: today + next 3
  const dailyRows = (d?.time ?? []).slice(0, 4).map((dateStr, i) => ({
    name:  dayName(dateStr),
    icon:  weatherCodeToEmoji(d.weathercode[i]),
    max:   Math.round(d.temperature_2m_max[i]),
    min:   Math.round(d.temperature_2m_min[i]),
    rain:  d.precipitation_probability_max?.[i] ?? 0,
    isToday: i === 0,
  }));

  const sunrise = d?.sunrise?.[0] ? formatTimeShort(new Date(d.sunrise[0])) : '--:--';
  const sunset  = d?.sunset?.[0]  ? formatTimeShort(new Date(d.sunset[0]))  : '--:--';

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
      <div class="widget-actions">
        <button class="btn-icon weather-refresh-btn" id="weather-refresh-btn" title="Osvježi">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 2A5.5 5.5 0 1 1 5.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 1l3 1-1 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>

    <div class="weather-current">
      <div class="weather-left">
        <span class="weather-icon-main">${icon}</span>
        <span class="weather-temp-main">${tempRound}<span class="weather-temp-unit">°</span></span>
      </div>
      <div class="weather-right">
        <div class="weather-condition">${condition}</div>
        <div class="weather-location">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1C3.3 1 2 2.3 2 4c0 2.5 3 5 3 5s3-2.5 3-5c0-1.7-1.3-3-3-3zm0 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" fill="currentColor"/></svg>
          ${city}
        </div>
      </div>
    </div>

    <div class="weather-details">
      <div class="weather-detail-item">
        <span class="weather-detail-icon">🌡️</span>
        <span>Osjeti se</span>
        <span class="weather-detail-val">${feelsLike}°</span>
      </div>
      <div class="weather-detail-item">
        <span class="weather-detail-icon">💧</span>
        <span>Vlažnost</span>
        <span class="weather-detail-val">${c.relative_humidity_2m}%</span>
      </div>
      <div class="weather-detail-item">
        <span class="weather-detail-icon">💨</span>
        <span>Vjetar</span>
        <span class="weather-detail-val">${Math.round(c.wind_speed_10m)} km/h ${windDir}</span>
      </div>
      <div class="weather-detail-item">
        <span class="weather-detail-icon">🌧️</span>
        <span>Oborina</span>
        <span class="weather-detail-val">${c.precipitation ?? 0} mm</span>
      </div>
    </div>

    <div class="weather-sun-row">
      <div class="weather-sun-item">☀️ <span>Izlazak ${sunrise}</span></div>
      <div class="weather-sun-item">🌇 <span>Zalazak ${sunset}</span></div>
    </div>

    <div class="weather-section-label">Sljedećih 8 sati</div>
    <div class="weather-hourly">
      ${hourlyItems.map(h => `
        <div class="weather-hour-item${h.isNow ? ' is-now' : ''}">
          <span class="weather-hour-time">${h.time}</span>
          <span class="weather-hour-icon">${h.icon}</span>
          <span class="weather-hour-temp">${h.temp}°</span>
          ${h.rain > 0 ? `<span class="weather-hour-rain">${h.rain}%</span>` : '<span style="height:14px"></span>'}
        </div>`).join('')}
    </div>

    <div class="weather-section-label">Prognoza</div>
    <div class="weather-daily">
      ${dailyRows.map(r => `
        <div class="weather-day-row">
          <span class="weather-day-name${r.isToday ? ' is-today' : ''}">${r.name}</span>
          <span class="weather-day-icon">${r.icon}</span>
          <span class="weather-day-range">
            <span class="weather-day-max">${r.max}°</span>
            <span class="weather-day-min">${r.min}°</span>
          </span>
        </div>`).join('')}
    </div>

    <div class="weather-footer">
      <span class="weather-updated">Osvježeno: ${new Date().toLocaleTimeString('hr-HR', {hour:'2-digit',minute:'2-digit'})}</span>
    </div>`;

  // Refresh button
  el.querySelector('#weather-refresh-btn')?.addEventListener('click', async () => {
    import('../utils/cache.js').then(async ({ cache }) => {
      cache.remove('weather_data');
      el.innerHTML = '<div class="sk sk-block" style="height:200px"></div>';
      el.classList.add('loading');
      // Re-trigger weather load from app
      const { lat, lon } = location;
      const { fetchWeatherData } = await import('../api/weather-api.js');
      try {
        const fresh = await fetchWeatherData(lat, lon);
        fresh._city = city;
        const { cache: c2 } = await import('../utils/cache.js');
        c2.set('weather_data', fresh, 30 * 60 * 1000);
        renderWeather(fresh, location);
      } catch { el.innerHTML = '<div class="error-state">⚠ Greška pri osvježavanju</div>'; }
    });
  });
}

function degreesToArrow(deg) {
  if (deg === undefined) return '';
  const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
  return arrows[Math.round(deg / 45) % 8];
}

function emptyState() {
  return `
    <div class="widget-header"><span class="widget-label">VRIJEME</span></div>
    <div class="empty-state">
      <div class="empty-state-icon">🌤️</div>
      <div class="empty-state-title">Nema podataka</div>
      <div class="empty-state-desc">Provjerava se pristup internetu...</div>
    </div>`;
}
