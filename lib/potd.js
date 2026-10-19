/**
 * Pick of the Day (POTD) — server-side selection (read-only)
 * Mirrors EliteOdds client gates (v3.4.97): edge≥4, price 28–72¢, O/U form soft path
 */
'use strict';

function modelPctOf(g) {
  let m = g.model_probability != null ? g.model_probability : g.modelPct;
  if (m == null) return null;
  m = Number(m);
  if (m <= 1) m = m * 100;
  return m;
}

function seBreakdown(g) {
  return g.breakdown || (g.evaluate && g.evaluate.matchup) || g.matchup || {};
}

function seL10WR(l10) {
  if (!l10 || l10.w == null) return null;
  const w = Number(l10.w) || 0;
  const l = Number(l10.l) || 0;
  const n = w + l;
  if (n <= 0) return null;
  return w / n;
}

function sePickIsHome(g) {
  const pick = String(g.modelPick || g.pickName || '').toLowerCase();
  const b = seBreakdown(g);
  const home = String(g.homeName || b.homeName || '').toLowerCase();
  const away = String(g.awayName || b.awayName || '').toLowerCase();
  if (g.pickHome === true || g.pickHome === false) return !!g.pickHome;
  if (home && pick && (pick.indexOf(home.slice(0, 5)) >= 0 || home.indexOf(pick.slice(0, 5)) >= 0)) return true;
  if (away && pick && (pick.indexOf(away.slice(0, 5)) >= 0 || away.indexOf(pick.slice(0, 5)) >= 0)) return false;
  if (g.formWinProb != null) return Number(g.formWinProb) >= 0.5;
  return true;
}

function seRoleForm(g) {
  const b = seBreakdown(g);
  const homeL10 = b.homeL10 || (g.matchup && g.matchup.homeL10) || null;
  const awayL10 = b.awayL10 || (g.matchup && g.matchup.awayL10) || null;
  const pickHome = sePickIsHome(g);
  const pickWR = seL10WR(pickHome ? homeL10 : awayL10);
  const oppWR = seL10WR(pickHome ? awayL10 : homeL10);
  const gap = pickWR != null && oppWR != null ? pickWR - oppWR : null;
  let formLeanHome = null;
  if (g.formWinProb != null) formLeanHome = Number(g.formWinProb) >= 0.5;
  else if (pickWR != null && oppWR != null) formLeanHome = pickHome ? pickWR >= oppWR : oppWR > pickWR;
  return {
    pickHome,
    homeL10,
    awayL10,
    pickWR,
    oppWR,
    gap,
    formLeanHome,
    hasRole: pickWR != null && oppWR != null,
  };
}

function seFormLine(g) {
  const f = seRoleForm(g);
  const rec = (l10) => (!l10 || l10.w == null ? '—' : l10.w + '-' + l10.l);
  return (
    'H L10 ' +
    rec(f.homeL10) +
    ' · A L10 ' +
    rec(f.awayL10) +
    (f.pickWR != null ? ' · pick WR ' + Math.round(f.pickWR * 100) + '%' : '') +
    (f.gap != null ? ' · gap ' + (f.gap >= 0 ? '+' : '') + Math.round(f.gap * 100) + 'pp' : '')
  );
}

function seMatchSport(g, sp) {
  if (!sp || sp === 'all') return true;
  return String(g.league || g.sport || '').toLowerCase() === String(sp).toLowerCase();
}

function seIsLive(g) {
  return !!(g.live || g.isLive);
}

const PRICE_LO = 0.28;
const PRICE_HI = 0.72;
const MAIN_LINE_LO = 0.42;
const MAIN_LINE_HI = 0.58;
const MODEL_MIN = 55;
const EDGE_MIN = 4;

/**
 * @param {object[]} games
 * @param {object} opts { sport, maxPicks, windowMode, pregameOnly }
 */
