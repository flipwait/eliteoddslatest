/** Polymarket US — only user sports */
const GATEWAY = 'https://gateway.polymarket.us';
const LEAGUES = ['nba', 'wnba', 'ufc', 'mlb', 'cfb', 'cbb', 'nfl', 'nhl', 'mls', 'epl', 'atp', 'wta', 'lol', 'cs2', 'dota2', 'valorant', 'cod'];

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

function normalizeMarket(m, event, league) {
  const sides = m.marketSides || [];
  const longSide = sides.find((s) => s.long) || sides[0];
  const shortSide = sides.find((s) => !s.long) || sides[1];
  const yesPrice = longSide && longSide.price != null ? Number(longSide.price) : null;
  return {
    id: m.id,
    question: m.question || m.slug,
    slug: m.slug,
    sportsMarketType: m.sportsMarketType || m.marketType || '',
    sportsMarketTypeV2: m.sportsMarketTypeV2 || null,
    line: m.line != null && m.line !== '' ? Number(m.line) : null,
    yesPrice,
    noPrice: shortSide && shortSide.price != null ? Number(shortSide.price) : yesPrice != null ? 1 - yesPrice : null,
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

module.exports = { GATEWAY, LEAGUES, fetchLeagueEvents, fetchAllSportsEvents, flattenMarkets };
