/**
 * GET /api/potd — read-only Pick of the Day for trading-app integration
 *
 * Query:
 *   venue=polymarket|kalshi   (default polymarket)
 *   sport=all|mlb|nfl|nba|... (default all)
 *   max=1..5                 (default 3)
 *   window=next3|today|all   (default next3)
 *   ai=1                     optional AI (OPENAI_API_KEY env only — never query string)
 *   Odds/OpenAI keys: server env only (ODDS_API_KEY, OPENAI_API_KEY)
 *
 * Response: { ok, picks: [{ potdScore, consensusPct, ai: { conviction, signal, thesis }, ... }], diag }
 */
'use strict';

const { selectPotdCandidates, formatPick, modelPctOf } = require('../lib/potd');

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url || '', 'http://localhost');
    const q = {};
    u.searchParams.forEach((v, k) => { q[k] = v; });
    return q;
  } catch (e) {
    return {};
  }
}

/** Invoke games handler in-process */
async function loadPolyGames(league, marketType) {
  const handler = require('./games');
  return new Promise((resolve) => {
    const req = {
      method: 'GET',
      query: {
        mode: 'all',
        league: league || 'all',
        marketType: marketType || 'all',
        rank: '',
        minEdge: '0',
        minScore: '0',
        limit: '80',
      },
      url: '/api/games?mode=all&league=' + encodeURIComponent(league || 'all') + '&marketType=' + encodeURIComponent(marketType || 'all'),
    };
    const res = {
      headers: {},
      setHeader() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve(body || {}); },
      end(s) {
        try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); }
      },
    };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ ok: false, error: String(e.message || e), games: [] }));
  });
}

async function loadKalshiGames(league, marketType) {
  try {
    const handler = require('./kalshi-games');
    return new Promise((resolve) => {
      const req = {
        method: 'GET',
        query: { mode: 'all', league: league || 'all', marketType: marketType || 'all', limit: '60' },
        url: '/api/kalshi-games',
      };
      const res = {
        setHeader() { return this; },
        status() { return this; },
        json(body) { resolve(body || {}); },
        end(s) {
          try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); }
        },
      };
      Promise.resolve(handler(req, res)).catch((e) => resolve({ ok: false, games: [], error: String(e.message || e) }));
    });
  } catch (e) {
    return { ok: false, games: [], error: String(e.message || e) };
  }
}

async function oddsConsensus(apiKey, game) {
  if (!apiKey) return null;
  try {
    const tools = require('./tools');
    // Prefer calling tools handler
    return await new Promise((resolve) => {
      const req = {
        method: 'POST',
        body: {
          action: 'odds-consensus',
          apiKey,
          game: {
            eventTitle: game.eventTitle || game.title,
            homeName: game.homeName,
            awayName: game.awayName,
            league: game.league || game.sport,
            marketType: game.marketType,
            modelPick: game.modelPick,
            commenceTime: game.startTime || game.commenceTime,
          },
        },
      };
      const res = {
        setHeader() { return this; },
        status() { return this; },
        json(body) { resolve(body || {}); },
        end() { resolve({}); },
      };
      Promise.resolve(tools(req, res)).catch(() => resolve({}));
    });
  } catch (e) {
    return null;
  }
}

async function potdAiAnalyze(openaiKey, game) {
  if (!openaiKey) return null;
  try {
    const ai = require('./ai');
    return await new Promise((resolve) => {
      const req = {
        method: 'POST',
        body: {
          action: 'potd-analyze',
          apiKey: openaiKey,
          openaiKey,
          game: {
            eventTitle: game.eventTitle || game.title,
            modelPick: game.modelPick,
            league: game.league,
            marketType: game.marketType,
            model_probability: game.model_probability,
            market_probability: game.market_probability,
            netEdge: game.netEdge,
            formLine: game._seFormLine,
            potdScore: game._potdScore,
          },
        },
      };
      const res = {
        setHeader() { return this; },
        status() { return this; },
        json(body) { resolve(body || {}); },
        end() { resolve({}); },
      };
      Promise.resolve(ai(req, res)).catch(() => resolve({}));
    });
  } catch (e) {
    return null;
  }
}

