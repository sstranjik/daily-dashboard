import { escapeHtml, formatDate } from '../utils/helpers.js';
import { bustCache, loadDataFile } from '../api/data-loader.js';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────
let _storesData  = null;
let _calEvents   = null;
let _weatherData = null;

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

/** Local-timezone YYYY-MM-DD (avoids UTC shift in UTC+2) */
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(dateStr + 'T00:00:00') - today) / 86_400_000);
}

function _fmtDays(n) {
  if (n === 0) return 'danas';
  if (n === 1) return 'sutra';
  return `za ${n} dana`;
}

function _birthdayName(summary) {
  return summary.replace(/\s*'s\s+birthday$/i, '').replace(/\s+birthday$/i, '').trim();
}

/** Croatian public holidays {YYYY-MM-DD: name} — uses local date to avoid UTC offset bug */
function _getCroatianHolidays(year) {
  const getEaster = y => {
    const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
          f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),
          h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
          l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
          mo=Math.floor((h+l-7*m+114)/31), dy=((h+l-7*m+114)%31)+1;
    return new Date(y, mo-1, dy);
  };
  const addD  = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
  const easter = getEaster(year);
  return {
    [`${year}-01-01`]: 'Nova godina',
    [`${year}-01-06`]: 'Bogojavljenje',
    [localISO(easter)]:            'Uskrs',
    [localISO(addD(easter,  1))]:  'Uskrsni ponedjeljak',
    [localISO(addD(easter, 60))]:  'Tijelovo',
    [`${year}-05-01`]: 'Praznik rada',
    [`${year}-05-30`]: 'Dan državnosti',
    [`${year}-06-22`]: 'Dan antifašističke borbe',
    [`${year}-08-05`]: 'Dan pobjede',
    [`${year}-08-15`]: 'Velika Gospa',
    [`${year}-11-01`]: 'Svi sveti',
    [`${year}-11-18`]: 'Dan sjećanja',
    [`${year}-12-25`]: 'Božić',
    [`${year}-12-26`]: 'Sveti Stjepan',
  };
}

// ─── EVENTS ROW ───────────────────────────────────────────────────────────────
// Builds the first content row of the briefing widget:
//   [Weather zone] | [Slot: non-working day + stores] | [Slot: birthday] | …
// Rebuilt whenever weather, calendar, or stores data changes.

