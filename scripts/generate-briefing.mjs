/**
 * Daily briefing generator — runs after fetch-all.mjs in GitHub Actions.
 * Generates data/briefing.json with structured sections:
 *   weather | fuel | market | ai_news | micro_tips
 *
 * APIs used:
 *   Open-Meteo     — weather (free, no key)
 *   CoinGecko      — Bitcoin price (free, no key)
 *   open.er-api.com — USD/EUR rate (free, no key)
 *   Gemini 2.0 Flash + Google Search — fuel prices (GEMINI_API_KEY)
 *   Gemini 1.5 Flash — micro tips generation (GEMINI_API_KEY)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const DATA    = join(__dir, '..', 'data');
const NOW     = new Date();
const NOW_ISO = NOW.toISOString();

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

function formatHrDate(d) {
  const days   = ['Nedjelja','Ponedjeljak','Utorak','Srijeda','Četvrtak','Petak','Subota'];
  const months = ['siječnja','veljače','ožujka','travnja','svibnja','lipnja',
                  'srpnja','kolovoza','rujna','listopada','studenog','prosinca'];
  return `${days[d.getDay()]}, ${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}.`;
}

/** Extract the first complete JSON object from a string */
function extractJSON(text) {
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    return JSON.parse(text.slice(s, e + 1));
  } catch { return null; }
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────

async function callGemini(prompt, { model = 'gemini-2.0-flash', useSearch = false } = {}) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0.15 },
  };
  if (useSearch) {
    body.tools = model.startsWith('gemini-2')
      ? [{ google_search: {} }]
      : [{ google_search_retrieval: { dynamic_retrieval_config: { mode: 'MODE_DYNAMIC', dynamic_threshold: 0.3 } } }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
  }
  const data  = await res.json();
  const text  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

async function gemini(prompt, useSearch = false) {
  // Try 2.0-flash first; fall back to 2.0-flash-lite
  try {
    return await callGemini(prompt, { model: 'gemini-2.0-flash', useSearch });
  } catch (e) {
    console.warn(`  gemini-2.0-flash: ${e.message} → trying 2.0-flash-lite`);
    return await callGemini(prompt, { model: 'gemini-2.0-flash-lite', useSearch });
  }
}

// ─── 1. WEATHER ───────────────────────────────────────────────────────────────

async function fetchWeather(lat, lon) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    Object.entries({
      latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 1,
      daily: [
        'weathercode','temperature_2m_max','temperature_2m_min',
        'precipitation_sum','windspeed_10m_max','windgusts_10m_max','snowfall_sum',
      ].join(','),
    }).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d   = await res.json();
    const day = d.daily ?? {};

    const code = day.weathercode?.[0] ?? 0;
    const tMax = Math.round(day.temperature_2m_max?.[0] ?? 0);
    const tMin = Math.round(day.temperature_2m_min?.[0] ?? 0);
    const rain = +(day.precipitation_sum?.[0] ?? 0).toFixed(1);
    const gust = +(day.windgusts_10m_max?.[0] ?? 0).toFixed(0);
    const wind = +(day.windspeed_10m_max?.[0] ?? 0).toFixed(0);
    const snow = +(day.snowfall_sum?.[0] ?? 0).toFixed(1);

    const COND = {
      0:'vedro', 1:'pretežno vedro', 2:'djelomično oblačno', 3:'oblačno',
      45:'magla', 48:'magla s injom', 51:'rosulja', 53:'rosulja', 55:'jaka rosulja',
      61:'lagana kiša', 63:'kiša', 65:'jaka kiša', 71:'snijeg', 73:'umjeren snijeg',
      75:'jak snijeg', 80:'pljuskovi', 81:'jaki pljuskovi', 95:'grmljavina',
      96:'grmljavina s gradom', 99:'jaka grmljavina',
    };
    const cond = COND[code] ?? COND[Math.floor(code / 10) * 10] ?? 'promjenljivo';
    const icon = code === 0 ? '☀️' : code <= 2 ? '🌤️' : code === 3 ? '☁️'
      : code <= 48 ? '🌫️' : code <= 67 ? '🌧️' : code <= 77 ? '❄️'
      : code <= 82 ? '🌦️' : '⛈️';

    const alerts = [];
    if      (tMax >= 38)   alerts.push({ level: 'danger',  text: `Opasna vrućina: ${tMax}°C` });
    else if (tMax >= 35)   alerts.push({ level: 'warning', text: `Ekstremna vrućina: ${tMax}°C` });
    if      (tMin <= -15)  alerts.push({ level: 'danger',  text: `Ekstremni mraz: ${tMin}°C` });
    else if (tMin <= -10)  alerts.push({ level: 'warning', text: `Jak mraz: ${tMin}°C` });
    if      (gust >= 90)   alerts.push({ level: 'danger',  text: `Orkanska oluja: udari do ${gust} km/h` });
    else if (gust >= 75)   alerts.push({ level: 'warning', text: `Olujni udari vjetra: do ${gust} km/h` });
    if      (rain >= 40)   alerts.push({ level: 'warning', text: `Obilne padaline: ${rain} mm` });
    if      (snow >= 10)   alerts.push({ level: 'warning', text: `Obilni snijeg: ${snow} cm` });
    if      (code >= 95)   alerts.push({ level: 'warning', text: 'Grmljavinska oluja' });

    const extra = [
      rain > 0.5 ? `${rain} mm` : null,
      wind > 25  ? `vjetar ${wind} km/h` : null,
    ].filter(Boolean).join(', ');
    const summary = `${tMin}–${tMax}°C, ${cond}${extra ? ' · ' + extra : ''}`;

    console.log(`✓ Weather: ${summary}, alerts: ${alerts.length}`);
    return { icon, summary, alerts };
  } catch (err) {
    console.warn(`Weather failed: ${err.message}`);
    return { icon: '🌡️', summary: 'Vremenski podaci nedostupni', alerts: [], error: err.message };
  }
}

