/**
 * fetch-stores.mjs — finds nearby stores and checks opening hours on upcoming
 * Sundays / Croatian public holidays (next 7 days).
 *
 * Sources:
 *   Overpass API  — free, no key, finds shops within radius
 *   Gemini 2.0 Flash + Google Search — fetches/parses store hours from websites
 *
 * Input:  data/stores-location.json  { lat, lon, radius_m }
 * Output: data/stores-hours.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const DATA       = join(__dir, '..', 'data');
const NOW        = new Date();
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(readFileSync(join(DATA, file), 'utf8')); }
  catch { return null; }
}
function writeJson(file, data) {
  writeFileSync(join(DATA, file), JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ Wrote ${file}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CROATIAN HOLIDAYS ────────────────────────────────────────────────────────

function getEaster(year) {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d;
}

function toISO(date) {
  // Use local date parts — toISOString() is UTC and shifts by 1 day in UTC+2
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function getCroatianHolidays(year) {
  const easter = getEaster(year);
  return [
    { date: `${year}-01-01`, name: 'Nova godina' },
    { date: `${year}-01-06`, name: 'Bogojavljenje' },
    { date: toISO(easter),               name: 'Uskrs' },
    { date: toISO(addDays(easter, 1)),   name: 'Uskrsni ponedjeljak' },
    { date: toISO(addDays(easter, 60)),  name: 'Tijelovo' },
    { date: `${year}-05-01`, name: 'Praznik rada' },
    { date: `${year}-05-30`, name: 'Dan državnosti' },
    { date: `${year}-06-22`, name: 'Dan antifašističke borbe' },
    { date: `${year}-08-05`, name: 'Dan pobjede' },
    { date: `${year}-08-15`, name: 'Velika Gospa' },
    { date: `${year}-11-01`, name: 'Svi sveti' },
    { date: `${year}-11-18`, name: 'Dan sjećanja' },
    { date: `${year}-12-25`, name: 'Božić' },
    { date: `${year}-12-26`, name: 'Sveti Stjepan' },
  ];
}

/** Returns all non-working days (Sunday + holiday) within the next `days` days */
function getUpcomingNonWorkingDays(days = 7) {
  const result = [];
  const holidays = [
    ...getCroatianHolidays(NOW.getFullYear()),
    ...getCroatianHolidays(NOW.getFullYear() + 1),
  ];
  const holidaySet = new Map(holidays.map(h => [h.date, h.name]));

  for (let i = 0; i <= days; i++) {
    const d    = addDays(NOW, i);
    const iso  = toISO(d);
    const dow  = d.getDay(); // 0=Sun
    const hName = holidaySet.get(iso);

    if (hName) {
      result.push({ date: iso, type: 'holiday', label: hName });
    } else if (dow === 0) {
      result.push({ date: iso, type: 'sunday', label: 'Nedjelja' });
    }
  }
  return result;
}

