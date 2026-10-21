/**
 * Kalshi public market data (no API key required for reads)
 * Multi-series per league: ML, spreads, totals, period markets
 */

const BASE = process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com/trade-api/v2';

/** Primary game ML series + extra market series */
const SERIES_BY_LEAGUE = {
  mlb: [
    'KXMLBGAME',
    'KXMLBF5',
    'KXMLBSPREAD',
    'KXMLBTOTAL',
    'KXMLBTEAMTOTAL',
    'KXMLBNRFI',
    'KXMLBYRFI',
    'KXMLBHR',
    'KXMLBSTRIKEOUTS',
    'KXMLBHITS',
  ],
  nfl: [
    'KXNFLGAME',
    'KXNFLTOTAL',
    'KXNFLSPREAD',
    'KXNFL1H',
    'KXNFL1HWINNER',
    'KXNFL1QWINNER',
    'KXNFL2HWINNER',
    'KXNFL2HSPREAD',
    'KXNFL1HSPREAD',
    'KXNFL1QSPREAD',
    'KXNFL1QTOTAL',
    'KXNFL2QTOTAL',
    'KXNFL3QTOTAL',
    'KXNFL4QTOTAL',
    'KXNFL1HTOTAL',
    'KXNFL2HTOTAL',
    'KXNFLTEAMTOTAL',
    'KXNFL1HTEAMTOTAL',
    'KXNFL2HTEAMTOTAL',
    'KXNFLPASSYDS',
    'KXNFLRUSHYDS',
    'KXNFLRECYDS',
    'KXNFLRECEPTIONS',
    'KXNFLANYTIMETD',
    'KXNFLPLAYER',
  ],
  nba: ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBAPTS', 'KXNBAPLAYER'],
  nhl: [
    'KXNHLGAME',
    'KXNHLSPREAD',
    'KXNHLTOTAL',
    'KXNHLPUCKLINE',
    'KXNHL1PWINNER',
    'KXNHL1PTOTAL',
    'KXNHL2PWINNER',
    'KXNHL2PTOTAL',
    'KXNHL3PWINNER',
    'KXNHL3PTOTAL',
    'KXNHLTEAMTOTAL',
  ],
  cfb: [
    'KXNCAAFGAME',
    'KXNCAAFSPREAD',
    'KXNCAAFTOTAL',
    'KXNCAAF1HSPREAD',
    'KXNCAAF2HSPREAD',
    'KXNCAAF1QSPREAD',
    'KXNCAAF1QTOTAL',
    'KXNCAAF2QTOTAL',
    'KXNCAAF3QTOTAL',
    'KXNCAAF4QTOTAL',
    'KXNCAAF1HTOTAL',
    'KXNCAAF2HTOTAL',
    'KXNCAAF1HWINNER',
    'KXNCAAF2HWINNER',
    'KXNCAAF1HFT',
    'KXNCAAFTEAMTOTAL',
    'KXNCAAFPLAYER',
  ],
  cbb: ['KXNCAAMBGAME', 'KXNCAAMBTOTAL', 'KXNCAAMBSPREAD'],
  wnba: ['KXWNBAGAME', 'KXWNBATOTAL', 'KXWNBA1HSPREAD'],
  esports: ['KXCSGOGAME', 'KXLOLGAME', 'KXDOTAGAME', 'KXVALORANTGAME', 'KXCODGAME', 'KXCS2GAME'],
  ufc: ['KXUFCFIGHT', 'KXUFCMMA', 'KXUFC'],
  atp: ['KXATPMATCH', 'KXTENNIS'],
  wta: ['KXWTAMATCH', 'KXTENNIS'],
};

async function fetchJson(path, params = {}) {
  const u = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  });
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Kalshi ' + r.status + ' ' + path);
  return r.json();
}

function midPrice(m) {
  const last = parseFloat(m.last_price_dollars);
  const bid = parseFloat(m.yes_bid_dollars);
  const ask = parseFloat(m.yes_ask_dollars);
  // Prefer bid/ask mid when last is missing or zero (common on thin Kalshi books)
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) {
    const mid = (bid + ask) / 2;
    if (Number.isFinite(last) && last > 0 && Math.abs(last - mid) < 0.15) return last;
    return mid;
  }
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(bid) && bid > 0) return bid;
  if (Number.isFinite(ask) && ask > 0) return ask;
  return null;
}