// ─── 2. FUEL PRICES ───────────────────────────────────────────────────────────

async function fetchFuelPrices() {
  if (!GEMINI_KEY) {
    console.log('⚠ No Gemini key — fuel prices skipped');
    return { error: 'no_api_key' };
  }

  const prompt = `Pronađi TRENUTNE maloprodajne cijene goriva u Hrvatskoj za sve dostupne benzinske kompanije. Provjeri i je li najavljena nova cijena za sljedeći tjedan.

Odgovori ISKLJUČIVO validnim JSON-om, bez ikakvog drugog teksta:
{
  "current_date": "DD.MM.YYYY",
  "eurodiesel": [{"company": "Naziv", "price": 1.234}, ...],
  "premium_eurodiesel": [{"company": "Naziv", "price": 1.234}, ...],
  "upcoming_date": null,
  "upcoming_eurodiesel": null,
  "upcoming_premium": null
}

Pravila:
- Kompanija je onaj koji prodaje gorivo (INA, MOL, Petrol, Tifon, BP, OMV, Lukoil, NIS Petrol...)
- Sortiraj po cijeni od NAJNIŽE prema NAJVIŠOJ unutar svake grupe
- Cijene u EUR/l kao broj s 3 decimalna mjesta
- upcoming_* popuni samo ako postoji konkretna najava nove cijene s datumom`;

  try {
    console.log('🔍 Fetching fuel prices via Gemini search...');
    const text   = await gemini(prompt, true);
    const parsed = extractJSON(text);
    if (!parsed?.eurodiesel?.length) throw new Error('Invalid fuel data');
    console.log(`✓ Fuel: ${parsed.eurodiesel.length} companies, date: ${parsed.current_date}`);
    return parsed;
  } catch (err) {
    console.warn(`Fuel prices failed: ${err.message}`);
    return { error: err.message };
  }
}

// ─── 3. MARKET DATA ───────────────────────────────────────────────────────────

async function fetchMarketData() {
  const result = { updated_at: NOW_ISO };

  // Bitcoin — CoinGecko (free, no key)
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur&include_24hr_change=true',
      { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    result.btc_usd        = d.bitcoin.usd;
    result.btc_eur        = d.bitcoin.eur;
    result.btc_change_24h = +((d.bitcoin.usd_24h_change ?? 0).toFixed(2));
    console.log(`✓ BTC: $${result.btc_usd} (${result.btc_change_24h > 0 ? '+' : ''}${result.btc_change_24h}%)`);
  } catch (err) {
    console.warn(`BTC failed: ${err.message}`);
    result.btc_error = err.message;
  }

  // USD/EUR — open.er-api.com (free, no key)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    result.usd_eur = +(d.rates?.EUR?.toFixed(4) ?? 0);
    console.log(`✓ USD/EUR: ${result.usd_eur}`);
  } catch (err) {
    console.warn(`USD/EUR failed: ${err.message}`);
    result.eur_error = err.message;
  }

  return result;
}

// ─── 4. AI NEWS ───────────────────────────────────────────────────────────────

const AI_KW = [
  'copilot','github copilot','claude','anthropic','openai','chatgpt','gpt-4','gpt-5',
  'vscode','visual studio code','oracle','postgresql','postgres','mysql','mariadb',
  'ai agent','agentic','llm','large language','gemini','mistral','llama',
  'vulnerability','cve','exploit','security patch','zero-day',
  'playwright','puppeteer','browser automation',
  'ollama','self-hosted ai','local llm','hugging face',
];

