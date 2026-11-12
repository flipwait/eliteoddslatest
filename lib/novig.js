/**
 * Novig Sports Trading API (v3) — Paper + Production
 */
const crypto = require('crypto');
const https = require('https');

const PAPER_HOST = 'api.paper.novig.com';
const PROD_HOST = 'api.novig.com';

function hostFor(env) {
  const e = String(env || '').toLowerCase();
  return e === 'prod' || e === 'production' ? PROD_HOST : PAPER_HOST;
}

function loadPrivateKey(pemOrB64) {
  if (!pemOrB64) return null;
  let raw = String(pemOrB64).trim();
  if (!raw.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 80) {
    try { raw = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (_) {}
  }
  if (!raw.includes('BEGIN')) {
    const b64 = raw.replace(/\s+/g, '');
    raw = '-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----';
  }
  try { return crypto.createPrivateKey(raw); }
  catch (e) {
    try { return crypto.createPrivateKey({ key: raw, format: 'pem' }); }
    catch (e2) { return null; }
  }
}

function signRequest({ keyId, privateKey, method, path, query, body, timestamp }) {
  const ts = String(timestamp || Date.now());
  const bodyStr = body == null || body === '' ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const pathOnly = String(path || '/').split('?')[0];
  const queryStr = query == null ? '' : String(query);
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const canonical = ['NOVIG-V3', ts, String(method || 'GET').toUpperCase(), pathOnly, queryStr, bodyHash].join('\n');
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return {
    'Novig-Key-Id': keyId,
    'Novig-Timestamp': ts,
    'Novig-Signature': sig.toString('base64'),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function httpsJson({ host, method, pathWithQuery, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = { hostname: host, path: pathWithQuery, method: method || 'GET', headers: { ...(headers || {}) }, timeout: timeoutMs || 20000 };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Novig timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function novigFetch({ keyId, pem, env, method, path, query, body }) {
  if (!keyId || !pem) {
    const err = new Error('Novig keys missing — add Key ID + private key PEM in Settings');
    err.code = 'NO_KEYS';
    throw err;
  }
  const privateKey = loadPrivateKey(pem);
  if (!privateKey) {
    const err = new Error('Novig private key PEM could not be parsed');
    err.code = 'BAD_KEY';
    throw err;
  }
  const host = hostFor(env);
  const pathOnly = (path.startsWith('/') ? path : '/' + path).split('?')[0];
  let queryStr = '';
  if (query && typeof query === 'object') {
    const keys = Object.keys(query).filter((k) => query[k] != null && query[k] !== '').sort();
    const qs = new URLSearchParams();
    keys.forEach((k) => qs.set(k, String(query[k])));
    queryStr = qs.toString();
  } else if (typeof query === 'string') queryStr = query;
  const pathWithQuery = queryStr ? pathOnly + '?' + queryStr : pathOnly;
  const headers = signRequest({ keyId, privateKey, method: method || 'GET', path: pathOnly, query: queryStr, body });
  return httpsJson({ host, method: method || 'GET', pathWithQuery, headers, body });
}

const LEAGUE_MAP = {
  nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', cfb: 'NCAAF', ncaaf: 'NCAAF',
  cbb: 'NCAAB', ncaab: 'NCAAB', wnba: 'WNBA', soccer: 'SOCCER', epl: 'EPL', ufc: 'UFC', atp: 'ATP', wta: 'WTA',
};


function mapMarketType(mt) {
  const u = String(mt || '').toUpperCase();
  if (u === 'MONEY' || u === 'MONEYLINE' || u === 'ML' || u === 'MONEYLINE_3_WAY_WIN') return 'moneyline';
  if (u === 'SPREAD') return 'spread';
  if (u === 'TOTAL') return 'total';
  if (u === 'TEAM_TOTAL') return 'team_total';
  if (/YARDS|RECEPTIONS|POINTS|ASSISTS|PROP/i.test(u)) return 'player_prop';
  return String(mt || 'moneyline').toLowerCase();
}

function extractItems(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.markets)) return json.markets;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.items)) return json.data.items;
  if (Array.isArray(json.results)) return json.results;
  return [];
}

/** Prices are decimal probs 0.001–0.999 (strings ok). */
function parsePrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (v.price != null) return parsePrice(v.price);
    return null;
  }
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  // already 0–1
  if (n > 0 && n < 1.5) return n;
  // percent 1–100
  if (n >= 1.5 && n <= 100) return n / 100;
  return null;
}

function outcomePrice(o) {
  if (!o) return null;
  return parsePrice(o.last) ?? parsePrice(o.bid) ?? parsePrice(o.ask) ?? parsePrice(o.price);
}

