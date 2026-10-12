/** Polymarket US — only user sports */
const GATEWAY = 'https://gateway.polymarket.us';
const LEAGUES = ['nba', 'wnba', 'ufc', 'mlb', 'cfb', 'cbb', 'nfl', 'nhl', 'epl', 'mls', 'lal', 'bun', 'sea', 'ucl', 'uefa', 'fwc', 'atp', 'wta', 'lol', 'cs2', 'dota2', 'valorant', 'cod'];
// Soccer family on Polymarket US (gateway league slugs)
const SOCCER_LEAGUES = ['epl', 'mls', 'lal', 'bun', 'sea', 'ucl', 'uefa', 'fwc', 'flc'];

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Polymarket US ' + r.status);
  return r.json();
}

async function fetchLeagueEvents(league, { limit = 25, type = 'sport' } = {}) {
  const url = GATEWAY + '/v2/leagues/' + encodeURIComponent(league) + '/events?limit=' + limit + '&type=' + type;
  try {
    const data = await fetchJson(url);
    return (data.events || []).map((e) => normalizeEvent(e, league));
  } catch (e) {
    return [];
  }
}

async function fetchAllSportsEvents({ limitPerLeague = 20 } = {}) {
  const results = await Promise.all(LEAGUES.map((l) => fetchLeagueEvents(l, { limit: limitPerLeague })));
  return results.flat();
}

function normalizeEvent(e, league) {
  const markets = (e.markets || []).map((m) => normalizeMarket(m, e, league));
  return {
    id: e.id,
    slug: e.slug,
    title: e.title || e.ticker,
    league,
    startTime: e.startTime || e.startDate,
    live: !!e.live,
    ended: !!e.ended,
    period: e.period || '',
    score: e.score || null,
    markets,
    url: e.slug ? 'https://polymarket.us/event/' + e.slug : 'https://polymarket.us',
  };
}

/** Normalize PM price to 0–1 (handles 0.96, 96 cents, or "0.96") */
function toPrice01(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.value != null) v = v.value;
  let n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1 && n <= 100) n = n / 100; // cents as integer
  if (n > 100) n = n / 1000; // rare milli
  if (n <= 0 || n >= 1) return null;
  return n;
}

function normalizeMarket(m, event, league) {
  const sides = m.marketSides || [];
  const longSide = sides.find((s) => s.long) || sides[0];
  const shortSide = sides.find((s) => !s.long) || sides[1];
  let yesPrice = toPrice01(longSide && longSide.price);
  let noPrice = toPrice01(shortSide && shortSide.price);
  // Prefer explicit quotes on market object when present
  if (yesPrice == null) yesPrice = toPrice01(m.yesPrice) || toPrice01(m.lastTradePrice) || toPrice01(m.bestAsk);
  if (noPrice == null) noPrice = toPrice01(m.noPrice);
  if (noPrice == null && yesPrice != null) noPrice = Math.round((1 - yesPrice) * 1000) / 1000;
  return {
    id: m.id,
    question: m.question || m.slug,
    slug: m.slug,
    sportsMarketType: m.sportsMarketType || m.marketType || '',
    sportsMarketTypeV2: m.sportsMarketTypeV2 || null,
    line: m.line != null && m.line !== '' ? Number(m.line) : null,
    yesPrice,
    noPrice,
    volume: Number(m.volume || 0),
    liquidity: Number(m.liquidity || 0),
    closed: !!m.closed,
    league,
    eventTitle: event && event.title,
    live: !!(event && event.live),
    period: (event && event.period) || '',
    score: (event && event.score) || null,
    startTime: event && (event.startTime || event.startDate),
    // Market-specific page (may 404 on some sports UI paths) + event page for Trade → game
    marketSlug: m.slug || null,
    eventSlug: event && event.slug ? event.slug : null,
    marketUrl: m.slug ? 'https://polymarket.us/market/' + m.slug : null,
    // Trade default: open the GAME (event), not a random market path
    url: (event && event.slug)
      ? ('https://polymarket.us/event/' + event.slug)
      : (m.slug ? 'https://polymarket.us/market/' + m.slug : 'https://polymarket.us'),
  };
}

function flattenMarkets(events) {
  const out = [];
  for (const ev of events) {
    for (const m of ev.markets || []) {
      out.push(Object.assign({}, m, {
        eventTitle: ev.title,
        eventSlug: ev.slug || m.eventSlug || null,
        league: ev.league,
        live: ev.live,
        period: ev.period,
        score: ev.score,
        startTime: ev.startTime,
        ended: ev.ended,
      }));
    }
  }
  return out;
}

async function fetchSoccerEvents({ limitPerLeague = 20 } = {}) {
  const results = await Promise.all(
    SOCCER_LEAGUES.map((l) => fetchLeagueEvents(l, { limit: limitPerLeague }))
  );
  return results.flat();
}

function isSoccerLeague(league) {
  const lg = String(league || '').toLowerCase();
  return SOCCER_LEAGUES.includes(lg) || lg === 'soccer' || lg === 'football';
}

module.exports = {
  toPrice01,
  GATEWAY,
  LEAGUES,
  SOCCER_LEAGUES,
  fetchLeagueEvents,
  fetchAllSportsEvents,
  fetchSoccerEvents,
  isSoccerLeague,
  flattenMarkets,
};

