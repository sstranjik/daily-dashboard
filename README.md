# Personal Daily Dashboard

A startup-quality, zero-maintenance personal dashboard hosted on GitHub Pages.
Every morning at 07:00 (Zagreb time), GitHub Actions auto-fetches news, generates an AI briefing, and commits static JSON files. The frontend loads instantly from those pre-generated files — no backend, no database, no server required.

---

## Features

| Widget | Source | Auto-refresh |
|--------|--------|-------------|
| ☀️ AI Morning Briefing | Gemini / rule-based | Daily via GH Actions |
| 🌤️ Weather | Open-Meteo (free, no key) | Every 30 min (live) |
| 🇭🇷 Croatian News | Index.hr, N1, Tportal, Jutarnji RSS | Daily |
| 💻 Tech / AI News | TechCrunch, The Verge, VentureBeat | Daily |
| 🔬 Science | ScienceDaily, Phys.org, NASA | Daily |
| ⚽ Sports | Sport RSS feeds | Daily |
| ✓ Productivity | localStorage TODO list | Instant |

---

## Quick Start

### 1. Create a GitHub repository

```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/daily-dashboard.git
```

### 2. Push the code

```bash
git add .
git commit -m "Initial dashboard"
git push -u origin main
```

### 3. Enable GitHub Pages

Go to **Settings → Pages → Source → Deploy from branch → `main` / `root`**

Your dashboard will be live at: `https://YOUR_USERNAME.github.io/daily-dashboard/`

### 4. Run the first data fetch manually

Go to **Actions → Daily Dashboard Update → Run workflow**

This immediately fetches news and generates your first briefing.

---

## Optional: AI Briefing via Gemini (free)

1. Get a free Gemini API key at [aistudio.google.com](https://aistudio.google.com/app/apikey)
2. Go to **Settings → Secrets and variables → Actions → New repository secret**
3. Name: `GEMINI_API_KEY`, Value: your key

The briefing will now be AI-generated. Without the key, a rule-based summary is used.

---

## Optional: Google Sign-In

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → APIs & Services → Credentials → OAuth 2.0 Client ID
3. Application type: **Web application**
4. Authorized JavaScript origins: `https://YOUR_USERNAME.github.io`
5. Copy the Client ID
6. Edit `config.json`:
   ```json
   "google": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com"
   }
   ```

---

## Configuration

Edit `config.json` to customize everything:

```json
{
  "widgets": {
    "sports": { "enabled": false }   ← disable any widget
  },
  "location": {
    "default_city": "Split",
    "lat": 43.508,
    "lon": 16.440
  },
  "news": {
    "max_items": 15
  }
}
```

Widget visibility can also be toggled per-session from the **Settings** panel (gear icon, top-right).

---

## Add Custom RSS Feeds

Edit `config.json` under `news_sources`:

```json
"hr": [
  { "name": "Moj Blog", "rss": "https://mojblog.hr/feed", "enabled": true }
]
```

---

## Local Development

Since this uses ES modules, you need a local server (not `file://`):

```bash
# Option 1: VS Code — install "Live Server" extension, right-click index.html → Open with Live Server
# Option 2: Node
npx serve .
# Option 3: Python
python -m http.server 8080
```

Then open `http://localhost:8080`

---

## File Structure

```
personal-dashboard/
├── index.html               ← Main page
├── config.json              ← Configuration
├── css/
│   ├── main.css             ← Design system
│   └── widgets.css          ← Widget styles
├── js/
│   ├── app.js               ← App entry point
│   ├── config.js            ← Config loader
│   ├── auth.js              ← Google auth
│   ├── utils/               ← Helpers, cache
│   ├── api/                 ← Weather & data APIs
│   └── widgets/             ← All widget components
├── data/                    ← Pre-generated JSON (auto-updated daily)
│   ├── briefing.json
│   ├── hr-news.json
│   ├── tech-news.json
│   ├── science-news.json
│   ├── sports.json
│   └── metadata.json
├── scripts/                 ← GitHub Actions scripts (Node.js)
│   ├── package.json
│   ├── fetch-all.mjs        ← RSS fetcher
│   └── generate-briefing.mjs← AI briefing generator
└── .github/workflows/
    └── daily-update.yml     ← Runs daily at 07:00 Zagreb time
```

---

## How it Works

```
Every day at 05:00 UTC
        │
        ▼
GitHub Actions starts
        │
        ├─ scripts/fetch-all.mjs
        │   Fetches RSS feeds → writes data/*.json
        │
        ├─ scripts/generate-briefing.mjs  
        │   Calls Gemini API (or rule-based) → writes data/briefing.json
        │
        └─ git commit && git push
                │
                ▼
         GitHub Pages serves
         updated static files

User opens dashboard
        │
        ▼
Frontend loads data/*.json (no CORS, same origin)
Weather fetched live from Open-Meteo (CORS-enabled, free, no key)
```

---

## License

MIT
