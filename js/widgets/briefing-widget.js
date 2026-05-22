import { escapeHtml, formatDate } from '../utils/helpers.js';

const CATEGORY_ICONS = {
  hr:      '🇭🇷',
  tech:    '💻',
  ai:      '🤖',
  science: '🔬',
  space:   '🚀',
  sport:   '⚽',
  economy: '📈',
  weather: '☀️',
  world:   '🌍',
  default: '•',
};

export function renderBriefing(data) {
  const el = document.getElementById('widget-briefing');
  if (!el) return;

  el.classList.remove('loading');

  if (!data || (!data.summary && !data.bullets?.length)) {
    el.innerHTML = emptyState();
    return;
  }

  const dateStr = data.date
    ? formatDate(new Date(data.date))
    : formatDate(new Date());

  const isAI = data.ai_generated === true;
  const badgeHtml = isAI
    ? '<span class="briefing-badge briefing-badge-ai">✦ AI</span>'
    : '<span class="briefing-badge briefing-badge-rule">Auto</span>';

  const genTime = data.generated_at
    ? new Date(data.generated_at).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })
    : null;

  const bulletsHtml = (data.bullets ?? []).map(b => {
    const icon = b.icon || CATEGORY_ICONS[b.category] || CATEGORY_ICONS.default;
    return `
      <li class="briefing-bullet">
        <span class="briefing-bullet-icon">${icon}</span>
        <span class="briefing-bullet-text">${escapeHtml(b.text)}</span>
      </li>`;
  }).join('');

  el.innerHTML = `
    <div class="briefing-header">
      <div class="briefing-header-left">
        <h2 class="briefing-title">Jutarnji pregled</h2>
        <div class="briefing-meta">
          <span class="briefing-date-str">${dateStr}</span>
          ${badgeHtml}
          ${genTime ? `<span class="briefing-date-str">Generirano u ${genTime}</span>` : ''}
        </div>
      </div>
      <div class="briefing-header-right">
        <button class="btn-icon" id="briefing-refresh-btn" title="Osvježi sažetak">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M12 2A6 6 0 1 1 6 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9 1l3 1-1 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>

    ${data.summary ? `<p class="briefing-summary">${escapeHtml(data.summary)}</p>` : ''}

    ${bulletsHtml ? `<ul class="briefing-bullets">${bulletsHtml}</ul>` : ''}

    <div class="briefing-footer">
      ${data.weather_note ? `<span class="briefing-weather-note">${escapeHtml(data.weather_note)}</span>` : '<span></span>'}
      <span class="briefing-footer-meta">GitHub Actions · svako jutro u 7:00</span>
    </div>`;

  el.querySelector('#briefing-refresh-btn')?.addEventListener('click', async () => {
    const btn = el.querySelector('#briefing-refresh-btn');
    btn?.classList.add('spinning');
    // Bust data cache and reload
    const { bustCache }     = await import('../api/data-loader.js');
    const { loadDataFile }  = await import('../api/data-loader.js');
    bustCache('data/briefing.json');
    try {
      const fresh = await loadDataFile('data/briefing.json');
      renderBriefing(fresh);
    } catch {
      // Generate rule-based summary from cached news
      const ruleData = await generateRuleBased();
      renderBriefing(ruleData);
    }
    btn?.classList.remove('spinning');
  });
}

async function generateRuleBased() {
  const bullets = [];
  const sources = [
    { key: 'data/hr-news.json',      cat: 'hr' },
    { key: 'data/tech-news.json',    cat: 'tech' },
    { key: 'data/science-news.json', cat: 'science' },
  ];

  for (const src of sources) {
    try {
      const { loadDataFile } = await import('../api/data-loader.js');
      const d = await loadDataFile(src.key);
      const items = d?.items?.slice(0, 2) ?? [];
      items.forEach(item => {
        bullets.push({ category: src.cat, text: item.title });
      });
    } catch { /* source unavailable */ }
  }

  return {
    date: new Date().toISOString().split('T')[0],
    generated_at: new Date().toISOString(),
    ai_generated: false,
    summary: 'Automatizirani sažetak vijesti ovog jutra.',
    bullets,
    weather_note: null,
  };
}

function emptyState() {
  return `
    <div class="briefing-header">
      <div class="briefing-header-left">
        <h2 class="briefing-title">Jutarnji pregled</h2>
        <div class="briefing-meta">
          <span class="briefing-date-str">${formatDate(new Date())}</span>
        </div>
      </div>
    </div>
    <div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-title">Sažetak još nije generiran</div>
      <div class="empty-state-desc">
        Postavi GitHub Actions workflow za automatsko generiranje svakog jutra.
        Pogledaj README za upute.
      </div>
    </div>`;
}
