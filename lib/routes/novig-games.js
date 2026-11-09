/**
 * GET /api/novig-games
 * Query: league, marketType, mode, keyId, pem (or use env NOVIG_KEY_ID / NOVIG_PEM / NOVIG_ENV)
 * Prefer server env vars; client may pass keys for personal deploy only (logged carefully).
 */
const { listNovigGames } = require('../novig');
const { buildSignal } = require('../score');

function pickKeys(req) {
  const q = req.query || {};
  const keyId = q.keyId || q.novigKeyId || process.env.NOVIG_KEY_ID || '';
  const pem = q.pem || q.novigPem || process.env.NOVIG_PEM || '';
  const env = q.env || q.novigEnv || process.env.NOVIG_ENV || 'paper';
  return { keyId: String(keyId).trim(), pem: String(pem).trim(), env: String(env).trim() };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    const league = String(q.league || q.sport || 'all').toLowerCase();
    const marketType = String(q.marketType || 'all').toLowerCase();
    const { keyId, pem, env } = pickKeys(req);

    if (!keyId || !pem) {
      return res.status(200).json({
        ok: false,
        source: 'novig',
        error: 'missing_keys',
        hint: 'Add Novig Key ID + private key PEM in Settings (or Vercel env NOVIG_KEY_ID / NOVIG_PEM). Start on Paper: paper.novig.com → Profile → Novig API.',
        games: [],
        summary: { total: 0, elite: 0, good: 0, live: 0, upcoming: 0 },
      });
    }

    const { games: raw, host, count } = await listNovigGames({
      keyId,
      pem,
      env,
      league: league === 'all' ? null : league,
      limit: league === 'all' ? 50 : 40,
    });

    let games = raw.map((g) => {
      try {
        return buildSignal(g) || g;
      } catch (_) {
        return g;
      }
    });

    if (marketType && marketType !== 'all') {
      games = games.filter((g) => {
        const mt = String(g.marketType || '').toLowerCase();
        if (marketType === 'moneyline' || marketType === 'ml') return mt === 'moneyline' || mt === 'ml';
        if (marketType === 'spread' || marketType === 'spreads') return mt.indexOf('spread') >= 0;
        if (marketType === 'total' || marketType === 'totals' || marketType === 'ou') {
          return mt === 'total' || mt.indexOf('total') >= 0;
        }
        if (marketType === 'team_total') return mt === 'team_total';
        if (marketType.indexOf('player') >= 0) return mt.indexOf('player') >= 0 || mt.indexOf('prop') >= 0;
        return mt === marketType || mt.indexOf(marketType) >= 0;
      });
    }

    // Rank filter soft
    const rankF = String(q.rank || 'all').toLowerCase();
    if (rankF === 'elite') {
      games = games.filter((g) => /elite|potd|super/i.test(String(g.rank || '')));
    } else if (rankF === 'good') {
      games = games.filter((g) => /good|elite|potd|super/i.test(String(g.rank || '')));
    }

    games = games.slice(0, 80);

    return res.status(200).json({
      ok: true,
      source: 'novig',
      host,
      env,
      league,
      marketType,
      catalogCount: count,
      updatedAt: new Date().toISOString(),
      summary: {
        total: games.length,
        live: games.filter((g) => g.live).length,
        upcoming: games.filter((g) => !g.live && !g.ended).length,
        elite: games.filter((g) => String(g.rank || '').toLowerCase() === 'elite').length,
        good: games.filter((g) => String(g.rank || '').toLowerCase() === 'good').length,
      },
      games,
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      source: 'novig',
      error: e.message || String(e),
      code: e.code || null,
      status: e.status || null,
      hint:
        e.code === 'NO_KEYS'
          ? 'Save Novig keys in Settings. Paper keys from paper.novig.com work for testing.'
          : 'Check key ID, PEM format, and Paper vs Production env. Signature scheme must match docs.novig.com.',
      games: [],
      summary: { total: 0, elite: 0, good: 0, live: 0, upcoming: 0 },
    });
  }
};
