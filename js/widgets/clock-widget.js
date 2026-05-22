import { formatTime, formatDate } from '../utils/helpers.js';

export function initClock() {
  const clockEl = document.getElementById('topbar-clock');
  const dateEl  = document.getElementById('topbar-date');

  function tick() {
    const now = new Date();
    if (clockEl) clockEl.textContent = formatTime(now);
    if (dateEl)  dateEl.textContent  = formatDate(now);
  }

  tick();
  setInterval(tick, 1000);
}
