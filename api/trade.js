/**
 * Auto-trade: paper | dry-run | live
 * Polymarket US: Ed25519 signed headers (docs.polymarket.us/api/authentication)
 * Kalshi: RSA-SHA256 signed headers
 */
const crypto = require('crypto');

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) { /* fall through */ }
  }
  if (Buffer.isBuffer(req.body) && req.body.length) {
    try { return JSON.parse(req.body.toString('utf8')); } catch (e) { /* fall through */ }
  }
  // Vercel / raw Node: body may only be on the stream
  try {
    if (typeof req[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {}
  return (req.body && typeof req.body === 'object') ? req.body : {};
}

function normalizeMode(body) {
  let mode = String(body.mode || '').toLowerCase();
  if (!mode) {
    if (body.dryRun === false) mode = 'live';
    else if (body.paper === true) mode = 'paper';
    else mode = 'dry-run';
  }
  if (mode === 'dryrun' || mode === 'dry') mode = 'dry-run';
  return mode;
}

function pmPrivateKey(secretRaw) {
  const secret = String(secretRaw || '').trim();
  if (!secret) throw new Error('Missing API secret (Ed25519 secret key from polymarket.us/developer)');

  if (secret.includes('BEGIN')) {
    return crypto.createPrivateKey(secret);
  }

  try {
    return crypto.createPrivateKey({
      key: Buffer.from(secret, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (e1) {}

  try {
    const seed = Buffer.from(secret, 'base64');
    if (seed.length === 32) {
      const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const der = Buffer.concat([prefix, seed]);
      return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
  } catch (e2) {}

  try {
    const seed = Buffer.from(secret.replace(/^0x/, ''), 'hex');
    if (seed.length === 32) {
      const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const der = Buffer.concat([prefix, seed]);
      return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
  } catch (e3) {}

  throw new Error(
    'Could not parse Polymarket secret key. Paste the Secret Key from polymarket.us/developer (shown once). Need Key ID + Secret.'
  );
}

function signPolymarket(method, path, secretRaw) {
  const timestamp = String(Date.now());
  const message = timestamp + String(method).toUpperCase() + path;
  const key = pmPrivateKey(secretRaw);
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
  return { timestamp, signature };
}

function signKalshi(method, path, secretRaw) {
  const timestamp = String(Date.now());
  const message = timestamp + String(method).toUpperCase() + path;
  let pem = String(secretRaw || '').trim();
  if (!pem.includes('BEGIN')) {
    pem = '-----BEGIN PRIVATE KEY-----\n' + pem + '\n-----END PRIVATE KEY-----';
  }
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(pem, 'base64');
  return { timestamp, signature };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = await parseBody(req);
  const mode = normalizeMode(body);

  const venue = String(body.venue || 'polymarket').toLowerCase();
  const pick = body.pick || body.modelPick || '—';
  const title = body.title || body.eventTitle || '';
  const slug = String(body.slug || body.marketSlug || '').trim();
  const ticker = String(body.ticker || body.kalshiTicker || slug || '').trim();
  let marketProb = body.market_probability != null ? Number(body.market_probability) : null;
  const modelProb = body.model_probability != null ? Number(body.model_probability) : null;
  const rank = body.rank || '';
  const units = Number(body.units) || 1;
  const unitSize = Number(body.unitSize) || 5;
  const stake = Math.round(units * unitSize * 100) / 100;
  const maxPrice = body.maxPriceCents != null ? Number(body.maxPriceCents) : 99;
  const side = String(body.side || 'YES').toUpperCase();
  const previewOnly = !!body.previewOnly;

  let price01 = marketProb;
  if (price01 != null && price01 > 1) price01 = price01 / 100;
  if (price01 == null || !Number.isFinite(price01)) price01 = 0.5;
  const priceCents = Math.round(price01 * 1000) / 10;

  if (priceCents != null && maxPrice < 100 && priceCents > maxPrice) {
    return res.status(200).json({
      ok: false,
      mode,
      skipped: true,
      reason: 'Price ' + priceCents + '¢ above max ' + maxPrice + '¢',
    });
  }

  const qty = Math.max(1, Math.round(stake / Math.max(0.01, price01)));

  const intent = {
    mode, venue, pick, title, slug, ticker, rank, stake, units, qty,
    priceCents, modelProb, marketProb: price01, side,
    at: new Date().toISOString(),
  };

  if (mode === 'dry-run') {
    return res.status(200).json({
      ok: true,
      mode: 'dry-run',
      message: 'DRY RUN — no order. Would buy ' + pick + ' @ ~' + priceCents + '¢ × ' + qty + ' (~$' + stake + ') slug=' + (slug || ticker || '?'),
      intent,
    });
  }

  if (mode === 'paper') {
    return res.status(200).json({
      ok: true,
      mode: 'paper',
      paper: true,
      message: 'PAPER FILL — ' + units + 'u on ' + pick + ' @ ~' + priceCents + '¢ ($' + stake + ' paper). No exchange order.',
      intent,
      fill: { status: 'paper_filled', pick, units, stake, priceCents, venue, qty },
    });
  }

  const apiKey = String(body.apiKey || body.pmApiKey || '').trim();
  const apiSecret = String(body.apiSecret || body.pmApiSecret || '').trim();

  if (venue === 'kalshi' || venue.indexOf('kalshi') >= 0) {
    if (!apiKey || !apiSecret) {
      return res.status(200).json({ ok: false, mode: 'live', error: 'Kalshi live needs API Key ID + private key PEM in Settings.', intent });
    }
    if (!ticker) {
      return res.status(200).json({ ok: false, mode: 'live', error: 'Missing Kalshi ticker on this card.', intent });
    }
    try {
      const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
      const path = '/trade-api/v2/portfolio/orders';
      const yesPrice = Math.round(price01 * 100);
      const order = {
        ticker: ticker,
        client_order_id: 'eo-' + Date.now(),
        action: 'buy',
        side: side === 'NO' ? 'no' : 'yes',
        count: qty,
        type: 'limit',
        yes_price: side === 'NO' ? undefined : yesPrice,
        no_price: side === 'NO' ? yesPrice : undefined,
      };
      const signed = signKalshi('POST', path, apiSecret);
      const r = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': apiKey,
          'KALSHI-ACCESS-SIGNATURE': signed.signature,
          'KALSHI-ACCESS-TIMESTAMP': signed.timestamp,
        },
        body: JSON.stringify(order),
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 400) }; }
      if (!r.ok) {
        return res.status(200).json({
          ok: false, mode: 'live',
          error: 'Kalshi ' + r.status + ': ' + (data.message || data.error || text.slice(0, 180)),
          intent, response: data,
        });
      }
      return res.status(200).json({
        ok: true, mode: 'live', live: true,
        message: 'LIVE Kalshi order submitted for ' + pick,
        intent, order: data,
      });
    } catch (e) {
      return res.status(200).json({ ok: false, mode: 'live', error: 'Kalshi live error: ' + (e.message || e), intent });
    }
  }

  if (!apiKey) {
    return res.status(200).json({
      ok: false, mode: 'live',
      error: 'Add Polymarket Key ID in Settings → Auto-trade (from polymarket.us/developer).',
      intent,
    });
  }
  if (!apiSecret) {
    return res.status(200).json({
      ok: false, mode: 'live',
      error: 'Add Polymarket Secret Key in Settings (shown once at key creation). Live needs Key ID + Secret for Ed25519 signing.',
      intent,
    });
  }
  if (!slug) {
    return res.status(200).json({
      ok: false, mode: 'live',
      error: 'Missing market slug on this card — open Trade manually or re-scan.',
      intent,
    });
  }

  try {
    const base = process.env.POLYMARKET_US_API || 'https://api.polymarket.us';
    const path = previewOnly ? '/v1/order/preview' : '/v1/orders';
    const orderBody = {
      marketSlug: slug,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: price01.toFixed(3), currency: 'USD' },
      quantity: qty,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
      intent: side === 'NO' ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_BUY_LONG',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    };

    let signed;
    try {
      signed = signPolymarket('POST', path, apiSecret);
    } catch (signErr) {
      return res.status(200).json({
        ok: false, mode: 'live',
        error: 'Sign failed: ' + (signErr.message || signErr),
        intent,
        hint: 'Secret Key must be the Polymarket US developer secret (Ed25519). Key ID in API key field.',
      });
    }

    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-PM-Access-Key': apiKey,
        'X-PM-Timestamp': signed.timestamp,
        'X-PM-Signature': signed.signature,
      },
      body: JSON.stringify(orderBody),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }

    if (!r.ok) {
      const errMsg = (data && (data.message || data.error || data.detail)) || text.slice(0, 220) || 'unknown';
      return res.status(200).json({
        ok: false, mode: 'live',
        error: 'Polymarket ' + r.status + ': ' + errMsg,
        intent, orderBody, path: base + path,
        hint:
          r.status === 401 || r.status === 403
            ? 'Auth failed — use Key ID + Secret from polymarket.us/developer (US app developer portal).'
            : r.status === 400
              ? 'Bad request — check market slug and quantity for this market.'
              : 'See error body from Polymarket.',
      });
    }

    const orderId = (data && (data.id || data.orderId || (data.order && data.order.id))) || null;
    return res.status(200).json({
      ok: true, mode: 'live', live: true,
      message: (previewOnly ? 'PREVIEW OK — ' : 'LIVE order submitted — ') + pick + ' @ ' + priceCents + '¢ × ' + qty + (orderId ? ' · id ' + orderId : ''),
      intent, order: data, orderId,
    });
  } catch (e) {
    return res.status(200).json({
      ok: false, mode: 'live',
      error: 'Polymarket live error: ' + (e.message || e),
      intent,
    });
  }
};
