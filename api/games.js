const { fetchAllSportsEvents, fetchLeagueEvents, LEAGUES } = require('../lib/polymarket');
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

function classifyMarket(m) {
  // Prefer Polymarket US sportsMarketType (authoritative)
  const rawType = String(m.sportsMarketType || m.marketType || m.sportsMarketTypeV2 || '').toLowerCase();
  const q = String(m.question || m.slug || m.title || '').toLowerCase();
  const blob = (rawType + ' ' + q).replace(/_/g, ' ');

  // --- Explicit PM type maps (NFL / CFB football_* and similar) ---
  if (rawType) {
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

    // Game totals by period
    if (/total/.test(rawType)) {
      if (/first_quarter|1st_quarter/.test(rawType)) return 'total_q1';
      if (/second_quarter|2nd_quarter/.test(rawType)) return 'total_q2';
      if (/third_quarter|3rd_quarter/.test(rawType)) return 'total_q3';
      if (/fourth_quarter|4th_quarter/.test(rawType)) return 'total_q4';
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

  const isTotal = /total|over|under|o\/u|combined score|more than \d/.test(blob);
  if (isTotal) {
    if (isQ1) return 'total_q1';
    if (isQ2) return 'total_q2';
    if (isQ3) return 'total_q3';
    if (isQ4) return 'total_q4';
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
    matchup: matchup || null,
    marketType: classifyMarket(m),
    yesIsHome: yesIsHome,
    league: (ev && ev.league) || (matchup && matchup.league) || null,
    live: !!(ev && ev.live),
    eventTitle: (ev && (ev.title || ev.name)) || null,
  }, rankOpts || {});
}

function nameHit(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  const y = String(b).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  if (!x || !y) return false;
  return x === y || x.includes(y.slice(0, 6)) || y.includes(x.slice(0, 6));
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
  const names = (sides || []).map((s) => s && s.name).filter(Boolean);
  if (names.some((n) => String(n).toLowerCase() === String(pick).toLowerCase())) return pick;
  // pick must appear in event title for team MLs
  const blob = String(eventTitle || '').toLowerCase();
  const nick = String(pick).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3).pop() || '';
  if (nick && blob.includes(nick)) return pick;
  // fallback to first side name if pick is foreign team
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
      const es = await Promise.all(['lol', 'cs2', 'dota2', 'valorant', 'cod'].map((l) => fetchLeagueEvents(l, { limit: 18 })));
      events = es.flat();
    } else if (league === 'soccer' || league === 'football') {
      // All soccer leagues on Polymarket US (EPL/MLS/La Liga/etc.)
      events = await fetchSoccerEvents({ limitPerLeague: marketType === 'all' ? 16 : 22 });
    } else if (league && league !== 'all' && (LEAGUES.includes(league) || (SOCCER_LEAGUES && SOCCER_LEAGUES.includes(league)))) {
      events = await fetchLeagueEvents(league, { limit: marketType === 'all' ? 28 : 35 });
      // MLS often empty in off-window — soft-fallback to full soccer slate so UI is not blank
      if ((!events || !events.length) && (league === 'mls' || league === 'ucl' || league === 'uefa' || league === 'fwc')) {
        events = await fetchSoccerEvents({ limitPerLeague: 16 });
      }
    } else {
      // all sports + all markets
      events = await fetchAllSportsEvents({ limitPerLeague: marketType === 'all' ? 12 : 14 });
    }
    if (mode === 'live') events = events.filter((e) => e.live && !e.ended);
    else if (mode === 'upcoming') events = events.filter((e) => !e.live && !e.ended);
    else {
      // all / both — still drop completed (no value as open bets)
      events = events.filter((e) => !e.ended);
    }
    // safety filter
    if (league === 'soccer' || league === 'football') {
      events = events.filter((e) => isSoccerLeague(e.league));
    } else if (league === 'esports') {
      events = events.filter((e) => ['lol', 'cs2', 'dota2', 'valorant', 'cod'].includes(String(e.league).toLowerCase()));
    } else if (league && league !== 'all') {
      // Keep exact league; if we soft-fallback filled soccer family for empty MLS, keep those
      const only = String(league).toLowerCase();
      const hasExact = events.some((e) => String(e.league).toLowerCase() === only);
      if (hasExact) events = events.filter((e) => String(e.league).toLowerCase() === only);
      else if (isSoccerLeague(only)) events = events.filter((e) => isSoccerLeague(e.league));
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
      for (const ev of events) {
        const title = ev.title || ev.name || '';
        const lg = (ev.league || league || 'mlb').toLowerCase();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        if (jobs.length >= (league && league !== "all" ? 12 : 8)) break;
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
              function okName(name) {
                if (!name) return false;
                const parts = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
                const nick = parts[parts.length - 1] || '';
                return nick && blob.includes(nick);
              }
              if (m.homeName && m.awayName && !(okName(m.homeName) && okName(m.awayName))) {
                return; // do not cache wrong game form
              }
              if (lg === 'mlb') {
                try { m = await enrichMlbMatchup(m); } catch (e) {}
              }
              matchupCache[title] = m;
            })
            .catch(() => {})
        );
      }
      await Promise.all(jobs);
    } catch (e) {}

