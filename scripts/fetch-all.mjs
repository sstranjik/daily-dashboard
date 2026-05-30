/**
 * Daily data fetcher — runs in GitHub Actions.
 * Fetches RSS feeds → saves JSON to ../data/
 * Node 20+ required (uses built-in fetch).
 */

import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const DATA    = join(__dir, '..', 'data');
const CONFIG  = JSON.parse(readFileSync(join(__dir, '..', 'config.json'), 'utf8'));

const parser  = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const NOW_ISO = new Date().toISOString();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function fetchRSS(url, sourceName) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'DashboardBot/1.0 (github-actions)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSSXml(xml, sourceName);
  } catch (err) {
    console.warn(`⚠ RSS fetch failed for ${sourceName} (${url}): ${err.message}`);
    return [];
  }
}

function parseRSSXml(xml, sourceName) {
  try {
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel ?? parsed?.feed;
    if (!channel) return [];

    const rawItems = Array.isArray(channel.item)
      ? channel.item
      : Array.isArray(channel.entry)
        ? channel.entry
        : channel.item ? [channel.item] : channel.entry ? [channel.entry] : [];

    return rawItems.slice(0, 20).map((item, i) => {
      const title   = getText(item.title);
      const link    = getLink(item.link ?? item['feedburner:origLink']);
      const summary = stripHtml(getText(item.description ?? item.summary ?? item.content));
      const pubDate = item.pubDate ?? item.published ?? item.updated ?? item['dc:date'];

      // Extract XML <category> tag for routing sources (e.g. N1 Info)
      const rawCat = item.category;
      let xmlCategory = '';
      if (typeof rawCat === 'string') {
        xmlCategory = rawCat.trim().toLowerCase();
      } else if (Array.isArray(rawCat)) {
        xmlCategory = String(rawCat[0] ?? '').trim().toLowerCase();
      } else if (rawCat && typeof rawCat === 'object') {
        xmlCategory = String(rawCat['#text'] ?? rawCat).trim().toLowerCase();
      }

      return {
        id:           `${sourceName.toLowerCase().replace(/\s/g,'-')}-${i}`,
        title:        title || '(no title)',
        summary:      summary ? summary.slice(0, 300) : '',
        link:         link || '',
        published:    pubDate ? new Date(pubDate).toISOString() : NOW_ISO,
        source:       sourceName,
        category:     guessCategory(title),
        xml_category: xmlCategory,
        tags:         [],
        image:        extractImage(item),
      };
    }).filter(i => i.title && i.link);
  } catch (err) {
    console.warn(`XML parse error for ${sourceName}: ${err.message}`);
    return [];
  }
}

function getText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object' && val['#text']) return String(val['#text']).trim();
  return String(val).trim();
}

function getLink(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) {
    const alternate = val.find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
    return alternate?.['@_href'] ?? val[0]?.['@_href'] ?? '';
  }
  if (typeof val === 'object') return val['@_href'] ?? getText(val);
  return String(val).trim();
}

function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractImage(item) {
  // media:content (most common in HR portals: Jutarnji, Index, N1…)
  const mc = item['media:content'];
  if (mc) {
    const url = Array.isArray(mc) ? mc[0]?.['@_url'] : mc['@_url'];
    if (url && typeof url === 'string') return url;
  }
  // media:thumbnail
  const mt = item['media:thumbnail'];
  if (mt) {
    if (typeof mt === 'string') return mt;
    const url = Array.isArray(mt) ? mt[0]?.['@_url'] : mt['@_url'];
    if (url && typeof url === 'string') return url;
  }
  // enclosure (Tportal, Večernji, some others)
  const enc = item.enclosure;
  if (enc) {
    const url = Array.isArray(enc) ? enc[0]?.['@_url'] : enc['@_url'];
    if (url && typeof url === 'string' && /image/i.test(enc['@_type'] ?? enc[0]?.['@_type'] ?? 'image')) {
      return url;
    }
  }
  return null;
}