/** Build chronological list of event slots for the next 7 days */
function _getEventSlots() {
  const today    = new Date(); today.setHours(0,0,0,0);
  const holidays = {
    ..._getCroatianHolidays(today.getFullYear()),
    ..._getCroatianHolidays(today.getFullYear() + 1),
  };
  const slots = [];

  // Non-working days (holidays + Sundays)
  for (let i = 0; i <= 7; i++) {
    const d   = new Date(today); d.setDate(d.getDate() + i);
    const iso = localISO(d);
    if (holidays[iso]) {
      slots.push({ type: 'holiday', date: iso, label: holidays[iso], daysUntil: i });
    } else if (d.getDay() === 0) {
      slots.push({ type: 'sunday',  date: iso, label: 'Nedjelja',    daysUntil: i });
    }
  }

  // Birthdays from calendar
  for (const ev of (_calEvents ?? [])) {
    if (!ev._isBirthday) continue;
    const dk = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
    if (!dk) continue;
    const n = _daysUntil(dk);
    if (n < 0 || n > 7) continue;
    slots.push({ type: 'birthday', date: dk, label: _birthdayName(ev.summary || ''), daysUntil: n });
  }

  // Sort chronologically; birthday before non-working day on same date
  slots.sort((a, b) => a.daysUntil - b.daysUntil || (a.type === 'birthday' ? -1 : 1));

  // Deduplicate (same date + same type)
  const seen = new Set();
  return slots.filter(s => {
    const k = `${s.type}|${s.date}|${s.label}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/** Open stores for a specific date, sorted by distance */
function _storesForDate(date) {
  return (_storesData?.stores ?? [])
    .map(s => ({ ...s, dayHours: (s.hours ?? []).find(h => h.date === date && h.open) }))
    .filter(s => s.dayHours)
    .sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
}

/** Build HTML for one slot */
function _buildSlot(slot) {
  const when = _fmtDays(slot.daysUntil);
  const icon = slot.type === 'birthday' ? '🎂' : '🗓';

  let row2 = '';
  if (slot.type !== 'birthday') {
    const stores = _storesForDate(slot.date);
    if (stores.length === 0) {
      row2 = `<div class="brf-slot-no-store">—</div>`;
    } else {
      const label = `${stores.length} otvorenih trgovina`;
      const items = stores.map(s => {
        const addr    = s.address ? s.address.split(',')[0].trim() : (s.dist != null ? `~${s.dist}m` : '');
        const timeStr = s.dayHours.time || '';
        const mapsUrl = s.lat && s.lon
          ? `https://maps.google.com/?q=${s.lat},${s.lon}`
          : `https://maps.google.com/?q=${encodeURIComponent(s.name + ' Zagreb')}`;
        return `<a class="brf-slot-dd-item" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">
          <span class="brf-sstore-name">${escapeHtml(s.name)}</span>
          ${addr ? `<span class="brf-sstore-addr">${escapeHtml(addr)}</span>` : ''}
          ${timeStr ? `<span class="brf-sstore-time">${escapeHtml(timeStr)}</span>` : ''}
        </a>`;
      }).join('');

      row2 = `<div class="brf-slot-dropdown">
        <button class="brf-slot-dd-btn" aria-expanded="false">
          <span>${escapeHtml(label)}</span>
          <span class="brf-slot-dd-arrow">▼</span>
        </button>
        <div class="brf-slot-dd-list" hidden>${items}</div>
      </div>`;
    }
  }

  return `<div class="brf-slot" data-type="${slot.type}">
    <div class="brf-slot-row1">
      <span class="brf-slot-icon">${icon}</span>
      <span class="brf-slot-label">${escapeHtml(slot.label)}</span>
      <span class="brf-slot-when">${escapeHtml(when)}</span>
    </div>
    ${row2 ? `<div class="brf-slot-row2">${row2}</div>` : ''}
  </div>`;
}

/** Attach dropdown toggles for store lists */
function _attachDropdowns(row) {
  row.querySelectorAll('.brf-slot-dd-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const list     = btn.nextElementSibling;
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.querySelector('.brf-slot-dd-arrow').textContent = expanded ? '▼' : '▲';
      if (expanded) list.setAttribute('hidden', '');
      else          list.removeAttribute('hidden');
    });
  });
}

/** Attach left/right slot navigation (moves 1 slot per click, arrows visible on hover) */
function _attachSlotsNav(row) {
  const viewport = row.querySelector('.brf-slots-viewport');
  const slotsCnt = row.querySelector('.brf-slots');
  const prevBtn  = row.querySelector('.brf-slots-prev');
  const nextBtn  = row.querySelector('.brf-slots-next');
  if (!slotsCnt || !viewport) return;

  const slots = [...slotsCnt.querySelectorAll('.brf-slot')];
  if (slots.length <= 1) {
    prevBtn?.remove(); nextBtn?.remove(); return;
  }

  let offset = 0;
  const update = () => {
    const slotW   = slots[0]?.offsetWidth + 1 || 180; // +1 for border
    const visible = Math.floor(viewport.offsetWidth / slotW);
    const maxOff  = Math.max(0, slots.length - visible);
    offset = Math.max(0, Math.min(offset, maxOff));
    slotsCnt.style.transform = `translateX(-${offset * slotW}px)`;
    if (prevBtn) prevBtn.disabled = offset === 0;
    if (nextBtn) nextBtn.disabled = offset >= maxOff;
  };
  prevBtn?.addEventListener('click', () => { offset--; update(); });
  nextBtn?.addEventListener('click', () => { offset++; update(); });
  setTimeout(update, 0); // after render
}