// ─── OVERPASS — find nearby shops ─────────────────────────────────────────────

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function overpassQuery(query) {
  const encoded = encodeURIComponent(query);
  for (const server of OVERPASS_SERVERS) {
    try {
      const res = await fetch(`${server}?data=${encoded}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'morning-insight-dashboard/1.0',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.warn(`  Overpass ${server} returned ${res.status}, trying next…`);
        continue;
      }
      return res.json();
    } catch (err) {
      console.warn(`  Overpass ${server} failed: ${err.message}, trying next…`);
    }
  }
  throw new Error('All Overpass servers failed');
}

async function findNearbyStores(lat, lon, radiusM = 1000) {
  const query = `
[out:json][timeout:30];
(
  node["shop"](around:${radiusM},${lat},${lon});
  way["shop"](around:${radiusM},${lat},${lon});
  relation["shop"](around:${radiusM},${lat},${lon});
);
out body center;
`;

  const data = await overpassQuery(query);

  return (data.elements ?? [])
    .map(el => {
      const tags = el.tags ?? {};
      const name = tags.name || tags.brand || tags['name:hr'] || null;
      if (!name) return null;

      // Prefer node coords, fall back to way center
      const lat2 = el.lat ?? el.center?.lat;
      const lon2 = el.lon ?? el.center?.lon;
      if (!lat2 || !lon2) return null;

      const dist = Math.round(haversineM(lat, lon, lat2, lon2));

      return {
        osm_id:   `${el.type}/${el.id}`,
        name:     name.trim(),
        brand:    tags.brand || null,
        address:  [tags['addr:street'], tags['addr:housenumber']]
                    .filter(Boolean).join(' ') || tags['addr:full'] || null,
        city:     tags['addr:city'] || tags['addr:town'] || 'Zagreb',
        website:  tags.website || tags['contact:website'] || null,
        opening_hours_osm: tags.opening_hours || null,
        lat: lat2, lon: lon2, dist,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist);
    // NOTE: no slice here — knownChains prioritisation in main() must see ALL stores
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────

// NOTE: No google_search tool here — store hours are stable enough that
// Gemini's training knowledge is sufficient and avoids the search quota.
async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0.1 },
  };
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

function extractJSON(text) {
  if (!text) return null;
  try {
    // Try to find a JSON array or object
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
  } catch { /* ignore */ }
  return null;
}

// ─── STATIC CHAIN HOURS TABLE ────────────────────────────────────────────────
// Hardcoded typical hours for major Croatian chains.
// Primary source — no API calls, no quota issues.
// sunday:  typical Sunday hours
// holiday: typical state holiday hours (most closed; some open with reduced hours)

const CHAIN_HOURS = {
  'Lidl':      { sunday: { open: true,  time: '08:00-21:00' }, holiday: { open: false } },
  'Konzum':    { sunday: { open: true,  time: '08:00-20:00' }, holiday: { open: false } },
  'Spar':      { sunday: { open: true,  time: '08:00-20:00' }, holiday: { open: false } },
  'Interspar': { sunday: { open: true,  time: '08:00-21:00' }, holiday: { open: false } },
  'Studenac':  { sunday: { open: true,  time: '07:00-21:00' }, holiday: { open: true, time: '07:00-14:00' } },
  'Kaufland':  { sunday: { open: true,  time: '08:00-21:00' }, holiday: { open: false } },
  'dm':        { sunday: { open: true,  time: '09:00-20:00' }, holiday: { open: false } },
  'Müller':    { sunday: { open: true,  time: '09:00-20:00' }, holiday: { open: false } },
  'Tommy':     { sunday: { open: true,  time: '07:00-21:00' }, holiday: { open: true, time: '08:00-14:00' } },
  'Plodine':   { sunday: { open: true,  time: '08:00-20:00' }, holiday: { open: false } },
  'Eurospin':  { sunday: { open: false },                       holiday: { open: false } },
  'Boso':      { sunday: { open: true,  time: '08:00-20:00' }, holiday: { open: false } },
  'Pevex':     { sunday: { open: true,  time: '09:00-20:00' }, holiday: { open: false } },
  'KTC':       { sunday: { open: true,  time: '08:00-20:00' }, holiday: { open: false } },
  'Ribola':    { sunday: { open: true,  time: '07:00-21:00' }, holiday: { open: true, time: '07:00-14:00' } },
};

const KNOWN_CHAINS = Object.keys(CHAIN_HOURS);

/** Match a store name to a known chain key */
function matchChain(storeName) {
  const n = (storeName || '').toLowerCase();
  for (const c of KNOWN_CHAINS) {
    if (n.includes(c.toLowerCase())) return c;
  }
  return null;
}

/**
 * Build hours for a store from the static table.
 * Falls back to Gemini for unknown chains (optional, best-effort).
 */
function hoursFromTable(chain, nonWorkingDays) {
  const entry = CHAIN_HOURS[chain];
  if (!entry) return null;

  return nonWorkingDays.map(d => {
    const src = d.type === 'holiday' ? entry.holiday : entry.sunday;
    return {
      date: d.date,
      open: !!src?.open,
      time: src?.open && src?.time ? src.time : null,
    };
  });
}

/**
 * For stores not in the static table, ask Gemini (no search, knowledge only).
 * Returns the same format as CHAIN_HOURS entries, or null on failure.
 */
async function askGeminiForChain(chainName, nonWorkingDays) {
  const daysDesc = nonWorkingDays.map(d => {
    const label = d.type === 'holiday' ? `državni praznik "${d.label}"` : 'nedjelja';
    return `  - ${d.date} (${label})`;
  }).join('\n');

  const prompt = `Radi se o trgovini/lancu "${chainName}" u Hrvatskoj.

Za svaki od sljedećih dana navedi je li tipično otvoreno i radno vrijeme:
${daysDesc}

Vrati SAMO JSON array (bez teksta):
[
  { "date": "YYYY-MM-DD", "open": true/false, "time": "HH:MM-HH:MM ili null" }
]`;

  try {
    const text = await callGemini(prompt);
    const arr  = extractJSON(text);
    if (!Array.isArray(arr)) return null;
    return arr
      .filter(e => e.date && typeof e.open === 'boolean')
      .map(e => ({ date: e.date, open: e.open, time: e.open && e.time ? String(e.time) : null }))
      .filter(e => nonWorkingDays.some(d => d.date === e.date));
  } catch {
    return null;
  }
}

// ─── STUDENAC WEB SCRAPER ────────────────────────────────────────────────────
// Studenac stores have highly variable individual hours — the static table is
// unreliable.  We scrape studenac.hr once per run to get actual per-store,
// per-week hours directly from their website.

/**
 * Fetch studenac.hr/trgovine (≈3.8 MB) and build two lookup structures:
 *   addressMap: Map<normalizedAddress, url>  — for stores that have an OSM address
 *   coordStores: [{lat, lon, url}]           — for coordinate-based fallback matching
 */
async function fetchStudenacStoreList() {
  const res = await fetch('https://www.studenac.hr/trgovine', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Studenac list returned ${res.status}`);
  const html = await res.text();

  // 1. Address → URL from card articles
  const addressMap = new Map();
  const cardParts = html.split('<article class="card card--03">');
  for (const part of cardParts.slice(1)) {
    const titleM = part.match(/<h3 class="card__title">([^<]+)<\/h3>/);
    const urlM   = part.match(/href="(https:\/\/www\.studenac\.hr\/trgovine\/\d+\/[^"]+)"/);
    if (titleM && urlM) {
      addressMap.set(_normAddr(titleM[1].trim()), urlM[1]);
    }
  }

  // 2. Coordinates → URL from map markers
  //    Each marker: <div class="marker" data-lat="X" data-lng="Y" ...>
  //    followed by info_window with the store URL
  const coordStores = [];
  const markerRe =
    /data-lat="([\d.]+)"\s+data-lng="([\d.]+)"[\s\S]{0,1500}?href="(https:\/\/www\.studenac\.hr\/trgovine\/\d+\/[^"]+)"/g;
  for (const m of html.matchAll(markerRe)) {
    coordStores.push({ lat: parseFloat(m[1]), lon: parseFloat(m[2]), url: m[3] });
  }

  console.log(`  Studenac list: ${addressMap.size} addresses, ${coordStores.length} coord entries`);
  return { addressMap, coordStores };
}

