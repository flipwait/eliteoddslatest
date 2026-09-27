const { listSportGames } = require('../lib/kalshi');
const { matchupForEvent } = require('../lib/espn');
const { buildSignal } = require('../lib/score');
const { buildLiveAnalysis } = require('../lib/live');
let attachEspnLiveBatch = null;
try { attachEspnLiveBatch = require('../lib/espn').attachEspnLiveBatch; } catch (e) {}
const { enrichMlbMatchup } = require('../lib/mlb');


function nameHit(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ').filter((w) => w.length > 2);
  const tb = nb.split(' ').filter((w) => w.length > 2);
  if (ta.length && tb.length && ta[ta.length - 1] === tb[tb.length - 1]) return true;
  return false;
}

function resolveYesIsHome(g, matchup) {
  if (!matchup || !matchup.homeName) return null;
  const yesName = (g.sides && g.sides[0] && g.sides[0].name) || '';
  const clean = String(yesName).replace(/\s*wins$/i, '').trim();
  if (nameHit(clean, matchup.homeName)) return true;
  if (nameHit(clean, matchup.awayName)) return false;
  return null;
}

function matchesType(type, marketType) {
  if (!marketType || marketType === 'all') return true;
  if (marketType === 'moneyline' || marketType === 'ml') return type === 'moneyline' || type === 'moneyline_1h';
  if (marketType === 'spreads' || marketType === 'spread') return type === 'spread' || String(type).startsWith('spread_');
  if (marketType === 'spread_fg') return type === 'spread';
  if (marketType === 'spread_1h') return type === 'spread_1h';
  if (marketType === 'spread_2h') return type === 'spread_2h';
  if (marketType === 'spread_q1') return type === 'spread_q1';
  if (marketType === 'spread_q2') return type === 'spread_q2';
  if (marketType === 'spread_q3') return type === 'spread_q3';
  if (marketType === 'spread_q4') return type === 'spread_q4';
  if (marketType === 'totals' || marketType === 'total') return type === 'total' || String(type).startsWith('total_');
  if (marketType === 'total_fg') return type === 'total';
  if (marketType === 'total_1h') return type === 'total_1h';
  if (marketType === 'total_2h') return type === 'total_2h';
  if (marketType === 'total_q1') return type === 'total_q1';
  if (marketType === 'total_q2') return type === 'total_q2';
  if (marketType === 'total_q3') return type === 'total_q3';
  if (marketType === 'total_q4') return type === 'total_q4';
  if (marketType === 'team_totals') return String(type).startsWith('team_total');
  if (marketType === 'team_total_fg') return type === 'team_total_fg';
  if (marketType === 'team_total_1h') return type === 'team_total_1h';
  if (marketType === 'team_total_2h') return type === 'team_total_2h';
  if (marketType === 'f5') return type === 'f5';
  if (marketType === 'f5_spread') return type === 'f5_spread';
  if (marketType === 'f5_total') return type === 'f5_total';
  if (marketType === 'nrfi') return type === 'nrfi' || type === 'yrfi';
  if (marketType === 'yrfi') return type === 'yrfi' || type === 'nrfi';
  if (marketType === 'player_hr') return type === 'player_hr' || type === 'player_prop';
  if (marketType === 'player_k') return type === 'player_k' || type === 'player_prop';
  if (marketType === 'player_hits') return type === 'player_hits' || type === 'player_prop';
  if (marketType === 'player_tb') return type === 'player_tb' || type === 'player_prop';
  if (marketType === 'player_hrr') return type === 'player_hrr' || type === 'player_prop';
  if (marketType === 'pitcher_outs') return type === 'pitcher_outs' || type === 'player_prop';
  if (marketType === 'pitcher_er') return type === 'pitcher_er' || type === 'player_prop';
  if (marketType === 'pitcher_ha') return type === 'pitcher_ha' || type === 'player_prop';
  if (marketType === 'pitcher_bb') return type === 'pitcher_bb' || type === 'player_prop';
  if (marketType === 'player_pass_yds') return type === 'player_pass_yds' || type === 'player_prop';
  if (marketType === 'player_rush_yds') return type === 'player_rush_yds' || type === 'player_prop';
  if (marketType === 'player_rec_yds') return type === 'player_rec_yds' || type === 'player_prop';
  if (marketType === 'player_receptions') return type === 'player_receptions' || type === 'player_prop';
  if (marketType === 'player_atd') return type === 'player_atd' || type === 'player_prop';
  if (marketType === 'player_props') return String(type).startsWith('player_') || String(type).startsWith('pitcher_') || type === 'player_prop' || type === 'prop';
  if (marketType === 'innings') return type === 'nrfi' || type === 'yrfi' || /^inning_/.test(type);
  return type === marketType;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    const league = String(q.league || q.sport || 'all').toLowerCase();
    const mode = String(q.mode || 'all');
    const marketType = String(q.marketType || 'all');
    const limit = Math.min(Number(q.limit) || 40, 80);

    const { games: raw, series, count } = await listSportGames(league, { limit, marketType });

    let filtered = raw.filter((g) => matchesType(g.marketType || 'moneyline', marketType));
    if (mode === 'upcoming') filtered = filtered.filter((g) => !g.live);
    if (mode === 'live') filtered = filtered.filter((g) => g.live);

    // Cap alternate lines
    const capped = [];
    const seen = new Map();
    filtered.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    for (const g of filtered) {
      const key = String(g.eventTitle || '') + '|' + String(g.marketType || '');
      const n = seen.get(key) || 0;
      if (n >= 4) continue;
      seen.set(key, n + 1);
      capped.push(g);
    }

    const uniqueTitles = [];
    const seenT = new Set();
    for (const g of capped) {
      if (g.eventTitle && !seenT.has(g.eventTitle)) {
        seenT.add(g.eventTitle);
        uniqueTitles.push(g.eventTitle);
      }
      if (uniqueTitles.length >= 10) break;
    }

    const matchupCache = {};
    await Promise.all(
      uniqueTitles.map(async (title) => {
        try {
          let m = await matchupForEvent(league, title);
          if (m && league === 'mlb') {
            try {
              m = await enrichMlbMatchup(m);
            } catch (e) {}
          }
          if (m) {
            m.league = league;
            matchupCache[title] = m;
          }
        } catch (e) {}
      })
    );

    const out = [];
    for (const g of capped.slice(0, 60)) {
      const matchup = matchupCache[g.eventTitle] || null;
      // Dual team-win markets: order sides as [home, away] and price YES = home
      if (g._kalshiDualTeam && matchup && matchup.homeName && g.sides && g.sides.length >= 2) {
        const s0 = g.sides[0];
        const s1 = g.sides[1];
        let homeSide = null;
        let awaySide = null;
        if (nameHit(s0.name, matchup.homeName)) { homeSide = s0; awaySide = s1; }
        else if (nameHit(s1.name, matchup.homeName)) { homeSide = s1; awaySide = s0; }
        else if (nameHit(s0.name, matchup.awayName)) { awaySide = s0; homeSide = s1; }
        if (homeSide && awaySide) {
          g.sides = [homeSide, awaySide];
          g.yesPrice = homeSide.price;
          g.noPrice = awaySide.price;
        }
      }
      let yesIsHome = resolveYesIsHome(g, matchup);
      if (g._kalshiDualTeam && matchup && matchup.homeName && g.sides && g.sides[0] && nameHit(g.sides[0].name, matchup.homeName)) {
        yesIsHome = true;
      }
      const sc = buildSignal(
        {
          id: g.marketSlug || g.id,
          question: g.title,
          yesPrice: g.yesPrice,
          noPrice: g.noPrice,
          volume: g.volume,
          liquidity: g.liquidity,
          matchup,
          league,
          marketType: g.marketType || 'moneyline',
          live: false,
          eventTitle: g.eventTitle,
          url: g.url,
          venue: 'kalshi',
          source: 'kalshi',
          yesIsHome,
        },
        {
          strictTruth: q.strict !== '0',
          allowMarketGood: q.allowMarketGood === '1',
        }
      );

      const card = {
        ...g,
        modelPick: sc.pickName || (sc.side === 'YES' ? g.sides[0].name : g.sides[1].name),
        rank: sc.rank,
        betScore: sc.betScore,
        netEdge: sc.netEdge,
        ev: sc.ev,
        market_probability: sc.market_probability,
        model_probability: sc.model_probability,
        no_vig_probability: sc.no_vig_probability,
        probability_edge: sc.probability_edge,
        decimal_odds: sc.decimal_odds,
        fairSource: sc.fairSource,
        hasForm: sc.hasForm,
        formWinProb: sc.formWinProb,
        formAwayWinProb: sc.formAwayWinProb,
        totalLine: sc.totalLine,
        formNudgePp: sc.formNudgePp,
        breakdown: sc.breakdown,
        evaluate: sc.evaluate,
        homeName: matchup && matchup.homeName,
        awayName: matchup && matchup.awayName,
        venueVerified: !!(matchup && matchup.venueVerified),
        venue: 'kalshi',
        source: 'kalshi',
      };
      out.push(card);
    }

    // Final safety: one card per event + market type (drops dual-side F5/ML duplicates)
    const deduped = [];
    const seenKey = {};
    out.sort((a, b) => (b.betScore || 0) - (a.betScore || 0));
    for (const c of out) {
      const mt = String(c.marketType || 'moneyline').toLowerCase();
      const ev = String(c.eventTicker || c.eventTitle || c.title || '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const pick = String(c.modelPick || '').toLowerCase().trim();
      // Group by event+type so F5 only keeps best-scoring side
      const key = ev + '|' + mt;
      if (seenKey[key]) continue;
      seenKey[key] = true;
      deduped.push(c);
    }
    out.length = 0;
    out.push(...deduped);
    // Drop completed / Final (not actionable)
    for (let i = out.length - 1; i >= 0; i--) {
      const x = out[i];
      const per = String((x && (x.period || x.score)) || '').toLowerCase();
      if ((x && x.ended) || /\bfinal\b|\bft\b|ended/.test(per)) out.splice(i, 1);
    }

    if (typeof attachEspnLiveBatch === 'function') {
      try { await attachEspnLiveBatch(out); } catch (e) {}
    }
    out.forEach((card) => {
      try { card.liveAnalysis = buildLiveAnalysis(card); } catch (e) {}
    });
    return res.status(200).json({
      ok: true,
      venue: 'kalshi',
      league,
      series,
      marketType,
      count: out.length,
      rawCount: count,
      games: out,
      summary: {
        live: out.filter((g) => g.live).length,
        upcoming: out.filter((g) => !g.live).length,
        elite: out.filter((g) => String(g.rank).toLowerCase() === 'elite').length,
        good: out.filter((g) => String(g.rank).toLowerCase() === 'good').length,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