/** Rebuild the events row from current state (_weatherData, _calEvents, _storesData) */
function _rebuildEventsRow() {
  const el  = document.getElementById('widget-briefing');
  const row = el?.querySelector('#brf-events-row');
  if (!row) return;

  // Weather zone
  const w     = _weatherData;
  const icon  = w?.icon ?? '🌡️';
  const summ  = w?.summary ?? '';
  const tMatch = summ.match(/^([\d,.\s-]+°C)/);
  const temp   = tMatch ? tMatch[1].trim() : summ.split(',')[0].trim();
  const cond   = (tMatch ? summ.slice(tMatch[0].length) : summ.split(',').slice(1).join(',')).replace(/^[,\s]+/, '').trim();

  // Event slots
  const slots    = _getEventSlots();
  const slotsHtml = slots.map(_buildSlot).join('');

  row.innerHTML = `
    <div class="brf-zone-weather">
      <span class="brf-wx-icon">${escapeHtml(icon)}</span>
      <div class="brf-wx-text">
        ${temp ? `<span class="brf-wx-temp">${escapeHtml(temp)}</span>` : ''}
        ${cond ? `<span class="brf-wx-cond">${escapeHtml(cond)}</span>` : ''}
      </div>
    </div>
    <div class="brf-slots-outer">
      <button class="brf-slots-arrow brf-slots-prev" aria-label="Prethodni">‹</button>
      <div class="brf-slots-viewport">
        <div class="brf-slots">${slotsHtml}</div>
      </div>
      <button class="brf-slots-arrow brf-slots-next" aria-label="Sljedeći">›</button>
    </div>`;

  _attachSlotsNav(row);
  _attachDropdowns(row);
}

// ─── DATA LOADERS ─────────────────────────────────────────────────────────────

window.addEventListener('calendar:loaded', e => {
  _calEvents = e.detail;
  _rebuildEventsRow();
});

export async function loadAndRenderStores() {
  try {
    bustCache('data/stores-hours.json');
    const data = await loadDataFile('data/stores-hours.json');
    _storesData = data;
    _rebuildEventsRow();
  } catch (err) {
    console.warn('stores-hours.json load failed:', err.message);
  }
}

function _renderStoresSection() {
  const el = document.getElementById('widget-briefing');
  if (!el || !_storesData) return;

  el.querySelector('.brf-stores-section')?.remove();

  const { non_working_days = [], stores = [] } = _storesData;
  if (!non_working_days.length) return;

  // Filter stores that are open on at least one non-working day
  const openStores = stores
    .map(s => ({ ...s, openDays: (s.hours || []).filter(h => h.open) }))
    .filter(s => s.openDays.length > 0)
    .sort((a, b) => (a.dist || 0) - (b.dist || 0));

  if (!openStores.length) return;

  // Build day labels for row 1
  const today = new Date(); today.setHours(0,0,0,0);
  const dayLabels = non_working_days.map(d => {
    const diff = Math.round((new Date(d.date + 'T00:00:00') - today) / 86_400_000);
    const when = diff === 0 ? 'danas' : diff === 1 ? 'sutra' : `za ${diff} dana`;
    return `<span class="brf-stores-day">${escapeHtml(d.label)} <strong>${when}</strong></span>`;
  }).join('<span class="brf-stores-day-sep">·</span>');

  // Build store cards for carousel
  const cards = openStores.map(s => {
    // Address: use street/number if available, otherwise show distance
    const addr = s.address
      ? s.address.split(',')[0].trim()
      : s.dist != null ? `~${s.dist}m` : (s.city || '');
    const daysHtml = s.openDays.map(h => {
      const nwd = non_working_days.find(d => d.date === h.date);
      const lbl = nwd ? (nwd.type === 'sunday' ? 'ned' : nwd.label.split(' ')[0].toLowerCase()) : h.date.slice(5);
      return `<span class="brf-store-day-chip">${lbl} ${h.time || ''}</span>`;
    }).join('');
    // Google Maps link: prefer coordinates (precise), fallback to name+city search
    const mapsUrl = s.lat && s.lon
      ? `https://maps.google.com/?q=${s.lat},${s.lon}`
      : `https://maps.google.com/?q=${encodeURIComponent(s.name + ' ' + (s.address || s.city || 'Zagreb'))}`;

    return `<a class="brf-store-card" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">
      <span class="brf-store-name">${escapeHtml(s.name)}</span>
      <span class="brf-store-addr">${escapeHtml(addr)}</span>
      ${daysHtml}
    </a>`;
  }).join('');

  // Carousel row — no day-labels header (already shown in quick-info above)
  const carousel = document.createElement('div');
  carousel.className = 'brf-stores-carousel-wrap';
  carousel.innerHTML = `
    <button class="brf-stores-arrow brf-stores-prev" aria-label="Prethodno">‹</button>
    <div class="brf-stores-carousel" id="brf-stores-carousel">${cards}</div>
    <button class="brf-stores-arrow brf-stores-next" aria-label="Sljedeće">›</button>`;

  // Wrap in a container and insert INSIDE the weather row (same visual block)
  const section = document.createElement('div');
  section.className = 'brf-stores-section';
  section.appendChild(carousel);

  const weatherRow = el.querySelector('.brf-weather-row');
  if (weatherRow) {
    weatherRow.appendChild(section); // inside weather row, as second line
  } else {
    el.querySelector('.briefing-v2')?.prepend(section);
  }

  _attachCarousel(section);
}