function filterAiNews(techData, n = 5) {
  const items = techData?.items ?? [];
  return items
    .map(item => {
      const t = `${item.title} ${item.summary ?? ''}`.toLowerCase();
      return { ...item, _score: AI_KW.filter(kw => t.includes(kw)).length };
    })
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score || new Date(b.published) - new Date(a.published))
    .slice(0, n)
    .map(({ title, link, source }) => ({ title, link, source }));
}

// ─── 5. MICRO TIPS ────────────────────────────────────────────────────────────

// Static pool — used when Gemini is unavailable
const POOL = {
  vscode: [
    { tip: 'Multi-cursor: postavi cursor na više mjesta istovremeno', keys: 'Alt+Click' },
    { tip: 'Command Palette: brzi pristup svim komandama', keys: 'Ctrl+Shift+P' },
    { tip: 'Rename Symbol svuda u projektu (refactoring)', keys: 'F2' },
    { tip: 'Quick Fix i Code Actions na trenutnoj poziciji', keys: 'Ctrl+.' },
    { tip: 'Toggle integrirani terminal', keys: 'Ctrl+`' },
    { tip: 'Selektiraj sva pojavljivanja trenutne riječi', keys: 'Ctrl+Shift+L' },
    { tip: 'Pomakni liniju gore ili dolje bez cut/paste', keys: 'Alt+↑ / Alt+↓' },
    { tip: 'Format Document (auto-format cijelog fajla)', keys: 'Shift+Alt+F' },
    { tip: 'Go to Definition simbola', keys: 'F12' },
    { tip: 'Peek Definition bez napuštanja fajla', keys: 'Alt+F12' },
    { tip: 'Dupliciraj trenutnu liniju ispod', keys: 'Shift+Alt+↓' },
    { tip: 'Obriši cijelu liniju odjednom', keys: 'Ctrl+Shift+K' },
    { tip: 'Otvori datoteku brzim pretraživanjem', keys: 'Ctrl+P' },
    { tip: 'Toggle Word Wrap za dugačke linije', keys: 'Alt+Z' },
    { tip: 'Nađi i selektiraj sljedeće pojavljivanje', keys: 'Ctrl+D' },
  ],
  sql: [
    'EXISTS umjesto IN za subqueries — brže jer stane na prvom podudaranju: WHERE EXISTS (SELECT 1 FROM ...)',
    'Nikad SELECT * u produkciji — navedi kolone, manji I/O i bolji cache plan',
    'Covering index: uključi sve kolone iz WHERE + SELECT u index pa nema pristupa tablici',
    'Window funkcije (ROW_NUMBER, LAG, LEAD) umjesto self-join za redosljed i razlike',
    'EXPLAIN ANALYZE prikazuje stvarne vs procijenjene redove — ključno za tuning',
    'Partial index s WHERE klauzulom smanjuje veličinu i ubrzava specifična filtriranja',
    'GROUP BY s ROLLUP za subtotale u jednom prolasku: GROUP BY ROLLUP(god, mj)',
    'NOT EXISTS brži od NOT IN kad subquery može vratiti NULL vrijednost',
    'Parametrizirani upiti = plan cache reuse + SQL injection zaštita istovremeno',
    'Batch INSERT umjesto jednog-po-jednog: INSERT INTO t VALUES (...),(...),...',
  ],
  oracle: [
    '/*+ INDEX(t ime_indexa) */ forsira specifičan index kad optimizer bira full scan',
    '/*+ PARALLEL(t 4) */ paralelno izvršavanje querija na N thread-ova',
    '/*+ NO_MERGE(v) */ sprječava merging inline viewa s parent queryjem',
    '/*+ RESULT_CACHE */ cache-ira rezultat funkcije u SGA za ponovljene pozive',
    'CONNECT BY LEVEL <= n generira broj redova bez pomoćne tablice',
    'LISTAGG(col, \',\') WITHIN GROUP (ORDER BY col) konkatenira u jedan string',
    'TRUNC(datum_kolona) = TRUNC(SYSDATE) koristi B-tree index na datumskoj koloni',
    'DBMS_STATS.GATHER_TABLE_STATS osvježava statistike za točniji execution plan',
    'NVL2(expr, kad_nije_null, kad_je_null) kompaktnija od dvostrukog NVL-a',
    'FETCH FIRST n ROWS ONLY umjesto ROWNUM — kompatibilno s ORDER BY i čitljivije',
  ],
  regex: [
    '\\b granica riječi: \\bword\\b podudara cijelu riječ, ne "password" ili "swordfish"',
    '(?:group) non-capturing group: grupiraj bez pamćenja za veće performanse',
    '(?=pattern) lookahead: "iza ovog mora slijediti X" bez konzumiranja znakova',
    '.+? lazy quantifier: stane na prvom mogućem podudaranju, ne zadnjem',
    '[^\\n]* svaki znak osim newline — dohvati cijelu liniju bez dotall flaga',
    '(?<ime>\\d{4}) named group — referenciraj s \\k<ime> ili $<ime> u replace',
    '\\d{4}-\\d{2}-\\d{2} ISO datum pattern; za validaciju zatvori s ^...$',
    '(?i) inline flag za case-insensitive bez mijenjanja ostatka patternahe',
    '\\s+ pokriva space, tab i newline; \\S je negacija (svaki ne-whitespace)',
    '^(?!.*pattern) negative lookahead: "ova linija ne smije sadržavati X"',
  ],
};

