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

/**
 * League list only returns ~1 market (moneyline). Full board (spreads/totals/player props)
 * lives on GET /v1/events/slug/{slug}. Expand when caller needs props or all markets.
 */
async function expandEventMarkets(e, league, { maxMarkets = 400 } = {}) {
  if (!e || !e.slug) return e;
  const already = (e.markets || []).length;
  if (already >= 8) return e; // already expanded
  try {
    const data = await fetchJson(GATEWAY + '/v1/events/slug/' + encodeURIComponent(e.slug));
    const full = data.event || data;
    const mkts = full.markets || data.markets || [];
    if (mkts.length > already) {
      e.markets = mkts.slice(0, maxMarkets);
      if (full.title) e.title = full.title;
      if (full.startTime || full.startDate) e.startTime = full.startTime || full.startDate;
      if (full.live != null) e.live = !!full.live;
      if (full.period) e.period = full.period;
      if (full.score) e.score = full.score;
    }
  } catch (err) {
    /* keep list markets */
  }
  return e;
}

async function fetchLeagueEvents(league, { limit = 25, type = 'sport', expandMarkets = false, maxEventsExpand = 8, maxMarkets = 350 } = {}) {
  const url = GATEWAY + '/v2/leagues/' + encodeURIComponent(league) + '/events?limit=' + limit + '&type=' + type;
  try {
    const data = await fetchJson(url);
    let events = data.events || [];
    if (expandMarkets && events.length) {
      const slice = events.slice(0, maxEventsExpand);
      await Promise.all(slice.map((e) => expandEventMarkets(e, league, { maxMarkets })));
    }
    return events.map((e) => normalizeEvent(e, league));
  } catch (e) {
    return [];
  }
}

async function fetchAllSportsEvents({ limitPerLeague = 20, expandMarkets = true, maxEventsExpand = 6, maxMarkets = 250 } = {}) {
  const results = await Promise.all(
    LEAGUES.map((l) =>
      fetchLeagueEvents(l, {
        limit: limitPerLeague,
        expandMarkets,
        maxEventsExpand,
        maxMarkets,
      })
    )
  );
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
  // CRITICAL: side.quote.value is live tradeable ¢; side.price is often stale/mirrored
  // e.g. SEA/PHI P1 Over 1.5: price=0.50 but quote=0.57 (matches PM app Yes 57¢)
  let yesPrice =
    toPrice01(longSide && longSide.quote && longSide.quote.value) ||
    toPrice01(longSide && longSide.price) ||
    toPrice01(m.yesPrice) ||
    toPrice01(m.lastTradePrice) ||
    toPrice01(m.bestAsk);
  let noPrice =
    toPrice01(shortSide && shortSide.quote && shortSide.quote.value) ||
    toPrice01(shortSide && shortSide.price);
  // short.price is frequently a copy of long quote (useless) — if both look like longs, drop short.price
  if (
    noPrice != null &&
    yesPrice != null &&
    Math.abs(noPrice - yesPrice) < 0.02 &&
    shortSide &&
    shortSide.quote &&
    shortSide.quote.value != null
  ) {
    noPrice = toPrice01(shortSide.quote.value);
  }
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
  expandEventMarkets,
  fetchSoccerEvents,
  isSoccerLeague,
  flattenMarkets,
};

