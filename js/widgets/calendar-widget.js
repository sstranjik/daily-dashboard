import { getAccessToken, fetchAllCalendarEvents } from '../api/google-api.js';
import { requestApiAccess, GRANTED_KEY } from '../auth.js';

const shortDays  = ['Ned', 'Pon', 'Uto', 'Sri', 'Čet', 'Pet', 'Sub'];
const shortMonths = ['sij','velj','ožu','tra','svi','lip','srp','kol','ruj','lis','stu','pro'];

export async function renderCalendar(config) {
  const el = document.getElementById('widget-calendar');
  if (!el) return;
  el.classList.remove('loading');

  const token = getAccessToken();

  if (!token) {
    // If user previously granted access, show skeleton while silent re-auth runs.
    // auth:token  → app.js re-renders this widget once the token arrives.
    // auth:silent-failed → fall back to the connect prompt.
    if (localStorage.getItem(GRANTED_KEY)) {
      el.innerHTML = loadingHtml();

      const onFail = () => {
        if (!getAccessToken()) showConnectPrompt(el, config);
      };
      window.addEventListener('auth:silent-failed', onFail, { once: true });

      // Safety timeout: if nothing fires in 5 s, fall back to connect prompt
      setTimeout(() => {
        window.removeEventListener('auth:silent-failed', onFail);
        if (!getAccessToken()) showConnectPrompt(el, config);
      }, 5000);
    } else {
      showConnectPrompt(el, config);
    }
    return;
  }

  el.innerHTML = loadingHtml();
  try {
    const data   = await fetchAllCalendarEvents(token);
    const events = data.items ?? [];
    renderEvents(el, events);
  } catch (err) {
    console.error('Calendar fetch failed:', err);
    if (err.message?.includes('401')) {
      showConnectPrompt(el, config);
    } else {
      el.innerHTML = headerHtml() + `<div class="error-state">⚠ Greška pri dohvaćanju kalendara.</div>`;
    }
  }
}

function renderEvents(el, events) {
  // Split holidays from regular events
  const holidays = {};   // dateKey → string[]
  const regular  = [];

  for (const ev of events) {
    const dk = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
    if (!dk) continue;
    if (ev._isHoliday) {
      if (!holidays[dk]) holidays[dk] = [];
      holidays[dk].push(ev.summary || '');
    } else {
      regular.push(ev);
    }
  }

  // Days with regular events
  const groups = groupByDay(regular);

  // Add holiday-only days (no regular events that day)
  for (const dk of Object.keys(holidays)) {
    if (!groups[dk]) groups[dk] = [];
  }

  if (!Object.keys(groups).length) {
    el.innerHTML = headerHtml() + `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <div class="empty-state-title">Nema događaja</div>
        <div class="empty-state-desc">Nema zakazanih događaja sljedećih 7 dana.</div>
      </div>`;
    return;
  }

  const today      = toDateKey(new Date());
  const sortedDays = Object.keys(groups).sort();

  const groupsHtml = sortedDays.map(dateKey => {
    const isToday    = dateKey === today;
    const isTomorrow = dateKey === tomorrowKey();
    const dateObj    = new Date(dateKey + 'T00:00:00');
    const dayLabel   = isToday    ? 'Danas'
      : isTomorrow   ? 'Sutra'
      : `${shortDays[dateObj.getDay()]}, ${dateObj.getDate()}. ${shortMonths[dateObj.getMonth()]}.`;

    const dayHolidays = holidays[dateKey] ?? [];
    const dayEvents   = groups[dateKey]   ?? [];

    const holidayBadges = dayHolidays
      .map(name => `<span class="cal-holiday-badge">${escHtml(name)}</span>`)
      .join('');

    const eventsHtml = dayEvents.map(ev => renderEvent(ev)).join('');

    return `
      <div class="cal-day-group">
        <div class="cal-day-header${isToday ? ' is-today' : ''}">
          ${isToday ? '<span class="cal-day-header-dot"></span>' : ''}
          <span>${dayLabel}</span>
          ${holidayBadges}
        </div>
        <div class="cal-events-list">${eventsHtml}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    ${headerHtml()}
    <div class="cal-scroll">${groupsHtml}</div>`;
}

function renderEvent(ev) {
  const isAllDay = !!ev.start?.date;
  let timeStr = '';

  if (isAllDay) {
    timeStr = `<span class="cal-event-time all-day">CIJELI DAN</span>`;
  } else if (ev.start?.dateTime) {
    const start = new Date(ev.start.dateTime);
    const end   = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
    const fmt   = d => d.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
    timeStr = `<span class="cal-event-time">${fmt(start)}${end ? '–' + fmt(end) : ''}</span>`;
  }

  const loc = ev.location
    ? `<div class="cal-event-location">📍 ${escHtml(ev.location.split(',')[0])}</div>`
    : '';

  const colorStyle = ev.colorId
    ? `background: ${calColor(ev.colorId)}`
    : ev._calColor
    ? `background: ${ev._calColor}`
    : '';

  return `
    <div class="cal-event">
      ${timeStr}
      <div class="cal-event-bar" style="${colorStyle}"></div>
      <div>
        <div class="cal-event-title">${escHtml(ev.summary || '(bez naslova)')}</div>
        ${loc}
      </div>
    </div>`;
}

function showConnectPrompt(el, config) {
  el.innerHTML = `
    ${headerHtml()}
    <div class="connect-prompt">
      <div class="connect-prompt-icon">📅</div>
      <div class="connect-prompt-title">Poveži Google Kalendar</div>
      <div class="connect-prompt-desc">Prikaži događaje iz svog Google Kalendaraz sljedećih 7 dana.</div>
      <button class="btn-connect" id="cal-connect-btn">Poveži</button>
    </div>`;

  el.querySelector('#cal-connect-btn')?.addEventListener('click', () => {
    requestApiAccess(config, async (token) => {
      await renderCalendar(config);
    });
  });
}

function groupByDay(events) {
  const groups = {};
  for (const ev of events) {
    const dateKey = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
    if (!dateKey) continue;
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(ev);
  }
  return groups;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function tomorrowKey() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateKey(d);
}

function calColor(colorId) {
  const map = {
    '1':'#a4bdfc','2':'#7ae7bf','3':'#dbadff','4':'#ff887c',
    '5':'#fbd75b','6':'#ffb878','7':'#46d6db','8':'#e1e1e1',
    '9':'#5484ed','10':'#51b749','11':'#dc2127',
  };
  return map[colorId] ?? 'var(--accent)';
}

function headerHtml() {
  return `
    <div class="widget-header">
      <span class="widget-label widget-label-icon">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <rect x="1" y="2" width="9" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M1 5h9M3.5 1v2M7.5 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        KALENDAR
      </span>
    </div>`;
}

function loadingHtml() {
  return `
    ${headerHtml()}
    <div class="sk sk-line" style="width:50%;margin-bottom:12px"></div>
    <div class="sk sk-line" style="width:90%"></div>
    <div class="sk sk-line" style="width:80%"></div>
    <div class="sk sk-line sk-sm" style="width:40%;margin-top:12px;margin-bottom:8px"></div>
    <div class="sk sk-line" style="width:85%"></div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
