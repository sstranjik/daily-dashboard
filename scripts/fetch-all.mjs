/**
 * Daily data fetcher — runs in GitHub Actions.
 * Fetches RSS feeds → saves JSON to ../data/
 * Node 20+ required (uses built-in fetch).
 */

import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

      return {
        id:        `${sourceName.toLowerCase().replace(/\s/g,'-')}-${i}`,
        title:     title || '(no title)',
        summary:   summary ? summary.slice(0, 300) : '',
        link:      link || '',
        published: pubDate ? new Date(pubDate).toISOString() : NOW_ISO,
        source:    sourceName,
        category:  guessCategory(title),
        tags:      [],
        image:     extractImage(item),
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
  const enc = item['media:content'] ?? item['media:thumbnail'];
  if (enc?.['@_url']) return enc['@_url'];
  const thumb = item['media:thumbnail'];
  if (typeof thumb === 'string') return thumb;
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

// ─── FETCH EACH CATEGORY ──────────────────────────────────────────────────────

async function fetchCategory(sources, maxAge = 36) {
  const cutoff = Date.now() - maxAge * 3600 * 1000;
  const allItems = [];

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

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📰 Dashboard data fetch started at ${NOW_ISO}\n`);

  const cfg  = CONFIG.news_sources;
  const maxAge = CONFIG.news?.max_age_hours ?? 36;

  const [hrItems, techItems, sciItems, sportsItems] = await Promise.all([
    fetchCategory(cfg.hr,      maxAge),
    fetchCategory(cfg.tech,    maxAge),
    fetchCategory(cfg.science, maxAge),
    fetchCategory(cfg.sports ?? [], maxAge),
  ]);

  writeDataFile('hr-news.json',      { last_updated: NOW_ISO, source_count: cfg.hr.length,      items: hrItems.slice(0, 20) });
  writeDataFile('tech-news.json',    { last_updated: NOW_ISO, source_count: cfg.tech.length,    items: techItems.slice(0, 15) });
  writeDataFile('science-news.json', { last_updated: NOW_ISO, source_count: cfg.science.length, items: sciItems.slice(0, 12) });
  writeDataFile('sports.json',       { last_updated: NOW_ISO, source_count: cfg.sports?.length ?? 0, items: sportsItems.slice(0, 20) });

  // Update metadata
  const metadata = {
    last_updated: NOW_ISO,
    generator: 'dashboard-bot/1.0',
    sources: {
      hr_news:   { updated_at: NOW_ISO, item_count: hrItems.length,    ok: true },
      tech_news: { updated_at: NOW_ISO, item_count: techItems.length,  ok: true },
      science:   { updated_at: NOW_ISO, item_count: sciItems.length,   ok: true },
      sports:    { updated_at: NOW_ISO, item_count: sportsItems.length,ok: true },
      briefing:  { updated_at: NOW_ISO, ok: false, ai_used: false },
    },
  };

  writeFileSync(join(DATA, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  console.log('\n✅ Fetch complete. Run generate-briefing.mjs next.\n');

  return { hrItems, techItems, sciItems };
}


main().catch(err => { console.error('Fatal:', err); process.exit(1); });