/**
 * Docs: never rely on array order — use outcome.index
 * MONEY/SPREAD: 0 = Home, 1 = Away
 * TOTAL/TEAM_TOTAL: 0 = Over, 1 = Under
 */
function sortOutcomes(outcomes) {
  const arr = Array.isArray(outcomes) ? outcomes.slice() : [];
  arr.sort((a, b) => {
    const ia = a && a.index != null ? Number(a.index) : 99;
    const ib = b && b.index != null ? Number(b.index) : 99;
    return ia - ib;
  });
  return arr;
}

function marketsToGames(items, leagueHint) {
  const games = [];
  for (const m of (items || [])) {
    try {
      const outcomes = sortOutcomes(m.outcomes || m.outcome || m.contracts || []);
      const mtRaw = String(m.marketType || m.type || m.market_type || 'MONEY');
      const mt = mapMarketType(mtRaw);
      const o0 = outcomes.find((o) => Number(o.index) === 0) || outcomes[0] || {};
      const o1 = outcomes.find((o) => Number(o.index) === 1) || outcomes[1] || {};
      const p0 = outcomePrice(o0);
      const p1 = outcomePrice(o1);
      const toPct = (p) => (p == null ? null : Math.round(p * 1000) / 10);
      const pct0 = toPct(p0);
      const pct1 = toPct(p1);

      let title = m.description || m.eventDescription || m.title || m.name || '';
      // Clean "— Moneyline" / "— Spread" suffixes for matchup column
      const eventTitle = String(title)
        .replace(/\s*[—\-–]\s*(Moneyline|Spread|Total|Team Total).*$/i, '')
        .replace(/\s+Moneyline$/i, '')
        .trim() || title || 'Novig market';

      const startMs = m.startsTs || m.startTs || m.scheduledStart || m.startTime || null;
      let startTime = null;
      if (startMs) {
        const n = typeof startMs === 'number' ? startMs : Date.parse(startMs);
        if (Number.isFinite(n)) startTime = new Date(n < 1e12 ? n * 1000 : n).toISOString();
      }

      const name0 = o0.name || o0.outcomeName || (mt === 'total' || mt === 'team_total' ? 'Over' : 'Home');
      const name1 = o1.name || o1.outcomeName || (mt === 'total' || mt === 'team_total' ? 'Under' : 'Away');

      const sides = [
        { name: name0, pct: pct0, price: p0, outcomeId: o0.outcomeId || o0.id, index: 0 },
        { name: name1, pct: pct1, price: p1, outcomeId: o1.outcomeId || o1.id, index: 1 },
      ];

      // Pick the higher-priced side as market favorite (display); model may override later
      let modelPick = name0;
      let yesPrice = p0;
      let noPrice = p1;
      let mktPct = pct0;
      if (pct0 != null && pct1 != null) {
        if (pct1 > pct0) {
          modelPick = name1;
          yesPrice = p1;
          noPrice = p0;
          mktPct = pct1;
        }
      } else if (pct0 == null && pct1 != null) {
        modelPick = name1;
        yesPrice = p1;
        noPrice = p0;
        mktPct = pct1;
      }

      // Spread/total picks: include strike in pick label
      const strikeRaw = m.strike != null ? Number(m.strike) : null;
      const strike = Number.isFinite(strikeRaw) ? strikeRaw : null;
      if (mt === 'spread' && strike != null) {
        // strike is home handicap per docs; index 0 = home
        if (modelPick === name0) modelPick = name0 + ' ' + (strike > 0 ? '+' : '') + strike;
        else modelPick = name1 + ' ' + (strike > 0 ? '-' : '+') + Math.abs(strike);
      }
      if ((mt === 'total' || mt === 'team_total') && strike != null) {
        if (/over/i.test(String(modelPick))) modelPick = 'Over ' + Math.abs(strike);
        else if (/under/i.test(String(modelPick))) modelPick = 'Under ' + Math.abs(strike);
      }

      const status = String(m.status || m.eventStatus || '').toUpperCase();
      const league = String(
        leagueHint || m.league || m.leagueName || m.sport || 'all'
      ).toLowerCase().replace('ncaaf', 'cfb').replace('ncaab', 'cbb');

      games.push({
        id: 'novig-' + (m.marketId || m.id || crypto.randomBytes(6).toString('hex')),
        venue: 'novig',
        source: 'novig',
        league,
        marketType: mt,
        title: eventTitle,
        eventTitle,
        startTime,
        live: /INGAME|LIVE|IN_PLAY|LIVE_TRADING/.test(status),
        ended: /FINAL|SETTLED|CLOSED|RESOLVED|DETERMINED|FINALIZED/.test(status),
        marketId: m.marketId || m.id,
        eventId: m.eventId,
        sides,
        yesPrice,
        noPrice,
        market_probability: mktPct,
        modelPick,
        line: strike,
        spreadLine: mt === 'spread' ? strike : null,
        totalLine: mt === 'total' || mt === 'team_total' ? Math.abs(strike) : null,
        volume: m.volume || 0,
        openInterest: m.openInterest || 0,
        url: 'https://novig.com',
        marketUrl: 'https://novig.com',
        novig: true,
        hasForm: false,
        novigMarketType: mtRaw,
      });
    } catch (_) {}
  }
  return games;
}