/** Normalize address for fuzzy matching (lowercase, strip city suffix & "Ulica") */
function _normAddr(addr) {
  return (addr || '').toLowerCase()
    .replace(/,\s*[\w\s]+$/, '')      // strip ", Zagreb" / ", Split" etc.
    .replace(/\bul(ica|\.)\s*/i, '')  // strip "Ulica" / "Ul."
    .trim();
}

/** Find the Studenac website URL for an Overpass store by address matching */
function findStudenacUrl(addressMap, overpassAddress) {
  if (!overpassAddress) return null;
  const norm = _normAddr(overpassAddress);
  if (addressMap.has(norm)) return addressMap.get(norm);
  // Prefix / substring fallback
  for (const [key, url] of addressMap) {
    if (key.startsWith(norm) || norm.startsWith(key)) return url;
  }
  return null;
}

/**
 * Find the Studenac website URL by coordinate proximity (for stores with no OSM address).
 * Returns the url of the closest marker within 100 m, or null.
 */
function findStudenacUrlByCoords(coordStores, storeLat, storeLon) {
  if (!storeLat || !storeLon || !coordStores.length) return null;
  let best = null, bestDist = Infinity;
  for (const cs of coordStores) {
    const d = haversineM(storeLat, storeLon, cs.lat, cs.lon);
    if (d < bestDist) { bestDist = d; best = cs.url; }
  }
  // Only accept matches within 100 m to avoid wrong stores
  return bestDist <= 100 ? best : null;
}

