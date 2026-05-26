/**
 * fetch-events.mjs  — scrapes Croatian concert + theater schedules
 * Outputs: ../data/events.json
 * No extra deps — uses built-in Node 20 fetch + crypto
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath }  from 'url';
import { createHash }     from 'crypto';

const __dir       = dirname(fileURLToPath(import.meta.url));
const DATA        = join(__dir, '..', 'data');
const EVENTS_FILE = join(DATA, 'zbivanja.json');

const NOW          = new Date();
const NOW_ISO      = NOW.toISOString();
const KEEP_PAST_MS = 15 * 24 * 3600 * 1000;   // keep 15 days after event date
const FETCH_TO     = 15_000;                    // 15 s per source

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DashboardBot/2.0; +https://github.com/sstranjik/daily-dashboard)',
      'Accept':     'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'hr,en;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TO),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

const HR_MON = {
  'siječnja':1,'veljače':2,'ožujka':3,'travnja':4,'svibnja':5,'lipnja':6,
  'srpnja':7,'kolovoza':8,'rujna':9,'listopada':10,'studenog':11,'studenoga':11,'prosinca':12,
  'siječanj':1,'veljača':2,'ožujak':3,'travanj':4,'svibanj':5,'lipanj':6,
  'srpanj':7,'kolovoz':8,'rujan':9,'listopad':10,'studeni':11,'prosinac':12,
};

/** Parse Croatian date strings → JS Date or null */
function parseCroDate(str) {
  if (!str) return null;
  const s = str.trim().replace(/\s+/g, ' ');
  let m;

  // "27. svibnja 2026." | "Srijeda, 27. svibnja 2026."
  m = s.match(/(\d{1,2})\.\s+([a-zšđčćž]+)\s+(\d{4})/i);
  if (m) {
    const mon = HR_MON[m[2].toLowerCase()];
    if (mon) return new Date(+m[3], mon - 1, +m[1]);
  }

  // "26.5.2026" | "26.05.2026"
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);

  // "26.5." or "26.05." — infer year (or +1 if > 6 months past)
  m = s.match(/(\d{1,2})\.(\d{1,2})\./);
  if (m) {
    const yr = NOW.getFullYear();
    const d  = new Date(yr, +m[2] - 1, +m[1]);
    if (d.getTime() < NOW.getTime() - 180 * 24 * 3600 * 1000) d.setFullYear(yr + 1);
    return d;
  }

  // "27/05" or "27/05/2026" (ZeKaeM format)
  m = s.match(/(\d{1,2})\/(\d{2})(?:\/(\d{4}))?/);
  if (m) {
    const yr = m[3] ? +m[3] : NOW.getFullYear();
    const d  = new Date(yr, +m[2] - 1, +m[1]);
    if (!m[3] && d.getTime() < NOW.getTime() - 180 * 24 * 3600 * 1000) d.setFullYear(yr + 1);
    return d;
  }

  return null;
}

function fmtDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('hr-HR', { weekday:'short', day:'numeric', month:'numeric', year:'numeric' });
}

// ─── HTML HELPERS ─────────────────────────────────────────────────────────────

function stripTags(html) {
  return (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#\d+;/g,'')
    .replace(/&[a-z]+;/g, '').replace(/\s+/g, ' ').trim();
}

function absUrl(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('javascript')) return '';
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return href; }
}

function makeId(source, title, dateStr) {
  return createHash('md5').update(`${source}|${title}|${dateStr}`).digest('hex').slice(0, 10);
}

// ─── BLOCK EXTRACTOR (generic helper) ────────────────────────────────────────
/** Pull text from <tag>...</tag> matching regex on attributes/content */
function extractBlocks(html, openTagRe, closeTag) {
  const blocks = [];
  const re = new RegExp(openTagRe.source + '[\\s\\S]*?<\\/' + closeTag + '>', openTagRe.flags + 'i');
  // Actually we need a non-consuming match with balancing — keep it simple:
  let idx = 0;
  const plainRe = new RegExp(openTagRe.source, openTagRe.flags);
  let match;
  while ((match = plainRe.exec(html.slice(idx))) !== null) {
    const start = idx + match.index;
    // Find matching close tag
    const close = html.indexOf('</' + closeTag + '>', start);
    if (close === -1) { idx = start + 1; continue; }
    blocks.push(html.slice(start, close + closeTag.length + 3));
    idx = start + 1;
  }
  return blocks;
}