function parseTeamsFromTitle(title) {
  const t = String(title || '');
  const vs = t.split(/\s+vs\.?\s+/i);
  if (vs.length === 2) return { a: vs[0].trim(), b: vs[1].trim() };
  return { a: t, b: null };
}

function kalshiTradeUrl({ marketTicker, eventTicker, series, title }) {
  const mt = String(marketTicker || '').trim();
  const et = String(eventTicker || '').trim();
  const ser = String(series || '').trim();
  // Prefer market ticker so Trade opens the exact contract (ML / spread / total / prop)
  if (mt) return 'https://kalshi.com/markets/' + encodeURIComponent(mt);
  if (et) return 'https://kalshi.com/markets/' + encodeURIComponent(et);
  if (ser) return 'https://kalshi.com/markets/' + encodeURIComponent(ser);
  if (title) return 'https://kalshi.com/browse?search=' + encodeURIComponent(title);
  return 'https://kalshi.com/browse/sports';
}


/** Parse spread line from Kalshi titles like "Washington wins by over 7.5 points" */
function parseKalshiSpreadLine(m) {
  const t = String((m && (m.title || m.yes_sub_title || m.subtitle)) || '');
  const r = String((m && (m.rules_primary || m.rules_secondary)) || '');
  const blob = t + ' ' + r;
  let mm = blob.match(/wins by over\s+(\d+(?:\.\d+)?)/i);
  if (mm) return Number(mm[1]);
  mm = blob.match(/wins by under\s+(\d+(?:\.\d+)?)/i);
  if (mm) return Number(mm[1]);
  mm = blob.match(/cover\s*([+-]?\d+(?:\.\d+)?)/i);
  if (mm) return Math.abs(Number(mm[1]));
  mm = blob.match(/([+-]\d+(?:\.\d+)?)\s*(?:points?|pts|runs?|goals?)?/i);
  if (mm && /spread|cover|line|wins by/i.test(blob)) return Math.abs(Number(mm[1]));
  return null;
}

function parseKalshiTotalLine(m) {
  const t = String((m && (m.title || m.yes_sub_title || m.subtitle)) || '');
  const r = String((m && (m.rules_primary || m.rules_secondary)) || '');
  const blob = t + ' ' + r;
  let mm = blob.match(/(?:over|under|o\/u|total)\s*(\d+(?:\.\d+)?)/i);
  if (mm) return Number(mm[1]);
  mm = blob.match(/(\d+(?:\.\d+)?)\s*(?:points?|pts|runs?|goals?|maps?)/i);
  if (mm && /total|over|under|o\/u/i.test(blob)) return Number(mm[1]);
  return null;
}

