# EliteOdds v3.9.6 — Vercel Hobby (max 12 functions)

This build has **exactly 6** files in `api/`:

```
api/health.js
api/games.js
api/venues.js
api/trade.js
api/ai.js
api/misc.js
```

## CRITICAL — if you still see “No more than 12 Serverless Functions”

Your GitHub repo still has **old** `api/*.js` files from earlier versions.

### Fix on GitHub (phone or desktop)
1. Open repo → **api** folder  
2. **Delete every file** that is NOT one of the 6 names above  
   Especially delete: `combo.js`, `discord.js`, `feed.js`, `placed.js`, `settle-ml.js`, `tools.js`, `kalshi-games.js`, `novig-games.js`, `potd.js` if they still exist  
3. Upload this zip’s `api/` folder (replace)  
4. Confirm `api/` shows **only 6** `.js` files  
5. Redeploy  

Also delete any old `vercel.json` that contains `"installCommand": "echo 'no deps'"` — use this zip’s `vercel.json`.

### Check after deploy
- `/api/health` → ok  
- Repo `api/` file count = 6  
