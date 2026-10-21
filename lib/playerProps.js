/**
 * Player prop projections (Polymarket + Kalshi)
 * ESPN public athlete search + season/gamelog averages → model vs line
 */
'use strict';

const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

const SPORT_PATH = {
  nfl: 'football/nfl',
  cfb: 'football/college-football',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  cbb: 'basketball/mens-college-basketball',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
};

/** Map marketType / question → ESPN stat key candidates */
function statKeysForType(marketType, question) {
  const mt = String(marketType || '').toLowerCase();
  const q = String(question || '').toLowerCase();
  if (mt === 'player_pass_yds' || /pass(ing)?\s*yards/.test(q)) return ['passingYards', 'passingYds', 'yds'];
  if (mt === 'player_rush_yds' || /rush(ing)?\s*yards/.test(q)) return ['rushingYards', 'rushingYds'];
  if (mt === 'player_rec_yds' || /receiv(ing)?\s*yards/.test(q)) return ['receivingYards', 'receivingYds'];
  if (mt === 'player_receptions' || /\breceptions\b|\bcatches\b/.test(q)) return ['receptions', 'receivingReceptions'];
  if (mt === 'player_atd' || /anytime\s*td|touchdown/.test(q)) return ['rushingTouchdowns', 'receivingTouchdowns', 'passingTouchdowns', 'totalTouchdowns'];
  if (mt === 'player_pra' || /combined points.*rebound|points, rebounds and assist|\bpra\b/i.test(q)) return ['points', 'rebounds', 'assists', 'avgPoints', 'avgRebounds', 'avgAssists'];
  if (mt === 'player_pts' || (/\bpoints\b|\bpts\b/.test(q) && !/spread|total|rebound|assist|combined/i.test(q))) return ['points', 'avgPoints', 'pts'];
  if (mt === 'player_reb' || /\brebounds?\b/.test(q)) return ['rebounds', 'avgRebounds', 'reb'];
  if (mt === 'player_ast' || /\bassists?\b/.test(q)) return ['assists', 'avgAssists', 'ast'];
  if (mt === 'player_hr' || /home\s*runs?|\bhr\b/.test(q)) return ['homeRuns', 'HR'];
  if (mt === 'player_k' || /strikeouts?/.test(q)) return ['strikeouts', 'strikeoutsPitching', 'K'];
  if (mt === 'player_hits' || /\bhits\b/.test(q)) return ['hits', 'H'];
  if (mt === 'player_tb' || /total bases/.test(q)) return ['totalBases', 'TB'];
  if (mt === 'player_hrr' || /hits.*runs.*rbi|h\+r\+rbi/.test(q)) return ['hits', 'runs', 'RBIs'];
  if (mt === 'pitcher_outs' || /outs recorded/.test(q)) return ['outs', 'innings'];
  if (mt === 'pitcher_er' || /earned runs?/.test(q)) return ['earnedRuns', 'ER'];
  if (mt === 'pitcher_ha' || /hits allowed/.test(q)) return ['hits', 'hitsAllowed'];
  if (mt === 'pitcher_bb' || /walks allowed/.test(q)) return ['walks', 'basesOnBalls'];
  // generic from question
  if (/pass(ing)?\s*yards/.test(q)) return ['passingYards'];
  if (/rush(ing)?\s*yards/.test(q)) return ['rushingYards'];
  if (/receiv/.test(q) && /yards/.test(q)) return ['receivingYards'];
  if (/receptions/.test(q)) return ['receptions'];
  if (/\bpoints\b/.test(q)) return ['points'];
  if (/rebounds/.test(q)) return ['rebounds'];
  if (/assists/.test(q)) return ['assists'];
  if (/strikeouts/.test(q)) return ['strikeouts'];
  if (/home\s*runs?/.test(q)) return ['homeRuns'];
  return null;
}