function parseAiText(text) {
  if (!text || typeof text !== 'string') return null;
  const get = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    conviction: get(/CONVICTION:\s*(HIGH|MEDIUM|LOW)/i),
    signal: get(/SIGNAL:\s*(YAY|LEAN_YAY|NEUTRAL|LEAN_NAY|NAY)/i),
    thesis: get(/THESIS:\s*([\s\S]*?)(?=\nBOTTOM:|$)/i) || get(/THESIS:\s*(.+)/i),
    agree: get(/AGREE:\s*(.+)/i),
    pushback: get(/PUSHBACK:\s*(.+)/i),
    raw: text.slice(0, 1200),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only — read-only POTD endpoint' });
  }

  try {
    const q = getQuery(req);
    const venue = String(q.venue || 'polymarket').toLowerCase() === 'kalshi' ? 'kalshi' : 'polymarket';
    const sport = String(q.sport || 'all').toLowerCase();
    const maxPicks = Math.min(5, Math.max(1, parseInt(q.max || q.maxPicks || '3', 10) || 3));
    const windowMode = String(q.window || 'next3').toLowerCase();
    const wantAi = q.ai === '1' || q.ai === 'true';
    // Never accept secrets via query string (access logs / referrers)
    const queryHadSecrets = !!(
      q.oddsKey || q.odds_api_key || q.oddsApiKey ||
      q.openaiKey || q.openai || q.openAiKey || q.apiKey
    );
    const oddsKey = String(process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || '').trim();
    const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();

    const leagues =
      sport === 'all'
        ? ['mlb', 'nfl', 'nba', 'nhl', 'cfb', 'cbb', 'wnba', 'soccer', 'ufc']
        : [sport];

    let games = [];
    const errors = [];

    if (venue === 'kalshi') {
      for (const lg of leagues) {
        try {
          const d = await loadKalshiGames(lg, 'all');
          const list = (d && d.games) || [];
          list.forEach((g) => {
            g.venue = 'kalshi';
            g.source = 'kalshi';
            g.league = g.league || lg;
          });
          games = games.concat(list);
        } catch (e) {
          errors.push(lg + ': ' + (e.message || e));
        }
      }
    } else {
      // Prefer per-league so form/matchup attach; fall back to single all
      for (const lg of leagues.slice(0, sport === 'all' ? 6 : 1)) {
        try {
          const d = await loadPolyGames(lg, 'all');
          const list = (d && d.games) || [];
          list.forEach((g) => {
            g.venue = 'polymarket';
            g.source = 'polymarket';
            g.league = g.league || lg;
          });
          games = games.concat(list);
        } catch (e) {
          errors.push(lg + ': ' + (e.message || e));
        }
      }
      if (!games.length) {
        const dAll = await loadPolyGames('all', 'all');
        games = (dAll && dAll.games) || [];
        games.forEach((g) => {
          g.venue = g.venue || 'polymarket';
        });
      }
    }

    // Dedupe
    const seenId = {};
    games = games.filter((g) => {
      const id = String(g.id || g.marketSlug || '') + '|' + String(g.modelPick || '');
      if (!id || seenId[id]) return false;
      seenId[id] = true;
      return true;
    });

    const { candidates, diag, potdBaseScore } = selectPotdCandidates(games, {
      sport: sport === 'all' ? 'all' : sport,
      maxPicks,
      windowMode,
      pregameOnly: true,
    });

    // Odds consensus on top survivors
    const pre = candidates.slice(0, Math.min(8, Math.max(maxPicks * 3, 4)));
    if (oddsKey && pre.length) {
      for (const og of pre) {
        try {
          const od = await oddsConsensus(oddsKey, og);
          const cons = (od && (od.consensus || od)) || {};
          let cPct = null;
          if (cons.implied != null) cPct = Number(cons.implied);
          else if (cons.probability != null) cPct = Number(cons.probability);
          else if (cons.yes != null) cPct = Number(cons.yes);
          if (cPct != null && cPct > 1) cPct = cPct / 100;
          og._potdConsensus = cPct;
          const mp01 = (modelPctOf(og) || 50) / 100;
          let boost = 0;
          if (cPct != null && Number.isFinite(cPct)) {
            const diff = Math.abs(mp01 - cPct);
            if (diff <= 0.06) boost = 8;
            else if (diff <= 0.12) boost = 3;
            else if (diff >= 0.22) boost = -12;
            og._potdConsensusLine =
              'Consensus ~' + Math.round(cPct * 1000) / 10 + '%' + (boost >= 8 ? ' · aligned' : boost < 0 ? ' · diverges' : '');
          } else {
            og._potdConsensusLine = 'Consensus unavailable';
          }
          og._potdOddsBoost = boost;
        } catch (e) {
          og._potdOddsBoost = 0;
          og._potdConsensusLine = 'Odds error';
        }
      }
    }

    candidates.forEach((g) => {
      g._potdScore = Math.round(Math.max(0, Math.min(100, potdBaseScore(g) + (g._potdOddsBoost || 0))));
    });
    candidates.sort((a, b) => (b._potdScore || 0) - (a._potdScore || 0));
    const top = candidates.slice(0, maxPicks);

    // Optional AI
    const picks = [];
    for (const g of top) {
      let aiPayload = null;
      if (wantAi && openaiKey) {
        try {
          const ar = await potdAiAnalyze(openaiKey, g);
          const text = (ar && (ar.text || ar.content || ar.message || ar.analysis)) || (typeof ar === 'string' ? ar : null);
          aiPayload = parseAiText(text) || (ar && ar.ok === false ? { error: ar.error } : null);
          if (!aiPayload && ar && (ar.conviction || ar.signal)) {
            aiPayload = {
              conviction: ar.conviction || null,
              signal: ar.signal || null,
              thesis: ar.thesis || ar.THESIS || null,
              raw: null,
            };
          }
        } catch (e) {
          aiPayload = { error: String(e.message || e) };
        }
      }
      picks.push(
        formatPick(g, {
          consensusPct: g._potdConsensus != null ? Math.round(Number(g._potdConsensus) * 1000) / 10 : null,
          consensusNote: g._potdConsensusLine || null,
          ai: aiPayload,
        })
      );
    }

    return res.status(200).json({
      ok: true,
      service: 'eliteodds-potd',
      version: '3.4.97',
      readOnly: true,
      venue,
      sport,
      window: windowMode,
      maxPicks,
      oddsUsed: !!oddsKey,
      aiUsed: !!(wantAi && openaiKey),
      keysFromEnv: true,
      querySecretsIgnored: queryHadSecrets || undefined,
      securityNote: queryHadSecrets
        ? 'oddsKey/openaiKey in the URL are ignored — set ODDS_API_KEY and OPENAI_API_KEY in Vercel env only'
        : undefined,
      envHint: (!oddsKey || (wantAi && !openaiKey))
        ? {
            ODDS_API_KEY: oddsKey ? 'set' : 'missing',
            OPENAI_API_KEY: openaiKey ? 'set' : (wantAi ? 'missing (needed for ai=1)' : 'optional'),
          }
        : undefined,
      updatedAt: new Date().toISOString(),
      diag,
      pickCount: picks.length,
      picks,
      errors: errors.length ? errors.slice(0, 8) : undefined,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e.message || e),
      service: 'eliteodds-potd',
    });
  }
};
