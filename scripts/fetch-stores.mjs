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
  return date.toISOString().slice(0, 10);
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
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 25); // max 25 stores, sorted by distance
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

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 800, temperature: 0.1 },
  };
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
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

// ─── CHAIN HOURS TABLE ────────────────────────────────────────────────────────
// ONE Gemini+search call to get hours for all known chains on specific dates.
// Then per-store matching uses this table — no extra API calls.

const KNOWN_CHAINS = [
  'Lidl','Konzum','Spar','Interspar','Studenac','Kaufland','dm','Müller',
  'Tommy','Plodine','Eurospin','KTC','Ribola','Boso','Pevex',
];

/** Normalise a store name to match a chain entry */
function matchChain(storeName) {
  const n = (storeName || '').toLowerCase();
  for (const c of KNOWN_CHAINS) {
    if (n.includes(c.toLowerCase())) return c;
  }
  return null;
}

/**
 * Fetch opening hours for all known chains on the given dates.
 * Returns: { "Lidl": { "2026-05-30": { open: false }, "2026-05-31": { open: true, time: "08-21" } }, … }
 */
async function fetchChainHoursTable(nonWorkingDays) {
  const daysDesc = nonWorkingDays.map(d => {
    const label = d.type === 'holiday' ? `državni praznik "${d.label}"` : 'nedjelja';
    return `  - ${d.date} (${label})`;
  }).join('\n');

  const prompt = `Provjeri radno vrijeme trgovačkih lanaca u Hrvatskoj koristeći Google pretragu.

Lanci: ${KNOWN_CHAINS.join(', ')}

Dani za provjeru:
${daysDesc}

Za svaki lanac i svaki dan vrati je li otvoreno i radno vrijeme. Uzmi u obzir da su neke lokacije drugačije — koristi tipično radno vrijeme za Hrvatsku.

Vrati SAMO JSON (bez ikakvog drugog teksta):
{
  "Lidl":    { "2026-05-30": { "open": false, "time": null }, "2026-05-31": { "open": true, "time": "08:00-21:00" } },
  "Konzum":  { "2026-05-30": { "open": false, "time": null }, "2026-05-31": { "open": true, "time": "08:00-20:00" } },
  ...
}`;

  try {
    console.log('  📡 Fetching chain hours table via Gemini+Search…');
    const text = await callGemini(prompt);
    const parsed = extractJSON(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('  ⚠ Could not parse chain hours table');
      return {};
    }
    console.log(`  ✓ Got hours for: ${Object.keys(parsed).join(', ')}`);
    return parsed;
  } catch (err) {
    console.warn(`  ⚠ Chain hours table error: ${err.message.slice(0, 100)}`);
    return {};
  }
}

/** Apply the chain table to a list of stores */
function applyChainTable(stores, table, nonWorkingDays) {
  return stores.map(store => {
    const chain = matchChain(store.name);
    if (!chain || !table[chain]) return { store, hours: [] };

    const hours = nonWorkingDays.map(d => {
      const entry = table[chain][d.date];
      if (!entry) return null;
      return {
        date: d.date,
        open: !!entry.open,
        time: entry.open && entry.time ? String(entry.time).trim() : null,
      };
    }).filter(Boolean);

    return { store, hours };
  });
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

/** Group nearby OSM nodes of the same chain into one entry */
function groupStores(stores) {
  const groups = new Map(); // key → store entry
  for (const s of stores) {
    const key = normalizeChainName(s.name) + '|' + (s.address || '');
    if (!groups.has(key)) groups.set(key, s);
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

  const stores = groupStores(rawStores).slice(0, 15); // max 15 unique chains nearby
  console.log(`  → ${stores.length} unique stores after grouping`);

  if (!stores.length || !GEMINI_KEY) {
    if (!GEMINI_KEY) console.log('⚠ GEMINI_API_KEY not set — skipping hours lookup');
    writeJson('stores-hours.json', {
      last_updated: NOW.toISOString(),
      location: { lat, lon },
      non_working_days: nonWorkingDays,
      stores: stores.map(s => ({
        name: s.name, address: s.address, city: s.city, dist: s.dist, hours: [],
      })),
    });
    return;
  }

  // 3. ONE Gemini+search call → hours table for all known chains
  console.log('\n  🔎 Fetching chain hours (1 API call for all chains)…');
  const chainTable = await fetchChainHoursTable(nonWorkingDays);

  // 4. Apply table to found stores (no extra API calls)
  const matched = applyChainTable(stores, chainTable, nonWorkingDays);

  const results = [];
  for (const { store, hours } of matched) {
    const chain  = matchChain(store.name);
    const openDays = hours.filter(h => h.open);
    console.log(`  ${store.name}${store.address ? ' · ' + store.address : ''}: ${chain ? `(${chain}) ` : ''}${openDays.length} open day(s)`);
    if (hours.length > 0) {
      results.push({
        name:    store.name,
        brand:   store.brand || null,
        address: store.address || null,
        city:    store.city || null,
        dist:    store.dist,
        hours,
      });
    }
  }

  writeJson('stores-hours.json', {
    last_updated: NOW.toISOString(),
    location: { lat, lon },
    non_working_days: nonWorkingDays,
    stores: results,
  });

  const totalOpen = results.reduce((n, s) => n + s.hours.filter(h => h.open).length, 0);
  console.log(`\n✅ Done. ${results.length} stores checked, ${totalOpen} open-day confirmations.\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