function guessCategory(title) {
  if (!title) return 'general';
  const t = title.toLowerCase();
  if (/ai|artificial intelligence|gpt|llm|openai|gemini|anthropic|claude/.test(t)) return 'ai';
  if (/tech|software|app|startup|developer|code|api|cloud/.test(t))               return 'tech';
  if (/economy|economics|market|finance|stock|crypto|inflation/.test(t))          return 'economy';
  if (/sport|football|basketball|tennis|nba|formula|dinamo|hajduk/.test(t))       return 'sport';
  if (/space|nasa|mars|moon|rocket|asteroid/.test(t))                             return 'space';
  if (/science|research|study|discovery|biology|physics/.test(t))                 return 'science';
  if (/health|medicine|covid|cancer|treatment/.test(t))                           return 'health';
  if (/politika|vlada|sabor|ministar|predsjednik/.test(t))                        return 'politika';
  return 'general';
}

function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.trim().toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByDate(items) {
  return items.sort((a, b) => new Date(b.published) - new Date(a.published));
}

function writeDataFile(filename, data) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, filename), JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ Wrote ${filename} (${data.items?.length ?? '?'} items)`);
}

// ─── ACCUMULATION HELPERS ─────────────────────────────────────────────────────

// Read items from an existing data file (returns [] if file missing/corrupt)
function readExistingItems(filename) {
  try {
    const p = join(DATA, filename);
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8'))?.items ?? [];
  } catch {
    return [];
  }
}

// Merge newly-fetched items with existing ones:
//  • Keeps items published within the last `maxAgeHours`
//  • Deduplicates by link URL (most reliable) then title prefix
//  • Sorts newest-first
function accumulate(newItems, existingItems, maxAgeHours) {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const all    = [...newItems, ...existingItems];

  const fresh  = all.filter(i => {
    if (!i.published) return true;
    return new Date(i.published).getTime() > cutoff;
  });

  const seen = new Set();
  const deduped = fresh.filter(item => {
    const key = item.link
      ? item.link.replace(/[?#].*$/, '').replace(/\/$/, '')   // strip query/hash/trailing-slash
      : (item.title ?? '').toLowerCase().trim().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => {
    const at = a.published ? new Date(a.published).getTime() : 0;
    const bt = b.published ? new Date(b.published).getTime() : 0;
    return bt - at;
  });
}

// ─── FETCH EACH CATEGORY ──────────────────────────────────────────────────────

// extras: pre-routed items from routing_sources (e.g. N1 category-routed articles)
async function fetchCategory(sources, maxAge = 36, extras = []) {
  const cutoff = Date.now() - maxAge * 3600 * 1000;
  const allItems = [...extras];

  await Promise.allSettled(
    sources
      .filter(s => s.enabled !== false)
      .map(async s => {
        const items = await fetchRSS(s.rss, s.name);
        allItems.push(...items);
      })
  );

  const fresh = allItems.filter(i => new Date(i.published).getTime() > cutoff);
  return deduplicateItems(sortByDate(fresh.length >= 3 ? fresh : allItems));
}

// Process routing_sources: fetch once, distribute items by XML category tag
async function processRoutingSources(routingConfigs) {
  const pools = {};  // category key → items[]

  for (const src of routingConfigs) {
    if (src.enabled === false) continue;
    const items = await fetchRSS(src.rss, src.name);
    const cmap  = src.category_map ?? {};

    for (const item of items) {
      const cat    = item.xml_category || '';
      const target = cmap[cat] ?? cmap['default'] ?? null;
      if (target) {
        if (!pools[target]) pools[target] = [];
        pools[target].push(item);
      }
    }

    console.log(`  Routing "${src.name}": ${items.length} items distributed across categories`);
  }

  return pools;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📰 Dashboard data fetch started at ${NOW_ISO}\n`);

  const cfg        = CONFIG.news_sources;
  const maxAge     = CONFIG.news?.max_age_hours ?? 24;   // rolling 24-h window
  const accumulAge = CONFIG.news?.accumulate_hours ?? 24; // how long to keep old items

  // Step 1: process routing sources (e.g. N1 — distributed by XML category tag)
  console.log('🔀 Processing routing sources…');
  const routed = await processRoutingSources(CONFIG.routing_sources ?? []);
  const r = (key) => routed[key] ?? [];

  // Step 2: fetch each category (regular sources + pre-routed items)
  const [
    hrItems, worldItems, financeItems, techItems, sciItems,
    sportsItems, entertainItems, healthItems, foodItems,
  ] = await Promise.all([
    fetchCategory(cfg.hr            ?? [], maxAge, r('hr')),
    fetchCategory(cfg.world         ?? [], maxAge, r('world')),
    fetchCategory(cfg.finance       ?? [], maxAge, r('finance')),
    fetchCategory(cfg.tech          ?? [], maxAge, r('tech')),
    fetchCategory(cfg.science       ?? [], maxAge, r('science')),
    fetchCategory(cfg.sports        ?? [], maxAge, r('sports')),
    fetchCategory(cfg.entertainment ?? [], maxAge, r('entertainment')),
    fetchCategory(cfg.health        ?? [], maxAge, r('health')),
    fetchCategory(cfg.food          ?? [], maxAge, r('food')),
  ]);

  // Step 3: accumulate — merge with previous run's items, keep last 24 h
  const files = [
    { file: 'hr-news.json',           new: hrItems,      srcLen: cfg.hr?.length            ?? 0 },
    { file: 'world-news.json',        new: worldItems,   srcLen: cfg.world?.length         ?? 0 },
    { file: 'finance-news.json',      new: financeItems, srcLen: cfg.finance?.length       ?? 0 },
    { file: 'tech-news.json',         new: techItems,    srcLen: cfg.tech?.length          ?? 0 },
    { file: 'science-news.json',      new: sciItems,     srcLen: cfg.science?.length       ?? 0 },
    { file: 'sports.json',            new: sportsItems,  srcLen: cfg.sports?.length        ?? 0 },
    { file: 'entertainment-news.json',new: entertainItems,srcLen: cfg.entertainment?.length ?? 0 },
    { file: 'health-news.json',       new: healthItems,  srcLen: cfg.health?.length        ?? 0 },
    { file: 'food-news.json',         new: foodItems,    srcLen: cfg.food?.length          ?? 0 },
  ];

  const itemCounts = {};
  for (const f of files) {
    const existing = readExistingItems(f.file);
    const merged   = accumulate(f.new, existing, accumulAge);
    writeDataFile(f.file, { last_updated: NOW_ISO, source_count: f.srcLen, items: merged });
    itemCounts[f.file] = merged.length;
  }

  // Update metadata
  const metadata = {
    last_updated: NOW_ISO,
    generator: 'dashboard-bot/1.0',
    sources: {
      hr_news:       { updated_at: NOW_ISO, item_count: itemCounts['hr-news.json'],           ok: true },
      world_news:    { updated_at: NOW_ISO, item_count: itemCounts['world-news.json'],        ok: true },
      finance_news:  { updated_at: NOW_ISO, item_count: itemCounts['finance-news.json'],      ok: true },
      tech_news:     { updated_at: NOW_ISO, item_count: itemCounts['tech-news.json'],         ok: true },
      science:       { updated_at: NOW_ISO, item_count: itemCounts['science-news.json'],      ok: true },
      sports:        { updated_at: NOW_ISO, item_count: itemCounts['sports.json'],            ok: true },
      entertainment: { updated_at: NOW_ISO, item_count: itemCounts['entertainment-news.json'],ok: true },
      health:        { updated_at: NOW_ISO, item_count: itemCounts['health-news.json'],       ok: true },
      food:          { updated_at: NOW_ISO, item_count: itemCounts['food-news.json'],         ok: true },
      briefing:      { updated_at: NOW_ISO, ok: false, ai_used: false },
    },
  };

  writeFileSync(join(DATA, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  console.log('\n✅ Fetch complete. Run generate-briefing.mjs next.\n');
}


main().catch(err => { console.error('Fatal:', err); process.exit(1); });