function parsePropFromMarket(g) {
  const q = String((g && (g.title || g.question || g.eventTitle || g.subTitle)) || '');
  const mt = String((g && g.marketType) || '').toLowerCase();
  let line = g.line != null ? Number(g.line) : (g.totalLine != null ? Number(g.totalLine) : null);
  let player = null;
  let thresholdStyle = false; // "35+" means 35 or more (over 34.5-ish)

  // Kalshi style: "Victor Wembanyama: 35+" or "Yandy Díaz: 2+"
  let km = q.match(/^\s*([^:\n]{3,40}?)\s*:\s*(\d+(?:\.\d+)?)\+?/i);
  if (km) {
    player = km[1].replace(/\s+ML$/i, '').trim();
    if (line == null || isNaN(line)) line = Number(km[2]);
    thresholdStyle = /\+\s*$/.test(km[0]) || /:\s*\d+\+/.test(q);
  }
  if (line == null || isNaN(line)) {
    const m = q.match(/(?:over|under|o\/u)\s*(\d+(?:\.\d+)?)/i) || q.match(/(\d+(?:\.\d+)?)\s*(?:yards?|pts|points|rebounds?|assists?|strikeouts?|hits?|receptions?|hr|home runs?)/i);
    if (m) line = Number(m[1]);
  }
  if (!player) {
    let m =
      q.match(/will\s+([A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+){0,3})\s+record/i) ||
      q.match(/^([A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+)+)\s+(?:over|under)/i) ||
      q.match(/(?:will|can)\s+([A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+)+)\s+(?:throw|rush|have|score|get|record)/i) ||
      q.match(/([A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+)+)\s+(?:passing|rushing|receiving|points|rebounds|assists|strikeouts|home runs|hits)/i);
    if (m) player = m[1].replace(/\s+vs\.?.*$/i, '').replace(/\s+ML$/i, '').trim();
  }
  if ((line == null || isNaN(line))) {
    const am = q.match(/at least\s+(\d+(?:\.\d+)?)/i);
    if (am) line = Number(am[1]);
  }
  // Side name often is the player on Kalshi
  if (!player && g.sides && g.sides[0] && g.sides[0].name) {
    const sn = String(g.sides[0].name).replace(/\s+ML$/i, '').trim();
    if (!/^(over|under|yes|no)\b/i.test(sn) && sn.length > 2 && sn.length < 48) {
      const sm = sn.match(/^([^:]+):\s*(\d+)/);
      if (sm) {
        player = sm[1].trim();
        if (line == null) line = Number(sm[2]);
      } else if (!/over|under|^\d/.test(sn)) {
        player = sn;
      }
    }
  }
  // Infer market type from title when generic
  let mt2 = mt;
  if (!mt2 || mt2 === 'moneyline' || mt2 === 'player_prop') {
    if (/points|pts|\d+\+/.test(q) && /nba|wnba|cbb|player/i.test(String(g.league || '') + q)) mt2 = 'player_pts';
    if (/hits|home run|strikeout|mlb/i.test(String(g.league || '') + q)) {
      if (/home run|\bhr\b/i.test(q)) mt2 = 'player_hr';
      else if (/strikeout/i.test(q)) mt2 = 'player_k';
      else if (/hits/i.test(q) || /:\s*\d+\+/.test(q)) mt2 = 'player_hits';
    }
  }
  const keys = statKeysForType(mt2 || mt, q);
  const isOver =
    thresholdStyle ||
    /over|\d+\+/i.test(q) ||
    (g.sides && g.sides[0] && /over|\+/i.test(String(g.sides[0].name || '')));
  return {
    player,
    line: line != null && !isNaN(line) ? line : null,
    statKeys: keys,
    marketType: mt2 || mt,
    question: q,
    preferOver: !!isOver,
    thresholdStyle,
  };
}

