/**
 * Novig Sports Trading API (v3) — Paper + Production
 * Docs: https://docs.novig.com
 * Access: free self-serve keys (Profile → Settings → Novig API)
 * LP $30k deposit is NOT required for normal trading API.
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PAPER_HOST = 'api.paper.novig.com';
const PROD_HOST = 'api.novig.com';

function hostFor(env) {
  return String(env || '').toLowerCase() === 'prod' || String(env || '').toLowerCase() === 'production'
    ? PROD_HOST
    : PAPER_HOST;
}

function loadPrivateKey(pemOrB64) {
  if (!pemOrB64) return null;
  let raw = String(pemOrB64).trim();
  // allow pasted PEM or base64 of PEM
  if (!raw.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 80) {
    try {
      raw = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (_) {}
  }
  if (!raw.includes('BEGIN')) {
    // wrap raw base64 PKCS8
    const b64 = raw.replace(/\s+/g, '');
    raw = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  }
  try {
    return crypto.createPrivateKey(raw);
  } catch (e) {
    try {
      return crypto.createPrivateKey({ key: raw, format: 'pem' });
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Sign request per Novig v3 style:
 * payload = timestamp + "\n" + METHOD + "\n" + pathWithQuery + "\n" + body
 */
function signRequest({ keyId, privateKey, method, pathWithQuery, body, timestamp }) {
  const ts = String(timestamp || Date.now());
  const bodyStr = body == null || body === '' ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const payload = `${ts}\n${String(method || 'GET').toUpperCase()}\n${pathWithQuery}\n${bodyStr}`;
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
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
    const opts = {
      hostname: host,
      path: pathWithQuery,
      method: method || 'GET',
      headers: { ...(headers || {}) },
      timeout: timeoutMs || 18000,
    };
    if (bodyStr) {
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = { raw: text };
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Novig timeout'));
    });
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
  let pathWithQuery = path.startsWith('/') ? path : `/${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v != null && v !== '') qs.set(k, String(v));
    });
    pathWithQuery += (pathWithQuery.includes('?') ? '&' : '?') + qs.toString();
  }
  const headers = signRequest({
    keyId,
    privateKey,
    method: method || 'GET',
    pathWithQuery,
    body,
  });
  return httpsJson({ host, method: method || 'GET', pathWithQuery, headers, body });
}

const LEAGUE_MAP = {
  nfl: 'NFL',
  nba: 'NBA',
  mlb: 'MLB',
  nhl: 'NHL',
  cfb: 'NCAAF',
  ncaaf: 'NCAAF',
  cbb: 'NCAAB',
  ncaab: 'NCAAB',
  wnba: 'WNBA',
  soccer: 'SOCCER',
  ufc: 'UFC',
};

function mapMarketType(mt) {
  const u = String(mt || '').toUpperCase();
  if (u === 'MONEY' || u === 'MONEYLINE') return 'moneyline';
  if (u === 'SPREAD') return 'spread';
  if (u === 'TOTAL') return 'total';
  if (u === 'TEAM_TOTAL') return 'team_total';
  if (/PASSING|RUSHING|RECEPTION|PLAYER|POINTS|ASSISTS|REBOUNDS/.test(u)) return 'player_prop';
  return String(mt || 'moneyline').toLowerCase();
}

/**
 * Normalize Novig catalog markets → EliteOdds game cards
 */
function marketsToGames(items, leagueHint) {
  const games = [];
  const list = Array.isArray(items) ? items : [];
  for (const m of list) {
    try {
      const outcomes = m.outcomes || m.outcome || [];
      if (!outcomes.length) continue;
      const mt = mapMarketType(m.marketType || m.type);
      const o0 = outcomes[0] || {};
      const o1 = outcomes[1] || {};
      const p0 = parseFloat(o0.last || o0.bid?.price || o0.price || '') || null;
      const p1 = parseFloat(o1.last || o1.bid?.price || o1.price || '') || null;
      // Novig prices are probabilities 0-1
      const pct0 = p0 != null ? Math.round(p0 * 1000) / 10 : null;
      const pct1 = p1 != null ? Math.round(p1 * 1000) / 10 : null;
      const title =
        m.description ||
        m.eventDescription ||
        [m.awayName || m.away, m.homeName || m.home].filter(Boolean).join(' vs. ') ||
        'Novig market';
      const startMs = m.startsTs || m.startTs || m.scheduledStart || null;
      const startTime = startMs
        ? new Date(typeof startMs === 'number' ? startMs : Date.parse(startMs)).toISOString()
        : null;
      const sides = outcomes.map((o, i) => ({
        name: o.name || o.outcomeName || `Side ${i + 1}`,
        pct: i === 0 ? pct0 : pct1,
        price: i === 0 ? p0 : p1,
        outcomeId: o.outcomeId || o.id,
      }));
      // Prefer higher model lean later; for now market-led pick = favorite
      let modelPick = sides[0]?.name || '—';
      if (pct0 != null && pct1 != null) {
        modelPick = pct0 >= pct1 ? sides[0].name : sides[1].name;
      }
      const mktPct = modelPick === sides[0]?.name ? pct0 : pct1;
      const strike = m.strike != null ? Number(m.strike) : null;
      games.push({
        id: `novig-${m.marketId || m.id || crypto.randomBytes(6).toString('hex')}`,
        venue: 'novig',
        source: 'novig',
        league: String(leagueHint || m.league || m.sport || '').toLowerCase() || 'nfl',
        marketType: mt,
        title,
        eventTitle: title,
        startTime,
        live: String(m.status || '').toUpperCase().includes('INGAME') || String(m.status || '').toUpperCase() === 'LIVE',
        ended: /FINAL|SETTLED|CLOSED/i.test(String(m.status || '')),
        marketId: m.marketId || m.id,
        eventId: m.eventId,
        outcomeId: sides.find((s) => s.name === modelPick)?.outcomeId || sides[0]?.outcomeId,
        sides,
        yesPrice: p0,
        noPrice: p1,
        market_probability: mktPct,
        modelPick,
        line: strike,
        spreadLine: mt === 'spread' ? strike : null,
        totalLine: mt === 'total' || mt === 'team_total' ? strike : null,
        volume: m.volume || 0,
        liquidity: m.openInterest || 0,
        url: 'https://novig.com',
        marketUrl: 'https://novig.com',
        novig: true,
        fee: m.fee || null,
      });
    } catch (_) {
      /* skip bad row */
    }
  }
  return games;
}

async function listNovigGames({ keyId, pem, env, league, limit }) {
  const lg = LEAGUE_MAP[String(league || '').toLowerCase()] || (league && league !== 'all' ? String(league).toUpperCase() : null);
  const query = { limit: Math.min(Number(limit) || 40, 100) };
  if (lg) query.league = lg;
  // Try catalog markets
  const res = await novigFetch({
    keyId,
    pem,
    env,
    method: 'GET',
    path: '/v3/catalog/markets',
    query,
  });
  if (res.status >= 400) {
    const msg = (res.json && (res.json.message || res.json.error)) || res.text?.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(`Novig catalog ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = res.json;
    throw err;
  }
  const items = res.json?.items || res.json?.markets || res.json?.data || [];
  return {
    games: marketsToGames(items, league),
    host: hostFor(env),
    count: items.length,
    rawStatus: res.status,
  };
}

async function echoTest({ keyId, pem, env }) {
  return novigFetch({
    keyId,
    pem,
    env,
    method: 'POST',
    path: '/v3/echo',
    body: { eliteodds: true, ts: Date.now() },
  });
}

module.exports = {
  listNovigGames,
  marketsToGames,
  novigFetch,
  echoTest,
  hostFor,
  LEAGUE_MAP,
  PAPER_HOST,
  PROD_HOST,
};
