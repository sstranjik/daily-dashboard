let _config = null;

export async function loadConfig() {
  if (_config) return _config;
  try {
    const res = await fetch('./config.json');
    if (!res.ok) throw new Error('config.json not found');
    _config = await res.json();
  } catch {
    _config = getDefaultConfig();
  }

  // Merge saved user prefs
  const prefs = JSON.parse(localStorage.getItem('dashboard_prefs') || '{}');
  Object.entries(prefs).forEach(([key, enabled]) => {
    if (_config.widgets[key]) _config.widgets[key].enabled = enabled;
  });

  return _config;
}

export function applyWidgetVisibility(config) {
  Object.entries(config.widgets).forEach(([key, cfg]) => {
    if (!cfg.enabled) {
      const section = document.querySelector(`[data-widget="${key}"]`);
      if (section) section.style.display = 'none';
    }
  });
}

function getDefaultConfig() {
  return {
    site: { title: 'Dashboard', timezone: 'Europe/Zagreb', language: 'hr' },
    location: { default_city: 'Zagreb', lat: 45.815, lon: 15.9819, auto_detect: true },
    widgets: {
      calendar: { enabled: true, order: 1 },
      tasks:    { enabled: true, order: 2 },
      weather:  { enabled: true, order: 3 },
      briefing: { enabled: true, order: 4 },
      news:     { enabled: true, order: 5 },
    },
    news: {
      max_items: 20, max_age_hours: 48, deduplicate: true, show_summary: true,
      tabs: [
        { key: 'hr',      label: 'HR Vijesti', file: 'data/hr-news.json'      },
        { key: 'tech',    label: 'Tech / AI',  file: 'data/tech-news.json'    },
        { key: 'science', label: 'Znanost',    file: 'data/science-news.json' },
        { key: 'sport',   label: 'Sport',      file: 'data/sports.json'       },
        { key: 'zbivanja', label: 'Zbivanja', file: 'data/zbivanja.json'        },
        { key: 'ostalo',   label: 'Ostalo',   files: [],  catch_all: true     },
      ],
    },
    weather: { units: 'celsius', hourly_count: 8, forecast_days: 3 },
    refresh: { weather_interval_min: 30, auto_refresh_news: false },
    theme:   { mode: 'dark', accent: '#58a6ff' },
    google:  { client_id: '' },
  };
}
