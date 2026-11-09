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

    const listed = await listNovigGames({
      keyId,
      pem,
      env,
      league: league === 'all' ? null : league,
      limit: league === 'all' ? 80 : 50,
    });
    const raw = listed.games || [];
    const host = listed.host;
    const count = listed.count;

    let games = raw.map((g) => {
      try {
        return buildSignal(g) || g;
      } catch (_) {
        return g;
      }
    });

    // ESPN team names + form for richer Novig board
    try {
      const { matchupForEvent } = require('../espn');
      games = games.map((g) => {
        try {
          const mu = matchupForEvent(g.league || 'nfl', g.eventTitle || g.title || '');
          if (!mu) return g;
          if (mu.home) g.home = mu.home;
          if (mu.away) g.away = mu.away;
          if (mu.home && mu.away) {
            g.eventTitle = mu.away + ' @ ' + mu.home;
            g.title = g.eventTitle + (g.marketType && g.marketType !== 'moneyline' ? ' · ' + g.marketType : '');
          }
          if (mu.startTime && !g.startTime) g.startTime = mu.startTime;
          if (mu.formHint) g.formNote = mu.formHint;
          if (mu.homeL10 || mu.awayL10) {
            g.homeL10 = mu.homeL10;
            g.awayL10 = mu.awayL10;
            g.hasForm = true;
          }
          g.espnMatched = true;
        } catch (_) {}
        return g;
      });
      // Re-score after form attach
      games = games.map((g) => {
        try { return buildSignal(g) || g; } catch (_) { return g; }
      });
    } catch (eEspn) { /* ESPN optional */ }

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
    // Novig often has no form yet → ranks are Pass. Keep board visible unless elite-only requested.
    const rankF = String(q.rank || 'all').toLowerCase();
    if (rankF === 'elite' || rankF === 'elite_only') {
      const elite = games.filter((g) => /elite|potd|super/i.test(String(g.rank || '')));
      if (elite.length) games = elite;
      // if zero elite, leave all so user sees the book is alive
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
      fetchAttempt: listed.attempt || null,
      hint: raw.length ? undefined : 'Catalog empty for this env. Confirm Production keys, or try Paper. Rank filters may hide Pass lines — use All ranks.',
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