function selectPotdCandidates(games, opts) {
  opts = opts || {};
  const sport = opts.sport || 'all';
  const maxPicks = Math.min(5, Math.max(1, Number(opts.maxPicks) || 3));
  const windowMode = opts.windowMode || 'next3';
  const pregameOnly = opts.pregameOnly !== false;
  const diag = { pool: (games || []).length, sport: 0, market: 0, model: 0, edge: 0, price: 0, form: 0, pass: 0 };

  const cands = [];
  for (const g of games || []) {
    if (!seMatchSport(g, sport)) continue;
    diag.sport++;
    const tmt = String(g.marketType || g.scanType || '').toLowerCase();
    if (/player_|prop|map_/.test(tmt)) continue;
    diag.market++;

    if (pregameOnly && seIsLive(g)) continue;

    if (windowMode === 'today' || windowMode === 'next3') {
      const iso = g.startTime || g.commenceTime || g.start;
      if (!iso) continue;
      const gd = new Date(iso);
      if (isNaN(gd.getTime())) continue;
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const t = gd.getTime();
      if (windowMode === 'today' && (t < start || t >= start + 86400000)) continue;
      if (windowMode === 'next3' && (t < start || t >= start + 3 * 86400000)) continue;
    }

    const mp = modelPctOf(g);
    if (mp == null || mp < MODEL_MIN) continue;
    diag.model++;

    let mkt = g.market_probability != null ? Number(g.market_probability) : g.impliedPct != null ? Number(g.impliedPct) : null;
    if (mkt != null && mkt > 1) mkt = mkt / 100;
    if (mkt == null || !Number.isFinite(mkt)) continue;
    if (mkt < PRICE_LO || mkt > PRICE_HI) continue;
    diag.price++;

    let edge = g.netEdge != null ? Number(g.netEdge) : g.probability_edge != null ? Number(g.probability_edge) : null;
    if (edge == null || !Number.isFinite(edge)) {
      edge = Math.round((mp / 100 - mkt) * 1000) / 10;
    }
    if (!Number.isFinite(edge)) edge = 0;
    if (edge < EDGE_MIN) continue;
    diag.edge++;

    const nearMain = mkt >= MAIN_LINE_LO && mkt <= MAIN_LINE_HI;
    if (!nearMain && edge < EDGE_MIN + 3) continue;

    let rf = seRoleForm(g);
    const isTotalish =
      /total|over|under|f5_total|nrfi|yrfi/.test(tmt) ||
      /\b(over|under)\b/i.test(String(g.modelPick || g.pick || ''));
    if (!rf || !rf.hasRole) {
      if (!(isTotalish && edge >= 6)) continue;
      rf = rf || { hasRole: false, pickWR: null, formLeanHome: null, gap: null, pickHome: true };
    }
    if (!isTotalish && rf.formLeanHome != null && rf.gap != null && rf.gap >= 0.08) {
      if (rf.pickHome !== rf.formLeanHome) continue;
    }
    if (rf.pickWR != null && rf.pickWR < 0.45 && edge < 7) continue;
    diag.form++;

    // H2H soft boost
    const b = seBreakdown(g);
    const h2h = b && b.h2h;
    let h2hBoost = 0;
    let h2hNote = 'H2H n/a';
    if (h2h && h2h.n >= 5) {
      const hw = Number(h2h.homeWins) || 0;
      const aw = Number(h2h.awayWins) || 0;
      const h2hSupports = rf.pickHome ? hw >= aw : aw >= hw;
      const h2hGap = Math.abs(hw - aw);
      if (h2hSupports && h2hGap >= 2) {
        h2hBoost = Math.min(6, h2hGap);
        h2hNote = 'H2H ' + hw + '-' + aw + ' n=' + h2h.n + ' supports';
      } else if (!h2hSupports && h2hGap >= 2) {
        h2hBoost = -Math.min(5, h2hGap);
        h2hNote = 'H2H ' + hw + '-' + aw + ' conflicts (soft)';
      } else {
        h2hNote = 'H2H ' + hw + '-' + aw + ' neutral';
      }
    }

    g._seForm = rf;
    g._seFormLine = seFormLine(g) + ' · ' + h2hNote;
    g._potdH2hBoost = h2hBoost;
    g._potdEdge = edge;
    g._potdNearMain = nearMain;
    diag.pass++;
    cands.push(g);
  }

  function potdBaseScore(g) {
    const fa = g._seForm && g._seForm.gap != null ? Number(g._seForm.gap) : 0;
    const ma = modelPctOf(g) || 0;
    let ea = g.netEdge != null ? Number(g.netEdge) : g._potdEdge != null ? Number(g._potdEdge) : 0;
    if (!Number.isFinite(ea)) ea = 0;
    const h2 = g._potdH2hBoost != null ? Number(g._potdH2hBoost) : 0;
    return fa * 40 + ma * 0.35 + ea * 2.5 + h2;
  }

  cands.sort((a, b) => potdBaseScore(b) - potdBaseScore(a));
  const seen = {};
  const uniq = [];
  for (const g of cands) {
    const k =
      String(g.eventTitle || g.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim() +
      '|' +
      String(g.marketType || '') +
      '|' +
      String(g.modelPick || '');
    if (seen[k]) continue;
    seen[k] = true;
    uniq.push(g);
  }

  return { candidates: uniq, diag, potdBaseScore, maxPicks };
}

function formatPick(g, extras) {
  extras = extras || {};
  const mp = modelPctOf(g);
  let mkt = g.market_probability != null ? Number(g.market_probability) : g.impliedPct != null ? Number(g.impliedPct) : null;
  if (mkt != null && mkt > 1) mkt = mkt / 100;
  const edge = g._potdEdge != null ? g._potdEdge : g.netEdge;
  return {
    id: g.id || g.marketSlug || g.slug || null,
    venue: g.venue || g.source || 'polymarket',
    league: g.league || g.sport || null,
    marketType: g.marketType || null,
    eventTitle: g.eventTitle || g.title || null,
    modelPick: g.modelPick || g.pick || null,
    startTime: g.startTime || g.commenceTime || null,
    marketSlug: g.marketSlug || g.slug || null,
    url: g.url || (g.marketSlug ? 'https://polymarket.us/market/' + g.marketSlug : null),
    modelPct: mp != null ? Math.round(mp * 10) / 10 : null,
    marketPct: mkt != null ? Math.round(mkt * 1000) / 10 : null,
    edgePp: edge != null ? Math.round(Number(edge) * 10) / 10 : null,
    potdScore: g._potdScore != null ? g._potdScore : null,
    nearMain: !!g._potdNearMain,
    formLine: g._seFormLine || null,
    consensusPct: extras.consensusPct != null ? extras.consensusPct : g._potdConsensus != null ? Math.round(Number(g._potdConsensus) * 1000) / 10 : null,
    consensusNote: extras.consensusNote || g._potdConsensusLine || null,
    ai: extras.ai || null,
    rank: g.rank || null,
    score10: g.score10 != null ? g.score10 : null,
  };
}

module.exports = {
  selectPotdCandidates,
  formatPick,
  modelPctOf,
  seRoleForm,
  MODEL_MIN,
  EDGE_MIN,
  PRICE_LO,
  PRICE_HI,
};