function staticTips() {
  const day = Math.floor((NOW - new Date(NOW.getFullYear(), 0, 0)) / 86400000);
  const p   = (arr) => arr[day % arr.length];
  return { vscode: p(POOL.vscode), sql: p(POOL.sql), oracle: p(POOL.oracle), regex: p(POOL.regex) };
}

async function generateMicroTips() {
  if (!GEMINI_KEY) return staticTips();

  const seed = NOW.getDate() * 7 + NOW.getMonth() * 31;
  const prompt = `Seed za varijaciju: ${seed}
Generiraj 4 konkretna stručna mikro-savjeta na HRVATSKOM jeziku.

Odgovori ISKLJUČIVO validnim JSON-om bez ikakvog drugog teksta:
{
  "vscode": {"tip": "što ova kombinacija radi (1 rečenica)", "keys": "Ctrl+X"},
  "sql":    "konkretan savjet s kratkim SQL primjerom (1-2 rečenice)",
  "oracle": "Oracle-specifičan hint ili savjet s primjerom (1-2 rečenice)",
  "regex":  "regex trik s primjerom patternam (1-2 rečenice)"
}

Zahtjevi:
- VSCode: realna tipkovna kombinacija koja uštedi kod pisanja koda
- SQL: tehnika optimizacije s kratkim primjerom (INDEX, EXISTS, EXPLAIN, JOIN...)
- Oracle: specifičan Oracle hint ili funkcija (/*+ HINT */, DBMS_*, ROWNUM, itd.)
- Regex: praktičan metacharacter ili pattern s primjerom primjene`;

  try {
    const text   = await callGemini(prompt, { model: 'gemini-2.0-flash-lite', useSearch: false });
    const parsed = extractJSON(text);
    if (!parsed?.vscode || !parsed?.sql || !parsed?.oracle || !parsed?.regex)
      throw new Error('Missing fields');
    return parsed;
  } catch (err) {
    console.warn(`Micro tips Gemini failed: ${err.message} → static pool`);
    return staticTips();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n✨ Briefing generation started — ${NOW_ISO}\n`);

  const cfg       = JSON.parse(readFileSync(join(__dir, '..', 'config.json'), 'utf8'));
  const { lat, lon } = cfg.location ?? { lat: 45.815, lon: 15.982 };

  // Run all independent tasks in parallel
  const [weather, fuel, market, microTips] = await Promise.all([
    fetchWeather(lat, lon),
    fetchFuelPrices(),
    fetchMarketData(),
    generateMicroTips(),
  ]);

  // AI news: filter from already-fetched RSS (no extra API call)
  const aiNews = filterAiNews(readJson('tech-news.json'), 5);
  console.log(`✓ AI news: ${aiNews.length} items matched`);

  const briefing = {
    version:      2,
    date:         NOW.toISOString().split('T')[0],
    generated_at: NOW_ISO,
    date_hr:      formatHrDate(NOW),
    weather,
    fuel,
    market,
    ai_news:      aiNews,
    micro_tips:   microTips,
  };

  writeJson('briefing.json', briefing);

  // Update metadata
  const meta = readJson('metadata.json') ?? {};
  if (meta.sources) {
    meta.sources.briefing = {
      updated_at: NOW_ISO, ok: true, ai_used: !!GEMINI_KEY,
      sections: ['weather', 'fuel', 'market', 'ai_news', 'micro_tips'],
    };
    writeJson('metadata.json', meta);
  }

  console.log(`\n✅ Briefing complete (Gemini: ${GEMINI_KEY ? 'yes' : 'no'})\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
