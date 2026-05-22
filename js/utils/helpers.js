const HR_DAYS   = ['Nedjelja','Ponedjeljak','Utorak','Srijeda','Četvrtak','Petak','Subota'];
const HR_MONTHS = ['siječnja','veljače','ožujka','travnja','svibnja','lipnja','srpnja','kolovoza','rujna','listopada','studenog','prosinca'];

export function formatDate(date = new Date()) {
  return `${HR_DAYS[date.getDay()]}, ${date.getDate()}. ${HR_MONTHS[date.getMonth()]} ${date.getFullYear()}.`;
}

export function formatTime(date = new Date()) {
  return date.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatTimeShort(date = new Date()) {
  return date.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function timeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60)   return 'upravo sada';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400)return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
}

export function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function formatHour(isoOrHour) {
  if (typeof isoOrHour === 'number') {
    return `${String(isoOrHour).padStart(2, '0')}:00`;
  }
  return new Date(isoOrHour).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dayName(date, short = false) {
  const d = new Date(date);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Danas';
  const tom = new Date(); tom.setDate(today.getDate() + 1);
  if (d.toDateString() === tom.toDateString()) return 'Sutra';
  const names = short
    ? ['Ned','Pon','Uto','Sri','Čet','Pet','Sub']
    : HR_DAYS;
  return names[d.getDay()];
}
