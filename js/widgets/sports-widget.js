import { escapeHtml, timeAgo } from '../utils/helpers.js';

export function renderSports(data) {
  const el = document.getElementById('widget-sports');
  if (!el) return;

  el.classList.remove('loading');

  if (!data?.leagues?.length && !data?.matches?.length) {
    el.innerHTML = emptyState();
    return;
  }

  const leagues = data.leagues ?? [];
  const allMatches = data.matches ?? [];

  // Build tabs from leagues
  const tabs = leagues.length
    ? leagues
    : [...new Set(allMatches.map(m => m.league))].map(l => ({ id: l, name: l }));

  const activeTab = tabs[0]?.id ?? 'all';

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">⚽ SPORT</span>
    </div>
    <div class="sports-tabs">
      ${tabs.slice(0, 4).map((t, i) => `
        <button class="sports-tab${i === 0 ? ' active' : ''}" data-tab="${escapeHtml(t.id)}">
          ${escapeHtml(t.name)}
        </button>`).join('')}
    </div>
    ${tabs.slice(0, 4).map((t, i) => {
      const matches = allMatches.filter(m => !m.league || m.league === t.id);
      return `
        <div class="sports-panel${i === 0 ? ' active' : ''}" data-panel="${escapeHtml(t.id)}">
          ${matches.length ? renderMatches(matches) : `<div class="empty-state" style="padding:16px"><div class="empty-state-desc">Nema utakmica</div></div>`}
        </div>`;
    }).join('')}
    ${data.last_updated ? `<p style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right">Osvježeno ${timeAgo(new Date(data.last_updated))}</p>` : ''}`;

  // Tab switching
  el.querySelectorAll('.sports-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.sports-tab').forEach(b => b.classList.remove('active'));
      el.querySelectorAll('.sports-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      el.querySelector(`[data-panel="${btn.dataset.tab}"]`)?.classList.add('active');
    });
  });
}

function renderMatches(matches) {
  return matches.slice(0, 8).map((m, i) => {
    const isLive = m.status === 'live';
    const isUpcoming = m.status === 'upcoming' || !m.score_home;
    const scoreClass = isLive ? ' live' : isUpcoming ? ' upcoming' : '';
    const scoreText = isUpcoming
      ? (m.time || 'Uskoro')
      : `${m.score_home} : ${m.score_away}`;

    const homeWins = !isUpcoming && m.score_home > m.score_away;
    const awayWins = !isUpcoming && m.score_away > m.score_home;

    return `
      ${i > 0 ? '<div class="match-divider"></div>' : ''}
      <div class="match-item">
        <span class="match-team home${homeWins ? ' winner' : ''}">${escapeHtml(m.home)}</span>
        <span class="match-score${scoreClass}">${escapeHtml(scoreText)}</span>
        <span class="match-team${awayWins ? ' winner' : ''}">${escapeHtml(m.away)}</span>
      </div>`;
  }).join('');
}

function emptyState() {
  return `
    <div class="widget-header"><span class="widget-label">⚽ SPORT</span></div>
    <div class="empty-state">
      <div class="empty-state-icon">🏆</div>
      <div class="empty-state-title">Nema sportskih podataka</div>
      <div class="empty-state-desc">GitHub Actions će dohvatiti sportske rezultate jednom dnevno.</div>
    </div>`;
}