const flattenTypes = ['map_1','map_2','map_3','map_total','map_winner','inning_1','inning_2','inning_3','inning_4','inning_5','inning_6','inning_7','inning_8','inning_9','inning_winner','inning_scorer','nrfi','yrfi','f5','f5_spread','f5_total','total','totals','spread','spreads','spread_fg','spread_1h','spread_2h','spread_q1','spread_q2','spread_q3','spread_q4','total_fg','total_1h','total_2h','total_q1','total_q2','total_q3','total_q4','team_totals','team_total_fg','team_total_1h','team_total_2h','prop','f5','nrfi','yrfi','f5_spread','f5_total','player_props','team_props','game_props','innings','player_hr','player_k','player_hits','player_tb','player_hrr','pitcher_outs','pitcher_er','pitcher_ha','pitcher_bb','inning_winner'];

    // Flat market cards (each Polymarket market = one card)
    // marketType=all → expand ML, spreads, totals, F5, NRFI, 1H, props, etc.
    if (marketType === 'all' || flattenTypes.includes(marketType)) {
      const flat = [];
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
            const core = /^(moneyline|moneyline_1h|spread|spread_|total|total_|f5|f5_|nrfi|yrfi|team_total|map_|inning_)/.test(type)
              || type === 'spread' || type === 'total' || type === 'f5' || type === 'f5_total' || type === 'f5_spread'
              || type === 'player_hr' || type === 'player_k' || type === 'player_hits'
              || type === 'player_pass_yds' || type === 'player_rush_yds' || type === 'player_rec_yds'
              || type === 'player_atd' || type === 'player_prop';
            // Always allow anything matchesType would allow for game_lines + listed cores
            if (!core && !matchesType(type, 'game_lines')) {
              // keep other classified non-unknown
              if (type === 'unknown' || type === 'prop') continue;
            }
          }
          if (m.yesPrice == null) continue;
          const mu = matchupCache[ev.title || ev.name || ''] || null;
          const sd = sidesFromMarket(m, ev.title, type, mu);
          const sides = sd.sides || sd;
          const sc = scoreOne(m, ev, mu, rankOpts, sd.yesIsHome);
          // Prefer team name matching form: if side YES/NO, map via yesIsHome + form
          let pickSide = sc && sc.side === 'NO' ? sides[1] : sides[0];
          if (sc && sc.pickName) {
            const hit = sides.find((s) => s.name && String(s.name).toLowerCase().includes(String(sc.pickName).toLowerCase().slice(0, 5)));
            if (hit) pickSide = hit;
          }
          flat.push({
            id: m.id || ev.id + '-' + type,
            title: m.question || ev.title,
            eventTitle: ev.title,
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
            url: (function () {
              if (ev.slug) return 'https://polymarket.us/event/' + ev.slug;
              if (ev.url && /\/event\//i.test(String(ev.url))) return ev.url;
              // Derive event slug from market slug (strip suffixes after YYYY-MM-DD)
              const ms = m.slug || m.marketSlug || '';
              const dm = String(ms).match(/^(.*?\d{4}-\d{2}-\d{2})/);
              if (dm) return 'https://polymarket.us/event/' + dm[1];
              if (m.url && /\/event\//i.test(String(m.url))) return m.url;
              if (ms) return 'https://polymarket.us/market/' + ms;
              return 'https://polymarket.us';
            })(),
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
            rank: sc ? sc.rank : 'Pass',
            netEdge: sc ? sc.netEdge : 0,
            probability_edge: sc ? sc.probability_edge : null,
            decimal_odds: sc ? sc.decimal_odds : null,
            market_probability: sc ? sc.market_probability : null,
            no_vig_probability: sc ? sc.no_vig_probability : null,
            model_probability: sc ? sc.model_probability : null,
            fairSource: sc ? sc.fairSource : null,
            hasForm: sc ? sc.hasForm : null,
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
            marketPriceCents: sc ? sc.marketPriceCents : null,
            impliedPct: sc ? sc.marketPriceCents : Math.round(m.yesPrice * 1000) / 10,
            modelFairPct: sc ? sc.fairProbability : null,
            priceDisplay: formatCents(m.yesPrice),
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
      const capped = [];
      const seen = new Map();
      const maxPerType = marketType === 'all' ? 2 : 4;
      flat.sort((a, b) => {
        const pa = typePriority[String(a.marketType)] || 50;
        const pb = typePriority[String(b.marketType)] || 50;
        if (pa !== pb) return pa - pb;
        return (b._vol || 0) - (a._vol || 0) || (b.betScore || 0) - (a.betScore || 0);
      });
      for (const row of flat) {
        const key = String(row.eventTitle || '') + '|' + String(row.marketType || '');
        const n = seen.get(key) || 0;
        if (n >= maxPerType) continue;
        seen.set(key, n + 1);
        capped.push(row);
      }
      // Prefer live, then type family order, then score
      capped.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        const pa = typePriority[String(a.marketType)] || 50;
        const pb = typePriority[String(b.marketType)] || 50;
        if (pa !== pb) return pa - pb;
        return (b.betScore || 0) - (a.betScore || 0);
      });
      // Soft cap total cards so Vercel stays healthy (all sports × all markets)
      if (marketType === 'all' && capped.length > 180) {
        capped.length = 180;
      }
      if (typeof attachEspnLiveBatch === 'function' && capped.length <= 60) {
        try { await attachEspnLiveBatch(capped); } catch (eLive) {}
      }
      capped.forEach((g) => { try { g.liveAnalysis = buildLiveAnalysis(g); } catch (eA) {} });
      let out = capped;
      if (minEdge > 0) out = out.filter((g) => Math.abs(g.netEdge || 0) >= minEdge);
      if (minScore > 0) out = out.filter((g) => (g.betScore || 0) >= minScore);
      if (minLiq > 0) out = out.filter((g) => (g.liquidity || 0) >= minLiq);
      if (rankFilter === 'elite') out = out.filter((g) => g.rank === 'Elite');
      if (rankFilter === 'good') out = out.filter((g) => g.rank === 'Good' || g.rank === 'Elite');

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
        games: (function(list){
        if (!rankFilter || rankFilter === 'all') return list;
        if (rankFilter === 'elite') return list.filter((g) => g.rank === 'Elite');
        if (rankFilter === 'good') return list.filter((g) => g.rank === 'Good' || g.rank === 'Elite');
        if (rankFilter === 'pass') return list.filter((g) => g.rank === 'Pass');
        return list;
      })(out),
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
        title: ev.title,
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
      filtered = filtered.filter((g) => g.rank === 'Elite' || (g.props || []).some((p) => p.rank === 'Elite'));
    }
    if (rankFilter === 'good') {
      filtered = filtered.filter(
        (g) => g.rank === 'Good' || g.rank === 'Elite' || (g.props || []).some((p) => p.rank === 'Good' || p.rank === 'Elite')
      );
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