async function listNovigGames({ keyId, pem, env, league, limit = 80 }) {
  const host = hostFor(env);
  const lg = league && league !== 'all' ? (LEAGUE_MAP[String(league).toLowerCase()] || String(league).toUpperCase()) : null;

  // Prefer broad OPEN catalog (all main types). Do NOT stop after 5 MONEY lines.
  const attempts = [];
  if (lg) {
    attempts.push({ league: lg, eventStatus: 'OPEN', marketType: 'MONEY,SPREAD,TOTAL,TEAM_TOTAL' });
    attempts.push({ league: lg, eventStatus: 'OPEN' });
    attempts.push({ league: lg, marketType: 'MONEY,SPREAD,TOTAL' });
    attempts.push({ league: lg });
  }
  attempts.push({ eventStatus: 'OPEN', marketType: 'MONEY,SPREAD,TOTAL,TEAM_TOTAL' });
  attempts.push({ eventStatus: 'OPEN', marketType: 'MONEY,SPREAD,TOTAL' });
  attempts.push({ eventStatus: 'OPEN' });
  attempts.push({ marketType: 'MONEY,SPREAD,TOTAL' });
  attempts.push({});

  let lastErr = null;
  let best = { games: [], count: 0, attempt: null, status: null, next: null };

  async function fetchPage(query, pagesMax) {
    let all = [];
    let q = { ...(query || {}) };
    let pages = 0;
    let nextCursor = null;
    while (pages < (pagesMax || 3)) {
      pages += 1;
      if (nextCursor) q = { ...q, after: nextCursor };
      const res = await novigFetch({ keyId, pem, env, method: 'GET', path: '/v3/catalog/markets', query: q });
      if (res.status >= 400) {
        const err = new Error('Novig ' + res.status + ': ' + ((res.json && (res.json.message || res.json.error)) || (res.text || '').slice(0, 120)));
        err.status = res.status;
        throw err;
      }
      const items = extractItems(res.json);
      all = all.concat(items);
      nextCursor = (res.json && (res.json.next || res.json.cursor || res.json.after)) || null;
      if (!nextCursor || !items.length) break;
      if (all.length >= (Number(limit) || 80) * 2) break;
    }
    return all;
  }

  for (const q of attempts) {
    try {
      const items = await fetchPage(q, 3);
      const games = marketsToGames(items, league || (lg ? String(league || '').toLowerCase() : 'all'));
      if (games.length > best.games.length) {
        best = { games, count: items.length, attempt: q, status: 200, host };
      }
      // Good enough: many markets across types
      const types = {};
      games.forEach((g) => { types[g.marketType] = (types[g.marketType] || 0) + 1; });
      if (games.length >= 15 || (types.moneyline && types.spread) || (types.moneyline && types.total)) break;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403 || e.code === 'NO_KEYS' || e.code === 'BAD_KEY') throw e;
    }
  }

  // Fallback: events → markets per event
  if (!best.games.length) {
    try {
      const res = await novigFetch({ keyId, pem, env, method: 'GET', path: '/v3/catalog/events', query: lg ? { league: lg } : {} });
      const events = extractItems(res.json);
      const collected = [];
      for (const ev of events.slice(0, 20)) {
        const eid = ev.eventId || ev.id;
        if (!eid) continue;
        try {
          const items = await fetchPage({ event: String(eid) }, 2);
          collected.push.apply(collected, items);
        } catch (_) {}
      }
      const games = marketsToGames(collected, league || 'all');
      if (games.length) best = { games, count: collected.length, attempt: 'events', status: 200, host };
    } catch (e) {
      lastErr = e;
    }
  }

  if (!best.games.length && lastErr) throw lastErr;

  return {
    games: best.games.slice(0, Math.min(Number(limit) || 100, 150)),
    host,
    count: best.count,
    attempt: best.attempt,
    rawStatus: best.status,
  };
}


module.exports = { listNovigGames, marketsToGames, novigFetch, hostFor, LEAGUE_MAP, PAPER_HOST, PROD_HOST };
