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

  // --- NBA / WNBA / CBB ---
  if (mt === 'player_pra' || /combined points.*rebound|points,\s*rebounds and assist|\bpra\b|points.?rebounds.?assists/.test(q))
    return ['points', 'rebounds', 'assists', 'avgPoints', 'avgRebounds', 'avgAssists'];
  if (mt === 'player_pts' || (/\bpoints\b|\bpts\b/.test(q) && !/spread|total|rebound|assist|combined|team/.test(q)))
    return ['points', 'avgPoints', 'pts'];
  if (mt === 'player_reb' || /\brebounds?\b/.test(q)) return ['rebounds', 'totalRebounds', 'avgRebounds', 'reb'];
  if (mt === 'player_ast' || /\bassists?\b/.test(q)) return ['assists', 'avgAssists', 'ast'];
  if (mt === 'player_blk' || mt === 'player_blocks' || /\bblocks?\b/.test(q)) return ['blocks', 'avgBlocks', 'blk'];
  if (mt === 'player_stl' || mt === 'player_steals' || /\bsteals?\b/.test(q)) return ['steals', 'avgSteals', 'stl'];
  if (mt === 'player_threes' || /three[- ]?pointers?|3[- ]?pointers?|\bthrees\b|\b3pm\b|made three/.test(q))
    return ['threePointFieldGoalsMade', 'avgThreePointFieldGoalsMade', 'threePointMade', '3PM'];
  if (mt === 'player_to' || /turnovers?/.test(q)) return ['turnovers', 'avgTurnovers'];
  if (mt === 'player_goals' || (/\bgoals?\b/.test(q) && !/field goal|game-winning/.test(q))) return ['goals', 'avgGoals', 'G'];
  if (mt === 'player_saves' || /\bsaves?\b/.test(q)) return ['saves', 'avgSaves'];

  // --- NFL / CFB ---
  if (mt === 'player_pass_yds' || /pass(ing)?\s*yards/.test(q)) return ['passingYards', 'passingYds', 'ydsPassing'];
  if (mt === 'player_rush_yds' || /rush(ing)?\s*yards/.test(q)) return ['rushingYards', 'rushingYds'];
  if (mt === 'player_rec_yds' || /receiv(ing)?\s*yards/.test(q)) return ['receivingYards', 'receivingYds'];
  if (mt === 'player_receptions' || /\breceptions\b|\bcatches\b/.test(q)) return ['receptions', 'receivingReceptions'];
  if (mt === 'player_pass_comp' || /completions/.test(q)) return ['completions', 'passingCompletions'];
  if (mt === 'player_pass_att' || /pass(ing)?\s*attempts/.test(q)) return ['passingAttempts', 'attempts'];
  if (mt === 'player_rush_att' || /rush(ing)?\s*attempts|carries/.test(q)) return ['rushingAttempts', 'carries'];
  if (mt === 'player_scrimmage' || /scrimmage\s*yards/.test(q)) return ['rushingYards', 'receivingYards'];
  if (mt === 'player_long_rec' || /longest\s*reception/.test(q)) return ['longReception', 'receivingLong'];
  if (mt === 'player_fantasy' || /fantasy/.test(q)) return ['fantasyPoints', 'fantasyPointsPerGame'];
  if (mt === 'player_atd' || /anytime\s*td|touchdown/.test(q))
    return ['rushingTouchdowns', 'receivingTouchdowns', 'passingTouchdowns', 'totalTouchdowns'];

  // --- MLB ---
  if (mt === 'player_hr' || /home\s*runs?|\bhr\b/.test(q)) return ['homeRuns', 'HR'];
  if (mt === 'player_k' || /strikeouts?/.test(q)) return ['strikeouts', 'strikeoutsPitching', 'K'];
  if (mt === 'player_hits' || (/\bhits\b/.test(q) && !/allowed/.test(q))) return ['hits', 'H'];
  if (mt === 'player_tb' || /total bases/.test(q)) return ['totalBases', 'TB'];
  if (mt === 'player_rbi' || /\brbis?\b/.test(q)) return ['RBIs', 'rbi', 'runsBattedIn'];
  if (mt === 'player_runs' || (/\bruns\b/.test(q) && !/earned|allowed/.test(q))) return ['runs', 'R'];
  if (mt === 'player_hrr' || /hits.*runs.*rbi|h\+r\+rbi/.test(q)) return ['hits', 'runs', 'RBIs'];
  if (mt === 'pitcher_outs' || /outs recorded/.test(q)) return ['outs', 'innings'];
  if (mt === 'pitcher_er' || /earned runs?/.test(q)) return ['earnedRuns', 'ER'];
  if (mt === 'pitcher_ha' || /hits allowed/.test(q)) return ['hits', 'hitsAllowed'];
  if (mt === 'pitcher_bb' || /walks allowed/.test(q)) return ['walks', 'basesOnBalls'];

  // --- generic question fallbacks ---
  if (/pass(ing)?\s*yards/.test(q)) return ['passingYards'];
  if (/rush(ing)?\s*yards/.test(q)) return ['rushingYards'];
  if (/receiv/.test(q) && /yards/.test(q)) return ['receivingYards'];
  if (/receptions/.test(q)) return ['receptions'];
  if (/combined points|points,\s*rebounds/.test(q)) return ['points', 'rebounds', 'assists'];
  if (/\bpoints\b/.test(q)) return ['points', 'avgPoints'];
  if (/rebounds/.test(q)) return ['rebounds', 'avgRebounds'];
  if (/assists/.test(q)) return ['assists', 'avgAssists'];
  if (/blocks/.test(q)) return ['blocks', 'avgBlocks'];
  if (/steals/.test(q)) return ['steals', 'avgSteals'];
  if (/three|3pm|3-pt/.test(q)) return ['threePointFieldGoalsMade', 'avgThreePointFieldGoalsMade'];
  if (/strikeouts/.test(q)) return ['strikeouts'];
  if (/home\s*runs?/.test(q)) return ['homeRuns'];
  if (/completions/.test(q)) return ['completions'];
  return null;
}

