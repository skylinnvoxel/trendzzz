# Trending Today — Phase 1

Personalized daily dashboard at **trendingtoday.skylinn.in**. Phase 1 covers
YouTube, GitHub trending, Reddit, and RSS (all fetchable without a login).
Twitter/X, Bilibili, and XiaoHongShu are stubbed in the UI for Phase 2, when
your Windows machine's Agent-Reach runner starts pushing data to `/api/ingest`.

These steps assume the files are unzipped at
`C:\Users\Karunanithi\Downloads\filesTrendingToday`, deploying to the
Cloudflare account `d68dc5b24def1de0bfd0acad621dc761` (already pinned in
`wrangler.toml` — this is the account that owns `skylinn.in`'s DNS), and
pushing to `https://github.com/skylinnvoxel/trendzzz`.

## 1. Push the files to GitHub

In PowerShell:

```powershell
cd C:\Users\Karunanithi\Downloads\filesTrendingToday
git init
git add .
git commit -m "Phase 1: trending today dashboard"
git branch -M main
git remote add origin https://github.com/skylinnvoxel/trendzzz.git
git push -u origin main
```

If GitHub created the `trendzzz` repo with its own README/license, the
push will be rejected as non-fast-forward. Fix with:

```powershell
git pull origin main --allow-unrelated-histories
# resolve any conflict (likely just README.md — keep this one), then:
git add .
git commit -m "Merge"
git push -u origin main
```

## 2. Log in to the right Cloudflare account

```powershell
wrangler login
```

This opens a browser — make sure you authorize the account matching
`d68dc5b24def1de0bfd0acad621dc761` (the one at the dashboard link you
shared), not any other Cloudflare account you're logged into.

## 3. Create the D1 database

```powershell
cd worker
wrangler d1 create trendingtoday-db
```

It prints a `database_id` — open `wrangler.toml` and paste it in place of
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

```powershell
wrangler d1 execute trendingtoday-db --remote --file=../schema.sql
```

## 4. Set secrets

Run each of these — wrangler will prompt you to paste the value, so
nothing sensitive goes in a file:

```powershell
wrangler secret put YOUTUBE_API_KEY   # from Google Cloud Console, free tier
wrangler secret put INGEST_KEY        # any long random string, e.g.:
```

To generate a random `INGEST_KEY` value in PowerShell first:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
```

Save whatever it prints somewhere — you'll reuse it later in the Phase 2
Agent-Reach runner's request headers.

## 5. Deploy the Worker

```powershell
wrangler deploy
```

This creates the Worker and registers the daily cron trigger
(`03:30 UTC` — edit `[triggers] crons` in `wrangler.toml` to change it).

## 6. Connect Cloudflare Pages via GitHub

In the dashboard at `d68dc5b24def1de0bfd0acad621dc761`:

1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git** →
   pick the `skylinnvoxel/trendzzz` repo.
2. Build settings: **no build command**, output directory = `public`.
3. Deploy. Cloudflare will auto-redeploy on every push to `main`.
4. **Custom domains** tab → add `trendingtoday.skylinn.in`.

## 7. Route API traffic to the Worker

Same account/zone:

1. **Workers & Pages** → your `trendingtoday-api` Worker → **Settings** →
   **Domains & Routes** → **Add route**.
2. Route: `trendingtoday.skylinn.in/api/*` → Worker `trendingtoday-api`.

This keeps the Worker on the same origin as the Pages site, so cookies and
`fetch()` calls need no CORS configuration.

## Known caveats (worth knowing, not blockers)

- **Reddit** was originally in Phase 1's open sources, but Reddit's unauthenticated
  `.json` endpoints now return an HTML shell instead of data for anyone —
  Cloudflare Workers, home IPs, everyone — not just cloud infrastructure.
  It's been moved to Phase 2: it's fetched by the Agent-Reach runner (which
  keeps a real logged-in session) and pushed to `/api/ingest` like Twitter,
  Bilibili, and XHS.
- **GitHub trending**: scraped from the public trending page via
  `HTMLRewriter`, since GitHub has no official trending API. If GitHub
  changes that page's HTML structure, the selector in `fetchGithubTrending`
  will need a small update.
- **YouTube quota**: the free tier is 10,000 units/day; each search call
  costs 100 units, so this comfortably supports fetching for dozens of
  distinct keywords daily.

## Phase 2 — wiring up Agent-Reach

On your Windows machine, a scheduled task (Task Scheduler, daily) runs
Agent-Reach against whatever Twitter/Bilibili/XHS topics users have added,
then POSTs the results to:

```
POST https://trendingtoday.skylinn.in/api/ingest
Headers: X-Ingest-Key: <the INGEST_KEY secret you set above>
Body: [{ "source_type": "twitter", "source_key": "<topic>", "title": "...", "url": "...", "published_at": 1234567890000 }, ...]
```

`source_key` must exactly match the `keyword` a user typed in when adding
that source in the dashboard, so items join correctly to their feed.

Happy to write the actual Agent-Reach-to-ingest script (Python or Node)
once Phase 1 is live and you're ready for Phase 2 — just say the word.