function _attachCarousel(section) {
  const carousel = section.querySelector('#brf-stores-carousel');
  if (!carousel) return;
  const cards    = [...carousel.querySelectorAll('.brf-store-card')];
  if (!cards.length) return;

  let idx = 0;
  let timer = null;

  const show = (n) => {
    idx = ((n % cards.length) + cards.length) % cards.length;
    cards.forEach((c, i) => c.classList.toggle('active', i === idx));
  };

  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(() => show(idx + 1), 10_000);
  };

  show(0);

  if (cards.length <= 1) {
    section.querySelectorAll('.brf-stores-arrow').forEach(b => b.style.display = 'none');
    return; // single card — shown, no rotation needed
  }

  startTimer();
  section.querySelector('.brf-stores-prev')?.addEventListener('click', () => { show(idx - 1); startTimer(); });
  section.querySelector('.brf-stores-next')?.addEventListener('click', () => { show(idx + 1); startTimer(); });
}

// (old _renderQuickInfo, _renderStoresSection etc. replaced by _rebuildEventsRow above)

const GITHUB_REPO    = 'sstranjik/daily-dashboard';
const WORKFLOW_FILE  = 'daily-update.yml';

export function renderBriefing(data) {
  const el = document.getElementById('widget-briefing');
  if (!el) return;
  el.classList.remove('loading');

  if (!data) { el.innerHTML = emptyState(); }
  else if (data.version === 2) { renderV2(el, data); }
  else { renderV1(el, data); }

  attachRefreshBtn(el);
  // Build events row from available data (weather is set by weatherSection above)
  _rebuildEventsRow();
  // Load stores (async) — will call _rebuildEventsRow again when done
  loadAndRenderStores();
}

function attachRefreshBtn(el) {
  const header = el.querySelector('.widget-header');
  if (!header || header.querySelector('.brf-refresh-btn')) return;

  const btn = document.createElement('button');
  btn.className  = 'brf-refresh-btn';
  btn.id         = 'brf-refresh-btn';
  btn.title      = 'Pokreni ručni refresh (GitHub Actions)';
  btn.innerHTML  = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
    <path d="M9.5 5.5A4 4 0 1 1 6.8 1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M6.5 1h2.5v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  btn.addEventListener('click', () => triggerBriefingJob(btn));
  header.appendChild(btn);
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
      </div>
    </div>
    <div class="briefing-v2 briefing-scroll">
      ${weatherSection(d.weather)}
      ${fuelSection(d.fuel)}
      ${marketSection(d.market)}
      ${aiNewsSection(d.ai_news)}
      ${microTipsSection(d.micro_tips)}
    </div>`;
}

// ─── SECTION: WEATHER + EVENTS ROW ───────────────────────────────────────────

function weatherSection(w) {
  _weatherData = w ?? null; // save for _rebuildEventsRow
  const alertsHtml = (w?.alerts ?? []).map(a => `
    <div class="brf-alert brf-alert-${a.level}">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M5 1L9 8.5H1L5 1Z" stroke="currentColor" stroke-width="1.2"/>
        <path d="M5 4.5v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="5" cy="7.5" r="0.5" fill="currentColor"/>
      </svg>
      ${escapeHtml(a.text)}
    </div>`).join('');

  return `
    <div class="brf-section brf-events-section">
      <div class="brf-events-row" id="brf-events-row">
        <!-- populated by _rebuildEventsRow() -->
      </div>
      ${alertsHtml}
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
