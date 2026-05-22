/**
 * Briefing generator — runs after fetch-all.mjs in GitHub Actions.
 * Uses Gemini API (free tier) if GEMINI_API_KEY is set,
 * otherwise falls back to a rule-based summary.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const DATA   = join(__dir, '..', 'data');
const NOW    = new Date();
const NOW_ISO= NOW.toISOString();

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function readJson(filename) {
  try { return JSON.parse(readFileSync(join(DATA, filename), 'utf8')); }
  catch { return null; }
}

function writeJson(filename, data) {
  writeFileSync(join(DATA, filename), JSON.stringify(data, null, 2), 'utf8');
}

function formatHrDate(date) {
  const days   = ['Nedjelja','Ponedjeljak','Utorak','Srijeda','Četvrtak','Petak','Subota'];
  const months = ['siječnja','veljače','ožujka','travnja','svibnja','lipnja','srpnja','kolovoza','rujna','listopada','studenog','prosinca'];
  return `${days[date.getDay()]}, ${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}.`;
}

function getTopHeadlines(data, n = 3) {
  return (data?.items ?? []).slice(0, n).map(i => i.title).filter(Boolean);
}

// ─── GEMINI API ───────────────────────────────────────────────────────────────

async function generateWithGemini(headlines) {
  const prompt = buildPrompt(headlines);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 800, temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');

  return parseAIResponse(text);
}

// ─── OPENAI API (fallback) ────────────────────────────────────────────────────

async function generateWithOpenAI(headlines) {
  const prompt = buildPrompt(headlines);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty OpenAI response');
  return parseAIResponse(text);
}

function buildPrompt(headlines) {
  const { hr = [], tech = [], science = [] } = headlines;
  const dateStr = formatHrDate(NOW);

  return `Ti si asistent za jutarnji pregled vijesti. Tvoj zadatak je napisati kratak jutarnji briefing na hrvatskom jeziku.

Danas je ${dateStr}.

Naslovi vijesti:
HRVATSKE VIJESTI:
${hr.map((h,i) => `${i+1}. ${h}`).join('\n') || '(nema podataka)'}

TECH / AI:
${tech.map((h,i) => `${i+1}. ${h}`).join('\n') || '(nema podataka)'}

ZNANOST:
${science.map((h,i) => `${i+1}. ${h}`).join('\n') || '(nema podataka)'}

Napiši jutarnji pregled u formatu:
- Jedna kratka uvodni rečenica (summary)
- 5-7 bullet točaka, svaka max 2 rečenice, pokrivajući najvažnije vijesti
- Svaka bullet točka označena s kategorijom: [HR], [TECH], [SCIENCE], [WORLD]

Budi koncizan, informativan i prijatan. Pisati u drugom licu ("Danas je...", "Ovog jutra...").`;
}

function parseAIResponse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = [];
  let summary = '';

  for (const line of lines) {
    if (line.startsWith('- ') || line.startsWith('• ') || line.match(/^\d+\./)) {
      const content = line.replace(/^[-•\d.]\s*/, '').trim();
      const catMatch = content.match(/^\[(HR|TECH|SCIENCE|WORLD|AI|SPORT)\]/i);
      const cat = catMatch ? catMatch[1].toLowerCase() : 'general';
      const text2 = content.replace(/^\[.*?\]\s*/, '');
      const icons = { hr:'🇭🇷', tech:'💻', science:'🔬', world:'🌍', ai:'🤖', sport:'⚽', general:'•' };
      bullets.push({ category: cat, icon: icons[cat] ?? '•', text: text2 });
    } else if (!summary && line.length > 20 && !line.startsWith('#')) {
      summary = line;
    }
  }

  return { summary, bullets };
}

// ─── RULE-BASED FALLBACK ──────────────────────────────────────────────────────

