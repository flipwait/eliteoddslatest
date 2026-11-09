# Fix common upload / deploy failures

| Symptom | Fix |
|--------|-----|
| Vercel "Get Started" blank / no app | Root Directory wrong — must be repo root where `public/` and `api/` live |
| Build fails Node 20 deprecated | `package.json` engines must be `"node": "24.x"` (already set) |
| `/` 404 | `vercel.json` outputDirectory must be `public` |
| `/api/health` 404 | `api/health.js` must be at repo root `api/`, not nested |
| Nested folder after unzip | Upload **inner** files, not the outer zip folder name |
| Old UI after deploy | Open latest Deployment URL; hard-refresh; check Settings → About version |

## Required root layout

```
/
  api/
  lib/
  public/index.html
  package.json
  vercel.json
```
