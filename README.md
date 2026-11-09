# EliteOdds v3.9.5 (Vercel Hobby safe)

**8 serverless functions** (Hobby limit is 12).

| Function | Role |
|----------|------|
| `/api/health` | Health check |
| `/api/games` | Polymarket board |
| `/api/kalshi-games` | Kalshi board |
| `/api/novig-games` | Novig board |
| `/api/potd` | Pick of the Day |
| `/api/trade` | Trade / auto |
| `/api/ai` | AI verdict |
| `/api/misc` | Discord, combo, feed, settle, tools (rewrites) |

## Deploy
1. Upload **repo root**: `api/`, `lib/`, `public/`, `package.json`, `vercel.json`
2. Vercel Root Directory = empty
3. Output Directory = `public`
4. After deploy: `/api/health` → `ok: true`