const _HR_DAYS = {
  Ponedjeljak: 0, Utorak: 1, Srijeda: 2,
  Četvrtak: 3, Petak: 4, Subota: 5, Nedjelja: 6,
};

/**
 * Parse the marketsingle__workhours section and return a Map<isoDate, {open,time}>
 * for the current Studenac week (Mon–Sun shown on the page).
 */
function parseStudenacWeeklyHours(html) {
  // Week header: <small>01.06 - 07.06.2026.</small>
  const rangeM = html.match(
    /Radno vrijeme <small>(\d{2})\.(\d{2})\s*-\s*\d{2}\.\d{2}\.(\d{4})\.<\/small>/,
  );
  if (!rangeM) return null;
  const weekStart = new Date(+rangeM[3], +rangeM[2] - 1, +rangeM[1]);

  // Extract the workhours section to limit the search scope.
  // Some stores have no services section (no second marketsingle__title after columns),
  // so we fall back to scanning from the columns div to end of page if needed.
  const workhoursSectionM =
    html.match(/class="marketsingle__columns">([\s\S]*?)(?=class="marketsingle__title"|class="prefooter)/) ||
    html.match(/class="marketsingle__columns">([\s\S]*)/);
  const searchIn = workhoursSectionM ? workhoursSectionM[1] : html;

  const dayMap = new Map();
  // Day name + hours appear in <li>DayName:\n  <strong>HH:MM-HH:MM</strong></li>
  const liRe =
    /(Ponedjeljak|Utorak|Srijeda|Četvrtak|Petak|Subota|Nedjelja):\s*<strong[^>]*>([^<]+)<\/strong>/g;
  for (const m of searchIn.matchAll(liRe)) {
    const offset = _HR_DAYS[m[1]];
    if (offset === undefined) continue;
    const hoursText = m[2].trim();
    const d = new Date(weekStart);
    d.setDate(d.getDate() + offset);
    dayMap.set(toISO(d), hoursText === 'Zatvoreno'
      ? { open: false, time: null }
      : { open: true,  time: hoursText });
  }
  return dayMap;
}

/**
 * Fetch one Studenac store page and return hours[] for the given non-working days.
 * Only days that fall within the current week are returned; others are skipped
 * so the caller can fall back to the static table.
 */
async function fetchStudenacStoreHours(storeUrl, nonWorkingDays) {
  const res = await fetch(storeUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  const dayMap = parseStudenacWeeklyHours(html);
  if (!dayMap) return null;

  const hours = [];
  for (const d of nonWorkingDays) {
    if (dayMap.has(d.date)) {
      const h = dayMap.get(d.date);
      hours.push({ date: d.date, open: h.open, time: h.time });
    }
  }
  return hours.length > 0 ? hours : null;
}

function getChainWebsiteHint(name) {
  const n = name.toLowerCase();
  if (n.includes('lidl'))     return '\nMoguća web stranica: www.lidl.hr/s/hr-HR/trazilica-trgovina/zagreb/';
  if (n.includes('konzum'))   return '\nMoguća web stranica: konzum.hr/popis-prodavaonica';
  if (n.includes('spar') || n.includes('interspar')) return '\nMoguća web stranica: www.spar.hr/prodavaonice';
  if (n.includes('studenac')) return '\nMoguća web stranica: www.studenac.hr/trgovine';
  if (n.includes('kaufland')) return '\nMoguća web stranica: www.kaufland.hr/prodavaonice.html';
  if (n.includes('tommy'))    return '\nMoguća web stranica: www.tommy.hr/prodavaonice';
  if (n.includes('plodine'))  return '\nMoguća web stranica: www.plodine.hr/popis-prodavaonica';
  if (n.includes(' dm') || n === 'dm') return '\nMoguća web stranica: www.dm.hr/service/c3/store-finder';
  if (n.includes('müller') || n.includes('muller')) return '\nMoguća web stranica: www.mueller.hr/prodavaonice/';
  return '';
}

// ─── DEDUPLICATE / GROUP STORES ───────────────────────────────────────────────

/** Group nearby OSM nodes — deduplicate only exact same chain+address.
 *  Uses OSM ID as fallback so stores without address aren't collapsed. */
function groupStores(stores) {
  const groups = new Map();
  for (const s of stores) {
    // Key: normalised chain name + address (if available) OR osm_id as fallback
    const addrKey = s.address
      ? normalizeChainName(s.name) + '|' + s.address.toLowerCase().trim()
      : s.osm_id; // each OSM node is unique
    if (!groups.has(addrKey)) groups.set(addrKey, s);
  }
  return [...groups.values()];
}

function normalizeChainName(name) {
  return name.toLowerCase()
    .replace(/\s+(maxi|mini|super|market|express|city|plus|hr|d\.o\.o\.)$/i, '')
    .trim();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏪 Store hours fetch started at ${NOW.toISOString()}\n`);

  const locData = readJson('stores-location.json');
  if (!locData?.lat || !locData?.lon) {
    console.log('⚠ Location not set (data/stores-location.json has no lat/lon). Skipping.');
    writeJson('stores-hours.json', {
      last_updated: NOW.toISOString(),
      location: null,
      non_working_days: [],
      stores: [],
    });
    return;
  }

  const { lat, lon, radius_m = 1000 } = locData;
  console.log(`📍 Location: ${lat}, ${lon} (radius ${radius_m}m)`);

  // 1. Upcoming non-working days
  const nonWorkingDays = getUpcomingNonWorkingDays(7);
  if (!nonWorkingDays.length) {
    console.log('✓ No non-working days in next 7 days. Nothing to check.');
    writeJson('stores-hours.json', {
      last_updated: NOW.toISOString(),
      location: { lat, lon },
      non_working_days: [],
      stores: [],
    });
    return;
  }
  console.log(`📅 Non-working days: ${nonWorkingDays.map(d => `${d.date} (${d.label})`).join(', ')}`);

  // 2. Find nearby stores via Overpass
  console.log('\n🔍 Querying Overpass for nearby stores…');
  let rawStores;
  try {
    rawStores = await findNearbyStores(lat, lon, radius_m);
    console.log(`  Found ${rawStores.length} stores`);
  } catch (err) {
    console.error(`  ✗ Overpass failed: ${err.message}`);
    rawStores = [];
  }

  const allUnique = groupStores(rawStores);

  // All known chains (no limit — must never cut off Lidl/Konzum/Spar etc.)
  const knownStores   = allUnique.filter(s => matchChain(s.name));
  // Unknown chains: closest 5 only
  const unknownStores = allUnique.filter(s => !matchChain(s.name)).slice(0, 5);
  const stores = [...knownStores, ...unknownStores];

  console.log(`  → ${allUnique.length} unique total, processing ${stores.length} (${knownStores.length} known + ${unknownStores.length} unknown)`);

  if (!stores.length) {
    writeJson('stores-hours.json', {
      last_updated: NOW.toISOString(),
      location: { lat, lon },
      non_working_days: nonWorkingDays,
      stores: [],
    });
    return;
  }

  // 3a. Studenac: scrape actual per-store hours from studenac.hr
  //     (static table is unreliable — individual stores vary)
  const studenacOverrides = new Map(); // osm_id → hours[]
  const studenacNearby = stores.filter(s => matchChain(s.name) === 'Studenac');
  if (studenacNearby.length > 0) {
    console.log(`\n🟠 Fetching Studenac hours from studenac.hr (${studenacNearby.length} stores)…`);
    try {
      const { addressMap, coordStores } = await fetchStudenacStoreList();
      for (const store of studenacNearby) {
        // Try address match first; fall back to coordinate proximity
        const url = findStudenacUrl(addressMap, store.address)
               ?? findStudenacUrlByCoords(coordStores, store.lat, store.lon);
        if (!url) {
          console.log(`  ⚠ No match on studenac.hr for: ${store.address ?? `coords ${store.lat},${store.lon}`}`);
          continue;
        }
        try {
          const hours = await fetchStudenacStoreHours(url, nonWorkingDays);
          if (hours) {
            studenacOverrides.set(store.osm_id, hours);
            const openCnt = hours.filter(h => h.open).length;
            const tag = store.address ?? `${store.lat},${store.lon}`;
            console.log(`  ✓ Studenac · ${tag}: ${openCnt}/${hours.length} open day(s) [website]`);
          } else {
            console.log(`  ⚠ Studenac · ${store.address ?? 'coords'}: dates outside current week → static table`);
          }
          await sleep(800);
        } catch (err) {
          console.warn(`  ⚠ Studenac · ${store.address}: ${err.message.slice(0, 60)}`);
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Studenac list fetch failed: ${err.message.slice(0, 80)} — falling back to static table`);
    }
  }

  // 3b. Match each store to static hours table; unknown chains → Gemini fallback
  const results = [];
  const unknownChains = new Set();

  for (const store of stores) {
    const chain = matchChain(store.name);
    let hours;

    if (chain === 'Studenac' && studenacOverrides.has(store.osm_id)) {
      // Use scraped actual hours from studenac.hr
      hours = studenacOverrides.get(store.osm_id);
    } else if (chain) {
      // Known chain — use static table, no API call
      hours = hoursFromTable(chain, nonWorkingDays);
      const openDays = hours.filter(h => h.open).length;
      const src = chain === 'Studenac' ? 'static fallback' : chain;
      console.log(`  ✓ ${store.name}${store.address ? ' · ' + store.address : ''} (${src}): ${openDays} open day(s)`);
    } else {
      // Unknown chain — queue for Gemini (best-effort)
      unknownChains.add(store.name);
      hours = null;
    }

    if (hours?.length > 0) {
      results.push({
        name:    store.name,
        brand:   store.brand || null,
        address: store.address || null,
        city:    store.city || null,
        lat:     store.lat  || null,
        lon:     store.lon  || null,
        dist:    store.dist,
        hours,
      });
    }
  }

  // 4. Ask Gemini for unknown chains (best-effort, skip on error)
  if (unknownChains.size > 0 && GEMINI_KEY) {
    console.log(`\n  🤖 Unknown chains for Gemini lookup: ${[...unknownChains].join(', ')}`);
    for (const chainName of unknownChains) {
      const storesForChain = stores.filter(s => s.name === chainName);
      try {
        const hours = await askGeminiForChain(chainName, nonWorkingDays);
        if (hours?.length > 0) {
          for (const s of storesForChain) {
            console.log(`  ✓ ${s.name}${s.address ? ' · ' + s.address : ''} (Gemini): ${hours.filter(h => h.open).length} open day(s)`);
            results.push({ name: s.name, brand: s.brand || null, address: s.address || null, city: s.city || null, lat: s.lat || null, lon: s.lon || null, dist: s.dist, hours });
          }
        }
        await sleep(4000);
      } catch (err) {
        console.warn(`  ⚠ Gemini failed for ${chainName}: ${err.message.slice(0, 60)}`);
      }
    }
  }

  // Include ALL found stores in the JSON (empty hours = not processed/unknown)
  // Frontend shows only stores with open hours; the full list aids debugging.
  const allStores = allUnique.map(s => {
    const found = results.find(r => r.name === s.name && r.dist === s.dist);
    return found ?? {
      name:    s.name,
      brand:   s.brand || null,
      address: s.address || null,
      city:    s.city || null,
      lat:     s.lat || null,
      lon:     s.lon || null,
      dist:    s.dist,
      hours:   [],   // empty = no hours data available
    };
  });

  writeJson('stores-hours.json', {
    last_updated: NOW.toISOString(),
    location: { lat, lon },
    non_working_days: nonWorkingDays,
    stores: allStores,
  });

  const totalOpen = results.reduce((n, s) => n + s.hours.filter(h => h.open).length, 0);
  console.log(`\n✅ Done. ${results.length} stores checked, ${totalOpen} open-day confirmations.\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
