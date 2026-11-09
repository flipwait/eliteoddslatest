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
  if (u === 'MONEY' || u === 'MONEYLINE' || u === 'ML') return 'moneyline';
  if (u === 'SPREAD') return 'spread';
  if (u === 'TOTAL') return 'total';
  if (u === 'TEAM_TOTAL') return 'team_total';
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

function marketsToGames(items, leagueHint) {
  const games = [];
  for (const m of (items || [])) {
    try {
      const outcomes = m.outcomes || m.outcome || m.contracts || [];
      const mt = mapMarketType(m.marketType || m.type || m.market_type);
      const o0 = outcomes[0] || {};
      const o1 = outcomes[1] || {};
      const p0 = parseFloat(o0.last || (o0.bid && o0.bid.price) || o0.price || '') || null;
      const p1 = parseFloat(o1.last || (o1.bid && o1.bid.price) || o1.price || '') || null;
      const toPct = (p) => (p == null ? null : (p > 1 ? Math.round(p * 10) / 10 : Math.round(p * 1000) / 10));
      const pct0 = toPct(p0);
      const pct1 = toPct(p1);
      const title = m.description || m.eventDescription || m.title || m.name ||
        [m.awayName || m.away, m.homeName || m.home].filter(Boolean).join(' vs. ') || 'Novig market';
      const startMs = m.startsTs || m.startTs || m.scheduledStart || m.startTime || null;
      let startTime = null;
      if (startMs) {
        const n = typeof startMs === 'number' ? startMs : Date.parse(startMs);
        if (Number.isFinite(n)) startTime = new Date(n < 1e12 ? n * 1000 : n).toISOString();
      }
      const sides = (outcomes.length ? outcomes : [{ name: 'Yes' }, { name: 'No' }]).map((o, i) => ({
        name: o.name || o.outcomeName || o.team || ('Side ' + (i + 1)),
        pct: i === 0 ? pct0 : pct1,
        price: i === 0 ? p0 : p1,
        outcomeId: o.outcomeId || o.id,
      }));
      let modelPick = sides[0] ? sides[0].name : '—';
      if (pct0 != null && pct1 != null) modelPick = pct0 >= pct1 ? sides[0].name : sides[1].name;
      const mktPct = modelPick === (sides[0] && sides[0].name) ? pct0 : pct1;
      const strike = m.strike != null ? Number(m.strike) : null;
      const status = String(m.status || m.eventStatus || '').toUpperCase();
      games.push({
        id: 'novig-' + (m.marketId || m.id || crypto.randomBytes(6).toString('hex')),
        venue: 'novig', source: 'novig',
        league: String(leagueHint || m.league || m.sport || 'nfl').toLowerCase(),
        marketType: mt, title, eventTitle: title, startTime,
        live: /INGAME|LIVE|IN_PLAY/.test(status),
        ended: /FINAL|SETTLED|CLOSED|RESOLVED/.test(status),
        marketId: m.marketId || m.id, eventId: m.eventId,
        sides, yesPrice: p0, noPrice: p1, market_probability: mktPct, modelPick,
        line: strike, spreadLine: mt === 'spread' ? strike : null,
        totalLine: (mt === 'total' || mt === 'team_total') ? strike : null,
        volume: m.volume || 0, url: 'https://novig.com', marketUrl: 'https://novig.com',
        novig: true, rank: 'Pass', hasForm: false,
      });
    } catch (_) {}
  }
  return games;
}

async function listNovigGames({ keyId, pem, env, league, limit }) {
  const host = hostFor(env);
  const lg = LEAGUE_MAP[String(league || '').toLowerCase()] || null;
  const attempts = [
    { eventStatus: 'OPEN', marketType: 'MONEY' },
    { eventStatus: 'OPEN' },
    { marketType: 'MONEY' },
    { marketType: 'MONEY,SPREAD,TOTAL' },
    {},
  ];
  if (lg) {
    attempts.push({ league: lg, eventStatus: 'OPEN' });
    attempts.push({ league: lg, marketType: 'MONEY' });
    attempts.push({ league: lg });
  }

  let lastErr = null;
  let best = { games: [], count: 0, attempt: null, status: null };

  for (const q of attempts) {
    try {
      const res = await novigFetch({ keyId, pem, env, method: 'GET', path: '/v3/catalog/markets', query: q });
      if (res.status >= 400) {
        lastErr = new Error('Novig ' + res.status + ': ' + ((res.json && (res.json.message || res.json.error)) || (res.text || '').slice(0, 120)));
        lastErr.status = res.status;
        if (res.status === 401 || res.status === 403) throw lastErr;
        continue;
      }
      const items = extractItems(res.json);
      const games = marketsToGames(items, league || (lg ? String(league || '').toLowerCase() : 'all'));
      if (games.length > best.games.length) best = { games, count: items.length, attempt: q, status: res.status, host };
      if (games.length >= 5) break;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403 || e.code === 'NO_KEYS' || e.code === 'BAD_KEY') throw e;
    }
  }

  if (!best.games.length) {
    try {
      const res = await novigFetch({ keyId, pem, env, method: 'GET', path: '/v3/catalog/events', query: lg ? { league: lg } : {} });
      const events = extractItems(res.json);
      const collected = [];
      for (const ev of events.slice(0, 12)) {
        const eid = ev.eventId || ev.id;
        if (!eid) continue;
        try {
          const mr = await novigFetch({ keyId, pem, env, method: 'GET', path: '/v3/catalog/markets', query: { event: String(eid) } });
          collected.push.apply(collected, extractItems(mr.json));
        } catch (_) {}
      }
      const games = marketsToGames(collected, league || 'all');
      if (games.length) best = { games, count: collected.length, attempt: 'events', status: 200, host };
    } catch (e) { lastErr = e; }
  }

  if (!best.games.length && lastErr) throw lastErr;

  return {
    games: best.games.slice(0, Math.min(Number(limit) || 80, 100)),
    host, count: best.count, attempt: best.attempt, rawStatus: best.status,
  };
}

module.exports = { listNovigGames, marketsToGames, novigFetch, hostFor, LEAGUE_MAP, PAPER_HOST, PROD_HOST };
