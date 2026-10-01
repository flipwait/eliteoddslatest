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

function classifyKalshiMarket(m, seriesTicker) {
  const ser = String(seriesTicker || m.event_ticker || m.ticker || '').toUpperCase();
  const title = String(m.title || m.yes_sub_title || '').toLowerCase();
  const rules = String(m.rules_primary || m.rules_secondary || '').toLowerCase();
  const blob = (ser + ' ' + title + ' ' + rules).toLowerCase();

  // Point-spread style titles on game series: "Team wins by over 7.5 points"
  if (/wins by over|wins by under|wins by\s*\d|cover\s*[+-]?\d|spread|run line/.test(blob)) {
    if (/first half|1st half|1h/.test(blob)) return 'spread_1h';
    if (/second half|2nd half|2h/.test(blob)) return 'spread_2h';
    if (/1st quarter|first quarter|1q/.test(blob)) return 'spread_q1';
    if (/2nd quarter|second quarter|2q/.test(blob)) return 'spread_q2';
    if (/3rd quarter|third quarter|3q/.test(blob)) return 'spread_q3';
    if (/4th quarter|fourth quarter|4q/.test(blob)) return 'spread_q4';
    return 'spread';
  }

  if (/F5/.test(ser) || /first 5|f5/.test(blob)) {
    if (/spread|run line/.test(blob)) return 'f5_spread';
    if (/total|over|under/.test(blob)) return 'f5_total';
    return 'f5';
  }
  if (/1QWINNER|1ST.?QUARTER.*WIN/.test(ser) || /1st quarter winner|first quarter winner/.test(blob)) return 'moneyline';
  if (/1HWINNER/.test(ser) || (/\b1H\b/.test(ser) && /WIN/.test(ser))) return 'moneyline_1h';
  if (/2HSPREAD|1HSPREAD|SPREAD/.test(ser) || /\bspread\b|\bcover\b/.test(title)) {
    if (/2H|SECOND.?HALF/.test(ser) || /2nd half|second half/.test(blob)) return 'spread_2h';
    if (/1H|FIRST.?HALF/.test(ser) || /1st half|first half/.test(blob)) return 'spread_1h';
    if (/1Q|FIRST.?QUARTER/.test(ser)) return 'spread_q1';
    if (/2Q/.test(ser)) return 'spread_q2';
    if (/3Q/.test(ser)) return 'spread_q3';
    if (/4Q/.test(ser)) return 'spread_q4';
    return 'spread';
  }
  if (/TEAMTOTAL|1HTEAMTOTAL/.test(ser) || /team total/.test(blob)) {
    if (/1H/.test(ser) || /first half/.test(blob)) return 'team_total_1h';
    if (/2H/.test(ser) || /second half/.test(blob)) return 'team_total_2h';
    return 'team_total_fg';
  }
  if (/TOTAL|2QTOTAL|1QTOTAL|2HTOTAL/.test(ser) || /\btotal\b|over|under|o\/u/.test(title)) {
    if (/1Q|FIRST.?QUARTER/.test(ser)) return 'total_q1';
    if (/2Q|SECOND.?QUARTER/.test(ser)) return 'total_q2';
    if (/3Q/.test(ser)) return 'total_q3';
    if (/4Q/.test(ser)) return 'total_q4';
    if (/1H|FIRST.?HALF/.test(ser)) return 'total_1h';
    if (/2H|SECOND.?HALF/.test(ser)) return 'total_2h';
    return 'total';
  }
  // NRFI / YRFI
  if (/NRFI|NO.?RUN.?FIRST/.test(ser) || /\bnrfi\b|no run first|no runs? in the first/.test(blob)) return 'nrfi';
  if (/YRFI|YES.?RUN.?FIRST/.test(ser) || /\byrfi\b|yes run first|run in the first inning/.test(blob)) return 'yrfi';

  // Player props
  if (/HR|HOMER|HOME.?RUN/.test(ser) || /home runs?|\bhr\b|homer/.test(blob)) return 'player_hr';
  if (/STRIKEOUT|KXMLB.*K\b|PITCHER.?K/.test(ser) || /strikeouts?/.test(blob)) return 'player_k';
  if (/HITS/.test(ser) && /PLAYER|BATTER/.test(ser) || /\bhits\b/.test(title) && !/hits allowed/.test(title)) return 'player_hits';
  if (/TOTAL.?BASES|\bTB\b/.test(ser) || /total bases/.test(blob)) return 'player_tb';
  if (/HRR|H\+R\+RBI|HITS.?RUNS.?RBI/.test(ser) || /hits.*runs.*rbi|h\+r\+rbi/.test(blob)) return 'player_hrr';
  if (/OUTS.?REC|PITCHER.?OUTS/.test(ser) || /outs recorded/.test(blob)) return 'pitcher_outs';
  if (/EARNED.?RUN|\bER\b/.test(ser) || /earned runs? allowed/.test(blob)) return 'pitcher_er';
  if (/HITS.?ALLOWED/.test(ser) || /hits allowed/.test(blob)) return 'pitcher_ha';
  if (/WALKS.?ALLOWED|\bBB\b/.test(ser) || /walks allowed/.test(blob)) return 'pitcher_bb';
  if (/PASS(ING)?.?YARD/.test(ser) || /passing yards/.test(blob)) return 'player_pass_yds';
  if (/RUSH(ING)?.?YARD/.test(ser) || /rushing yards/.test(blob)) return 'player_rush_yds';
  if (/REC(EIVING)?.?YARD/.test(ser) || /receiving yards/.test(blob)) return 'player_rec_yds';
  if (/RECEPTION/.test(ser) || /\breceptions\b/.test(blob)) return 'player_receptions';
  if (/ANYTIME.?TD|TOUCHDOWN/.test(ser) || /anytime touchdown|to score a td/.test(blob)) return 'player_atd';
  if (/PLAYER|BATTER|PITCHER/.test(ser) || /player prop/.test(blob)) return 'player_prop';

  // True ML: "Team wins" without margin
  if (/\bwins\b/.test(title) && !/wins by/.test(title)) return 'moneyline';
  if (/winner|moneyline|who will win/.test(blob) && !/wins by/.test(blob)) return 'moneyline';
  if (/GAME/.test(ser) && /\bwins\b/.test(title) && !/wins by/.test(title)) return 'moneyline';
  return 'prop';
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
          games.push({
            id: et + '-ml',
            title: title,
            eventTitle: title,
            league: String(league).toLowerCase(),
            venue: 'kalshi',
            source: 'kalshi',
            marketType: 'moneyline',
            startTime: primary.m.occurrence_datetime || primary.m.expected_expiration_time || primary.m.close_time || null,
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
          games.push({
            id: et + '-ml',
            title: title,
            eventTitle: title,
            league: String(league).toLowerCase(),
            venue: 'kalshi',
            source: 'kalshi',
            marketType: 'moneyline',
            startTime: r.m.occurrence_datetime || r.m.expected_expiration_time || r.m.close_time || null,
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
      const yesName = m.yes_sub_title || m.title || 'Yes';
      const noName = m.no_sub_title || 'No';

      games.push({
        id: m.ticker || et + '-' + type,
        title: m.title || title,
        eventTitle: title,
        subTitle: m.subtitle || null,
        league: String(league).toLowerCase(),
        venue: 'kalshi',
        source: 'kalshi',
        marketType: type,
        startTime: m.occurrence_datetime || m.expected_expiration_time || m.close_time || null,
        live: false,
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

  games.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return ta - tb;
  });

  return { games, series: seriesList, source: 'kalshi', count: games.length };
}

module.exports = {
  listSportGames,
  SERIES_BY_LEAGUE,
  BASE,
  midPrice,
  fetchJson,
  kalshiTradeUrl,
  classifyKalshiMarket,
};