/** YES-side display name for spreads/totals (no invented 1H/-1.5) */
function kalshiOutcomeLabels(m, type) {
  const title = String((m && (m.title || m.yes_sub_title)) || 'Yes');
  const yesRaw = String((m && (m.yes_sub_title || m.title)) || 'Yes').trim();
  const noRaw = String((m && (m.no_sub_title)) || 'No').trim();
  const line = /spread|f5_spread/.test(type)
    ? parseKalshiSpreadLine(m)
    : /total|team_total|f5_total/.test(type)
      ? parseKalshiTotalLine(m)
      : null;

  if (/^spread/.test(type) || type === 'f5_spread') {
    // "Washington wins by over 7.5" → YES = Washington -7.5 (team lays the points)
    const team = yesRaw.replace(/\s*wins by over.*/i, '').replace(/\s*wins$/i, '').trim()
      || title.replace(/\s*wins by over.*/i, '').trim();
    const ln = line != null ? line : null;
    const yesName = ln != null ? (team + ' -' + ln) : (team || yesRaw);
    const noName = ln != null ? ('Not ' + team + ' -' + ln) : (noRaw !== 'No' ? noRaw : 'No');
    return { yesName, noName, line: ln, pickHint: yesName };
  }
  if (/^total/.test(type) || type === 'f5_total' || /^team_total/.test(type)) {
    const ln = line;
    const isOver = /over/i.test(yesRaw) || (/over/i.test(title) && !/under/i.test(yesRaw));
    const isUnder = /under/i.test(yesRaw);
    let yesName = yesRaw;
    let noName = noRaw;
    if (ln != null) {
      if (isOver || (!isUnder && /over/i.test(title))) {
        yesName = 'Over ' + ln;
        noName = 'Under ' + ln;
      } else if (isUnder) {
        yesName = 'Under ' + ln;
        noName = 'Over ' + ln;
      } else {
        yesName = 'Over ' + ln;
        noName = 'Under ' + ln;
      }
    }
    return { yesName, noName, line: ln, pickHint: yesName };
  }
  if (type === 'nrfi') {
    return { yesName: 'NRFI (No run first inning)', noName: 'YRFI', line: null, pickHint: 'NRFI' };
  }
  if (type === 'yrfi') {
    return { yesName: 'YRFI (Run first inning)', noName: 'NRFI', line: null, pickHint: 'YRFI' };
  }
  // Player props: "Name: 15+" — YES is that player threshold, never another player
  if (String(type).indexOf('player_') === 0 || type === 'player_prop' || type === 'prop') {
    const t = String(title || yesRaw || '');
    const pm = t.match(/^\s*([^:\n]{3,40}?)\s*:\s*(\d+(?:\.\d+)?)\+?/i);
    if (pm) {
      const pl = pm[1].replace(/\s+ML$/i, '').trim();
      const ln = pm[2];
      return {
        yesName: pl + ' ' + ln + '+',
        noName: pl + ' Under ' + ln,
        line: Number(ln),
        pickHint: pl + ' ' + ln + '+',
      };
    }
  }
  // moneyline etc.
  const yn = yesRaw.replace(/\s*wins$/i, '').trim();
  return { yesName: yn || yesRaw, noName: noRaw, line: null, pickHint: yn || yesRaw };
}

