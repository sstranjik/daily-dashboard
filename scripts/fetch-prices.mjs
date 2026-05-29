/**
 * fetch-prices.mjs — scrapes najcijena.hr for weekly promo prices
 * Stores: Lidl, Konzum, Spar (+ Interspar), Studenac
 * Output: ../data/prices.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const DATA   = join(__dir, '..', 'data');
const BASE   = 'https://najcijena.hr';
const NOW    = new Date().toISOString();
const DELAY  = 600; // ms between requests

// ─── STORE CONFIG ─────────────────────────────────────────────────────────────

const TARGET_STORES = [
  { label: 'Lidl',     re: /^lidl$/i },
  { label: 'Konzum',   re: /^konzum$/i },
  { label: 'Spar',     re: /^(inter\s*)?spar$/i },
  { label: 'Studenac', re: /^studenac$/i },
];

function normalizeStore(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  for (const t of TARGET_STORES) {
    if (t.re.test(s)) return t.label;
  }
  return null;
}

// ─── CATEGORY CONFIG ──────────────────────────────────────────────────────────

const CATEGORIES = [
  // Hrana
  { id: 'mlijecni-proizvodi-i-jaja',         label: 'Mliječni i jaja',    group: 'hrana' },
  { id: 'meso-i-riba',                        label: 'Meso i riba',        group: 'hrana' },
  { id: 'voce-i-povrce',                      label: 'Voće i povrće',      group: 'hrana' },
  { id: 'pekarski-proizvodi',                 label: 'Pekarski proizvodi', group: 'hrana' },
  { id: 'smrznuta-hrana',                     label: 'Smrznuta hrana',     group: 'hrana' },
  { id: 'slatkisi-i-grickalice',              label: 'Slatkiši i grickalice', group: 'hrana' },
  { id: 'konzervirano-i-juhe',                label: 'Konzerve i juhe',    group: 'hrana' },
  { id: 'tjestenina-riza-njoki-tortilje',     label: 'Tjestenina i riža',  group: 'hrana' },
  { id: 'umaci-i-zacini',                     label: 'Umaci i začini',     group: 'hrana' },
  { id: 'pahuljice-i-namazi',                 label: 'Pahuljice i namazi', group: 'hrana' },
  // Pića
  { id: 'alkoholna-pica',                     label: 'Alkohol',            group: 'pica' },
  { id: 'bezalkoholna-pica',                  label: 'Bezalkoholna pića',  group: 'pica' },
  { id: 'kave-i-cajevi',                      label: 'Kava i čaj',         group: 'pica' },
  // Kozmetika
  { id: 'njega-lica',                         label: 'Njega lica',         group: 'kozmetika' },
  { id: 'njega-tijela',                       label: 'Njega tijela',       group: 'kozmetika' },
  { id: 'njega-kose',                         label: 'Njega kose',         group: 'kozmetika' },
  { id: 'njega-zubi',                         label: 'Njega zubi',         group: 'kozmetika' },
  { id: 'higijenski-proizvodi',               label: 'Higijena',           group: 'kozmetika' },
  { id: 'makeup',                             label: 'Makeup',             group: 'kozmetika' },
];

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'hr-HR,hr;q=0.9,en;q=0.7',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── PARSER: __NEXT_DATA__ ────────────────────────────────────────────────────

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Recursively search JSON tree for an array that looks like a product list
function findProductArray(obj, depth = 0) {
  if (depth > 12 || obj == null || typeof obj !== 'object') return null;

  if (Array.isArray(obj) && obj.length > 0 && isProductLike(obj[0])) {
    return obj;
  }

  for (const val of Object.values(obj)) {
    const found = findProductArray(val, depth + 1);
    if (found) return found;
  }
  return null;
}

function isProductLike(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const keys = Object.keys(item).map(k => k.toLowerCase());

  const hasName  = keys.some(k => ['name','naziv','title','naslov','productname','ime'].includes(k));
  const hasPrice = keys.some(k => ['price','cijena','pricevalue','amount','regularPrice','currentPrice',
                                    'akcijskaCijena','finalPrice','value'].includes(k));
  const hasStore = keys.some(k => ['store','trader','merchant','shop','tradername','storename',
                                    'trgovina','prodavaonica'].includes(k));
  return (hasName && hasPrice) || (hasName && hasStore) || (hasPrice && hasStore);
}

// Map a raw product object (unknown field names) to our standard format
function mapProduct(raw) {
  const r = (keys) => {
    for (const k of keys) {
      const found = Object.entries(raw).find(([key]) => key.toLowerCase() === k.toLowerCase());
      if (found !== undefined && found[1] != null) return found[1];
    }
    return null;
  };

  const nameRaw  = r(['name','naziv','title','naslov','productName','ime','product']);
  const priceRaw = r(['price','cijena','currentPrice','akcijskaCijena','finalPrice','amount','priceValue']);
  const storeRaw = r(['store','trader','merchant','tradername','storename','trgovina','prodavaonica','shop']);
  const discRaw  = r(['discount','discountPercentage','popust','percentage','discountPercent','percent']);
  const validRaw = r(['validUntil','endDate','vrijediDo','akcijaKraj','datumKraja','endAt','endsAt',
                       'validTo','validEnd','do','until','expires','expiry']);
  const urlRaw   = r(['slug','url','href','path','link','akcija','canonicalUrl']);
  const imgRaw   = r(['image','imageUrl','img','thumbnail','photo','slika','imageSrc']);
  const origRaw  = r(['originalPrice','regularPrice','redovnaCijena','oldPrice','priceRegular',
                       'normalPrice','priceOriginal']);

  if (!nameRaw) return null;

  const store = normalizeStore(typeof storeRaw === 'string' ? storeRaw
    : (storeRaw && typeof storeRaw === 'object') ? (storeRaw.name || storeRaw.naziv || '') : '');
  if (!store) return null;

  const price = parsePrice(priceRaw);
  if (price === null) return null;

  const orig  = parsePrice(origRaw);
  const disc  = discRaw != null ? Math.abs(parseInt(discRaw, 10)) || null : null;
  const pct   = disc || (orig && orig > price ? Math.round((1 - price / orig) * 100) : null);

  const slug = typeof urlRaw === 'string' ? urlRaw : null;
  const url  = slug ? (slug.startsWith('http') ? slug : `${BASE}/${slug.replace(/^\//, '')}`) : null;

  return {
    name:       String(nameRaw).trim(),
    store,
    price,
    price_str:  formatPrice(price),
    discount:   pct || null,
    valid:      parseValidity(validRaw),
    url:        url || null,
    image:      typeof imgRaw === 'string' ? imgRaw : null,
  };
}

// ─── PARSER: HTML ─────────────────────────────────────────────────────────────
// najcijena.hr uses Next.js App Router (no __NEXT_DATA__).
// Product data IS server-rendered. Parsed by class/alt-text patterns.
//
// Card structure (verified from live HTML):
//   <a href="/akcija/milbona-mozzarella-125-379754">
//     <span class="product-card__badge">-<!-- -->34<!-- -->%</span>
//     <img alt="Milbona Mozzarella 125 g - Akcija u trgovini Lidl" .../>
//     <span class="item-date future">03.06. do 07.06.</span>
//     <span class="text-price fw-bold pe-6">0,75 €</span>
//     <span class="regular-price ...">1,15 €</span>
//     <img alt="Logo trgovine Lidl" .../>     ← logo alt for store name
//   </a>

function parseFromHtml(html) {
  const items = [];

  // Split by product card anchor hrefs. Each part[i] (i>=1):
  //   starts with: slug-id">[card content]
  //   ends before: next href="/akcija/
  // This is reliable and avoids regex lookahead/size issues.
  const parts = html.split('href="/akcija/');

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // ── URL slug ───────────────────────────────────────────────────────────
    const slugEnd = part.indexOf('"');
    if (slugEnd < 1) continue;
    const slug = '/akcija/' + part.slice(0, slugEnd);

    const block = part.slice(slugEnd);

    // ── Store ──────────────────────────────────────────────────────────────
    // "alt="Logo trgovine Lidl"" is the most reliable marker
    const logoM    = block.match(/alt="Logo trgovine ([^"]+)"/i);
    const store    = normalizeStore(logoM?.[1]);
    if (!store) continue;

    // ── Name ───────────────────────────────────────────────────────────────
    // alt="Milbona Mozzarella 125 g - Akcija u trgovini Lidl"
    const altM  = block.match(/alt="([^"]+?)\s*-\s*Akcija u trgovini/i);
    let name    = altM?.[1]?.trim();

    // Fallback: <span class="link text-line-1">Name<!-- --> …</span>
    if (!name) {
      const spanM = block.match(/text-line-1[^>]*>([\s\S]{3,80}?)<\/span>/);
      if (spanM) name = spanM[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
    }
    if (!name || name.length < 2) continue;
    name = decodeHtmlEntities(name);

    // ── Price ──────────────────────────────────────────────────────────────
    const priceM = block.match(/text-price[^>]*>([\d,. ]+)\s*€/);
    const price  = priceM ? parsePrice(priceM[1]) : null;
    if (!price) continue;

    // ── Discount % ─────────────────────────────────────────────────────────
    // Badge contains HTML comments: -<!-- -->34<!-- -->%
    const discM  = block.match(/product-card__badge[^>]*>[\s\S]{0,30}?(\d+)[\s\S]{0,10}?%/);
    const disc   = discM ? parseInt(discM[1], 10) : null;

    // ── Validity date ──────────────────────────────────────────────────────
    const dateM  = block.match(/item-date[^>]*>([^<]{4,30})<\/span>/);
    const valid  = dateM ? dateM[1].trim() : null;

    // ── Image ──────────────────────────────────────────────────────────────
    const imgM   = block.match(/cdn\.najcijena\.hr\/images\/[a-f0-9-]+\.jpg/);
    const image  = imgM ? `https://${imgM[0]}` : null;

    items.push({
      name,
      store,
      price,
      price_str: formatPrice(price),
      discount:  disc,
      valid,
      url:   `${BASE}${slug}`,
      image,
    });
  }

  return items;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 0 ? Math.round(raw * 100) / 100 : null;
  const s = String(raw).replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

function formatPrice(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function parseValidity(raw) {
  if (!raw) return null;
  // Could be ISO date string, timestamp, or display string
  if (typeof raw === 'number') {
    return new Date(raw).toLocaleDateString('hr-HR', { day: 'numeric', month: 'numeric' });
  }
  const s = String(raw).trim();
  // If it looks like an ISO date, format it
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return `do ${d.getDate()}.${d.getMonth() + 1}.`;
  }
  return s;
}

// ─── CATEGORY SCRAPER ─────────────────────────────────────────────────────────

async function scrapeCategory(cat) {
  const items = [];
  const maxPages = 3;

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1
      ? `${BASE}/kategorija/${cat.id}`
      : `${BASE}/kategorija/${cat.id}?page=${page}`;

    let html;
    try {
      html = await fetchHtml(url);
      await sleep(DELAY);
    } catch (err) {
      console.warn(`  ⚠ Page ${page} fetch failed: ${err.message}`);
      break;
    }

    let pageItems = [];

    // Strategy 1: __NEXT_DATA__ JSON
    const nextData = extractNextData(html);
    if (nextData) {
      const arr = findProductArray(nextData.props ?? nextData);
      if (arr) {
        for (const raw of arr) {
          const p = mapProduct(raw);
          if (p) pageItems.push(p);
        }
        if (pageItems.length > 0) {
          console.log(`  ✓ Page ${page}: ${pageItems.length} items via __NEXT_DATA__`);
        } else {
          // __NEXT_DATA__ found but no products mapped – log structure hint
          console.log(`  ⚠ Page ${page}: __NEXT_DATA__ found but no products mapped.`);
          console.log(`    Top-level keys: ${Object.keys(nextData.props?.pageProps ?? {}).join(', ')}`);
        }
      }
    }

    // Strategy 2: HTML regex fallback
    if (pageItems.length === 0) {
      pageItems = parseFromHtml(html);
      if (pageItems.length > 0) {
        console.log(`  ✓ Page ${page}: ${pageItems.length} items via HTML regex`);
      } else {
        console.log(`  ⚠ Page ${page}: no items found on this page – stopping pagination`);
        break;
      }
    }

    items.push(...pageItems);

    // Stop paginating if this page had no results for our 4 stores
    const ourItems = pageItems.filter(p => TARGET_STORES.some(s => s.label === p.store));
    if (ourItems.length === 0 && page > 1) break;
  }

  // Deduplicate by name+store (same product might appear across pages)
  const seen = new Set();
  const deduped = items.filter(p => {
    const key = `${p.store}|${p.name.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => a.price - b.price);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🛒 Price fetch started at ${NOW}\n`);

  mkdirSync(DATA, { recursive: true });

  const result = {
    last_updated: NOW,
    stores: TARGET_STORES.map(s => s.label),
    categories: [],
  };

  for (const cat of CATEGORIES) {
    console.log(`\n📦 Category: ${cat.label} (${cat.id})`);
    try {
      const items = await scrapeCategory(cat);
      const byStore = {};
      for (const s of TARGET_STORES) byStore[s.label] = [];
      for (const item of items) {
        if (byStore[item.store]) byStore[item.store].push(item);
      }
      const totals = TARGET_STORES.map(s => `${s.label}:${byStore[s.label].length}`).join(' ');
      console.log(`  → ${items.length} total [${totals}]`);
      result.categories.push({ ...cat, items: byStore });
    } catch (err) {
      console.error(`  ✗ Category failed: ${err.message}`);
      const byStore = {};
      for (const s of TARGET_STORES) byStore[s.label] = [];
      result.categories.push({ ...cat, items: byStore });
    }

    await sleep(DELAY);
  }

  const outPath = join(DATA, 'prices.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  const totalItems = result.categories.reduce(
    (sum, c) => sum + Object.values(c.items).flat().length, 0
  );
  console.log(`\n✅ Done. ${totalItems} items across ${result.categories.length} categories.\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
