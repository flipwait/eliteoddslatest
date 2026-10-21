const { fetchAllSportsEvents, fetchLeagueEvents, fetchSoccerEvents, isSoccerLeague, LEAGUES, SOCCER_LEAGUES } = require('../lib/polymarket');
const { buildSignal } = require('../lib/score');
const { buildLiveAnalysis } = require('../lib/live');
const { pushPrice, getMove, getBook, setBook } = require('../lib/store');
let matchupForEvent = async () => null;
let enrichMlbMatchup = async (m) => m;
let attachEspnLiveBatch = null;
try {
  const espnMod = require('../lib/espn');
  matchupForEvent = espnMod.matchupForEvent;
  attachEspnLiveBatch = espnMod.attachEspnLiveBatch;
} catch (e) {
  console.error('espn module optional', e.message);
}
try {
  enrichMlbMatchup = require('../lib/mlb').enrichMlbMatchup;
} catch (e) {
  console.error('mlb module optional', e.message);
}

let matchupForEsports = async () => null;
let isEsportsLeague = () => false;
let esportsNameInTitle = null;
try {
  const esMod = require('../lib/esports');
let enrichPlayerProps = async (g) => g;
try { enrichPlayerProps = require('../lib/playerProps').enrichPlayerProps; } catch (e) {}

/** Strip verbose API titles → "Team A vs Team B" */
function cleanEventTitle(raw) {
  let t = String(raw || '').trim();
  if (!t) return t;
  t = t.replace(/^who\s+will\s+win\s+(in\s+)?(the\s+)?(upcoming\s+)?/i, '');
  t = t.replace(/^who\s+wins\s+(in\s+)?(the\s+)?/i, '');
  t = t.replace(/\s+game\??\s*$/i, '');
  t = t.replace(/\s+match\??\s*$/i, '');
  t = t.replace(/\?+$/g, '');
  t = t.replace(/\s+vs\.\s+/i, ' vs. ');
  t = t.replace(/\s+versus\s+/i, ' vs. ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

  matchupForEsports = esMod.matchupForEsports || matchupForEsports;
  isEsportsLeague = esMod.isEsportsLeague || isEsportsLeague;
  esportsNameInTitle = esMod.esportsNameInTitle || null;
} catch (e) {
  console.error('esports module optional', e.message);
}



/** Live Yes/No from gateway BBO — list `price` is often stale (0.50 vs app 57¢) */
async function refreshMarketBbo(m) {
  const slug = m && (m.slug || m.marketSlug);
  if (!slug) return m;
  try {
    const r = await fetch(
      'https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/bbo',
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) return m;
    const data = await r.json();
    const md = data.marketData || data || {};
    const amt = (x) => {
      if (x == null) return null;
      let v = typeof x === 'object' && x.value != null ? Number(x.value) : Number(x);
      if (!Number.isFinite(v) || v < 0) return null;
      if (v > 1 && v <= 100) v = v / 100;
      if (v <= 0 || v >= 1) return null;
      return v;
    };
    // Over/Yes = longQuote or bestAsk (what you pay to buy Yes)
    const longPx =
      amt(md.longQuote) ||
      amt(md.bestAsk) ||
      amt(md.lastPriceSample && md.lastPriceSample.longPx) ||
      amt(md.currentPx);
    // Under/No = shortQuote
    const shortPx =
      amt(md.shortQuote) ||
      amt(md.lastPriceSample && md.lastPriceSample.shortPx);
    if (longPx != null) m.yesPrice = longPx;
    if (shortPx != null) m.noPrice = shortPx;
    else if (longPx != null) m.noPrice = Math.round((1 - longPx) * 1000) / 1000;
    if (m.yesPrice != null && m.noPrice != null && Math.abs(m.yesPrice - m.noPrice) < 0.02) {
      m.noPrice = Math.round((1 - m.yesPrice) * 1000) / 1000;
    }
    m._bbo = true;
  } catch (e) {}
  return m;
}

async function refreshBboBatch(markets, limit) {
  const list = (markets || []).filter((m) => m && (m.slug || m.marketSlug));
  const cap = Math.min(list.length, limit != null ? limit : 32);
  const chunk = list.slice(0, cap);
  // parallel but capped
  const size = 8;
  for (let i = 0; i < chunk.length; i += size) {
    await Promise.all(chunk.slice(i, i + size).map((m) => refreshMarketBbo(m)));
  }
  return markets;
}

async function fetchBookForSlug(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(
      'https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/book',
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const md = data.marketData || data;
    const bids = md.bids || [];
    const offers = md.offers || [];
    const bidQty = bids.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const askQty = offers.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const imbalance =
      bidQty + askQty > 0 ? Math.round(((bidQty - askQty) / (bidQty + askQty)) * 1000) / 10 : 0;
    return { imbalance, bidQty, askQty };
  } catch (e) {
    return null;
  }
}



function priceToDecimal(p) {
  if (p == null || p <= 0) return '—';
  return (1 / p).toFixed(2) + 'x';
}

function priceToAmerican(p) {
  if (p == null || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function formatCents(p) {
  if (p == null || isNaN(p)) return '—';
  const cents = Math.round(Number(p) * 1000) / 10;
  const am = priceToAmerican(Number(p));
  const amStr = am == null ? '' : ' (' + (am > 0 ? '+' : '') + am + ')';
  return cents + '¢' + amStr;
}

/** 0–1 price for the MODEL PICK side (Over→Yes/long, Under→No/short) */
function pickSidePrice01(sc, m) {
  let yes = m && m.yesPrice != null ? Number(m.yesPrice) : null;
  if (yes != null && yes > 1) yes = yes / 100;
  let no = m && m.noPrice != null ? Number(m.noPrice) : null;
  if (no != null && no > 1) no = no / 100;
  if (no == null && yes != null) no = Math.round((1 - yes) * 1000) / 1000;
  const pick = String((sc && (sc.pickName || sc.modelPick)) || '').toLowerCase();
  // Authority: label Over/Under always maps to Yes/No prices on PM totals
  if (/\bunder\b/.test(pick)) {
    if (no != null && no > 0 && no < 1) return no;
  }
  if (/\bover\b/.test(pick)) {
    if (yes != null && yes > 0 && yes < 1) return yes;
  }
  // Fallback scored market_probability
  if (sc && sc.market_probability != null) {
    let mp = Number(sc.market_probability);
    if (mp > 1) mp = mp / 100;
    if (mp > 0 && mp < 1) return mp;
  }
  const side = String((sc && sc.side) || 'YES').toUpperCase();
  if (side === 'NO' && no != null) return no;
  return yes;
}

function classifyMarket(m) {
  // Fine-grained Polymarket US sportsMarketType (from expanded event markets)
  const smt = String(m.sportsMarketType || '').toLowerCase();
  if (smt) {
    if (/player_passing_yards|passing_yards/.test(smt)) return 'player_pass_yds';
    if (/player_rushing_yards|rushing_yards/.test(smt)) return 'player_rush_yds';
    if (/player_receiving_yards|receiving_yards/.test(smt)) return 'player_rec_yds';
    if (/player_receptions/.test(smt)) return 'player_receptions';
    if (/player_passing_touchdowns|player_touchdowns|anytime|player_rushing_touchdowns/.test(smt)) return 'player_atd';
    if (/player_points|basketball_player_points/.test(smt)) return 'player_pts';
    if (/player_rebounds|basketball_player_rebounds/.test(smt)) return 'player_reb';
    if (/player_assists|basketball_player_assists/.test(smt)) return 'player_ast';
    if (/player_threes|basketball_player_threes|three.?point/.test(smt)) return 'player_threes';
    if (/player_steals|player_blocks|basketball_player_steals|basketball_player_blocks/.test(smt)) return 'player_prop';
    if (/player_rebounds/.test(smt)) return 'player_reb';
    if (/player_assists/.test(smt)) return 'player_ast';
    if (/player_strikeouts|pitcher_strikeouts/.test(smt)) return 'player_k';
    if (/player_home_runs|batter_home/.test(smt)) return 'player_hr';
    if (/player_hits/.test(smt)) return 'player_hits';
    if (/player_/.test(smt) || /_player_/.test(smt)) return 'player_prop';
    if (/full_game_spread|team_full_game_spread|spread/.test(smt) && /first_half|1h/.test(smt)) return 'spread_1h';
    if (/full_game_spread|team_.*_spread/.test(smt)) return 'spread';
    if (/first_half_total|game_first_half_total/.test(smt)) return 'total_1h';
    if (/full_game_total|game_total|team_.*_total|points_full_game_total/.test(smt)) return 'total';
    if (/full_game_winner|team_full_game_winner/.test(smt)) return 'moneyline';
    if (/first_half_winner/.test(smt)) return 'moneyline_1h';
  }

  // Prefer Polymarket US sportsMarketType (authoritative)
  const rawType = String(m.sportsMarketType || m.marketType || m.sportsMarketTypeV2 || '').toLowerCase();
  const q = String(m.question || m.slug || m.title || '').toLowerCase();
  const blob = (rawType + ' ' + q).replace(/_/g, ' ');

  // --- Explicit PM type maps (NFL / CFB football_* and similar) ---
  if (rawType) {
    // NHL period totals (must before generic total)
    if (/first_period_total|period_1_total|p1_total/.test(rawType)) return 'total_1h';
    if (/second_period_total|period_2_total|p2_total/.test(rawType)) return 'total_p2';
    if (/third_period_total|period_3_total|p3_total/.test(rawType)) return 'total_p3';
    if (/full_game_total|game_total/.test(rawType) && /hockey|nhl/.test(rawType + ' ' + blob)) return 'total';
    if (/first_period_spread/.test(rawType)) return 'spread_1h';
    if (/second_period_spread/.test(rawType)) return 'spread_2h';
    if (/third_period_spread/.test(rawType)) return 'spread_p3';
    // Winner / ML
    if (/full_game_winner|moneyline|match_winner|game_winner/.test(rawType) && !/spread|total/.test(rawType))
      return 'moneyline';

    // Baseball / football explicit period keys
    if (/first_five_spread|first_five.*spread/.test(rawType)) return 'f5_spread';
    if (/first_five_total|first_five.*total/.test(rawType)) return 'f5_total';
    if (/first_five_winner|first_five.*winner/.test(rawType)) return 'f5';

    // Spreads by period
    if (/spread/.test(rawType)) {
      if (/first_quarter|1st_quarter|\bq1\b/.test(rawType)) return 'spread_q1';
      if (/second_quarter|2nd_quarter|\bq2\b/.test(rawType)) return 'spread_q2';
      if (/third_quarter|3rd_quarter|\bq3\b/.test(rawType)) return 'spread_q3';
      if (/fourth_quarter|4th_quarter|\bq4\b/.test(rawType)) return 'spread_q4';
      if (/first_half|1st_half|\b1h\b/.test(rawType)) return 'spread_1h';
      if (/second_half|2nd_half|\b2h\b/.test(rawType)) return 'spread_2h';
      if (/first.?5|first.?five|f5|five_inning/.test(rawType)) return 'f5_spread';
      if (/full_game|game_spread|run_line|team_full_game_spread/.test(rawType)) return 'spread';
      return 'spread';
    }

    // Team totals (points by team) — before generic total
    if (/team_points|team_total|points_full_game|points_first_half|points_second_half/.test(rawType)) {
      if (/first_half|1st_half/.test(rawType)) return 'team_total_1h';
      if (/second_half|2nd_half/.test(rawType)) return 'team_total_2h';
      return 'team_total_fg';
    }

    // Game totals by period (incl. hockey periods)
    if (/total/.test(rawType)) {
      if (/first_quarter|1st_quarter/.test(rawType)) return 'total_q1';
      if (/second_quarter|2nd_quarter/.test(rawType)) return 'total_q2';
      if (/third_quarter|3rd_quarter/.test(rawType)) return 'total_q3';
      if (/fourth_quarter|4th_quarter/.test(rawType)) return 'total_q4';
      // NHL / hockey periods (before generic 1h)
      if (/first_period|1st_period|period_1|\bp1\b/.test(rawType)) return 'total_1h';
      if (/second_period|2nd_period|period_2|\bp2\b/.test(rawType)) return 'total_p2';
      if (/third_period|3rd_period|period_3|\bp3\b/.test(rawType)) return 'total_p3';
      if (/first_half|1st_half/.test(rawType)) return 'total_1h';
      if (/second_half|2nd_half/.test(rawType)) return 'total_2h';
      if (/first.?5|first.?five|f5|five_inning/.test(rawType)) return 'f5_total';
      // football_team_full_game_total on PM is game O/U (not team)
      if (/full_game|game_total/.test(rawType)) return 'total';
      return 'total';
    }

    // Player props (specific first)
    if (/home_run|homer|player_hr|\bhr\b/.test(rawType)) return 'player_hr';
    if (/strikeout|player_k|pitcher_k/.test(rawType)) return 'player_k';
    if (/hits_runs_rbi|hrr|player_hrr/.test(rawType)) return 'player_hrr';
    if (/total_bases|player_tb/.test(rawType)) return 'player_tb';
    if (/player_hits|batter_hits/.test(rawType)) return 'player_hits';
    if (/outs_recorded|pitcher_outs/.test(rawType)) return 'pitcher_outs';
    if (/earned_run|pitcher_er/.test(rawType)) return 'pitcher_er';
    if (/hits_allowed|pitcher_ha/.test(rawType)) return 'pitcher_ha';
    if (/walks_allowed|pitcher_bb/.test(rawType)) return 'pitcher_bb';
    // Football player props (keep as player_prop for menu; classify sub-types)
    if (/pass(ing)?_yards|passing yards/.test(rawType + ' ' + q)) return 'player_pass_yds';
    if (/rush(ing)?_yards|rushing yards/.test(rawType + ' ' + q)) return 'player_rush_yds';
    if (/receiving_yards|reception yards/.test(rawType + ' ' + q)) return 'player_rec_yds';
    if (/receptions|catches/.test(rawType + ' ' + q)) return 'player_receptions';
    if (/anytime.?td|touchdown.?scorer|to score a touchdown/.test(rawType + ' ' + q)) return 'player_atd';
    if (/player|passing|rushing|receiving|reception|touchdown|anytime|yards|completions|attempts|sacks|interceptions/.test(rawType))
      return 'player_prop';
  }

  // --- Text fallbacks (underscore-normalized blob) ---
  const isQ1 = /1st quarter|first quarter|\bq1\b|quarter 1/.test(blob);
  const isQ2 = /2nd quarter|second quarter|\bq2\b|quarter 2/.test(blob);
  const isQ3 = /3rd quarter|third quarter|\bq3\b|quarter 3/.test(blob);
  const isQ4 = /4th quarter|fourth quarter|\bq4\b|quarter 4/.test(blob);
  const is1H = /1st half|first half|\b1h\b|first half/.test(blob);
  const is2H = /2nd half|second half|\b2h\b|second half/.test(blob);

  // Esports
  if (/map 1|game 1|first map|1st map/.test(blob) && /win|winner|victory/.test(blob)) return 'map_1';
  if (/map 2|game 2|second map|2nd map/.test(blob) && /win|winner|victory/.test(blob)) return 'map_2';
  if (/map 3|game 3|third map|3rd map/.test(blob) && /win|winner|victory/.test(blob)) return 'map_3';
  if (/total maps|map total|maps over|maps under/.test(blob)) return 'map_total';
  if (/map winner|wins map/.test(blob)) return 'map_winner';

  // MLB innings / NRFI
  const innWin = blob.match(/(\d)(?:st|nd|rd|th)?\s*inning\s*(?:winner|win)|(?:wins?|winner of)\s*(?:the\s*)?(\d)(?:st|nd|rd|th)?\s*inning/);
  if (innWin) {
    const n = innWin[1] || innWin[2];
    if (n) return 'inning_' + n;
  }
  if (/inning winner/.test(blob)) return 'inning_winner';
  if (/first inning (run|score|scorer)|scores? in the 1st|1st inning (run|score)/.test(blob)) return 'inning_scorer';
  if (/\bnrfi\b|no run first inning|no runs? in the first/.test(blob)) return 'nrfi';
  if (/\byrfi\b|yes run first inning|run in the first inning/.test(blob)) return 'yrfi';

  const isF5 = /first 5|first five|f5\b|1st 5|five inning|through 5|thru 5|innings 1-5/.test(blob);
  if (isF5) {
    if (/spread|run line|cover|handicap/.test(blob)) return 'f5_spread';
    if (/total|over|under|o\/u|combined/.test(blob)) return 'f5_total';
    return 'f5';
  }

  if (/team total|team points|team runs/.test(blob)) {
    if (is1H) return 'team_total_1h';
    if (is2H) return 'team_total_2h';
    return 'team_total_fg';
  }

  const isSpread = /spread|cover|run line|handicap|beat the spread|runline/.test(blob);
  if (isSpread) {
    if (isQ1) return 'spread_q1';
    if (isQ2) return 'spread_q2';
    if (isQ3) return 'spread_q3';
    if (isQ4) return 'spread_q4';
    if (is1H) return 'spread_1h';
    if (is2H) return 'spread_2h';
    return 'spread';
  }

  const isP1 = /1st period|first period|period 1|\bp1\b/.test(blob);
  const isP2 = /2nd period|second period|period 2|\bp2\b/.test(blob);
  const isP3 = /3rd period|third period|period 3|\bp3\b/.test(blob);
  const isTotal = /total|over|under|o\/u|combined score|more than \d|goals?/.test(blob);
  if (isTotal) {
    if (isQ1) return 'total_q1';
    if (isQ2) return 'total_q2';
    if (isQ3) return 'total_q3';
    if (isQ4) return 'total_q4';
    if (isP1) return 'total_1h';
    if (isP2) return 'total_p2';
    if (isP3) return 'total_p3';
    if (is1H) return 'total_1h';
    if (is2H) return 'total_2h';
    return 'total';
  }

  if (/winner|moneyline|\bml\b|to win the game|outright|who will win/.test(blob)) {
    if (is1H) return 'moneyline_1h';
    return 'moneyline';
  }

  // MLB / NBA style player props — specific types for UI filters
  if (/home\s*runs?|\bhr\b|homer(?:s|un)?/.test(blob)) return 'player_hr';
  if (/strikeouts?|\bk\s*s\b|pitcher strikeout/.test(blob)) return 'player_k';
  if (/hits\s*\+|hits\s*runs\s*rbi|h\+r\+rbi|hits\s*\+\s*runs/.test(blob)) return 'player_hrr';
  if (/total bases|\btb\b/.test(blob)) return 'player_tb';
  if (/\bhits\b|player hits|batter hits/.test(blob)) return 'player_hits';
  if (/outs recorded|pitcher outs|outs by/.test(blob)) return 'pitcher_outs';
  if (/earned runs?|\ber\b allowed|er allowed/.test(blob)) return 'pitcher_er';
  if (/hits allowed|hits against pitcher/.test(blob)) return 'pitcher_ha';
  if (/walks allowed|\bbb\b allowed|bases on balls/.test(blob)) return 'pitcher_bb';
  if (/pass(ing)? yards/.test(blob)) return 'player_pass_yds';
  if (/rush(ing)? yards/.test(blob)) return 'player_rush_yds';
  if (/receiving yards/.test(blob)) return 'player_rec_yds';
  if (/\breceptions\b|catches/.test(blob)) return 'player_receptions';
  if (/anytime\s*td|anytime touchdown|to score a touchdown|touchdown scorer/.test(blob)) return 'player_atd';
  if (/completions|interceptions|sacks|pass(ing)? tds|rush(ing)? tds|touchdowns?/.test(blob)) return 'player_prop';
  if (/rebounds|assists|points scored by|batter|pitcher|player/.test(blob))
    return 'player_prop';

  // NBA / WNBA style player props
  if (/combined points|points,? rebounds and assist|\bpra\b/i.test(blob)) return 'player_pra';
  if (/\bpoints\b|\bpts\b/.test(blob) && /player|over|under|prop/.test(blob)) return 'player_pts';
  if (/\brebounds?\b|\brebs?\b/.test(blob)) return 'player_reb';
  if (/\bassists?\b/.test(blob) && !/pass(?:ing)?/.test(blob)) return 'player_ast';
  if (/pts\s*\+\s*reb|points\s*\+\s*rebound|\bpra\b|pts\+reb\+ast/.test(blob)) return 'player_pra';
  if (/three.?pointers?|3\s*-?pointers?|made threes|threes made/.test(blob)) return 'player_threes';

  return 'prop';
}


function scoreOne(m, ev, matchup, rankOpts, yesIsHome) {
  if (m.yesPrice == null) return null;
  const id = String(m.id || m.question || ev.id);
  pushPrice(id, m.yesPrice);
  const mv = getMove(id, 15 * 60 * 1000);
  let prior = null;
  if (mv && mv.from != null) prior = mv.from;
  const book = getBook(id);
  let yesName = null;
  let noName = null;
  try {
    const outcomes = m.outcomes || m.tokens || m.shortOutcomes || [];
    if (Array.isArray(outcomes) && outcomes.length >= 2) {
      yesName = outcomes[0].name || outcomes[0].title || outcomes[0];
      noName = outcomes[1].name || outcomes[1].title || outcomes[1];
      if (typeof yesName === 'object') yesName = yesName.name || yesName.title;
      if (typeof noName === 'object') noName = noName.name || noName.title;
    }
    const will = String(m.question || '').match(/will\s+(?:the\s+)?(.+?)\s+(?:win|cover|beat)/i);
    if (will && will[1]) yesName = yesName || will[1].trim();
  } catch (eLab) {}
  // Prefer long-side description as line hint (e.g. "+5.50")
  let lineFromSide = null;
  try {
    const sides = m.marketSides || [];
    const longS = sides.find((x) => x.long) || sides[0];
    if (longS && longS.description) {
      const dm = String(longS.description).match(/([+-]?\d+\.?\d*)/);
      if (dm) lineFromSide = Number(dm[1]);
    }
  } catch (eL) {}
  let lineVal =
    m.line != null && !isNaN(Number(m.line))
      ? Number(m.line)
      : lineFromSide;
  if (lineVal == null || isNaN(lineVal)) {
    const qq = String(m.question || '');
    const am = qq.match(/at least\s+(\d+(?:\.\d+)?)/i) || qq.match(/:\s*(\d+(?:\.\d+)?)\+?/i)
      || qq.match(/(?:over|under)\s*(\d+(?:\.\d+)?)/i);
    if (am) lineVal = Number(am[1]);
  }
  if ((lineVal == null || isNaN(lineVal)) && m.playerProp && m.playerProp.line != null) {
    lineVal = Number(m.playerProp.line);
  }

  return buildSignal({
    id,
    question: m.question || ev.title,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    volume: m.volume || 0,
    liquidity: m.liquidity || 0,
    volume24hr: m.volume || 0,
    url: m.url || ev.url,
    slug: m.slug || m.marketSlug || (m.url && String(m.url).split('/').filter(Boolean).pop()) || null,
    priorPrice: prior,
    bookImbalance: book ? book.imbalance : null,
    matchup: (function(){
      const t = classifyMarket(m);
      if (String(t).indexOf('player_')===0 || t==='player_prop' || t==='prop' || String(t).indexOf('pitcher_')===0) return null;
      const q = String(m.question||'');
      if (/will\s+[A-Z].*record\s+at\s+least/i.test(q) || /:\s*\d+\+/.test(q)) return null;
      return matchup || null;
    })(),
    marketType: classifyMarket(m),
    playerProp: m.playerProp || null,
    propProjection: m.propProjection,
    propPlayer: m.propPlayer,
    line: m.line != null ? Number(m.line) : (m.playerProp && m.playerProp.line != null ? Number(m.playerProp.line) : null),
    playerProp: m.playerProp || null,
    propProjection: m.propProjection,
    propPlayer: m.propPlayer,
    line: m.line != null ? m.line : (m.playerProp && m.playerProp.line),
    yesIsHome: yesIsHome,
    yesName: yesName,
    noName: noName,
    yesLabel: yesName,
    noLabel: noName,
    league: (ev && ev.league) || (matchup && matchup.league) || null,
    live: !!(ev && ev.live),
    eventTitle: (ev && (ev.title || ev.name)) || null,
    line: lineVal,
  }, rankOpts || {});
}

function nameHit(a, b) {
  if (!a || !b) return false;
  const na = String(a).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nb = String(b).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ').filter((w) => w.length > 2);
  const tb = nb.split(' ').filter((w) => w.length > 2);
  if (ta.length && tb.length) {
    const la = ta[ta.length - 1];
    const lb = tb[tb.length - 1];
    if (la.length > 3 && la === lb) return true;
    if (ta.some((w) => w.length > 3 && tb.includes(w))) return true;
  }
  return false;
}

function sidesFromMarket(m, evTitle, type, matchup) {
  let p = m.yesPrice != null ? Number(m.yesPrice) : null;
  if (p != null && p > 1) p = p / 100;
  let no = m.noPrice != null ? Number(m.noPrice) : p != null ? 1 - p : null;
  if (no != null && no > 1) no = no / 100;
  const pack = (name, price, role) => ({
    name,
    role: role || null,
    price,
    pct: price != null ? Math.round(price * 1000) / 10 : null,
    decimal: priceToDecimal(price),
    american: priceToAmerican(price),
    display: formatCents(price),
  });

  if (type === 'total' || type === 'f5_total' || String(type).startsWith('total_')) {
    // Prefer API line (all sports), then question "more than X", then slug 6pt5
    let lineVal = m.line != null && !isNaN(Number(m.line)) ? Number(m.line) : null;
    if (lineVal == null) {
      const qm = String(m.question || '').match(/more than\s*([0-9]+\.?[0-9]*)/i)
        || String(m.question || '').match(/(?:o\/u|total)\s*([0-9]+\.?[0-9]*)/i)
        || String(m.question || '').match(/([0-9]+\.?[0-9]*)\s*(?:runs|points|goals)/i);
      if (qm) lineVal = Number(qm[1]);
    }
    if (lineVal == null) {
      const sm = String(m.slug || m.marketSlug || '').match(/(\d+)pt(\d+)/i);
      if (sm) lineVal = Number(sm[1] + '.' + sm[2]);
    }
    const lineStr = lineVal != null
      ? (Number.isInteger(lineVal) ? String(lineVal) : String(Math.round(lineVal * 10) / 10))
      : '';
    return {
      sides: [
        pack(lineStr ? 'Over ' + lineStr : 'Over', p, 'over'),
        pack(lineStr ? 'Under ' + lineStr : 'Under', no, 'under'),
      ],
      yesIsHome: null,
      line: lineVal,
    };
  }
  if (type === 'nrfi' || type === 'yrfi') {
    return {
      sides: [pack('Yes (run scores)', p), pack('No (NRFI)', no)],
      yesIsHome: null,
    };
  }

  // Resolve team names: matchup home/away > title parse
  let homeName = matchup && matchup.homeName;
  let awayName = matchup && matchup.awayName;
  const title = String(evTitle || '');
  const at = title.split(/\s+at\s+/i);
  const vs = title.split(/\s+vs\.?\s+/i);
  if ((!homeName || !awayName) && at.length === 2) {
    awayName = awayName || at[0].trim();
    homeName = homeName || at[1].trim();
  } else if ((!homeName || !awayName) && vs.length === 2) {
    // "A vs B" on Polymarket is often not home order — still use as labels if no matchup
    if (!homeName && !awayName) {
      homeName = vs[0].trim();
      awayName = vs[1].trim();
    }
  }

  // Outcome names from market if present
  let yesLabel = null;
  let noLabel = null;
  const outcomes = m.outcomes || m.tokens || m.shortOutcomes || [];
  if (Array.isArray(outcomes) && outcomes.length >= 2) {
    yesLabel = outcomes[0].name || outcomes[0].title || outcomes[0];
    noLabel = outcomes[1].name || outcomes[1].title || outcomes[1];
    if (typeof yesLabel === 'object') yesLabel = yesLabel.name || yesLabel.title;
    if (typeof noLabel === 'object') noLabel = noLabel.name || noLabel.title;
  }
  // question sometimes "Will the X win?"
  const will = String(m.question || '').match(/will\s+(?:the\s+)?(.+?)\s+win/i);
  if (will && will[1]) yesLabel = yesLabel || will[1].trim();

  let yesIsHome = null;
  if (homeName && (yesLabel || homeName)) {
    if (yesLabel && nameHit(yesLabel, homeName)) yesIsHome = true;
    else if (yesLabel && nameHit(yesLabel, awayName)) yesIsHome = false;
    else if (!yesLabel && vs.length === 2 && nameHit(vs[0], homeName)) yesIsHome = true;
    else if (!yesLabel && vs.length === 2 && nameHit(vs[0], awayName)) yesIsHome = false;
  }

  // Default display order: home then away when known
  let side0;
  let side1;
  if (homeName && awayName && yesIsHome === true) {
    side0 = pack(homeName, p, 'home');
    side1 = pack(awayName, no, 'away');
  } else if (homeName && awayName && yesIsHome === false) {
    // YES is away — still show home first on card, but tag prices correctly
    side0 = pack(homeName, no, 'home');
    side1 = pack(awayName, p, 'away');
  } else if (homeName && awayName) {
    // Unknown yes mapping: assume title/order yes = first label only for prices on yes/no
    side0 = pack(yesLabel || homeName, p, 'yes');
    side1 = pack(noLabel || awayName, no, 'no');
  } else if (vs.length === 2) {
    side0 = pack(vs[0].trim(), p, 'yes');
    side1 = pack(vs[1].trim(), no, 'no');
  } else {
    side0 = pack(yesLabel || 'Yes', p, 'yes');
    side1 = pack(noLabel || 'No', no, 'no');
  }

  // Spread / run line: always show Team ±line (API line field is authoritative)
  if (type === 'spread' || String(type).startsWith('spread_') || type === 'f5_spread') {
    const q = String(m.question || '');
    const slug = String(m.slug || m.marketSlug || '');
    // All sports (NFL/CFB/NBA/CBB/NHL/MLB/WNBA): API `line` is source of truth
    let rawLine = m.line != null && !isNaN(Number(m.line)) ? Number(m.line) : null;
    let mag = rawLine != null ? Math.abs(rawLine) : null;
    if (mag == null) {
      let lm = q.match(/cover\s*([+-]?[0-9]+\.?[0-9]*)/i) || q.match(/wins by over\s*([0-9]+\.?[0-9]*)/i);
      if (lm) mag = Math.abs(Number(lm[1]));
      if (lm && String(lm[1]).trim().startsWith('-')) rawLine = -mag;
    }
    if (mag == null) {
      let lm = slug.match(/(?:neg|pos)[-_]?(\d+)(?:pt(\d+))?/i);
      if (lm) {
        mag = Number(lm[1] + '.' + (lm[2] || '0'));
        if (/neg/i.test(lm[0])) rawLine = -mag;
        else rawLine = mag;
      }
    }
    // Sign for YES team (the team named in "Will X cover …")
    let yesSign = 1;
    if (rawLine != null && rawLine < 0) yesSign = -1;
    else if (rawLine != null && rawLine > 0) yesSign = 1;
    else if (/neg[-_]?\d/i.test(slug)) yesSign = -1;
    else if (/pos[-_]?\d/i.test(slug)) yesSign = 1;
    else if (/wins by over/i.test(q)) yesSign = -1;
    else if (/cover\s*[0-9]/i.test(q)) yesSign = 1;

    // Named team in "Will the TEAM cover"
    let yesTeam = yesLabel;
    const coverTeam = q.match(/will\s+(?:the\s+)?(.+?)\s+cover/i);
    if (coverTeam) yesTeam = coverTeam[1].trim();
    if (!yesTeam && yesIsHome === true) yesTeam = homeName;
    if (!yesTeam && yesIsHome === false) yesTeam = awayName;

    if (mag != null) {
      const fmt = (v) => (v > 0 ? '+' : '') + (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
      const yesLine = yesSign * mag;
      const noLine = -yesSign * mag;
      const short = (n) => {
        n = String(n || '').trim();
        const p = n.split(/\s+/);
        return p[p.length - 1] || n;
      };
      // Resolve NO team as the other side
      let noTeam = noLabel;
      if (homeName && awayName) {
        if (yesTeam && nameHit(yesTeam, homeName)) noTeam = awayName;
        else if (yesTeam && nameHit(yesTeam, awayName)) noTeam = homeName;
      }
      const yName = (yesTeam || side0.name || 'YES') + ' ' + fmt(yesLine);
      const nName = (noTeam || side1.name || 'NO') + ' ' + fmt(noLine);
      // Keep price mapping: side0/side1 may be home-first ordered
      if (homeName && awayName && yesIsHome === true) {
        side0 = pack(short(homeName) + ' ' + fmt(yesLine), side0.price, 'home');
        side1 = pack(short(awayName) + ' ' + fmt(noLine), side1.price, 'away');
      } else if (homeName && awayName && yesIsHome === false) {
        side0 = pack(short(homeName) + ' ' + fmt(noLine), side0.price, 'home');
        side1 = pack(short(awayName) + ' ' + fmt(yesLine), side1.price, 'away');
      } else {
        side0 = pack(yName, side0.price, side0.role || 'yes');
        side1 = pack(nName, side1.price, side1.role || 'no');
      }
    }
  }

  return { sides: [side0, side1], yesIsHome, homeName, awayName, line: m.line != null ? Number(m.line) : null };
}

function sanitizePick(pick, sides, eventTitle) {
  if (!pick) return pick;
  // Never show full Polymarket spread questions as the pick label
  if (/will\s+.+(cover|win)|wins by over/i.test(String(pick))) {
    const sidesWithLine = (sides || []).filter((s) => s && s.name && /[+-]\d/.test(String(s.name)));
    if (sidesWithLine.length) return sidesWithLine[0].name;
    // Try to compress "Will the Liberty cover -4.5..." → "Liberty -4.5"
    const m = String(pick).match(/will\s+(?:the\s+)?(.+?)\s+cover\s*([-+]?[0-9]+\.?[0-9]*)/i);
    if (m) {
      const team = m[1].replace(/\s+vs\.?\s+.*$/i, '').trim().split(/\s+/).slice(0, 2).join(' ');
      const ln = Number(m[2]);
      const ls = (ln > 0 ? '+' : '') + ln;
      return team + ' ' + ls;
    }
  }
  const names = (sides || []).map((s) => s && s.name).filter(Boolean);
  if (names.some((n) => String(n).toLowerCase() === String(pick).toLowerCase())) return pick;
  const blob = String(eventTitle || '').toLowerCase();
  const nick = String(pick).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3).pop() || '';
  if (nick && blob.includes(nick)) return pick;
  return names[0] || pick;
}

function matchesType(type, marketType) {
  if (marketType === 'all') return true;
  if (marketType === 'moneyline' || marketType === 'ml') return type === 'moneyline' || type === 'moneyline_1h';
  if (marketType === 'game_lines') return ['moneyline', 'moneyline_1h', 'spread', 'total', 'f5', 'f5_spread', 'f5_total'].includes(type);
  if (marketType === 'spreads') return type === 'spread' || type.startsWith('spread_');
  if (marketType === 'spread') return type === 'spread'; // FG only
  if (marketType === 'spread_fg') return type === 'spread';
  if (marketType === 'spread_1h') return type === 'spread_1h';
  if (marketType === 'spread_2h') return type === 'spread_2h';
  if (marketType === 'spread_q1') return type === 'spread_q1';
  if (marketType === 'spread_q2') return type === 'spread_q2';
  if (marketType === 'spread_q3') return type === 'spread_q3';
  if (marketType === 'spread_q4') return type === 'spread_q4';
  if (marketType === 'totals' || marketType === 'total') return type === 'total' || type.startsWith('total_');
  if (marketType === 'total_fg') return type === 'total';
  if (marketType === 'total_1h') return type === 'total_1h';
  if (marketType === 'total_2h') return type === 'total_2h';
  if (marketType === 'total_q1') return type === 'total_q1';
  if (marketType === 'total_q2') return type === 'total_q2';
  if (marketType === 'total_q3') return type === 'total_q3';
  if (marketType === 'total_q4') return type === 'total_q4';
  if (marketType === 'team_totals') return type.startsWith('team_total');
  if (marketType === 'team_total_fg') return type === 'team_total_fg';
  if (marketType === 'team_total_1h') return type === 'team_total_1h';
  if (marketType === 'team_total_2h') return type === 'team_total_2h';
  if (marketType === 'map_1') return type === 'map_1';
  if (marketType === 'map_2') return type === 'map_2';
  if (marketType === 'map_3') return type === 'map_3';
  if (marketType === 'map_total') return type === 'map_total';
  if (marketType === 'map_winner') return type === 'map_1' || type === 'map_2' || type === 'map_3' || type === 'map_winner';
  if (marketType === 'f5_spread') return type === 'f5_spread';
  if (marketType === 'f5_total') return type === 'f5_total';
  if (marketType === 'f5') return type === 'f5';
  if (marketType === 'total') return type === 'total';
  if (marketType === 'player_hr') return type === 'player_hr' || type === 'player_prop';
  if (marketType === 'player_k') return type === 'player_k' || type === 'player_prop';
  if (marketType === 'player_hits') return type === 'player_hits' || type === 'player_prop';
  if (marketType === 'player_tb') return type === 'player_tb' || type === 'player_prop';
  if (marketType === 'player_hrr') return type === 'player_hrr' || type === 'player_prop';
  if (marketType === 'pitcher_outs') return type === 'pitcher_outs' || type === 'player_prop';
  if (marketType === 'pitcher_er') return type === 'pitcher_er' || type === 'player_prop';
  if (marketType === 'pitcher_ha') return type === 'pitcher_ha' || type === 'player_prop';
  if (marketType === 'pitcher_bb') return type === 'pitcher_bb' || type === 'player_prop';
  if (marketType === 'inning_winner') return type === 'inning_winner';
  if (marketType === 'player_pass_yds') return type === 'player_pass_yds' || type === 'player_prop';
  if (marketType === 'player_rush_yds') return type === 'player_rush_yds' || type === 'player_prop';
  if (marketType === 'player_rec_yds') return type === 'player_rec_yds' || type === 'player_prop';
  if (marketType === 'player_receptions') return type === 'player_receptions' || type === 'player_prop';
  if (marketType === 'player_atd') return type === 'player_atd' || type === 'player_prop';
  if (marketType === 'moneyline_1h') return type === 'moneyline_1h';
  if (marketType === 'player_pts') return type === 'player_pts' || type === 'player_prop';
  if (marketType === 'player_reb') return type === 'player_reb' || type === 'player_prop';
  if (marketType === 'player_ast') return type === 'player_ast' || type === 'player_prop';
  if (marketType === 'player_pra') {
    return type === 'player_pra' || type === 'player_pts' || type === 'player_reb' || type === 'player_ast' || type === 'player_prop';
  }
  if (marketType === 'player_threes') return type === 'player_threes' || type === 'player_prop';
  if (marketType === 'player_props') return String(type).startsWith('player_') || String(type).startsWith('pitcher_') || type === 'player_prop' || type === 'prop';
  if (marketType === 'team_props') return type === 'team_prop';
  if (marketType === 'game_props') return type === 'game_prop';
  if (marketType === 'innings') return type === 'innings' || type === 'inning_winner' || type === 'inning_scorer' || /^inning_[1-9]$/.test(type) || type === 'nrfi' || type === 'yrfi';
  if (/^inning_[1-9]$/.test(marketType)) return type === marketType;
  if (marketType === 'inning_scorer') return type === 'inning_scorer';
  if (marketType === 'inning_winner') return type === 'inning_winner' || /^inning_[1-9]$/.test(type);

  if (marketType === 'prop') return true;
  if (marketType === 'nrfi') return type === 'nrfi' || type === 'yrfi';
  return type === marketType;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const mode = (req.query.mode || 'all').toLowerCase();
    const league = (req.query.league || '').toLowerCase();
    const marketType = (req.query.marketType || 'all').toLowerCase();
    const minEdge = parseFloat(req.query.minEdge || '0');
    const minLiq = parseFloat(req.query.minLiq || '0');
    const rankFilter = (req.query.rank || '').toLowerCase();
    const minScore = parseFloat(req.query.minScore || '0');
    const pandascoreToken = String(req.query.pandascore || req.query.pandascoreToken || process.env.PANDASCORE_TOKEN || '').trim();
    const rankOpts = {
      strictTruth: req.query.strictTruth !== '0',
      allowMarketGood: req.query.allowMarketGood === '1',
      allowThinFormGood: req.query.allowThinFormGood !== '0',
      allowThinFormElite: req.query.allowThinFormElite === '1',
      minGoodEv: req.query.minGoodEv != null ? parseFloat(req.query.minGoodEv) : undefined,
      minEliteEv: req.query.minEliteEv != null ? parseFloat(req.query.minEliteEv) : undefined,
      minGoodEdge: req.query.minGoodEdge != null ? parseFloat(req.query.minGoodEdge) : undefined,
      minEliteEdge: req.query.minEliteEdge != null ? parseFloat(req.query.minEliteEdge) : undefined,
      minGoodScore: req.query.minGoodScore != null ? parseFloat(req.query.minGoodScore) : undefined,
      minEliteScore: req.query.minEliteScore != null ? parseFloat(req.query.minEliteScore) : undefined,
    };

    let events;
    if (league === 'esports') {
      const es = await Promise.all(['lol', 'cs2', 'dota2', 'valorant', 'cod'].map((l) => fetchLeagueEvents(l, { limit: 10, expandMarkets: true, maxEventsExpand: 6, maxMarkets: 300 })));
      events = es.flat();
    } else if (league === 'soccer' || league === 'football' || (typeof isSoccerLeague === 'function' && isSoccerLeague(league))) {
      // One Soccer category: pull every soccer league (EPL, MLS, La Liga, Bundesliga, Serie A, UCL, …)
      events = await fetchSoccerEvents({ limitPerLeague: marketType === 'all' ? 18 : 24 });
    } else if (league && league !== 'all' && LEAGUES.includes(league)) {
      events = await fetchLeagueEvents(league, {
          limit: marketType === 'all' ? 18 : 28,
          expandMarkets: true,
          maxEventsExpand: marketType === 'player_props' || String(marketType).indexOf('player_') === 0 ? 12 : (marketType === 'all' ? 8 : 10),
          maxMarkets: marketType === 'player_props' || String(marketType).indexOf('player_') === 0 ? 400 : 280,
        });
    } else {
      // all sports + all markets
      events = await fetchAllSportsEvents({
        limitPerLeague: marketType === 'all' ? 8 : 10,
        // expand inside fetchLeagueEvents per league — pass via patched fetchAll
      });
    }
    if (mode === 'live') events = events.filter((e) => e.live && !e.ended);
    else if (mode === 'upcoming') events = events.filter((e) => !e.live && !e.ended);
    else {
      // all / both — still drop completed (no value as open bets)
      events = events.filter((e) => !e.ended);
    }
    // safety filter
    if (league === 'soccer' || league === 'football' || (typeof isSoccerLeague === 'function' && isSoccerLeague(league))) {
      events = events.filter((e) => isSoccerLeague(e.league));
    } else if (league === 'esports') {
      events = events.filter((e) => ['lol', 'cs2', 'dota2', 'valorant', 'cod'].includes(String(e.league).toLowerCase()));
    } else if (league && league !== 'all') {
      events = events.filter((e) => String(e.league).toLowerCase() === String(league).toLowerCase());
    }

    events.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return new Date(a.startTime || 0) - new Date(b.startTime || 0);
    });

    
    // Warm order books for Smart$ (limit to avoid rate limits)
    try {
      const warmList = [];
      for (const ev of events) {
        for (const m of ev.markets || []) {
          if (m.yesPrice == null) continue;
          const slug = m.slug || m.marketSlug || (m.url && String(m.url).split('/').pop());
          if (!slug) continue;
          warmList.push({ id: String(m.id || m.question || ev.id), slug: String(slug) });
          if (warmList.length >= 8) break;
        }
        if (warmList.length >= 8) break;
      }
      await Promise.all(
        warmList.map(async (w) => {
          const b = await fetchBookForSlug(w.slug);
          if (b) setBook(w.id, { ...b, slug: w.slug });
        })
      );
    } catch (e) {}


    // ESPN matchups for unique events (limit to keep Vercel time safe)
    const matchupCache = {};
    try {
      const seen = new Set();
      const jobs = [];
      // Prioritize esports events for form fetch
      const evSorted = events.slice().sort((a, b) => {
        const ae = typeof isEsportsLeague === 'function' && isEsportsLeague(a.league) ? 0 : 1;
        const be = typeof isEsportsLeague === 'function' && isEsportsLeague(b.league) ? 0 : 1;
        return ae - be;
      });
      for (const ev of evSorted) {
        const title = ev.title || ev.name || '';
        const lg = (ev.league || league || 'mlb').toLowerCase();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        const _esJobs = league === 'esports' || ['lol','cs2','dota2','valorant','cod'].includes(String(league||''))
          || (typeof isEsportsLeague === 'function' && isEsportsLeague(lg));
        if (jobs.length >= (_esJobs ? 10 : (league && league !== "all" ? 12 : 8))) break;
        jobs.push(
          (async () => {
            let m = null;
            if (typeof isEsportsLeague === 'function' && isEsportsLeague(lg)) {
              try { m = await matchupForEsports(lg, title, { pandascoreToken: pandascoreToken }); } catch (e) { m = null; }
            } else {
              try { m = await matchupForEvent(lg, title); } catch (e) { m = null; }
            }
            return m;
          })()
            .then(async (m) => {
              if (!m || m.error) return;
              m.league = lg;
              // Reject matchups that don't belong to this event title
              const blob = String(title).toLowerCase();
              const isEs = typeof isEsportsLeague === 'function' && isEsportsLeague(lg);
              function okName(name) {
                if (!name) return false;
                // Esports: short tags (G2, T1) + aliases (Navi ↔ Natus Vincere)
                if (isEs && typeof esportsNameInTitle === 'function' && esportsNameInTitle(name, title)) return true;
                if (isEs) {
                  const parts = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
                  const stop = new Set(['the', 'and', 'team', 'esports', 'gaming', 'club', 'org']);
                  for (const w of parts) {
                    if (stop.has(w)) continue;
                    if (blob.includes(w)) return true;
                  }
                  return false;
                }
                const parts = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
                const stop = new Set(['university', 'state', 'college', 'the', 'and', 'tech']);
                for (const w of parts) {
                  if (w.length < 4 && w !== 'tech') continue;
                  if (stop.has(w) && w !== 'tech') continue;
                  if (blob.includes(w)) return true;
                }
                for (let i = 0; i < parts.length - 1; i++) {
                  const pair = parts[i] + ' ' + parts[i + 1];
                  if (pair.length >= 6 && blob.includes(pair)) return true;
                }
                return false;
              }
              if (m.homeName && m.awayName && !(okName(m.homeName) && okName(m.awayName))) {
                if (isEs) {
                  // Keep a stub so the card can show WHY form was dropped
                  matchupCache[title] = {
                    league: lg,
                    homeName: m.homeName,
                    awayName: m.awayName,
                    hasForm: false,
                    formSource: m.formSource || 'pandascore',
                    note: 'Title/name mismatch after PandaScore lookup',
                    formNote: 'Name mismatch: ' + String(m.homeName).slice(0, 24) + ' / ' + String(m.awayName).slice(0, 24),
                  };
                }
                return;
              }
              if (isEs && m) {
                m.formSource = m.formSource || 'pandascore';
                var l10n = (m.homeL10 && m.homeL10.n ? ('L10 ' + (m.homeL10.w || 0) + '-' + (m.homeL10.l || 0)) : '') +
                  (m.awayL10 && m.awayL10.n ? (' / ' + (m.awayL10.w || 0) + '-' + (m.awayL10.l || 0)) : '');
                // Keep failure notes (team not found / no token); only fill L10 when we have data
                if (l10n && String(l10n).trim()) m.formNote = l10n;
                else if (!m.formNote && m.note) m.formNote = m.note;
                else if (!m.formNote && !m.hasForm) m.formNote = 'No series history from PandaScore';
              }
              if (lg === 'mlb') {
                try { m = await enrichMlbMatchup(m); } catch (e) {}
              }
              matchupCache[title] = m;
            })
            .catch(() => {})
        );
      }
      // Batch matchup fetches (esports external APIs are slow — avoid 20s client timeout)
      for (let bi = 0; bi < jobs.length; bi += 3) {
        await Promise.all(jobs.slice(bi, bi + 3));
      }
    } catch (e) {}

const flattenTypes = ['map_1','map_2','map_3','map_total','map_winner','inning_1','inning_2','inning_3','inning_4','inning_5','inning_6','inning_7','inning_8','inning_9','inning_winner','inning_scorer','nrfi','yrfi','f5','f5_spread','f5_total','total','totals','spread','spreads','spread_fg','spread_1h','spread_2h','spread_q1','spread_q2','spread_q3','spread_q4','total_fg','total_1h','total_2h','total_q1','total_q2','total_q3','total_q4','total_p2','total_p3','team_totals','team_total_fg','team_total_1h','team_total_2h','prop','f5','nrfi','yrfi','f5_spread','f5_total','player_props','team_props','game_props','innings','player_hr','player_k','player_hits','player_tb','player_hrr','pitcher_outs','pitcher_er','pitcher_ha','pitcher_bb','inning_winner','player_pts','player_reb','player_ast','player_pra','player_threes','player_pass_yds','player_rush_yds','player_rec_yds','player_receptions','player_atd','player_prop'];

    function shouldFlattenMarkets(mt) {
      const s = String(mt || '');
      if (s === 'all' || flattenTypes.includes(s)) return true;
      if (s.indexOf('player_') === 0 || s.indexOf('pitcher_') === 0) return true;
      return false;
    }

    // Flat market cards (each Polymarket market = one card)
    // marketType=all → expand ML, spreads, totals, F5, NRFI, 1H, props, etc.
    if (shouldFlattenMarkets(marketType)) {
      const flat = [];
      // Refresh live Yes/No from BBO for totals (list prices often stale → wrong 50¢ vs 96¢)
      try {
        // Skip large BBO warm on elite-only (speed) — still refresh a small sample for totals
        const needBbo = [];
        const bboCap = String(rankFilter || '').toLowerCase() === 'elite' ? 12 : 28;
        for (const ev of events) {
          for (const m of ev.markets || []) {
            if (needBbo.length >= bboCap) break;
            const t = classifyMarket(m);
            if (/total|nrfi|yrfi|spread/.test(String(t)) && (m.slug || m.marketSlug)) needBbo.push(m);
          }
          if (needBbo.length >= bboCap) break;
        }
        await refreshBboBatch(needBbo, bboCap);
      } catch (eBbo) {}
      // Player props: attach ESPN L5/season projection before scoring
      try {
        const propMarkets = [];
        for (const ev of events) {
          for (const m of ev.markets || []) {
            const t = classifyMarket(m);
            if (t === 'player_prop' || t === 'prop' || String(t).indexOf('player_') === 0 || String(t).indexOf('pitcher_') === 0) {
              m.marketType = t;
              m.title = m.question || m.title;
              m.league = ev.league || league;
              m.eventTitle = ev.title;
              propMarkets.push(m);
            }
          }
        }
        if (propMarkets.length) {
          // Prefer enriching markets for the selected filter first
          const mtQ = String(marketType || '');
          propMarkets.sort((a, b) => {
            const ta = String(a.marketType || '');
            const tb = String(b.marketType || '');
            const sa = (mtQ.indexOf('player') === 0 || mtQ === 'player_props') && (ta.indexOf('player') === 0 || matchesType(ta, mtQ)) ? 0 : 1;
            const sb = (mtQ.indexOf('player') === 0 || mtQ === 'player_props') && (tb.indexOf('player') === 0 || matchesType(tb, mtQ)) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            return Math.abs((Number(a.yesPrice)||0.5)-0.5) - Math.abs((Number(b.yesPrice)||0.5)-0.5);
          });
          await enrichPlayerProps(propMarkets, league || (events[0] && events[0].league));
        }
      } catch (eProp) {}
      // Prefer a stable order of market families so board is scannable
      const typePriority = {
        moneyline: 1, moneyline_1h: 2,
        spread: 3, spread_1h: 4, spread_2h: 5, spread_q1: 6, f5_spread: 7,
        total: 10, total_1h: 11, total_2h: 12, f5_total: 13,
        f5: 20, nrfi: 21, yrfi: 22,
        team_total_fg: 25, team_total_1h: 26,
        map_1: 30, map_2: 31, map_total: 32,
      };
      for (const ev of events) {
        for (const m of ev.markets || []) {
          const type = classifyMarket(m);
          if (marketType !== 'all' && !matchesType(type, marketType)) continue;
          // Skip pure noise props when All — still include core game lines + common props
          if (marketType === 'all') {
            const core = /^(moneyline|moneyline_1h|spread|spread_|total|total_|f5|f5_|nrfi|yrfi|team_total|map_|inning_|player_|pitcher_)/.test(type)
              || type === 'spread' || type === 'total' || type === 'f5' || type === 'f5_total' || type === 'f5_spread'
              || type === 'player_hr' || type === 'player_k' || type === 'player_hits'
              || type === 'player_pass_yds' || type === 'player_rush_yds' || type === 'player_rec_yds'
              || type === 'player_atd' || type === 'player_prop' || type === 'player_pts'
              || type === 'player_reb' || type === 'player_ast' || type === 'player_receptions'
              || type === 'player_tb' || type === 'player_hrr' || type === 'player_threes' || type === 'player_pra';
            if (!core && !matchesType(type, 'game_lines') && !matchesType(type, 'player_props')) {
              if (type === 'unknown') continue;
              // generic "prop" only if question looks like a player line
              if (type === 'prop') {
                const q = String(m.question || '');
                if (!/player|yards|points|rebounds|assists|strikeouts|receptions|passing|rushing|over|under/i.test(q)) continue;
              }
            }
          }
          if (m.yesPrice == null) continue;
          const mu = matchupCache[ev.title || ev.name || ''] || null;
          const sd = sidesFromMarket(m, ev.title, type, mu);
          const sides = sd.sides || sd;
          let sc = scoreOne(m, ev, mu, rankOpts, sd.yesIsHome);
          // PM props: if ESPN enrich attached projection but score stayed prop-market, re-score with explicit fields
          if (
            m.playerProp &&
            m.playerProp.projection != null &&
            sc &&
            (!sc.hasForm || /prop-market/i.test(String(sc.fairSource || '')))
          ) {
            try {
              const { buildSignal } = require('../lib/score');
              sc = buildSignal(
                {
                  id: String(m.id || m.question || ev.id),
                  question: m.question || ev.title,
                  title: m.question || m.title,
                  yesPrice: m.yesPrice,
                  noPrice: m.noPrice,
                  volume: m.volume || 0,
                  liquidity: m.liquidity || 0,
                  matchup: null,
                  marketType: type,
                  line: m.line != null ? Number(m.line) : (m.playerProp.line != null ? Number(m.playerProp.line) : null),
                  league: ev.league || league,
                  live: !!ev.live,
                  eventTitle: cleanEventTitle(ev.title),
                  playerProp: m.playerProp,
                  propProjection: m.playerProp.projection,
                  propPlayer: m.playerProp.playerName || m.propPlayer,
                  sides: sides,
                },
                rankOpts || {}
              );
            } catch (eRe) {}
          }
          // Prefer team name matching form: if side YES/NO, map via yesIsHome + form
          let pickSide = sc && sc.side === 'NO' ? sides[1] : sides[0];
          if (sc && sc.pickName) {
            const hit = sides.find((s) => s.name && String(s.name).toLowerCase().includes(String(sc.pickName).toLowerCase().slice(0, 5)));
            if (hit) pickSide = hit;
          }
          flat.push({
            id: m.id || ev.id + '-' + type,
            title: m.question || cleanEventTitle(ev.title),
            eventTitle: cleanEventTitle(ev.title),
            league: ev.league,
            _vol: Number(m.volume || 0),
            live: !!ev.live,
            ended: !!ev.ended,
            period: ev.period || '',
            score: ev.score || null,
            startTime: ev.startTime || (mu && mu.espnGameStart) || null,
            marketCount: 1,
            marketType: type,
            // Always prefer EVENT (game) URL for Trade — market slugs like
            // asc-nfl-ari-nyg-2026-10-04-1h-neg-3pt5 are not event pages
            eventSlug: ev.slug || null,
            marketSlug: m.slug || m.marketSlug || null,
            marketUrl: (m.slug || m.marketSlug)
              ? ('https://polymarket.us/market/' + (m.slug || m.marketSlug))
              : (m.marketUrl || null),
            eventSlug: ev.slug || null,
            url: (function () {
              // Trade primary target = GAME event page (reliable for the matchup on the card)
              if (ev.slug) return 'https://polymarket.us/event/' + ev.slug;
              if (ev.url && /\/event\//i.test(String(ev.url))) return ev.url;
              const ms = m.slug || m.marketSlug || '';
              const dm = String(ms).match(/^(.*?\d{4}-\d{2}-\d{2})/);
              if (dm) {
                // market slug prefix through date → event slug family (cfb-x-y-date)
                // PM event slugs are like cfb-kenest-msrst-2026-10-14 (no tsc-/asc- prefix)
                var core = dm[1].replace(/^(tsc|asc|tsc-cfb|asc-cfb)-/i, '').replace(/^(tsc|asc)-/i, '');
                // if still has sport prefix noise, try strip leading product code
                core = core.replace(/^(tsc|asc)-/i, '');
                if (/^(nba|nhl|nfl|cfb|cbb|mlb|wnba)-/i.test(dm[1])) return 'https://polymarket.us/event/' + dm[1].replace(/^(tsc|asc)-[a-z]+-/i, function(){ return ''; });
                // Better: from ms like tsc-cfb-kenest-msrst-2026-10-14-total-43pt5 → cfb-kenest-msrst-2026-10-14
                var em = String(ms).match(/((?:nba|nhl|nfl|cfb|cbb|mlb|wnba|ufc)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2})/i);
                if (em) return 'https://polymarket.us/event/' + em[1];
                return 'https://polymarket.us/event/' + dm[1];
              }
              if (ms) return 'https://polymarket.us/market/' + ms;
              return 'https://polymarket.us';
            })(),
            // Exact line (optional deep link)
            marketUrl: (m.slug || m.marketSlug)
              ? ('https://polymarket.us/market/' + (m.slug || m.marketSlug))
              : (m.marketUrl || null),
            slug: ev.slug || m.slug || m.marketSlug || null,
            sides,
            modelPick: (function () {
              if (sc && sc.pickName && !/^YES|NO/i.test(String(sc.pickName))) return sc.pickName;
              // Attach spread line to side name if missing
              const nm = pickSide && pickSide.name;
              if (nm && (type === 'spread' || String(type).startsWith('spread_') || type === 'f5_spread')) {
                const q = String(m.question || m.slug || '');
                let line = null;
                let lm = q.match(/wins by over\s*([0-9]+\.?[0-9]*)/i);
                if (lm) line = Number(lm[1]);
                if (line == null) {
                  lm = q.match(/([+-]\d+\.?\d*)/);
                  if (lm) line = Number(lm[1]);
                }
                if (line == null) {
                  lm = String(m.slug || '').match(/neg[-_]?(\d+)(?:pt(\d+))?/i);
                  if (lm) line = -Number(lm[1] + '.' + (lm[2] || '0'));
                }
                if (line != null && !/[+-]\d/.test(String(nm))) {
                  const last = String(nm).split(/\s+/).pop();
                  // side covering as favorite vs dog: if question is "wins by over X" YES is favorite -line
                  const isYesPick = pickSide === sides[0] || (sc && sc.side === 'YES');
                  let disp = line;
                  if (/wins by over/i.test(q) && isYesPick) disp = -Math.abs(line);
                  else if (/wins by over/i.test(q) && !isYesPick) disp = Math.abs(line);
                  const ls = (disp > 0 ? '+' : '') + disp;
                  return last + ' ' + ls;
                }
              }
              if (nm) return nm;
              if (sc && sc.pickName) return sc.pickName;
              if (sc && sc.side) return sc.side;
              return null;
            })(),
            spreadLine: (sc && sc.spreadLine != null) ? sc.spreadLine : ((type === 'spread' || String(type).startsWith('spread_') || type === 'f5_spread') && m.line != null ? Number(m.line) : null),
            totalLine: (sc && sc.totalLine != null) ? sc.totalLine : ((type === 'total' || type === 'f5_total' || String(type).startsWith('total_')) && m.line != null ? Number(m.line) : null),
            line: m.line != null ? Number(m.line) : null,
            side: sc && sc.side ? sc.side : 'YES',
            rank: sc ? sc.rank : 'Pass',
            playerProp: m.playerProp || null,
            propProjection: m.propProjection != null ? m.propProjection : (m.playerProp && m.playerProp.projection != null ? m.playerProp.projection : null),
            propDetail: m.propDetail || (m.playerProp && m.playerProp.detail) || null,
            propPlayer: m.propPlayer || (m.playerProp && m.playerProp.playerName) || null,
            propRole: m.propRole || (m.playerProp && m.playerProp.role) || null,
            propSource: m.propSource || (m.playerProp && m.playerProp.source) || null,
            netEdge: sc ? sc.netEdge : 0,
            probability_edge: sc ? sc.probability_edge : null,
            decimal_odds: sc ? sc.decimal_odds : null,
            market_probability: (function () {
              const px = pickSidePrice01(sc, m);
              if (px != null) return Math.round(px * 1000) / 10; // 0–100 for UI
              return sc ? sc.market_probability : null;
            })(),
            no_vig_probability: sc ? sc.no_vig_probability : null,
            model_probability: sc ? sc.model_probability : null,
            fairSource: sc ? sc.fairSource : null,
            hasForm: sc ? sc.hasForm : null,
            formNote: (function () {
              if (mu && (mu.formNote || mu.note)) return mu.formNote || mu.note;
              if (sc && sc.formNote) return sc.formNote;
              const lg0 = String(ev.league || league || '').toLowerCase();
              const isEs0 = typeof isEsportsLeague === 'function' && isEsportsLeague(lg0);
              if (isEs0 && !(sc && sc.hasForm)) {
                if (!pandascoreToken) return 'No PandaScore token on this scan — Save key in Settings';
                if (!mu) {
                  var lgHint = String((ev && ev.league) || league || '').toLowerCase();
                  if (/dota/.test(lgHint)) return 'No matchup fetched — rescan Dota2 (PandaScore/OpenDota)';
                  if (/lol|league/.test(lgHint)) return 'No matchup fetched — rescan LoL';
                  if (/valorant/.test(lgHint)) return 'No matchup fetched — rescan Valorant';
                  if (/cs2|csgo|esport/.test(lgHint)) return 'No matchup fetched — rescan CS2';
                  return 'No matchup fetched (limit or parse)';
                }
                return 'No form from PandaScore';
              }
              return null;
            })(),
            formNudgePp: sc ? sc.formNudgePp : null,
            formWinProb: sc ? sc.formWinProb : null,
            formAwayWinProb: sc ? sc.formAwayWinProb : null,
            breakdown: sc ? sc.breakdown : null,
            fairLayers: sc ? sc.fairLayers : null,
            powerNudgePp: sc ? sc.powerNudgePp : null,
            spNudgePp: sc ? sc.spNudgePp : null,
            ev: sc ? sc.ev : null,
            betScore: sc ? sc.betScore : 0,
            confidence: sc ? sc.confidence : 0,
            fairProbability: sc ? sc.fairProbability : null,
            marketPriceCents: (function () {
              const px = pickSidePrice01(sc, m);
              return px != null ? Math.round(px * 1000) / 10 : (sc ? sc.marketPriceCents : null);
            })(),
            impliedPct: (function () {
              const px = pickSidePrice01(sc, m);
              return px != null ? Math.round(px * 1000) / 10 : (sc && sc.marketPriceCents != null ? sc.marketPriceCents : Math.round(Number(m.yesPrice) * 1000) / 10);
            })(),
            modelFairPct: sc ? sc.fairProbability : null,
            priceDisplay: formatCents(pickSidePrice01(sc, m) != null ? pickSidePrice01(sc, m) : m.yesPrice),
            sides: (sd && sd.sides) ? sd.sides : null,
            yesPrice: m.yesPrice,
            noPrice: m.noPrice != null ? m.noPrice : (m.yesPrice != null ? 1 - Number(m.yesPrice) : null),
            evaluate: sc ? sc.evaluate : null,
            lmBadge: sc ? sc.lmBadge : null,
            matchupDetail: sc && sc.evaluate && sc.evaluate.matchup ? sc.evaluate.matchup.detail : null,
            matchupScore: sc && sc.evaluate && sc.evaluate.matchup ? sc.evaluate.matchup.score : null,
            liquidity: m.liquidity || 0,
            props: [],
            bestProp: null,
            scanType: marketType,
            isFlatMarket: true,
          });
          flat[flat.length - 1].liveAnalysis = buildLiveAnalysis(flat[flat.length - 1]);
        }
      }
      // Keep top lines per game + type (PM lists many alternate numbers)
      // Elite scans need more room so the actual Elite line is not dropped
      const capped = [];
      const seen = new Map();
      const eliteMode = String(rankFilter || '').toLowerCase() === 'elite';
      const maxPerType = eliteMode ? 6 : (marketType === 'all' ? 3 : 4);
      flat.sort((a, b) => {
        // Prefer higher score first so Elites survive the per-type cap
        const sc = (b.betScore || 0) - (a.betScore || 0);
        if (sc) return sc;
        const pa = typePriority[String(a.marketType)] || 50;
        const pb = typePriority[String(b.marketType)] || 50;
        if (pa !== pb) return pa - pb;
        return (b._vol || 0) - (a._vol || 0);
      });
      for (const row of flat) {
        const key = String(row.eventTitle || '') + '|' + String(row.marketType || '');
        const n = seen.get(key) || 0;
        if (n >= maxPerType) continue;
        seen.set(key, n + 1);
        capped.push(row);
      }
      // Prefer live, then score (elite first), then type family
      capped.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        const ra = String(a.rank || '').toLowerCase() === 'elite' ? 0 : 1;
        const rb = String(b.rank || '').toLowerCase() === 'elite' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const sc = (b.betScore || 0) - (a.betScore || 0);
        if (sc) return sc;
        const pa = typePriority[String(a.marketType)] || 50;
        const pb = typePriority[String(b.marketType)] || 50;
        if (pa !== pb) return pa - pb;
        return 0;
      });
      // Soft cap — higher when filtering elite so we don't truncate before rank filter
      const softCap = eliteMode ? 320 : (marketType === 'all' ? 200 : 180);
      if (capped.length > softCap) {
        capped.length = softCap;
      }
      if (typeof attachEspnLiveBatch === 'function' && capped.length <= 60) {
        try { await attachEspnLiveBatch(capped); } catch (eLive) {}
      }
      capped.forEach((g) => { try { g.liveAnalysis = buildLiveAnalysis(g); } catch (eA) {} });
      let out = capped;
      if (minEdge > 0) out = out.filter((g) => Math.abs(g.netEdge || 0) >= minEdge);
      if (minScore > 0) out = out.filter((g) => (g.betScore || 0) >= minScore);
      if (minLiq > 0) out = out.filter((g) => (g.liquidity || 0) >= minLiq);
      if (rankFilter === 'elite') {
        out = out.filter((g) => {
          const r = String(g.rank || '');
          return r === 'Elite' || r === 'POTD' || r === 'Super Elite';
        });
      } else if (rankFilter === 'pass') {
        out = out.filter((g) => g.rank === 'Pass');
      } else if (rankFilter === 'all') {
        /* keep Pass + Good + Elite */
      } else if (rankFilter === 'good' || !rankFilter) {
        // Default board: Good / Elite / POTD only
        const before = out.slice();
        out = out.filter((g) => {
          const r = String(g.rank || '');
          return r === 'Good' || r === 'Elite' || r === 'POTD' || r === 'Super Elite';
        });
        // Props: if nothing clears Good+, show Pass so board is not empty
        if (!out.length && before.length && (String(marketType || '').indexOf('player_') === 0 || marketType === 'player_props' || marketType === 'prop')) {
          out = before;
        }
      }

      return res.status(200).json({
        ok: true,
        source: 'gateway.polymarket.us',
        leagues: LEAGUES,
        marketType,
        flat: true,
        updatedAt: new Date().toISOString(),
        summary: {
          total: out.length,
          live: out.filter((g) => g.live).length,
          upcoming: out.filter((g) => !g.live && !g.ended).length,
          elite: out.filter((g) => g.rank === 'Elite').length,
          good: out.filter((g) => g.rank === 'Good').length,
        },
        games: out,
      });
    }

    // Game-level cards (moneyline / all)
    let games = events.map((ev) => {
      const markets = ev.markets || [];
      const typed = markets.map((m) => ({ m, type: classifyMarket(m) }));
      let focus = typed;
      if (marketType === 'moneyline') focus = typed.filter((x) => x.type === 'moneyline');

      const primary = (focus.find((x) => x.type === 'moneyline') || focus[0] || typed[0] || {}).m || null;
      const primaryType = primary ? classifyMarket(primary) : 'moneyline';
      const mu = matchupCache[ev.title || ev.name || ''] || null;
      const sd = primary ? sidesFromMarket(primary, ev.title, primaryType, mu) : { sides: [], yesIsHome: null };
      const sides = sd.sides || [];
      const mlScore = primary ? scoreOne(primary, ev, mu, rankOpts, sd.yesIsHome) : null;
      let modelPick = null;
      if (mlScore) {
        if (mlScore.pickName) modelPick = mlScore.pickName;
        else if (sides.length >= 2) {
          if (sd.yesIsHome === false) {
            modelPick = mlScore.side === 'YES' ? sides[1].name : sides[0].name;
          } else {
            modelPick = mlScore.side === 'NO' ? sides[1].name : sides[0].name;
          }
        }
        modelPick = sanitizePick(modelPick, sides, ev.title);
      }

      const propList = typed
        .filter((x) => x.m !== primary && x.m.yesPrice != null)
        .map(({ m, type }) => {
          const psd = sidesFromMarket(m, ev.title, type, null);
          const ps = psd.sides || [];
          // Props/totals: no team form matchup (prevents Marlins on Mets totals etc.)
          const sc = scoreOne(m, ev, null, rankOpts, null);
          let pick = null;
          if (ps.length >= 2) {
            pick = sc && sc.side === 'NO' ? (ps[1] && ps[1].name) : (ps[0] && ps[0].name);
          } else if (ps[0]) pick = ps[0].name;
          return {
            id: m.id,
            slug: m.slug || null,
            question: m.question,
            type,
            rank: 'Pass',
            netEdge: 0,
            modelPick: pick,
            priceDisplay: formatCents(m.yesPrice),
            url: m.url,
          };
        })
        .sort((a, b) => (b.betScore || 0) - (a.betScore || 0));

      const bestProp = propList.find((p) => p.rank === 'Elite' || p.rank === 'Good') || propList[0] || null;

      return {
        id: ev.id,
        title: cleanEventTitle(ev.title),
        eventSlug: ev.slug || null,
        marketSlug: primary && (primary.slug || primary.marketSlug) || null,
        marketSlugs: markets.map((m) => m.slug).filter(Boolean),
        league: ev.league,
        live: !!ev.live,
        ended: !!ev.ended,
        period: ev.period || '',
        score: ev.score || null,
        startTime: ev.startTime || (mu && mu.espnGameStart) || null,
        marketCount: markets.length,
        url: ev.url,
        sides,
        modelPick,
        rank: mlScore ? mlScore.rank : 'Pass',
        netEdge: mlScore ? mlScore.netEdge : 0,
        probability_edge: mlScore ? mlScore.probability_edge : null,
        decimal_odds: mlScore ? mlScore.decimal_odds : null,
        market_probability: mlScore ? mlScore.market_probability : null,
        no_vig_probability: mlScore ? mlScore.no_vig_probability : null,
        model_probability: mlScore ? mlScore.model_probability : null,
        fairSource: mlScore ? mlScore.fairSource : null,
        hasForm: mlScore ? mlScore.hasForm : null,
        formNote: (mu && (mu.formNote || mu.note)) || (mlScore && mlScore.formNote) || null,
        formNudgePp: mlScore ? mlScore.formNudgePp : null,
        formWinProb: mlScore ? mlScore.formWinProb : null,
        formAwayWinProb: mlScore ? mlScore.formAwayWinProb : null,
        breakdown: mlScore ? mlScore.breakdown : null,
        fairLayers: mlScore ? mlScore.fairLayers : null,
        powerNudgePp: mlScore ? mlScore.powerNudgePp : null,
        spNudgePp: mlScore ? mlScore.spNudgePp : null,
        ev: mlScore ? mlScore.ev : null,
        betScore: mlScore ? mlScore.betScore : 0,
        confidence: mlScore ? mlScore.confidence : 0,
        fairProbability: mlScore ? mlScore.fairProbability : null,
        marketPriceCents: mlScore ? mlScore.marketPriceCents : null,
        impliedPct: mlScore ? mlScore.marketPriceCents : null,
        modelFairPct: mlScore ? mlScore.fairProbability : null,
        priceDisplay: primary ? formatCents(primary.yesPrice) : null,
        evaluate: mlScore ? mlScore.evaluate : null,
        lmBadge: mlScore ? mlScore.lmBadge : null,
        matchupDetail: mlScore && mlScore.evaluate && mlScore.evaluate.matchup ? mlScore.evaluate.matchup.detail : null,
        matchupScore: mlScore && mlScore.evaluate && mlScore.evaluate.matchup ? mlScore.evaluate.matchup.score : null,
        liquidity: primary ? primary.liquidity || 0 : 0,
        bestProp,
        props: [],
        propsAll: [],
        scanType: marketType,
        isFlatMarket: false,
      };
    });

    if (typeof attachEspnLiveBatch === 'function' && games.length <= 60) {
      try { await attachEspnLiveBatch(games); } catch (eLive) {}
    }
    games.forEach((g) => {
      try { g.liveAnalysis = buildLiveAnalysis(g); } catch (eLa) {}
    });
    function looksEnded(x) {
      if (!x) return false;
      if (x.ended || x.isFinal || x.staleLiveCleared) return true;
      if (x.espnLive && x.espnLive.ended) return true;
      if (x.espnLive && x.espnLive.remainingFrac === 0) return true;
      const per = String(x.period || x.score || x.status || '').toLowerCase();
      if (/\bfinal\b|\bft\b|ended|complete|game over/.test(per)) return true;
      // Stale: listed start many hours ago still flagged live without ESPN in-play confirm
      const startMs = x.startTime ? new Date(x.startTime).getTime() : NaN;
      if (Number.isFinite(startMs) && x.live) {
        const ageH = (Date.now() - startMs) / 3600000;
        const lg = String(x.league || '').toLowerCase();
        const maxH = lg === 'mlb' ? 5.5 : lg === 'nfl' || lg === 'cfb' ? 5 : 4.5;
        const espnLive = x.espnLive && x.espnLive.live && !x.espnLive.ended;
        if (ageH > maxH && !espnLive) return true;
        if (ageH > maxH + 1.5) return true;
      }
      let m = x.market_probability;
      if (m != null) {
        if (m > 1) m = m / 100;
        if (m >= 0.98 || m <= 0.02) return true;
      }
      return false;
    }
    games = games.filter((x) => !looksEnded(x));
    let filtered = games;
    if (minEdge > 0) {
      filtered = filtered.filter(
        (g) => Math.abs(g.netEdge || 0) >= minEdge || (g.props || []).some((p) => Math.abs(p.netEdge || 0) >= minEdge)
      );
    }
    if (minLiq > 0) filtered = filtered.filter((g) => (g.liquidity || 0) >= minLiq || g.marketCount > 3);
    if (minScore > 0) filtered = filtered.filter((g) => (g.betScore || 0) >= minScore);
    if (rankFilter === 'elite') {
      filtered = filtered.filter((g) => {
        const r = String(g.rank || '');
        return r === 'Elite' || r === 'POTD' || r === 'Super Elite' ||
          (g.props || []).some((p) => ['Elite','POTD','Super Elite'].includes(p.rank));
      });
    } else if (rankFilter === 'pass') {
      filtered = filtered.filter((g) => g.rank === 'Pass');
    } else if (rankFilter === 'all') {
      /* keep all ranks */
    } else if (rankFilter === 'good' || !rankFilter) {
      const before = filtered.slice();
      filtered = filtered.filter((g) => {
        const r = String(g.rank || '');
        return r === 'Good' || r === 'Elite' || r === 'POTD' || r === 'Super Elite' ||
          (g.props || []).some((p) => ['Good','Elite','POTD','Super Elite'].includes(p.rank));
      });
      if (!filtered.length && before.length && (String(marketType || '').indexOf('player_') === 0 || marketType === 'player_props' || marketType === 'prop')) {
        filtered = before;
      }
    }

    return res.status(200).json({
      ok: true,
      source: 'gateway.polymarket.us',
      leagues: LEAGUES,
      marketType,
      updatedAt: new Date().toISOString(),
      summary: {
        total: filtered.length,
        live: filtered.filter((g) => g.live).length,
        upcoming: filtered.filter((g) => !g.live && !g.ended).length,
        elite: filtered.filter((g) => g.rank === 'Elite').length,
        good: filtered.filter((g) => g.rank === 'Good').length,
      },
      games: filtered,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