function classifyKalshiMarket(m, seriesTicker) {
  const ser = String(seriesTicker || m.event_ticker || m.ticker || '').toUpperCase();
  const title = String(m.title || m.yes_sub_title || '').toLowerCase();
  const rules = String(m.rules_primary || m.rules_secondary || '').toLowerCase();
  const blob = (ser + ' ' + title + ' ' + rules).toLowerCase();

  // Player threshold props: "Victor Wembanyama: 35+" — NEVER moneyline
  if (/^[^:]{3,40}:\s*\d+\+?/.test(title.trim()) || /PLAYER|PTS|PASSYDS|RUSHYDS|RECYDS|STRIKEOUTS|HITS|\bHR\b/.test(ser)) {
    if (/PASSYDS|passing yards/.test(ser + blob)) return 'player_pass_yds';
    if (/RUSHYDS|rushing yards/.test(ser + blob)) return 'player_rush_yds';
    if (/RECYDS|receiving/.test(ser + blob)) return 'player_rec_yds';
    if (/STRIKEOUTS/.test(ser) || /strikeouts/.test(blob)) return 'player_k';
    if (/\bHR\b|home runs?/.test(ser + blob)) return 'player_hr';
    if (/HITS/.test(ser) || /\bhits\b/.test(blob)) return 'player_hits';
    if (/PTS|points/.test(ser + blob) || /:\s*\d+\+?/.test(title)) return 'player_pts';
    return 'player_prop';
  }

  // Spreads first — "wins by over X points" is NEVER moneyline
  if (/wins by over|wins by under|wins by\s*\d|cover\s*[+-]?\d|\bspread\b|run line|puck line/.test(blob)
      || /SPREAD|PUCKLINE/.test(ser)) {
    if (/first half|1st half|\b1h\b|1HSPREAD|1H\b/.test(blob + ser)) return 'spread_1h';
    if (/second half|2nd half|\b2h\b|2HSPREAD/.test(blob + ser)) return 'spread_2h';
    if (/1st quarter|first quarter|\b1q\b|1QSPREAD/.test(blob + ser)) return 'spread_q1';
    if (/2nd quarter|second quarter|\b2q\b|2QSPREAD/.test(blob + ser)) return 'spread_q2';
    if (/3rd quarter|third quarter|\b3q\b|3QSPREAD/.test(blob + ser)) return 'spread_q3';
    if (/4th quarter|fourth quarter|\b4q\b|4QSPREAD/.test(blob + ser)) return 'spread_q4';
    if (/F5|first 5/.test(ser + blob)) return 'f5_spread';
    return 'spread';
  }

  if (/F5/.test(ser) || /first 5|f5/.test(blob)) {
    if (/spread|run line/.test(blob)) return 'f5_spread';
    if (/total|over|under/.test(blob)) return 'f5_total';
    return 'f5';
  }
  if (/NRFI/.test(ser) || /\bnrfi\b|no run first/.test(blob)) return 'nrfi';
  if (/YRFI/.test(ser) || /\byrfi\b|yes run first|run first inning/.test(blob)) return 'yrfi';

  if (/1QWINNER|1ST.?QUARTER.*WIN/.test(ser) || /1st quarter winner|first quarter winner/.test(blob)) return 'moneyline';
  if (/1HWINNER/.test(ser) || (/\b1H\b/.test(ser) && /WIN/.test(ser) && !/SPREAD|TOTAL/.test(ser))) return 'moneyline_1h';
  if (/2HWINNER/.test(ser) || (/2H.*WIN/.test(ser) && !/SPREAD|TOTAL/.test(ser))) return 'moneyline_2h';

  if (/TEAMTOTAL|1HTEAMTOTAL|2HTEAMTOTAL/.test(ser) || /team total/.test(blob)) {
    if (/1H/.test(ser) || /first half/.test(blob)) return 'team_total_1h';
    if (/2H/.test(ser) || /second half/.test(blob)) return 'team_total_2h';
    return 'team_total_fg';
  }
  if (/TOTAL|2QTOTAL|1QTOTAL|2HTOTAL|1HTOTAL|3QTOTAL|4QTOTAL/.test(ser) || (/\btotal\b|over|under|o\/u/.test(title) && !/wins by/.test(title))) {
    if (/1Q|FIRST.?QUARTER/.test(ser) || /1st quarter/.test(blob)) return 'total_q1';
    if (/2Q|SECOND.?QUARTER/.test(ser) || /2nd quarter/.test(blob)) return 'total_q2';
    if (/3Q|THIRD.?QUARTER/.test(ser) || /3rd quarter/.test(blob)) return 'total_q3';
    if (/4Q|FOURTH.?QUARTER/.test(ser) || /4th quarter/.test(blob)) return 'total_q4';
    if (/1H|FIRST.?HALF/.test(ser) || /first half/.test(blob)) return 'total_1h';
    if (/2H|SECOND.?HALF/.test(ser) || /second half/.test(blob)) return 'total_2h';
    if (/1P|FIRST.?PERIOD/.test(ser) || /1st period|first period/.test(blob)) return 'total_1p';
    if (/2P|SECOND.?PERIOD/.test(ser)) return 'total_2p';
    if (/3P|THIRD.?PERIOD/.test(ser)) return 'total_3p';
    return 'total';
  }

  // Player props
  if (/PASSYDS|RUSHYDS|RECYDS|RECEPTIONS|ANYTIMETD|PLAYER|STRIKEOUTS|HITS|\bHR\b|PTS/.test(ser) || /player|passing yards|rushing|receptions|strikeouts|home runs/.test(blob)) {
    return 'player_prop';
  }

  // Default team-win moneyline
  if (/GAME\b/.test(ser) || /wins$/i.test(title) || /winner/.test(blob)) return 'moneyline';
  return 'moneyline';
}


async function fetchSeriesMarkets(seriesTicker, limit = 100) {
  try {
    const data = await fetchJson('/markets', {
      series_ticker: seriesTicker,
      status: 'open',
      limit: Math.min(limit, 200),
    });
    return { series: seriesTicker, markets: data.markets || [] };
  } catch (e) {
    return { series: seriesTicker, markets: [], error: e.message };
  }
}


/**
 * Kalshi sports times:
 * occurrence_datetime / expected_expiration_time are ~end-of-window (often ~3h after kickoff).
 * Using them raw made boards 3h late and let live games pass POTD pregame/next3 checks.
 * Always convert end-ish timestamps → estimated kickoff; never trust them as start as-is.
 */