function parsePropFromMarket(g) {
  const q = String((g && (g.title || g.question || g.eventTitle || g.subTitle)) || '');
  const mt = String((g && g.marketType) || '').toLowerCase();
  let line = g.line != null ? Number(g.line) : (g.totalLine != null ? Number(g.totalLine) : null);
  let player = null;
  let thresholdStyle = false; // "35+" means 35 or more (over 34.5-ish)

  // Prefer full "Will X record at least N" over short card titles
  const qWill = String((g && (g.question || g.title || '')) || '');
  if (/will\s+.+\s+record\s+at\s+least/i.test(qWill) && !/will\s+.+\s+record\s+at\s+least/i.test(q)) {
    // re-parse from question below using qWill as primary
  }
  // Kalshi / card style: "Victor Wembanyama: 35+" or "Anthony Davis · 1+ blocks"
  let km =
    q.match(/^\s*([^:\n·]{3,40}?)\s*[:·]\s*(\d+(?:\.\d+)?)\+?/i) ||
    qWill.match(/^\s*([^:\n·]{3,40}?)\s*[:·]\s*(\d+(?:\.\d+)?)\+?/i);
  if (km) {
    player = km[1].replace(/\s+ML$/i, '').trim();
    if (line == null || isNaN(line)) line = Number(km[2]);
    thresholdStyle = true;
  }
  if (line == null || isNaN(line)) {
    const m = q.match(/(?:over|under|o\/u)\s*(\d+(?:\.\d+)?)/i) || q.match(/(\d+(?:\.\d+)?)\s*(?:yards?|pts|points|rebounds?|assists?|strikeouts?|hits?|receptions?|hr|home runs?)/i);
    if (m) line = Number(m[1]);
  }
  // Always try full question for "Will Name record..."
  const qSrc = /will\s+.+\s+record/i.test(qWill) ? qWill : q;
  if (line == null || isNaN(line)) {
    const am = qSrc.match(/at least\s+(\d+(?:\.\d+)?)/i) || qSrc.match(/[:·]\s*(\d+(?:\.\d+)?)\+?/i);
    if (am) line = Number(am[1]);
  }
  if (!player) {
    let m =
      qSrc.match(/will\s+([A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+(?:\s+[A-ZÀ-ÖØ-öø-ÿ][\w.'\-]+){0,3})\s+record/i) ||
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
    if (/\bblocks?\b/i.test(q)) mt2 = 'player_blocks';
    else if (/\bsteals?\b/i.test(q)) mt2 = 'player_steals';
    else if (/three|3pm|3-pt/i.test(q)) mt2 = 'player_threes';
    else if (/points|pts|\d+\+/.test(q) && /nba|wnba|cbb|player/i.test(String(g.league || '') + q)) mt2 = 'player_pts';
    if (/hits|home run|strikeout|mlb/i.test(String(g.league || '') + q)) {
      if (/home run|\bhr\b/i.test(q)) mt2 = 'player_hr';
      else if (/strikeout/i.test(q)) mt2 = 'player_k';
      else if (/hits/i.test(q) || /:\s*\d+\+/.test(q)) mt2 = 'player_hits';
    }
  }
  const keys = statKeysForType(mt2 || mt, q);
  const isOver =
    thresholdStyle ||
    /over|\d+\+|at least/i.test(q) ||
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


function statIndex(names, keys) {
  const nms = (names || []).map((n) => String(n).toLowerCase());
  for (const k of keys || []) {
    const kk = String(k).toLowerCase();
    let idx = nms.findIndex((n) => n === kk);
    if (idx < 0) idx = nms.findIndex((n) => n.indexOf(kk) >= 0 || kk.indexOf(n) >= 0);
    if (idx < 0 && /point/.test(kk)) idx = nms.findIndex((n) => n === 'points' || n === 'avgpoints');
    if (idx < 0 && /rebound/.test(kk)) idx = nms.findIndex((n) => /rebound/.test(n));
    if (idx < 0 && /assist/.test(kk)) idx = nms.findIndex((n) => /assist/.test(n));
    if (idx < 0 && /minute/.test(kk)) idx = nms.findIndex((n) => /minute/.test(n));
    if (idx < 0 && /pass.*yard/.test(kk)) idx = nms.findIndex((n) => /passingyards|pass.*yds/.test(n));
    if (idx < 0 && /rush.*yard/.test(kk)) idx = nms.findIndex((n) => /rushingyards|rush.*yds/.test(n));
    if (idx < 0 && /receiv/.test(kk)) idx = nms.findIndex((n) => /receiving|reception/.test(n));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Pull per-game rows from ESPN athlete gamelog (seasonTypes categories). */
function collectGamelogRows(gamelog, keys) {
  if (!gamelog) return [];
  const names = gamelog.names || [];
  const idx = statIndex(names, keys);
  const minIdx = statIndex(names, ['minutes', 'avgMinutes', 'MIN']);
  const meta = gamelog.events || {};
  const rows = [];

  function pushEvent(eventId, stats) {
    if (!Array.isArray(stats) || idx < 0) return;
    const v = num(stats[idx]);
    if (v == null) return;
    const m = meta[String(eventId)] || {};
    const atVs = String(m.atVs || '').toLowerCase(); // '@' away, 'vs' home typically
    const isHome = atVs === 'vs' || atVs === 'v' || atVs === 'home';
    const isAway = atVs === '@' || atVs === 'at' || atVs === 'away';
    const minutes = minIdx >= 0 ? num(stats[minIdx]) : null;
    const gd = m.gameDate || m.date || null;
    rows.push({
      eventId: String(eventId),
      value: v,
      minutes,
      isHome: isHome ? true : isAway ? false : null,
      gameDate: gd,
      opponent: (m.opponent && (m.opponent.displayName || m.opponent.name)) || null,
    });
  }

  for (const st of gamelog.seasonTypes || []) {
    const stName = String(st.displayName || '');
    // Prefer regular season; still accept if only postseason exists
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        pushEvent(ev.eventId || ev.id, ev.stats);
      }
    }
  }
  // Deduplicate by eventId, keep first (categories are newest-first usually)
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    out.push(r);
  }
  // Sort by date desc
  out.sort((a, b) => {
    const ta = a.gameDate ? new Date(a.gameDate).getTime() : 0;
    const tb = b.gameDate ? new Date(b.gameDate).getTime() : 0;
    return tb - ta;
  });
  return out;
}

function avgRows(rows, lastN) {
  if (!rows || !rows.length) return null;
  const use = rows.slice(0, lastN || 10);
  if (!use.length) return null;
  const avg = use.reduce((a, b) => a + b.value, 0) / use.length;
  const minAvg = use.filter((r) => r.minutes != null).length
    ? use.filter((r) => r.minutes != null).reduce((a, b) => a + b.minutes, 0) /
      use.filter((r) => r.minutes != null).length
    : null;
  return {
    value: avg,
    n: use.length,
    minutesAvg: minAvg,
    source: 'espn-L' + use.length,
    samples: use.map((r) => r.value),
  };
}

function avgFromGamelog(gamelog, keys, lastN) {
  const rows = collectGamelogRows(gamelog, keys);
  return avgRows(rows, lastN);
}

/**
 * context: { eventTitle, startTime, isHome }
 */
async function fetchPlayerProjection(playerName, league, marketType, question, context) {
  context = context || {};
  let keys = statKeysForType(marketType, question);
  // Kalshi "Name: 25+" often arrives as moneyline — default to points for NBA/WNBA
  if (!keys && playerName) {
    const qq = String(question || '').toLowerCase();
    const lg = String(league || '').toLowerCase();
    if (/block/.test(qq)) keys = ['blocks', 'avgBlocks'];
    else if (/steal/.test(qq)) keys = ['steals', 'avgSteals'];
    else if (/three|3pm|3-pt/.test(qq)) keys = ['threePointFieldGoalsMade', 'avgThreePointFieldGoalsMade'];
    else if (/rebound/.test(qq)) keys = ['rebounds', 'avgRebounds'];
    else if (/assist/.test(qq)) keys = ['assists', 'avgAssists'];
    else if (/point|pts|:\s*\d+/.test(qq) || lg === 'nba' || lg === 'wnba' || lg === 'cbb') keys = ['points', 'avgPoints', 'pts'];
    else if (lg === 'nfl' || lg === 'cfb') keys = ['passingYards', 'rushingYards', 'receivingYards'];
    else if (lg === 'mlb') keys = ['strikeouts', 'hits', 'homeRuns'];
  }
  if (!playerName || !keys) return null;
  const cacheKey = ['proj2', league, playerName, keys.join(','), context.isHome === true ? 'H' : context.isHome === false ? 'A' : 'U'].join(':');
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

    // PRA / combined: sum points + rebounds + assists per game when keys request multi
    const isPra = (keys || []).some((k) => /rebound/i.test(k)) && (keys || []).some((k) => /assist/i.test(k));
    const isScrimmage = (keys || []).some((k) => /rushingYards/i.test(k)) && (keys || []).some((k) => /receivingYards/i.test(k)) && !(keys || []).some((k) => /rebound/i.test(k));
    const isHrr = (keys || []).some((k) => /hits/i.test(k)) && (keys || []).some((k) => /RBI|runs/i.test(k));
    let rows;
    if ((isPra || isScrimmage || isHrr) && gamelog) {
      let keySets;
      if (isPra) {
        keySets = [
          ['points', 'avgPoints', 'pts'],
          ['totalRebounds', 'rebounds', 'avgRebounds'],
          ['assists', 'avgAssists'],
        ];
      } else if (isScrimmage) {
        keySets = [
          ['rushingYards', 'rushingYds'],
          ['receivingYards', 'receivingYds'],
        ];
      } else {
        keySets = [
          ['hits', 'H'],
          ['runs', 'R'],
          ['RBIs', 'rbi', 'runsBattedIn'],
        ];
      }
      const byId = {};
      for (const ks of keySets) {
        const part = collectGamelogRows(gamelog, ks);
        for (const r of part) {
          if (!byId[r.eventId]) byId[r.eventId] = { eventId: r.eventId, value: 0, minutes: r.minutes, isHome: r.isHome, gameDate: r.gameDate };
          byId[r.eventId].value += r.value;
        }
      }
      rows = Object.values(byId).sort((a, b) => {
        const ta = a.gameDate ? new Date(a.gameDate).getTime() : 0;
        const tb = b.gameDate ? new Date(b.gameDate).getTime() : 0;
        return tb - ta;
      });
    } else {
      rows = collectGamelogRows(gamelog, keys);
    }
    const L5 = avgRows(rows, 5);
    const L10 = avgRows(rows, 10);
    const homeRows = rows.filter((r) => r.isHome === true);
    const awayRows = rows.filter((r) => r.isHome === false);
    const homeL10 = avgRows(homeRows, 10);
    const awayL10 = avgRows(awayRows, 10);
    let season = extractStatFromOverview(overview, keys, league);

    // Blend: L5 40% + L10 30% + season 15% + venue split 15% when known
    let parts = [];
    if (L5 && L5.value != null) parts.push({ v: L5.value, w: 0.4, src: 'L5' });
    if (L10 && L10.value != null && L10.n >= 2) parts.push({ v: L10.value, w: L10.n >= 5 ? 0.3 : 0.22, src: 'L' + L10.n });
    if (season && season.value != null) parts.push({ v: season.value, w: 0.15, src: season.source || 'season' });

    let venueNote = null;
    if (context.isHome === true && homeL10 && homeL10.n >= 2) {
      parts.push({ v: homeL10.value, w: 0.15, src: 'homeL10' });
      venueNote = 'home L10 n=' + homeL10.n;
    } else if (context.isHome === false && awayL10 && awayL10.n >= 2) {
      parts.push({ v: awayL10.value, w: 0.15, src: 'awayL10' });
      venueNote = 'away L10 n=' + awayL10.n;
    }

    if (!parts.length) {
      if (L10 && L10.value != null) parts.push({ v: L10.value, w: 1, src: 'L10' });
      else if (season && season.value != null) parts.push({ v: season.value, w: 1, src: 'season' });
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

    // Minutes / role (usage proxy)
    let minutesFactor = 1;
    let role = 'unknown';
    const minL5 = L5 && L5.minutesAvg != null ? L5.minutesAvg : null;
    let minSeason = null;
    try {
      const minStat = extractStatFromOverview(overview, ['avgMinutes', 'minutes'], league);
      if (minStat && minStat.value != null) minSeason = minStat.value;
    } catch (e) {}
    const minUse = minL5 != null ? minL5 : minSeason;
    if (minUse != null) {
      if (minUse >= 32) {
        role = 'starter-heavy';
        minutesFactor = 1.06;
      } else if (minUse >= 26) {
        role = 'starter';
        minutesFactor = 1.0;
      } else if (minUse >= 18) {
        role = 'rotation';
        minutesFactor = 0.9;
      } else if (minUse >= 10) {
        role = 'bench';
        minutesFactor = 0.78;
      } else {
        role = 'fringe';
        minutesFactor = 0.65;
      }
      // Minutes collapse: L5 min << season min → cut overs
      if (minL5 != null && minSeason != null && minSeason >= 24 && minL5 < minSeason * 0.7) {
        minutesFactor *= 0.85;
        role = (role || '') + '+min-down';
      }
    }

    // Rest / B2B from last game date vs slate start
    let restDays = null;
    let restNudgePp = 0;
    try {
      const last = rows[0] && rows[0].gameDate ? new Date(rows[0].gameDate).getTime() : null;
      const start = context.startTime ? new Date(context.startTime).getTime() : Date.now();
      if (last && start && !isNaN(last) && !isNaN(start) && start >= last) {
        restDays = Math.round((start - last) / 86400000);
        // NBA: B2B (0–1 day) mild under lean; 3+ days rest slight over lean
        const lg = String(league || '').toLowerCase();
        if (lg === 'nba' || lg === 'wnba') {
          if (restDays <= 1) restNudgePp = -1.5; // fatigue → under
          else if (restDays >= 4) restNudgePp = 1.0;
        } else if (lg === 'nfl' || lg === 'cfb') {
          if (restDays <= 5) restNudgePp = -0.5;
          else if (restDays >= 10) restNudgePp = 0.5;
        }
      }
    } catch (e) {}

    // Soft matchup nudge: home edge for scorers; away slight under (no full DVP feed)
    let matchupNudgePp = restNudgePp;
    if (context.isHome === true) matchupNudgePp += 0.8;
    if (context.isHome === false) matchupNudgePp -= 0.6;
    if (venueNote) matchupNudgePp += 0; // already in blend

    // Apply minutes to projection scale (bench less production)
    if (proj != null && minutesFactor != null && minutesFactor !== 1) {
      proj = proj * (0.55 + 0.45 * minutesFactor); // don't fully zero
    }

    const detailParts = [];
    if (L5) detailParts.push('L5 ' + Math.round(L5.value * 10) / 10);
    if (L10) detailParts.push('L10 ' + Math.round(L10.value * 10) / 10 + ' n=' + L10.n);
    if (homeL10 && homeL10.n) detailParts.push('H' + Math.round(homeL10.value * 10) / 10);
    if (awayL10 && awayL10.n) detailParts.push('A' + Math.round(awayL10.value * 10) / 10);
    if (minUse != null) detailParts.push('min ' + Math.round(minUse * 10) / 10 + ' (' + role + ')');
    if (restDays != null) detailParts.push('rest ' + restDays + 'd');
    if (venueNote) detailParts.push(venueNote);

    const out = {
      ok: proj != null,
      playerName: found.displayName || playerName,
      athleteId: id,
      projection: proj != null ? Math.round(proj * 10) / 10 : null,
      blendProj: blendProj != null ? Math.round(blendProj * 10) / 10 : null,
      source,
      minutesFactor,
      minutesAvg: minUse != null ? Math.round(minUse * 10) / 10 : null,
      role,
      restDays,
      matchupNudgePp: Math.round(matchupNudgePp * 10) / 10,
      sampleN: (L10 && L10.n) || (L5 && L5.n) || (season && season.games) || 0,
      L5: L5 ? { avg: Math.round(L5.value * 10) / 10, n: L5.n, minutesAvg: L5.minutesAvg } : null,
      L10: L10 ? { avg: Math.round(L10.value * 10) / 10, n: L10.n, minutesAvg: L10.minutesAvg } : null,
      homeL10: homeL10 ? { avg: Math.round(homeL10.value * 10) / 10, n: homeL10.n } : null,
      awayL10: awayL10 ? { avg: Math.round(awayL10.value * 10) / 10, n: awayL10.n } : null,
      season: season ? { avg: Math.round(season.value * 10) / 10, games: season.games } : null,
      statKeys: keys,
      detail: detailParts.join(' · '),
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
    const title = String(g.title || g.question || g.eventTitle || '');
    const looksProp =
      mt === 'player_prop' || mt === 'prop' || mt.indexOf('player_') === 0 || mt.indexOf('pitcher_') === 0 ||
      /[A-Za-z][A-Za-z.'\-]+(?:\s+[A-Za-z][A-Za-z.'\-]+){0,3}\s*:\s*\d+(?:\.\d+)?\+?/.test(title) ||
      /will\s+[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){0,3}\s+record\s+at\s+least/i.test(title);
    if (!looksProp) continue;
    // Normalize type so downstream scoring always hits player path
    if (mt.indexOf('player_') !== 0 && mt.indexOf('pitcher_') !== 0 && mt !== 'player_prop' && mt !== 'prop') {
      g.marketType = 'player_pts';
    }
    jobs.push(g);
  }
  jobs.sort((a, b) => {
    const pa = Math.abs((Number(a.yesPrice) || 0.5) - 0.5);
    const pb = Math.abs((Number(b.yesPrice) || 0.5) - 0.5);
    return pa - pb;
  });
  // Prefer action prices; cap volume so Vercel does not time out
  const slice = jobs.slice(0, 60);
  const memo = new Map();
  async function enrichOne(g) {
    try {
      // Prefer long question for parse (card title may be "Name · 1+ blocks")
      const parsed = parsePropFromMarket(
        Object.assign({}, g, {
          title: g.question || g.title,
          question: g.question || g.title,
        })
      );
      if (!parsed.player || parsed.line == null) {
        g.playerProp = { ok: false, reason: 'parse-failed', parsed };
        return;
      }
      let mtProj = String(g.marketType || parsed.marketType || 'player_pts');
      if (mtProj.indexOf('player_') !== 0 && mtProj.indexOf('pitcher_') !== 0) mtProj = 'player_pts';
      // Prefer question-derived type when generic
      if ((mtProj === 'player_prop' || mtProj === 'prop') && parsed.marketType) mtProj = parsed.marketType;
      const memoKey = [league || g.league, parsed.player.toLowerCase(), mtProj, String(parsed.line)].join('|');
      let proj = memo.get(memoKey);
      if (proj === undefined) {
        let isHome = null;
        if (g._propIsHome === true || g._propIsHome === false) isHome = g._propIsHome;
        proj = await fetchPlayerProjection(
          parsed.player,
          league || g.league,
          mtProj,
          parsed.question || g.question || g.title,
          { eventTitle: g.eventTitle, startTime: g.startTime, isHome }
        );
        memo.set(memoKey, proj || null);
      }
      g.playerProp = Object.assign({ line: parsed.line, preferOver: parsed.preferOver !== false }, proj || {});
      g.line = parsed.line;
      g.totalLine = null;
      if (proj && proj.ok && proj.projection != null) {
        g.propProjection = proj.projection;
        g.propSource = proj.source;
        g.propPlayer = proj.playerName;
        g.propDetail = proj.detail || null;
        g.propRole = proj.role || null;
        g.propRestDays = proj.restDays;
      }
    } catch (e) {
      g.playerProp = { ok: false, reason: (e && e.message) || 'enrich-error' };
    }
  }
  // Concurrency 4 — ESPN is fragile under mass parallel on serverless
  const CONC = 4;
  for (let i = 0; i < slice.length; i += CONC) {
    await Promise.all(slice.slice(i, i + CONC).map(enrichOne));
  }
  return list;
}

/** Single-card enrich (inline fallback when batch missed) */
async function enrichOneGame(g, league) {
  await enrichPlayerProps([g], league || g.league);
  return g;
}

module.exports = {
  parsePropFromMarket,
  fetchPlayerProjection,
  enrichPlayerProps,
  enrichOneGame,
  statKeysForType,
};