async function espnSearchPlayer(name, league) {
  if (!name) return null;
  const key = 'search:' + league + ':' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const u =
    'https://site.web.api.espn.com/apis/common/v3/search?query=' +
    encodeURIComponent(name) +
    '&limit=8&type=player';
  const r = await fetch(u, { headers: { 'User-Agent': 'EliteOdds/1.0', Accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  const items = j.items || [];
  const lg = String(league || '').toLowerCase();
  const sportPath = SPORT_PATH[lg] || '';
  let best = null;
  for (const it of items) {
    if (String(it.type || '').toLowerCase() !== 'player') continue;
    const leagueSlug = String((it.league && it.league.slug) || it.league || '').toLowerCase();
    const sport = String(it.sport || '').toLowerCase();
    // Prefer matching league
    if (lg === 'nfl' && (leagueSlug === 'nfl' || sport === 'football')) {
      best = it;
      break;
    }
    if (lg === 'nba' && (leagueSlug === 'nba' || sport === 'basketball')) {
      best = it;
      break;
    }
    if (lg === 'mlb' && (leagueSlug === 'mlb' || sport === 'baseball')) {
      best = it;
      break;
    }
    if (lg === 'nhl' && (leagueSlug === 'nhl' || sport === 'hockey')) {
      best = it;
      break;
    }
    if (lg === 'cfb' && (leagueSlug.indexOf('college') >= 0 || leagueSlug === 'college-football')) {
      best = it;
      break;
    }
    if (!best) best = it;
  }
  cache.set(key, { t: Date.now(), v: best });
  return best;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Pull stat from overview.statistics.splits (Regular Season / Last 5 Games). */
function extractStatFromOverview(overview, keys, league) {
  if (!overview || !keys || !keys.length) return null;
  const stats = overview.statistics;
  if (!stats) return null;
  const names = (stats.names || []).map((n) => String(n));
  const splits = stats.splits || [];
  if (!names.length || !splits.length) return null;
  const lg = String(league || '').toLowerCase();

  function parseVal(raw) {
    return num(String(raw == null ? '' : raw).replace(/,/g, ''));
  }

  function idxFor(keys) {
    for (const k of keys) {
      const kk = String(k).toLowerCase();
      let idx = names.findIndex((n) => n.toLowerCase() === kk);
      if (idx < 0) idx = names.findIndex((n) => n.toLowerCase().indexOf(kk) >= 0 || kk.indexOf(n.toLowerCase()) >= 0);
      // avgPoints style
      if (idx < 0 && kk.indexOf('points') >= 0) idx = names.findIndex((n) => /avgpoints|^points$/i.test(n));
      if (idx < 0 && kk.indexOf('rebound') >= 0) idx = names.findIndex((n) => /avgrebounds|rebounds/i.test(n));
      if (idx < 0 && kk.indexOf('assist') >= 0) idx = names.findIndex((n) => /avgassists|assists/i.test(n));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  const idx = idxFor(keys);
  if (idx < 0) return null;

  const last5 = splits.find((s) => /last\s*5/i.test(String(s.displayName || '')));
  const reg = splits.find((s) => /regular\s*season/i.test(String(s.displayName || '')));
  const gpIdx = names.findIndex((n) => /gamesplayed|^gp$/i.test(n));

  // Already per-game averages (NBA style avgPoints)
  const nameAt = names[idx] || '';
  const alreadyAvg = /^avg/i.test(nameAt) || /avgpoints|avgrebounds|avgassists|avgminutes/i.test(nameAt);

  if (last5 && last5.stats && last5.stats[idx] != null) {
    let v = parseVal(last5.stats[idx]);
    if (v == null) return null;
    if (!alreadyAvg) v = v / 5; // NFL totals over last 5
    return { value: v, source: 'espn-L5', games: 5 };
  }

  if (reg && reg.stats && reg.stats[idx] != null) {
    let v = parseVal(reg.stats[idx]);
    if (v == null) return null;
    if (alreadyAvg) {
      return { value: v, source: 'espn-season-avg', games: gpIdx >= 0 ? parseVal(reg.stats[gpIdx]) : null };
    }
    let gp = gpIdx >= 0 ? parseVal(reg.stats[gpIdx]) : null;
    if (!(gp > 0)) {
      if (lg === 'nfl' || lg === 'cfb') gp = 5;
      else if (lg === 'nba' || lg === 'wnba' || lg === 'cbb') gp = 10;
      else if (lg === 'mlb') gp = 20;
      else if (lg === 'nhl') gp = 10;
      else gp = 5;
    }
    return { value: v / gp, source: 'espn-season-pg', games: gp };
  }
  return null;
}

function avgFromGamelog(gamelog, keys, lastN) {
  if (!gamelog || !Array.isArray(gamelog.names) || !gamelog.events) return null;
  const names = gamelog.names.map((n) => String(n).toLowerCase());
  let idx = -1;
  for (const k of keys || []) {
    const kk = String(k).toLowerCase();
    idx = names.findIndex((n) => n === kk || n.indexOf(kk) >= 0 || kk.indexOf(n) >= 0);
    if (idx >= 0) break;
  }
  if (idx < 0) return null;
  const events = Object.values(gamelog.events || {});
  // events may be dict of event id → { stats: [...] }
  const vals = [];
  for (const ev of events) {
    const st = ev && (ev.stats || ev.statistics);
    if (!st) continue;
    const row = Array.isArray(st) ? st : st.values || st;
    if (Array.isArray(row) && row[idx] != null) {
      const v = num(row[idx]);
      if (v != null) vals.push(v);
    } else if (row && typeof row === 'object') {
      // alternate shape
    }
  }
  // Alternative: events as array
  if (!vals.length && Array.isArray(gamelog.events)) {
    for (const ev of gamelog.events) {
      const st = ev.stats || ev.statistics || [];
      if (Array.isArray(st) && st[idx] != null) {
        const v = num(st[idx]);
        if (v != null) vals.push(v);
      }
    }
  }
  if (!vals.length) return null;
  const use = vals.slice(0, lastN || 10);
  const avg = use.reduce((a, b) => a + b, 0) / use.length;
  return { value: avg, source: 'espn-L' + use.length, n: use.length, samples: use };
}

async function fetchPlayerProjection(playerName, league, marketType, question) {
  const keys = statKeysForType(marketType, question);
  if (!playerName || !keys) return null;
  const cacheKey = ['proj', league, playerName, keys.join(',')].join(':');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  const path = SPORT_PATH[String(league || '').toLowerCase()];
  if (!path) {
    const out = { ok: false, reason: 'league-not-mapped', playerName };
    cache.set(cacheKey, { t: Date.now(), v: out });
    return out;
  }

  try {
    const found = await espnSearchPlayer(playerName, league);
    if (!found || !found.id) {
      const out = { ok: false, reason: 'player-not-found', playerName };
      cache.set(cacheKey, { t: Date.now(), v: out });
      return out;
    }
    const id = found.id;
    const base = 'https://site.web.api.espn.com/apis/common/v3/sports/' + path + '/athletes/' + id;
    const [ovRes, glRes] = await Promise.all([
      fetch(base + '/overview', { headers: { 'User-Agent': 'EliteOdds/1.0', Accept: 'application/json' } }),
      fetch(base + '/gamelog', { headers: { 'User-Agent': 'EliteOdds/1.0', Accept: 'application/json' } }),
    ]);
    let overview = null;
    let gamelog = null;
    if (ovRes.ok) overview = await ovRes.json();
    if (glRes.ok) gamelog = await glRes.json();

    let L10 = avgFromGamelog(gamelog, keys, 10);
    let season = extractStatFromOverview(overview, keys, league);

    // Blend L5 / L10 / season for a sturdier projection (prop model B)
    let L5 = season && String(season.source || '').indexOf('L5') >= 0 ? season : null;
    let seasonOnly = season && !L5 ? season : null;
    // If overview returned L5 as season object, keep; also try extract again conceptually
    let parts = [];
    if (L5 && L5.value != null) parts.push({ v: L5.value, w: 0.5, src: 'L5' });
    if (L10 && L10.value != null && L10.n >= 2) parts.push({ v: L10.value, w: L10.n >= 5 ? 0.35 : 0.25, src: 'L' + L10.n });
    if (seasonOnly && seasonOnly.value != null) parts.push({ v: seasonOnly.value, w: 0.2, src: 'season' });
    // Fallback chain if blend empty
    if (!parts.length) {
      if (L10 && L10.value != null) parts.push({ v: L10.value, w: 1, src: L10.source || 'L10' });
      else if (season && season.value != null) parts.push({ v: season.value, w: 1, src: season.source || 'season' });
    }
    let proj = null;
    let source = null;
    let blendProj = null;
    if (parts.length) {
      const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
      blendProj = parts.reduce((a, p) => a + p.v * p.w, 0) / wsum;
      proj = blendProj;
      source = parts.map((p) => p.src).join('+');
    }

    // Soft minutes factor from overview if present (NBA)
    let minutesFactor = 1;
    try {
      const minStat = extractStatFromOverview(overview, ['avgMinutes', 'minutes'], league);
      if (minStat && minStat.value != null) {
        // Typical starter ~28–36 min; if under 18, dampen projection confidence
        if (minStat.value < 18) minutesFactor = 0.75;
        else if (minStat.value < 24) minutesFactor = 0.88;
        else if (minStat.value > 34) minutesFactor = 1.05;
      }
    } catch (e) {}

    const out = {
      ok: proj != null,
      playerName: found.displayName || playerName,
      athleteId: id,
      projection: proj != null ? Math.round(proj * 10) / 10 : null,
      blendProj: blendProj != null ? Math.round(blendProj * 10) / 10 : null,
      source,
      minutesFactor,
      sampleN: (L10 && L10.n) || (season && season.games) || 0,
      L10: L10 ? { avg: Math.round(L10.value * 10) / 10, n: L10.n } : null,
      season: season ? { avg: Math.round(season.value * 10) / 10, games: season.games } : null,
      statKeys: keys,
    };
    cache.set(cacheKey, { t: Date.now(), v: out });
    return out;
  } catch (e) {
    const out = { ok: false, reason: e.message, playerName };
    cache.set(cacheKey, { t: Date.now(), v: out });
    return out;
  }
}

/**
 * Enrich a list of game cards that look like player props (bounded concurrency).
 */
async function enrichPlayerProps(games, league) {
  const list = games || [];
  const jobs = [];
  for (const g of list) {
    const mt = String(g.marketType || '').toLowerCase();
    if (!(mt === 'player_prop' || mt === 'prop' || mt.indexOf('player_') === 0 || mt.indexOf('pitcher_') === 0)) {
      continue;
    }
    jobs.push(g);
  }
  // Cap enrichment; prefer mid-price props (more likely to rank)
  jobs.sort((a, b) => {
    const pa = Math.abs((Number(a.yesPrice) || 0.5) - 0.5);
    const pb = Math.abs((Number(b.yesPrice) || 0.5) - 0.5);
    return pa - pb;
  });
  const slice = jobs.slice(0, 40);
  const memo = new Map();
  const queue = slice.map(async (g) => {
    try {
      const parsed = parsePropFromMarket(g);
      if (!parsed.player || parsed.line == null) {
        g.playerProp = { ok: false, reason: 'parse-failed', parsed };
        return;
      }
      const memoKey = [league || g.league, parsed.player.toLowerCase(), (parsed.statKeys || []).join(',')].join('|');
      let proj = memo.get(memoKey);
      if (!proj) {
        proj = await fetchPlayerProjection(
          parsed.player,
          league || g.league,
          g.marketType || parsed.marketType,
          parsed.question
        );
        memo.set(memoKey, proj);
      }
      g.playerProp = Object.assign({ line: parsed.line, preferOver: parsed.preferOver }, proj || {});
      g.line = parsed.line;
      if (proj && proj.ok && proj.projection != null) {
        g.propProjection = proj.projection;
        g.propSource = proj.source;
        g.propPlayer = proj.playerName;
      }
    } catch (e) {
      g.playerProp = { ok: false, reason: e.message };
    }
  });
  await Promise.all(queue);
  return list;
}

module.exports = {
  parsePropFromMarket,
  fetchPlayerProjection,
  enrichPlayerProps,
  statKeysForType,
};