// ─── PARSERS ──────────────────────────────────────────────────────────────────

// Helper: build final event object
function mkEvent({ title, date, time, link, venue, city = 'Zagreb', country = 'HR', category, source }) {
  const d = date instanceof Date ? date : parseCroDate(String(date ?? ''));
  if (!d || !title || title.length < 2) return null;
  const dateStr = d.toISOString().slice(0, 10);
  return {
    id:           makeId(source, title, dateStr),
    title:        title.trim().slice(0, 200),
    venue:        venue ?? '',
    city,
    country,
    category,
    date_iso:     dateStr + (time ? 'T' + time + ':00' : 'T00:00:00'),
    date_display: fmtDate(d),
    time:         time ?? null,
    link,
    source,
    is_new:       false,
    first_seen:   NOW_ISO,
  };
}

// ── MOCHVARA ──
async function fetchMochvara() {
  const html = await fetchHtml('https://mochvara.hr');
  const events = [];
  // Events block: article or similar containing a link + date
  // Date format: "Utorak 26.5.2026" | "srijeda 27.05.2026"
  // Links point to mochvara.hr/dogadaj/... or /event/...
  const linkRe = /<a\s[^>]*href="([^"]*(?:dogadaj|event|nastup|konc)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const inner = m[2];
    const text  = stripTags(inner);
    if (text.length < 3) continue;

    // Find date in surrounding context (±500 chars)
    const ctx   = html.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
    const dateM = ctx.match(/\b(?:\w+\s+)?(\d{1,2}\.\d{1,2}\.\d{4})\b/);
    const date  = dateM ? parseCroDate(dateM[1]) : null;
    const timeM = ctx.match(/\b(\d{2}:\d{2})\b/);

    const ev = mkEvent({
      title: text.split(/\n/)[0].trim().slice(0, 150),
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://mochvara.hr'),
      venue:    'Mochvara',
      category: 'concert',
      source:   'Mochvara',
    });
    if (ev) events.push(ev);
  }
  // Fallback: scan for date+title patterns
  if (!events.length) {
    const dayRe = /(?:Pon|Uto|Sri|Čet|Pet|Sub|Ned)\w*\s+(\d{1,2}\.\d{1,2}\.\d{4})/gi;
    const titleRe = /<h[1-6][^>]*>([^<]{5,})<\/h[1-6]>/gi;
    const titles  = [...html.matchAll(titleRe)].map(x => stripTags(x[1]));
    let di = 0;
    let dm;
    while ((dm = dayRe.exec(html)) !== null) {
      const title = titles[di++];
      if (!title) break;
      const date = parseCroDate(dm[1]);
      const ev = mkEvent({ title, date, link:'https://mochvara.hr', venue:'Mochvara', category:'concert', source:'Mochvara' });
      if (ev) events.push(ev);
    }
  }
  return events;
}

