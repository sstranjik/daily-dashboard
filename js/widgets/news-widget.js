import { escapeHtml, truncate, stripHtml, timeAgo } from '../utils/helpers.js';

const CATEGORY_COLORS = {
  politika: 'tag-blue',
  ekonomija:'tag-orange',
  tech:     'tag-blue',
  ai:       'tag-blue',
  sport:    'tag-green',
  kultura:  'tag-gray',
  zdravlje: 'tag-green',
  default:  'tag-gray',
};

export function renderNews(containerId, { title, label, data, config }) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.classList.remove('loading');

  if (!data?.items?.length) {
    el.innerHTML = noDataState(label, title);
    return;
  }

  const maxItems  = config?.max_items ?? 12;
  const showSummary = config?.show_summary !== false;
  const items     = deduplicateByTitle(data.items).slice(0, maxItems);
  const initialShow = 5;

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">${escapeHtml(label)}</span>
      <div class="widget-actions">
        <button class="btn-icon widget-refresh" data-container="${containerId}" title="Osvježi">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 2A5.5 5.5 0 1 1 5.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 1l3 1-1 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="news-list" id="${containerId}-list">
      ${items.slice(0, initialShow).map(item => renderCard(item, showSummary)).join('')}
    </div>
    ${items.length > initialShow ? `
      <button class="news-load-more" data-total="${items.length}" data-shown="${initialShow}">
        Prikaži više (${items.length - initialShow})
      </button>` : ''}`;

  // "Load more" expand
  const loadMore = el.querySelector('.news-load-more');
  if (loadMore) {
    loadMore.addEventListener('click', () => {
      const list   = el.querySelector('.news-list');
      const shown  = parseInt(loadMore.dataset.shown);
      const total  = parseInt(loadMore.dataset.total);
      const next   = Math.min(shown + 5, total);
      items.slice(shown, next).forEach(item => {
        list.insertAdjacentHTML('beforeend', renderCard(item, showSummary));
      });
      loadMore.dataset.shown = next;
      if (next >= total) loadMore.remove();
      else loadMore.textContent = `Prikaži više (${total - next})`;
    });
  }

  // Last updated footer
  if (data.last_updated) {
    const footer = document.createElement('p');
    footer.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right';
    footer.textContent = `Osvježeno ${timeAgo(new Date(data.last_updated))}`;
    el.appendChild(footer);
  }

  // Manual refresh button
  el.querySelector('.widget-refresh')?.addEventListener('click', async (e) => {
    e.currentTarget.classList.add('spinning');
    await new Promise(r => setTimeout(r, 800)); // cosmetic delay
    e.currentTarget.classList.remove('spinning');
    import('../app.js').then(m => m.showToast('Vijesti se osvježavaju svako jutro automatski.', 'info'));
  });
}

function renderCard(item, showSummary) {
  const summary = showSummary && item.summary
    ? truncate(stripHtml(item.summary), 140)
    : null;

  const tags = (item.tags ?? [item.category]).filter(Boolean).slice(0, 2);
  const tagsHtml = tags.map(t =>
    `<span class="tag ${CATEGORY_COLORS[t?.toLowerCase()] ?? CATEGORY_COLORS.default}">${escapeHtml(t)}</span>`
  ).join('');

  const timeStr = item.published ? timeAgo(new Date(item.published)) : '';

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
        <div class="news-tags">${tagsHtml}</div>
        ${item.link ? `<a href="${escapeHtml(item.link)}" class="news-read-more" target="_blank" rel="noopener noreferrer">Čitaj →</a>` : ''}
      </div>
    </article>`;
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

function noDataState(label, title) {
  return `
    <div class="widget-header"><span class="widget-label">${escapeHtml(label)}</span></div>
    <div class="empty-state">
      <div class="empty-state-icon">📰</div>
      <div class="empty-state-title">Nema vijesti</div>
      <div class="empty-state-desc">
        Postavi GitHub Actions workflow za automatsko dohvaćanje vijesti.
        Podaci se generiraju jednom dnevno.
      </div>
    </div>`;
}