function kalshiContestHours(league) {
  const lg = String(league || '').toLowerCase();
  if (/nba|cbb|wnba/.test(lg)) return 2.5;
  if (/nhl/.test(lg)) return 2.75;
  if (/soccer|mls|epl|ufc|mma/.test(lg)) return 2.25;
  if (/esports|csgo|lol|dota|valorant/.test(lg)) return 2;
  if (/mlb|baseball/.test(lg)) return 3.25;
  if (/nfl|cfb|football/.test(lg)) return 3.25; // includes OT buffer
  return 3.0;
}

function kalshiParseMs(v) {
  if (v == null || v === '') return NaN;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function kalshiGameStartTime(m, league) {
  if (!m || typeof m !== 'object') return null;
  const lg = String(league || '').toLowerCase();
  const hours = kalshiContestHours(lg);

  const occRaw = m.occurrence_datetime || m.occurrence_at || m.expected_expiration_time || null;
  const occMs = kalshiParseMs(occRaw);
  const closeMs = kalshiParseMs(m.close_time);
  const openMs = kalshiParseMs(m.open_time);

  // Explicit kickoff-ish fields — only trust if clearly earlier than occurrence/close
  const explicitCandidates = [
    m.event_start_time,
    m.scheduled_start,
    m.game_start_time,
    m.start_time,
    m.kickoff_time,
  ].filter(Boolean);

  for (const ex of explicitCandidates) {
    const t = kalshiParseMs(ex);
    if (!Number.isFinite(t)) continue;
    // Same as occurrence/expiration (±20 min) → treat as END, not start
    if (Number.isFinite(occMs) && Math.abs(t - occMs) < 20 * 60 * 1000) continue;
    if (Number.isFinite(closeMs) && Math.abs(t - closeMs) < 20 * 60 * 1000) continue;
    // Must be before end window if we know it
    if (Number.isFinite(occMs) && t > occMs - 30 * 60 * 1000) continue;
    return new Date(t).toISOString();
  }

  // Rules: "originally scheduled for Oct 26, 2026"
  const rules = String(m.rules_primary || m.rules_secondary || m.title || m.subtitle || '');
  const sched = rules.match(
    /scheduled\s+for\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i
  );

  // Primary path: occurrence / expected_expiration ≈ end → kickoff = end − contest hours
  if (Number.isFinite(occMs)) {
    let startMs = occMs - hours * 3600 * 1000;
    if (sched) {
      try {
        const day = new Date(sched[1] + ' UTC');
        if (Number.isFinite(day.getTime())) {
          const adj = new Date(startMs);
          startMs = Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            adj.getUTCHours(),
            adj.getUTCMinutes(),
            adj.getUTCSeconds()
          );
        }
      } catch (e) {}
    }
    // Sanity: kickoff should not be after occurrence
    if (startMs >= occMs) startMs = occMs - hours * 3600 * 1000;
    return new Date(startMs).toISOString();
  }

  // Fallback: close_time is also end-ish on sports
  if (Number.isFinite(closeMs)) {
    return new Date(closeMs - hours * 3600 * 1000).toISOString();
  }
  if (Number.isFinite(openMs)) return new Date(openMs).toISOString();
  return null;
}


function kalshiStartMeta(m, league) {
  const startTime = kalshiGameStartTime(m, league);
  const occRaw = (m && (m.occurrence_datetime || m.occurrence_at || m.expected_expiration_time)) || null;
  let startTimeSource = 'unknown';
  if (!m) return { startTime: null, startTimeSource, startTimeRaw: null };
  const explicit = m.event_start_time || m.scheduled_start || m.game_start_time || m.start_time || m.kickoff_time;
  const occMs = kalshiParseMs(occRaw);
  const exMs = kalshiParseMs(explicit);
  if (Number.isFinite(exMs) && !(Number.isFinite(occMs) && Math.abs(exMs - occMs) < 20 * 60 * 1000)) {
    startTimeSource = 'kalshi-explicit';
  } else if (Number.isFinite(occMs) || kalshiParseMs(m.close_time)) {
    startTimeSource = 'kalshi-est';
  } else if (kalshiParseMs(m.open_time)) {
    startTimeSource = 'kalshi-open';
  }
  return { startTime, startTimeSource, startTimeRaw: occRaw };
}

