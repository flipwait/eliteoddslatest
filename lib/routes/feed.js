/**
 * GET /api/feed — unified read-only board for trading-app embedding
 *
 * Query:
 *   venue=polymarket|kalshi|novig|both   (default polymarket)
 *   sport=all|mlb|nfl|nba|nhl|cfb|cbb|...
 *   rank=elite|good|all                  (default elite)
 *   marketType=all|moneyline|spread|total|...
 *   limit=1..50                          (default 25)
 *   mode=pregame|live|both               (default both)
 *
 * Response picks are normalized for any UI:
 *   id, venue, league, marketType, title, pick, rank, score,
 *   mktPct, modelPct, edgePp, startTime, tradeUrl, live
 */
'use strict';

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url || '', 'http://localhost');
    const q = {};
    u.searchParams.forEach((v, k) => {
      q[k] = v;
    });
    return q;
  } catch (e) {
    return {};
  }
}

function invoke(handlerPath, query) {
  const handler = require(handlerPath);
  return new Promise((resolve) => {
    const req = { method: 'GET', query: query || {}, url: '/api' };
    const res = {
      headers: {},
      setHeader() {
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve(body || {});
      },
      end(s) {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          resolve({});
        }
      },
    };
    Promise.resolve(handler(req, res)).catch((e) =>
      resolve({ ok: false, error: String(e.message || e), games: [] })
    );
  });
}

function normalize(g, venue) {
  const re = (g && g.evaluate && g.evaluate.edge) || {};
  const mkt =
    g.market_probability != null
      ? Number(g.market_probability)
      : g.mktPct != null
        ? Number(g.mktPct)
        : null;
  const model =
    g.model_probability != null
      ? Number(g.model_probability)
      : g.modelPct != null
        ? Number(g.modelPct)
        : null;
  let edge =
    g.probability_edge != null
      ? Number(g.probability_edge)
      : re.probability_edge != null
        ? Number(re.probability_edge)
        : g.netEdge != null
          ? Number(g.netEdge)
          : null;
  const tradeUrl =
    g.marketUrl ||
    g.url ||
    g.kalshiUrl ||
    g.tradeUrl ||
    (String(venue) === 'kalshi'
      ? 'https://kalshi.com'
      : String(venue) === 'novig'
        ? 'https://novig.com'
        : 'https://polymarket.us');
  return {
    id: g.id || g.marketSlug || g.slug || null,
    venue: g.venue || g.source || venue,
    league: g.league || g.sport || null,
    marketType: g.marketType || null,
    title: g.eventTitle || g.title || null,
    pick: g.modelPick || g.pick || null,
    rank: g.rank || 'Pass',
    score: g.betScore != null ? g.betScore : g.score != null ? g.score : null,
    score10: g.score10 != null ? g.score10 : null,
    mktPct: mkt,
    modelPct: model,
    edgePp: edge,
    startTime: g.startTime || g.commenceTime || null,
    live: !!g.live,
    ended: !!g.ended,
    tradeUrl,
    line: g.line != null ? g.line : g.spreadLine != null ? g.spreadLine : g.totalLine,
    hasForm: !!g.hasForm,
    formNote: g.formNote || null,
  };
}

function rankOk(g, rank) {
  const r = String(g.rank || '').toLowerCase();
  if (rank === 'all') return true;
  if (rank === 'elite') return r === 'elite' || r.indexOf('super') >= 0 || r === 'potd';
  if (rank === 'good') return r === 'good' || r === 'elite' || r.indexOf('super') >= 0 || r === 'potd';
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = getQuery(req);
    const venue = String(q.venue || 'polymarket').toLowerCase();
    const sport = String(q.sport || 'all').toLowerCase();
    const rank = String(q.rank || 'elite').toLowerCase();
    const marketType = String(q.marketType || 'all').toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(q.limit || '25', 10) || 25));
    const mode = String(q.mode || 'both').toLowerCase();

    const venues =
      venue === 'both' ? ['polymarket', 'kalshi'] : venue === 'all' ? ['polymarket', 'kalshi', 'novig'] : [venue];

    const errors = [];
    let games = [];

    for (const v of venues) {
      let data = { games: [] };
      if (v === 'polymarket') {
        data = await invoke('../../api/games', {
          mode: mode === 'both' ? 'all' : mode,
          league: sport,
          marketType,
          rank: '',
          minEdge: '0',
          minScore: '0',
          limit: '80',
        });
      } else if (v === 'kalshi') {
        data = await invoke('./kalshi-games', {
          mode: mode === 'both' ? 'all' : mode,
          league: sport,
          marketType,
          limit: '60',
        });
      } else if (v === 'novig') {
        data = await invoke('./novig-games', {
          league: sport,
          marketType,
          rank: 'all',
          env: process.env.NOVIG_ENV || 'paper',
        });
      }
      if (!data.ok && data.error) errors.push({ venue: v, error: data.error });
      (data.games || []).forEach((g) => {
        g.venue = g.venue || v;
        g.source = g.source || v;
        games.push(g);
      });
    }

    // mode filter
    if (mode === 'live') games = games.filter((g) => g.live);
    if (mode === 'pregame') games = games.filter((g) => !g.live && !g.ended);

    games = games.filter((g) => rankOk(g, rank) && !g.ended);
    // sort score then edge
    games.sort((a, b) => {
      const sa = Number(a.betScore != null ? a.betScore : a.score) || 0;
      const sb = Number(b.betScore != null ? b.betScore : b.score) || 0;
      if (sb !== sa) return sb - sa;
      const ea = Number(a.probability_edge != null ? a.probability_edge : a.netEdge) || 0;
      const eb = Number(b.probability_edge != null ? b.probability_edge : b.netEdge) || 0;
      return eb - ea;
    });

    const picks = games.slice(0, limit).map((g) => normalize(g, g.venue));

    return res.status(200).json({
      ok: true,
      service: 'eliteodds-feed',
      version: '3.9.1',
      readOnly: true,
      venue,
      sport,
      rank,
      marketType,
      mode,
      updatedAt: new Date().toISOString(),
      count: picks.length,
      picks,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      service: 'eliteodds-feed',
      error: String(e.message || e),
    });
  }
};