function generateRuleBased(headlines) {
  const bullets = [];
  const { hr = [], tech = [], science = [] } = headlines;

  hr.slice(0, 3).forEach(h =>
    bullets.push({ category: 'hr', icon: '🇭🇷', text: h })
  );
  tech.slice(0, 2).forEach(h =>
    bullets.push({ category: 'tech', icon: '💻', text: h })
  );
  science.slice(0, 2).forEach(h =>
    bullets.push({ category: 'science', icon: '🔬', text: h })
  );

  return {
    summary: `Jutarnji pregled vijesti za ${formatHrDate(NOW)}`,
    bullets,
  };
}

// ─── WEATHER NOTE ────────────────────────────────────────────────────────────

async function fetchWeatherNote(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum&timezone=auto&forecast_days=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = await res.json();
    const code = d?.daily?.weathercode?.[0];
    const max  = Math.round(d?.daily?.temperature_2m_max?.[0] ?? 0);
    const min  = Math.round(d?.daily?.temperature_2m_min?.[0] ?? 0);
    const rain = d?.daily?.precipitation_sum?.[0] ?? 0;

    const descs = { 0:'vedro', 1:'pretežno vedro', 2:'djelomično oblačno', 3:'oblačno' };
    const desc = code <= 3 ? (descs[code] ?? 'promjenljivo')
      : code <= 57 ? 'rosulja' : code <= 67 ? 'kiša' : code <= 77 ? 'snijeg'
        : code <= 82 ? 'pljuskovi' : code <= 99 ? 'grmljavina' : 'promjenljivo';

    const icons = { 0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️' };
    const icon = code <= 3 ? (icons[code] ?? '🌡️')
      : code <= 67 ? '🌧️' : code <= 77 ? '❄️' : '⛈️';

    const rainNote = rain > 1 ? `, ${rain.toFixed(1)} mm oborina` : '';
    return `${icon} Zagreb danas: ${min}–${max}°C, ${desc}${rainNote}.`;
  } catch { return null; }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n✨ Briefing generation started at ${NOW_ISO}\n`);

  const hrData  = readJson('hr-news.json');
  const techData= readJson('tech-news.json');
  const sciData = readJson('science-news.json');
  const cfg     = JSON.parse(readFileSync(join(__dir, '..', 'config.json'), 'utf8'));

  const headlines = {
    hr:      getTopHeadlines(hrData, 5),
    tech:    getTopHeadlines(techData, 4),
    science: getTopHeadlines(sciData, 3),
  };

  let summary = '';
  let bullets = [];
  let aiUsed  = false;

  if (GEMINI_KEY) {
    try {
      console.log('🤖 Generating with Gemini...');
      ({ summary, bullets } = await generateWithGemini(headlines));
      aiUsed = true;
      console.log('✓ Gemini generation successful');
    } catch (err) {
      console.warn(`Gemini failed: ${err.message}`);
    }
  }

  if (!aiUsed && OPENAI_KEY) {
    try {
      console.log('🤖 Generating with OpenAI...');
      ({ summary, bullets } = await generateWithOpenAI(headlines));
      aiUsed = true;
      console.log('✓ OpenAI generation successful');
    } catch (err) {
      console.warn(`OpenAI failed: ${err.message}`);
    }
  }

  if (!aiUsed) {
    console.log('📋 Using rule-based summary...');
    ({ summary, bullets } = generateRuleBased(headlines));
  }

  const weatherNote = await fetchWeatherNote(cfg.location.lat, cfg.location.lon);
  if (weatherNote) {
    bullets.unshift({ category: 'weather', icon: '☀️', text: weatherNote });
  }

  const briefing = {
    date:          NOW.toISOString().split('T')[0],
    generated_at:  NOW_ISO,
    ai_generated:  aiUsed,
    summary,
    bullets,
    weather_note:  weatherNote,
  };

  writeJson('briefing.json', briefing);

  // Update metadata
  const meta = readJson('metadata.json') ?? {};
  if (meta.sources) {
    meta.sources.briefing = { updated_at: NOW_ISO, ok: true, ai_used: aiUsed };
    writeJson('metadata.json', meta);
  }

  console.log(`\n✅ Briefing generated (ai_used=${aiUsed}, bullets=${bullets.length})\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
