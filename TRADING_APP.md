# EliteOdds → Trading App integration (v3.9.1)

Drop this repo on **Vercel** (or copy `api/` + `lib/` into your trading app’s serverless folder).  
All integration routes are **read-only JSON** with CORS `*`.

## Base URL

```
https://YOUR-DEPLOY.vercel.app
```

## Endpoints

### 1) Health
```
GET /api/health
```
```json
{ "ok": true, "service": "betbetter", "node": "v24.x", "ts": "..." }
```

### 2) Unified feed (best for embedding)
```
GET /api/feed?venue=polymarket&sport=all&rank=elite&limit=25&mode=both
```

| Param | Values | Default |
|--------|--------|---------|
| `venue` | `polymarket` · `kalshi` · `novig` · `both` · `all` | `polymarket` |
| `sport` | `all` · `nfl` · `mlb` · `nba` · `nhl` · `cfb` · … | `all` |
| `rank` | `elite` · `good` · `all` | `elite` |
| `marketType` | `all` · `moneyline` · `spread` · `total` · … | `all` |
| `mode` | `pregame` · `live` · `both` | `both` |
| `limit` | 1–50 | `25` |

Each pick:
```json
{
  "id": "...",
  "venue": "polymarket",
  "league": "nfl",
  "marketType": "moneyline",
  "title": "Team A vs Team B",
  "pick": "Team A",
  "rank": "Elite",
  "score": 72,
  "mktPct": 45.5,
  "modelPct": 58.0,
  "edgePp": 8.2,
  "startTime": "2026-11-09T18:00:00.000Z",
  "live": false,
  "tradeUrl": "https://polymarket.us/...",
  "hasForm": true
}
```

### 3) Pick of the Day
```
GET /api/potd?venue=polymarket&sport=all&max=3&window=next3
```
Optional: `ai=1` (uses **server** `OPENAI_API_KEY` only — do not put keys in the query string).

### 4) Full boards (same as main app)
```
GET /api/games?league=nfl&marketType=moneyline&mode=all
GET /api/kalshi-games?league=nfl&marketType=all
GET /api/novig-games?league=nfl&env=paper
```

## Env vars (Vercel → Settings → Environment Variables)

| Name | Purpose |
|------|---------|
| `ODDS_API_KEY` | Optional consensus / POTD boost |
| `OPENAI_API_KEY` | Optional AI verdict / POTD `ai=1` |
| `NOVIG_KEY_ID` | Novig Key ID (Paper or Prod) |
| `NOVIG_PEM` | Novig private key PEM |
| `NOVIG_ENV` | `paper` (default) or `prod` |

Browser Settings in the main UI still work for personal deploys; **prefer env vars** for a shared trading app.

## Minimal fetch example

```js
const base = 'https://YOUR-DEPLOY.vercel.app';
const res = await fetch(`${base}/api/feed?venue=both&rank=elite&limit=20`);
const data = await res.json();
if (data.ok) {
  data.picks.forEach((p) => {
    console.log(p.venue, p.rank, p.title, p.pick, p.edgePp, p.tradeUrl);
  });
}
```

## Deploy notes

1. Upload this zip to GitHub → import on Vercel  
2. Root directory = repo root (where `api/` and `public/` live)  
3. `package.json` engines → `node` `24.x`  
4. After deploy, open `/api/health` then `/api/feed?rank=elite`  
5. Point your trading app UI at those URLs  

## Version

- App shell: **3.9.1-trading** (Novig + Auto performance gates + feed API)  
- Built from EliteOdds **3.9.0** core
