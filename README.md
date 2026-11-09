# EliteOdds v3.9.3

## Deploy on Vercel (recommended)

1. Unzip this folder on your computer **or** upload the zip to GitHub.
2. On GitHub: create a **new empty repo** → Upload files → select **everything inside** this folder  
   (`api`, `lib`, `public`, `package.json`, `vercel.json`, `README.md`).  
   **Do not** upload a nested folder like `eliteodds-v3.9.3/api` — root must show `api` and `public`.
3. Vercel → Add New Project → Import that repo.
4. Settings:
   - Framework Preset: **Other**
   - Root Directory: `.` (leave blank)
   - Build Command: leave empty
   - Output Directory: `public`
5. Deploy. Then open:
   - `https://YOUR-APP.vercel.app/` → app
   - `https://YOUR-APP.vercel.app/api/health` → should show `{ "ok": true, ... }`

## Phone / GitHub only

1. Download zip → Files app → Unzip.
2. GitHub app → Create repo → Add files → Upload the **contents** (api, lib, public, package.json, vercel.json).
3. Connect repo in Vercel as above.

## After deploy

Hard refresh the site. Version badge should read **v3.9.3**.  
If you only see an old version, purge Vercel cache or open the deployment URL from the latest deploy.

## Novig board

Settings → Novig → paste Paper Key ID + PEM from paper.novig.com → Save → Test → open **Novig** venue tab.