function kalshiIsLive(startTimeIso, m, league) {
  if (!startTimeIso) return false;
  const t = new Date(startTimeIso).getTime();
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  if (now < t - 2 * 60 * 1000) return false; // not started yet (2m grace)
  const status = String((m && (m.status || m.market_status)) || '').toLowerCase();
  if (/determined|finalized|settled|closed|inactive/.test(status)) return false;
  const hours = kalshiContestHours(league || (m && m.league));
  // Past typical full contest → not live (ended)
  if (now > t + (hours + 0.75) * 3600 * 1000) return false;
  return true;
}


/**
 * List open markets for a league across ML + side series
 */
async function listSportGames(league, { limit = 40, marketType = 'all' } = {}) {
  const lg = String(league || '').toLowerCase();
  // All sports: merge several leagues (auto-elite friendly)
  if (lg === 'all' || lg === '') {
    const leagues = ['mlb', 'nfl', 'nba', 'cfb', 'cbb', 'wnba', 'nhl', 'mls', 'esports'];
    const allGames = [];
    const allSeries = [];
    for (const L of leagues) {
      try {
        const part = await listSportGames(L, { limit: Math.min(12, limit), marketType });
        allGames.push(...(part.games || []));
        if (part.series) allSeries.push(...(Array.isArray(part.series) ? part.series : [part.series]));
      } catch (e) { /* skip league */ }
      await new Promise((r) => setTimeout(r, 80));
    }
    // dedupe by id/ticker
    const seen = new Set();
    const games = [];
    for (const g of allGames) {
      const id = String(g.id || g.marketTicker || g.marketSlug || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      games.push(g);
      if (games.length >= limit * 3) break;
    }
    return { games, series: allSeries, count: games.length, note: 'all-leagues' };
  }
  const seriesList = SERIES_BY_LEAGUE[lg];
  if (!seriesList || !seriesList.length) {
    return { games: [], note: 'No Kalshi series mapped for ' + league };
  }

  // Fetch primary + extra series (cap to limit rate pressure)
  const primary = seriesList[0];
  const extras = seriesList.slice(1, Math.min(seriesList.length, 20));
  const packs = [];
  packs.push(await fetchSeriesMarkets(primary, 200));
  for (const s of extras) {
    await new Promise((r) => setTimeout(r, 100));
    packs.push(await fetchSeriesMarkets(s, 80));
  }

  const games = [];
  const byEvent = {};

  for (const pack of packs) {
    const series = pack.series;
    for (const m of pack.markets || []) {
      const et = m.event_ticker || m.ticker;
      if (!et) continue;
      const type = classifyKalshiMarket(m, series);
      if (marketType && marketType !== 'all') {
        // light filter — full match in API layer
      }
      if (!byEvent[et]) byEvent[et] = [];
      byEvent[et].push({ m, series, type });
    }
  }

  for (const et of Object.keys(byEvent)) {
    const items = byEvent[et];
    // Prefer ML win markets for title
    const winItems = items.filter((x) => x.type === 'moneyline' || /wins$/i.test(x.m.title || ''));
    const primaryItem = winItems[0] || items[0];
    const primary = primaryItem.m;
    const series = primaryItem.series;

    let title = et;
    if (winItems.length >= 2) {
      const n0 = String(winItems[0].m.yes_sub_title || winItems[0].m.title || '').replace(/\s*wins$/i, '').trim();
      const n1 = String(winItems[1].m.yes_sub_title || winItems[1].m.title || '').replace(/\s*wins$/i, '').trim();
      if (n0 && n1) title = n0 + ' vs. ' + n1;
    } else {
      const rules = String(primary.rules_primary || primary.rules_secondary || '');
      const vsInRules = rules.match(/the\s+(.+?)\s+vs\.?\s+(.+?)\s+professional/i);
      if (vsInRules) title = vsInRules[1].trim() + ' vs. ' + vsInRules[2].trim();
      else if (primary.yes_sub_title) title = String(primary.yes_sub_title).replace(/\s*wins$/i, '') + ' ML';
    }

    // Moneyline: ONE card per event (Kalshi lists each team as its own market — do not show both)
    const mlItems = items.filter((x) => x.type === 'moneyline' || /wins$/i.test(x.m.title || x.m.yes_sub_title || ''));
    const otherItems = items.filter((x) => !(x.type === 'moneyline' || /wins$/i.test(x.m.title || x.m.yes_sub_title || '')));

    if (mlItems.length) {
      // Build two-sided book from team-win markets when available
      const sideRows = [];
      for (const { m, series: ser } of mlItems) {
        const price = midPrice(m);
        if (price == null) continue;
        const yesName = String(m.yes_sub_title || m.title || 'Yes').replace(/\s*wins$/i, '').trim();
        sideRows.push({ m, ser, price, yesName });
      }
      if (sideRows.length) {
        // Prefer highest liquidity / volume as primary ticker for trade link
        sideRows.sort((a, b) => (parseFloat(b.m.volume_fp) || 0) - (parseFloat(a.m.volume_fp) || 0));
        const primary = sideRows[0];
        let sides;
        if (sideRows.length >= 2) {
          sides = sideRows.slice(0, 2).map((r) => ({
            name: r.yesName,
            price: r.price,
            pct: Math.round(r.price * 1000) / 10,
            ticker: r.m.ticker,
          }));
          // yesPrice = first side (will be remapped to form winner in API)
          const smDual = kalshiStartMeta(primary.m, league);
          games.push({
            id: et + '-ml',
            title: title,
            eventTitle: title,
            league: String(league).toLowerCase(),
            venue: 'kalshi',
            source: 'kalshi',
            marketType: 'moneyline',
            startTime: smDual.startTime,
            startTimeRaw: smDual.startTimeRaw,
            startTimeSource: smDual.startTimeSource || 'kalshi-est',
            live: false,
            ended: false,
            marketSlug: primary.m.ticker,
            marketTicker: primary.m.ticker,
            eventTicker: et,
            marketSlugs: sideRows.map((r) => r.m.ticker).filter(Boolean),
            url: kalshiTradeUrl({ eventTicker: et, marketTicker: primary.m.ticker, series: primary.ser, title }),
            marketUrl: primary.m.ticker ? 'https://kalshi.com/markets/' + primary.m.ticker : null,
            sides,
            yesPrice: sides[0].price,
            noPrice: sides[1] ? sides[1].price : 1 - sides[0].price,
            volume: sideRows.reduce((s, r) => s + (parseFloat(r.m.volume_fp) || 0), 0),
            liquidity: sideRows.reduce((s, r) => s + (parseFloat(r.m.liquidity_dollars) || 0), 0),
            _kalshiDualTeam: true,
          });
        } else {
          const r = sideRows[0];
          const noPrice = r.m.no_ask_dollars != null ? parseFloat(r.m.no_ask_dollars) : (r.m.no_bid_dollars != null ? parseFloat(r.m.no_bid_dollars) : 1 - r.price);
          const smOne = kalshiStartMeta(r.m, league);
          games.push({
            id: et + '-ml',
            title: title,
            eventTitle: title,
            league: String(league).toLowerCase(),
            venue: 'kalshi',
            source: 'kalshi',
            marketType: 'moneyline',
            startTime: smOne.startTime,
            startTimeRaw: smOne.startTimeRaw,
            startTimeSource: smOne.startTimeSource || 'kalshi-est',
            live: false,
            ended: false,
            marketSlug: r.m.ticker,
            marketTicker: r.m.ticker,
            eventTicker: et,
            marketSlugs: [r.m.ticker],
            url: kalshiTradeUrl({ eventTicker: et, marketTicker: r.m.ticker, series: r.ser, title }),
            marketUrl: r.m.ticker ? 'https://kalshi.com/markets/' + r.m.ticker : null,
            sides: [
              { name: r.yesName, price: r.price, pct: Math.round(r.price * 1000) / 10 },
              { name: 'No', price: noPrice, pct: Math.round(noPrice * 1000) / 10 },
            ],
            yesPrice: r.price,
            noPrice,
            volume: parseFloat(r.m.volume_fp) || 0,
            liquidity: parseFloat(r.m.liquidity_dollars) || 0,
          });
        }
      }
    }

    // Non-ML markets: one card each (spreads, totals, etc.)
    for (const { m, series: ser, type } of otherItems) {
      const price = midPrice(m);
      if (price == null) continue;
      let noPrice = m.no_ask_dollars != null ? parseFloat(m.no_ask_dollars) : null;
      if (noPrice == null && m.no_bid_dollars != null) noPrice = parseFloat(m.no_bid_dollars);
      if (noPrice == null) noPrice = 1 - price;
      const labels = kalshiOutcomeLabels(m, type);
      const yesName = labels.yesName;
      const noName = labels.noName;
      const sm = kalshiStartMeta(m, league);
      // Clean card title: keep event matchup, put market detail in subTitle
      let cardTitle = String(m.title || title || '').replace(/\s+ML$/i, '');
      if (/^[^:]{3,40}:\s*\d+/.test(cardTitle) && !/spread|total|wins by/i.test(cardTitle)) {
        /* keep player prop title clean */
      }
      if (/^spread/.test(type) || type === 'f5_spread') {
        cardTitle = title + (labels.line != null ? (' · Spread ' + labels.line) : ' · Spread');
      } else if (/^total/.test(type) || type === 'f5_total' || /^team_total/.test(type)) {
        cardTitle = title + (labels.line != null ? (' · Total ' + labels.line) : ' · Total');
      } else if (type === 'nrfi' || type === 'yrfi') {
        cardTitle = title + ' · ' + type.toUpperCase();
      }

      games.push({
        id: m.ticker || (et + '-' + type + '-' + String(m.title || m.yes_sub_title || '').slice(0, 40).replace(/\W+/g, '_')),
        title: cardTitle,
        eventTitle: title,
        subTitle: m.subtitle || m.title || null,
        league: String(league).toLowerCase(),
        venue: 'kalshi',
        source: 'kalshi',
        marketType: type,
        spreadLine: (/spread|f5_spread/.test(type) ? labels.line : null),
        totalLine: (/total|f5_total|team_total/.test(type) ? labels.line : null),
        pickHint: labels.pickHint,
        startTime: sm.startTime,
        startTimeRaw: sm.startTimeRaw,
        startTimeSource: sm.startTimeSource || 'kalshi-est',
        live: kalshiIsLive(sm.startTime, m, league),
        ended: false,
        marketSlug: m.ticker,
        marketTicker: m.ticker,
        eventTicker: et,
        marketSlugs: [m.ticker],
        url: kalshiTradeUrl({ eventTicker: et, marketTicker: m.ticker, series: ser, title }),
        marketUrl: m.ticker ? 'https://kalshi.com/markets/' + m.ticker : null,
        sides: [
          { name: yesName, price, pct: Math.round(price * 1000) / 10 },
          { name: noName, price: noPrice, pct: Math.round(noPrice * 1000) / 10 },
        ],
        yesPrice: price,
        noPrice,
        volume: parseFloat(m.volume_fp) || 0,
        liquidity: parseFloat(m.liquidity_dollars) || 0,
      });
      if (games.length >= limit * 8) break;
    }
    if (games.length >= limit * 8) break;
  }

  // Mark live from adjusted kickoff (not false-pregame)
  games.forEach((g) => {
    const lg = g.league || league;
    if (g.startTime) {
      g.live = kalshiIsLive(g.startTime, { status: g.status }, lg);
      const ageH = (Date.now() - new Date(g.startTime).getTime()) / 3600000;
      const maxH = kalshiContestHours(lg) + 1;
      if (ageH > maxH) { g.live = false; g.ended = true; }
    }
  });

  games.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return ta - tb;
  });

  return { games, series: seriesList, source: 'kalshi', count: games.length };
}

module.exports = {
  listSportGames,
  kalshiGameStartTime,
  kalshiStartMeta,
  kalshiIsLive,
  kalshiContestHours,
  classifyKalshiMarket,
  kalshiOutcomeLabels,
  parseKalshiSpreadLine,
  parseKalshiTotalLine,
};