// ── TVORNICA KULTURE ──
async function fetchTvornica() {
  const html = await fetchHtml('https://www.tvornicakulture.com/svi-dogadaji/');
  const events = [];
  // Links to events: /dogadaj/... or /event/... with nearby date "4. lipnja 2026. u 20:00"
  const linkRe = /<a\s[^>]*href="([^"]+(?:dogadaj|event|nastup|konc)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const inner = m[2];
    const text  = stripTags(inner);
    if (text.length < 3) continue;

    const ctx   = html.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
    const dateM = ctx.match(/(\d{1,2})\.\s+([a-zšđčćž]+)\s+(\d{4})/i);
    const date  = dateM ? parseCroDate(dateM[0]) : null;
    const timeM = ctx.match(/u\s+(\d{2}:\d{2})/i) ?? ctx.match(/\b(\d{2}:\d{2})\b/);

    const ev = mkEvent({
      title: text.split(/\n/)[0].trim().slice(0, 150),
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://www.tvornicakulture.com'),
      venue:    'Tvornica Kulture',
      category: 'concert',
      source:   'Tvornica Kulture',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── POGON ──
async function fetchPogon() {
  const html = await fetchHtml('https://pogon.hr/program/');
  const events = [];
  // Card structure: <div class="event-card"> ... </div>
  // Date: "DD. MM. YYYY. u HH:h"  or "DD. MM. YYYY."
  // Title: <h3><a href="...">Title</a></h3>
  // Category tag: [koncert] / [predstava]
  const cardRe = /<(?:div|article)[^>]*class="[^"]*(?:event|program)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article)>/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[0];
    const text  = stripTags(block);

    const titleM = block.match(/<(?:h[1-6]|strong)[^>]*><a[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/i)
                ?? block.match(/<a[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/i);
    if (!titleM) continue;

    const dateM = text.match(/(\d{1,2})\.\s*(\d{2})\.\s*(\d{4})/);
    const date  = dateM ? parseCroDate(`${dateM[1]}.${dateM[2]}.${dateM[3]}`) : null;
    const timeM = text.match(/u\s+(\d{1,2}[h:]?\d{0,2})/i);
    const time  = timeM ? timeM[1].replace('h',':00').padEnd(5,'0').slice(0,5) : null;

    const catMatch = text.match(/\[(\w+)\]/);
    const cat = catMatch?.[1].toLowerCase() === 'predstava' ? 'theater'
              : catMatch?.[1].toLowerCase() === 'koncert'   ? 'concert' : 'concert';

    const ev = mkEvent({
      title:    stripTags(titleM[2]).slice(0, 150),
      date,
      time,
      link:     absUrl(titleM[1], 'https://pogon.hr'),
      venue:    'Pogon',
      category: cat,
      source:   'Pogon',
    });
    if (ev) events.push(ev);
  }

  // Fallback: find all h3>a links + nearby dates
  if (!events.length) {
    const hre  = /<h[1-6][^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/gi;
    let hm;
    while ((hm = hre.exec(html)) !== null) {
      const ctx   = html.slice(Math.max(0, hm.index - 400), hm.index + 400);
      const dateM = ctx.match(/(\d{1,2})\.\s*(\d{2})\.\s*(\d{4})/);
      const date  = dateM ? parseCroDate(`${dateM[1]}.${dateM[2]}.${dateM[3]}`) : null;
      const ev = mkEvent({
        title:    stripTags(hm[2]).slice(0, 150),
        date,
        link:     absUrl(hm[1], 'https://pogon.hr'),
        venue:    'Pogon',
        category: 'concert',
        source:   'Pogon',
      });
      if (ev) events.push(ev);
    }
  }
  return events;
}

// ── LISINSKI ──
async function fetchLisinski() {
  const html = await fetchHtml('https://lisinski.hr/hr/dogadanja/');
  const events = [];
  // Each event: div with date + title + link
  // Dates: "26. 5. 2026" or "11. 6. 2026"
  // Links: /hr/dogadanja/[slug]/
  const linkRe = /<a\s[^>]*href="([^"]*\/dogadanja\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const inner = m[2];
    if (href.endsWith('/dogadanja/')) continue;  // skip "all events" link

    const ctx   = html.slice(Math.max(0, m.index - 600), m.index + m[0].length + 100);
    const text  = stripTags(inner);
    if (text.length < 3) continue;

    // Date patterns: "26. 5. 2026" or "26. svibnja 2026"
    const dateM = ctx.match(/(\d{1,2})\.\s+([a-zšđčćž\d]+)\.?\s+(\d{4})/) ??
                  ctx.match(/(\d{1,2})\.\s+(\d{1,2})\.\s+(\d{4})/);
    const date = dateM ? parseCroDate(dateM[0]) : null;
    const timeM = ctx.match(/\b(\d{2}:\d{2})\b/);

    // Venue hint: "Velika dvorana" vs "Mala dvorana"
    const venueM = ctx.match(/(?:Velika|Mala|Foyer)\s+dvorana/i);

    const ev = mkEvent({
      title:    text.trim().slice(0, 150),
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://lisinski.hr'),
      venue:    venueM ? `Lisinski – ${venueM[0]}` : 'Lisinski',
      category: 'concert',
      source:   'Lisinski',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── MUZIKA.HR ──
async function fetchMuzika() {
  const html = await fetchHtml('https://www.muzika.hr/kalendar/');
  const events = [];
  // Structure: <h3><a href="...">Title</a></h3> near date text + venue
  const linkRe = /<h[1-6][^>]*>\s*<a\s[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const title = stripTags(m[2]);
    if (!title || title.length < 3) continue;

    const ctx    = html.slice(Math.max(0, m.index - 600), m.index + m[0].length + 600);
    const ctxTxt = stripTags(ctx);

    // Date: "Sri 27.5." | "27.5.2026" | "Čet 28.5. - Ned 31.5."
    const dateM = ctxTxt.match(/(\d{1,2}\.\d{1,2}\.\d{4})/) ??
                  ctxTxt.match(/(?:\w+\s+)?(\d{1,2}\.\d{1,2}\.)/);
    const date  = dateM ? parseCroDate(dateM[1] ?? dateM[0]) : null;
    const timeM = ctxTxt.match(/\b(\d{2}:\d{2})\b/);

    // Venue + city
    const venueM = ctxTxt.match(/[A-ZŠĐČĆŽ][a-zšđčćžA-ZŠĐČĆŽ0-9 ]{2,40},\s*([A-ZŠĐČĆŽ][a-zšđčćž]+)/);
    const rawCity   = venueM?.[1] ?? '';
    const isAbroad  = rawCity && !/(zagreb|split|rijeka|osijek|zadar|pula|dubrovnik|slavonski|varaždin|sisak|karlovac|šibenik|hrvatska|croatia)/i.test(rawCity);
    const city      = rawCity || 'Zagreb';
    const country   = isAbroad ? guessCountry(rawCity) : 'HR';

    const ev = mkEvent({
      title,
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://www.muzika.hr'),
      venue:    venueM?.[0]?.split(',')[0]?.trim() ?? '',
      city,
      country,
      category: 'concert',
      source:   'muzika.hr',
    });
    if (ev) events.push(ev);
  }
  return events;
}

function guessCountry(city) {
  const c = city.toLowerCase();
  if (/beograd|novi sad|niš|srbija/.test(c))     return 'RS';
  if (/beč|wien|graz|salzburg|austrija/.test(c)) return 'AT';
  if (/budimpešta|budapest|mađarska/.test(c))    return 'HU';
  if (/ljubljana|maribor|slovenija/.test(c))     return 'SI';
  if (/münchen|berlin|hamburg|germany/.test(c))  return 'DE';
  if (/london|manchester|uk/.test(c))            return 'GB';
  if (/sarajevo|bih|mostar/.test(c))             return 'BA';
  if (/skopje|makedonija/.test(c))               return 'MK';
  return 'EU';
}

// ── HNK ZAGREB ──
async function fetchHnk() {
  const html = await fetchHtml('https://hnk.hr/raspored');
  const events = [];
  // Structure: links to /hr/opera/..., /hr/drama/..., /hr/balet/... with date nearby
  const linkRe = /<a\s[^>]*href="(\/hr\/[^"]+\/[^"]+#[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const inner = m[2];
    const title = stripTags(inner).trim();
    if (title.length < 3 || /Rasprodano|Sold/i.test(title)) continue;

    const ctx   = html.slice(Math.max(0, m.index - 500), m.index + m[0].length + 100);
    const ctxT  = stripTags(ctx);

    // Date embedded in hash: #26.05.19.30 → May 26
    const hashM = href.match(/#(\d{2})\.(\d{2})/);
    let date;
    if (hashM) {
      date = parseCroDate(`${hashM[1]}.${hashM[2]}.${NOW.getFullYear()}`);
      if (date && date.getTime() < NOW.getTime() - 30 * 24 * 3600 * 1000) date.setFullYear(date.getFullYear() + 1);
    } else {
      const dateM = ctxT.match(/\b(\d{1,2})\.(\d{2})\b/);
      date = dateM ? parseCroDate(`${dateM[1]}.${dateM[2]}.`) : null;
    }

    // Time from hash: #26.05.19.30 → 19:30
    const timeHashM = href.match(/#\d{2}\.\d{2}\.(\d{2})\.(\d{2})/);
    const time = timeHashM ? `${timeHashM[1]}:${timeHashM[2]}` : null;

    // Category badge in context
    const catM = ctxT.match(/\b(Opera|Drama|Balet|Konc|Recital)/i);
    const category = catM?.[1].toLowerCase() === 'drama' ? 'theater' : 'concert';

    const ev = mkEvent({
      title: title.slice(0, 150),
      date,
      time,
      link:     absUrl(href, 'https://hnk.hr'),
      venue:    'HNK Zagreb',
      category,
      source:   'HNK Zagreb',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── ZEKAEM ──
async function fetchZekaem() {
  const html = await fetchHtml('https://www.zekaem.hr/raspored/');
  const events = [];
  // Date: "SRI 27/05" + time "20:00" + title as heading+link
  const linkRe = /<a\s[^>]*href="([^"]+)"[^>]*>\s*([^<]{3,})\s*<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const title = stripTags(m[2]).trim();
    if (title.length < 3 || /kupi|raspored|program|home|više/i.test(title)) continue;

    const ctx  = html.slice(Math.max(0, m.index - 600), m.index + m[0].length + 200);
    const ctxT = stripTags(ctx);

    // Date: "27/05" or "27/05/2026"
    const dateM = ctxT.match(/(\d{1,2})\/(\d{2})(?:\/(\d{4}))?/);
    const date  = dateM ? parseCroDate(dateM[0]) : null;
    const timeM = ctxT.match(/\b(\d{2}:\d{2})\b/);

    if (!date) continue;

    const ev = mkEvent({
      title: title.slice(0, 150),
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://www.zekaem.hr'),
      venue:    'ZeKaeM',
      category: 'theater',
      source:   'ZeKaeM',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── GAVELLA ──
async function fetchGavella() {
  const html = await fetchHtml('https://www.gavella.hr/raspored-izvedbi');
  const events = [];
  // Table rows: date "Srijeda, 27. svibnja 2026." | time "19:30" | title link
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row   = m[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]).trim());
    if (cells.length < 2) continue;

    const dateTxt = cells[0] ?? '';
    const date    = parseCroDate(dateTxt);
    if (!date) continue;

    const timeM  = (cells[1] ?? '').match(/(\d{2}:\d{2})/);
    const time   = timeM?.[1] ?? null;

    // Title from a link in row
    const titleM = row.match(/<a[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/i);
    if (!titleM) continue;

    const ev = mkEvent({
      title:    stripTags(titleM[2]).slice(0, 150),
      date,
      time,
      link:     absUrl(titleM[1], 'https://www.gavella.hr'),
      venue:    'Gavella',
      category: 'theater',
      source:   'Gavella',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── KEREMPUH ──
async function fetchKerempuh() {
  const html = await fetchHtml('https://www.kazalistekerempuh.hr/raspored/');
  const events = [];
  // Month-based sections, day containers "Srijeda 27", title+link, time
  const linkRe = /<a\s[^>]*href="([^"]+\/predstave[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const title = stripTags(m[2]).trim();
    if (title.length < 3) continue;

    const ctx  = html.slice(Math.max(0, m.index - 600), m.index + m[0].length + 200);
    const ctxT = stripTags(ctx);

    // "Srijeda 27" or similar — grab DD and nearest month heading
    const dayM   = ctxT.match(/\b(?:Pon|Uto|Sri|Čet|Pet|Sub|Ned)\w*\s+(\d{1,2})\b/i);
    const monM   = ctxT.match(/(?:Siječanj|Veljača|Ožujak|Travanj|Svibanj|Lipanj|Srpanj|Kolovoz|Rujan|Listopad|Studeni|Prosinac)/i);
    const yearM  = ctxT.match(/\b(202\d)\b/);

    let date = null;
    if (dayM && monM) {
      const mon   = HR_MON[monM[0].toLowerCase()];
      const yr    = yearM ? +yearM[1] : NOW.getFullYear();
      if (mon) date = new Date(yr, mon - 1, +dayM[1]);
    }
    if (!date) {
      // Fallback: "27.05." style
      const dateM2 = ctxT.match(/(\d{1,2})\.(\d{2})\./);
      date = dateM2 ? parseCroDate(dateM2[0]) : null;
    }

    const timeM = ctxT.match(/\b(\d{2}:\d{2})\b/);

    const ev = mkEvent({
      title: title.slice(0, 150),
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://www.kazalistekerempuh.hr'),
      venue:    'Kazalište Kerempuh',
      category: 'theater',
      source:   'Kerempuh',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── TREŠNJA ──
async function fetchTresnja() {
  const html = await fetchHtml('https://www.kazaliste-tresnja.hr/raspored/');
  const events = [];
  // Table layout: date | day | time | title | age | tickets
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row   = m[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]).trim());
    if (cells.length < 3) continue;

    const date = parseCroDate(cells[0]);
    if (!date) continue;

    const timeM = cells.find(c => /^\d{2}:\d{2}$/.test(c));
    // Title: find cell with a link or longest text cell
    const titleM = row.match(/<a[^>]*href="([^"]+)"[^>]*>([^<]{3,})<\/a>/i);
    const title  = titleM ? stripTags(titleM[2]) : cells[2];
    if (!title || title.length < 3) continue;

    const ev = mkEvent({
      title: title.slice(0, 150),
      date,
      time:     timeM ?? null,
      link:     titleM ? absUrl(titleM[1], 'https://www.kazaliste-tresnja.hr') : 'https://www.kazaliste-tresnja.hr/raspored/',
      venue:    'Kazalište Trešnja',
      category: 'theater',
      source:   'Trešnja',
    });
    if (ev) events.push(ev);
  }
  return events;
}

// ── KOMEDIJA ──
async function fetchKomedija() {
  const html = await fetchHtml('https://www.komedija.hr/www/raspored-predstava/');
  const events = [];
  // Date: "26. 5. 2025 (Tuesday) | 19:30–22:00" format (or similar)
  // Entries contain date, title link, venue
  const linkRe = /<a\s[^>]*href="([^"]+(?:event|ulaznice)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const ctx   = html.slice(Math.max(0, m.index - 800), m.index + m[0].length + 200);
    const ctxT  = stripTags(ctx);
    const title = stripTags(m[2]).trim();

    // Date patterns: "26. 5. 2025" or "26.5.2025"
    const dateM = ctxT.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(202\d)/);
    const date  = dateM ? parseCroDate(`${dateM[1]}.${dateM[2]}.${dateM[3]}`) : null;
    if (!date) continue;

    const timeM = ctxT.match(/\b(\d{2}:\d{2})\b/);

    // Title fallback from heading near the link
    const hMatch = ctx.match(/<h[1-6][^>]*>([^<]{5,})<\/h[1-6]>/i);
    const finalTitle = (title.length > 5 ? title : hMatch ? stripTags(hMatch[1]) : '').slice(0, 150);
    if (!finalTitle) continue;

    const ev = mkEvent({
      title: finalTitle,
      date,
      time:     timeM?.[1] ?? null,
      link:     absUrl(href, 'https://www.komedija.hr'),
      venue:    'Kazalište Komedija',
      category: 'theater',
      source:   'Komedija',
    });
    if (ev) events.push(ev);
  }

  // Also grab heading+date pairs (main schedule table)
  const entryRe = /(\d{1,2}\.\s*\d{1,2}\.\s*202\d)[^<]{0,200}<[^>]+>([A-ZŠĐČĆŽ][^<]{4,50})</gs;
  let em;
  while ((em = entryRe.exec(html)) !== null) {
    const date  = parseCroDate(em[1]);
    const title = em[2].trim();
    if (!date || !title || events.find(e => e.title === title && e.date_iso.startsWith(date.toISOString().slice(0,10)))) continue;
    const ev = mkEvent({ title: title.slice(0, 150), date, link:'https://www.komedija.hr/www/raspored-predstava/', venue:'Kazalište Komedija', category:'theater', source:'Komedija' });
    if (ev) events.push(ev);
  }
  return events;
}

// ─── RUNNERS ──────────────────────────────────────────────────────────────────

const SOURCES = [
  { name: 'Mochvara',   fn: fetchMochvara,  cat: 'concert',  city: 'Zagreb' },
  { name: 'Tvornica',   fn: fetchTvornica,  cat: 'concert',  city: 'Zagreb' },
  { name: 'Pogon',      fn: fetchPogon,     cat: 'mixed',    city: 'Zagreb' },
  { name: 'Lisinski',   fn: fetchLisinski,  cat: 'concert',  city: 'Zagreb' },
  { name: 'muzika.hr',  fn: fetchMuzika,    cat: 'concert',  city: 'multi'  },
  { name: 'HNK Zagreb', fn: fetchHnk,       cat: 'theater',  city: 'Zagreb' },
  { name: 'ZeKaeM',     fn: fetchZekaem,    cat: 'theater',  city: 'Zagreb' },
  { name: 'Gavella',    fn: fetchGavella,   cat: 'theater',  city: 'Zagreb' },
  { name: 'Kerempuh',   fn: fetchKerempuh,  cat: 'theater',  city: 'Zagreb' },
  { name: 'Trešnja',    fn: fetchTresnja,   cat: 'theater',  city: 'Zagreb' },
  { name: 'Komedija',   fn: fetchKomedija,  cat: 'theater',  city: 'Zagreb' },
];

// ─── MERGE WITH PREVIOUS DATA ─────────────────────────────────────────────────

function loadPrevious() {
  if (!existsSync(EVENTS_FILE)) return { ids: new Set(), events: [] };
  try {
    const prev = JSON.parse(readFileSync(EVENTS_FILE, 'utf8'));
    const all  = [...(prev.concerts ?? []), ...(prev.theater ?? []), ...(prev.abroad ?? [])];
    return {
      ids:    new Set(all.map(e => e.id)),
      events: all,
    };
  } catch { return { ids: new Set(), events: [] }; }
}

function mergeAndPrune(freshEvents, prev) {
  const cutoff = NOW.getTime() - KEEP_PAST_MS;
  const byId   = new Map(prev.events.map(e => [e.id, e]));

  for (const ev of freshEvents) {
    const existing = byId.get(ev.id);
    if (existing) {
      // Keep first_seen, update other fields
      byId.set(ev.id, { ...ev, is_new: false, first_seen: existing.first_seen });
    } else {
      byId.set(ev.id, { ...ev, is_new: true });
    }
  }

  // Prune events past cutoff
  return [...byId.values()].filter(ev => {
    const d = new Date(ev.date_iso);
    return d.getTime() >= cutoff;
  });
}

// ─── DEDUP + SORT ─────────────────────────────────────────────────────────────

function dedup(events) {
  const seen = new Set();
  return events.filter(ev => {
    const key = `${ev.title.toLowerCase().slice(0, 50)}|${ev.date_iso.slice(0, 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByDate(events) {
  return [...events].sort((a, b) => a.date_iso.localeCompare(b.date_iso));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎭 Events fetch started at ${NOW_ISO}\n`);

  mkdirSync(DATA, { recursive: true });

  const prev   = loadPrevious();
  const allNew = [];
  const stats  = {};

  await Promise.allSettled(
    SOURCES.map(async ({ name, fn }) => {
      try {
        const items = await fn();
        const valid = items.filter(Boolean).filter(ev => {
          // Only future events (or up to 15 days past)
          const d = new Date(ev.date_iso);
          return d.getTime() >= NOW.getTime() - KEEP_PAST_MS;
        });
        console.log(`  ✓ ${name}: ${valid.length} events`);
        stats[name] = { ok: true, count: valid.length };
        allNew.push(...valid);
      } catch (err) {
        console.warn(`  ✗ ${name}: ${err.message}`);
        stats[name] = { ok: false, error: err.message };
      }
    })
  );

  const merged   = mergeAndPrune(allNew, prev);
  const deduped  = dedup(merged);
  const sorted   = sortByDate(deduped);

  // Split into sections
  const concerts = sorted.filter(e => e.category === 'concert' && e.country === 'HR');
  const theater  = sorted.filter(e => e.category === 'theater');
  const abroad   = sorted.filter(e => e.category === 'concert' && e.country !== 'HR');
  const newEvents= sorted.filter(e => e.is_new);

  const out = {
    generated_at: NOW_ISO,
    stats,
    concerts,
    theater,
    abroad,
    new_count:    newEvents.length,
  };

  writeFileSync(EVENTS_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n✅ events.json: ${concerts.length} concerts, ${theater.length} theater, ${abroad.length} abroad, ${newEvents.length} new\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
