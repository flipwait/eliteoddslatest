/**
 * Auto-trade: paper | dry-run | live
 * paper  — log paper fill only (no exchange)
 * dry-run — simulate order, no money
 * live   — attempt real order (venue APIs; requires keys)
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  let mode = String(body.mode || '').toLowerCase();
  if (!mode) {
    if (body.dryRun === false) mode = 'live';
    else if (body.paper === true) mode = 'paper';
    else mode = 'dry-run';
  }
  if (mode === 'dryrun' || mode === 'dry') mode = 'dry-run';

  const venue = String(body.venue || 'polymarket').toLowerCase();
  const pick = body.pick || body.modelPick || '—';
  const title = body.title || body.eventTitle || '';
  const slug = body.slug || body.marketSlug || '';
  const ticker = body.ticker || body.kalshiTicker || slug;
  let marketProb = body.market_probability != null ? Number(body.market_probability) : null;
  const modelProb = body.model_probability != null ? Number(body.model_probability) : null;
  const rank = body.rank || '';
  const units = Number(body.units) || 1;
  const unitSize = Number(body.unitSize) || 5;
  const stake = Math.round(units * unitSize * 100) / 100;
  const maxPrice = body.maxPriceCents != null ? Number(body.maxPriceCents) : 99;
  const side = String(body.side || 'YES').toUpperCase();

  let price01 = marketProb;
  if (price01 != null && price01 > 1) price01 = price01 / 100;
  const priceCents = price01 != null ? Math.round(price01 * 1000) / 10 : null;

  if (priceCents != null && maxPrice < 100 && priceCents > maxPrice) {
    return res.status(200).json({
      ok: false,
      mode,
      skipped: true,
      reason: 'Price ' + priceCents + '¢ above max ' + maxPrice + '¢',
    });
  }

  const intent = {
    mode,
    venue,
    pick,
    title,
    slug,
    ticker,
    rank,
    stake,
    units,
    priceCents,
    modelProb,
    marketProb: price01,
    side,
    at: new Date().toISOString(),
  };

  if (mode === 'dry-run') {
    return res.status(200).json({
      ok: true,
      mode: 'dry-run',
      message: 'DRY RUN — no order, no paper. Would buy ' + pick + ' @ ~' + (priceCents != null ? priceCents + '¢' : '?') + ' for $' + stake,
      intent,
    });
  }

  if (mode === 'paper') {
    return res.status(200).json({
      ok: true,
      mode: 'paper',
      paper: true,
      message: 'PAPER FILL — logged ' + units + 'u on ' + pick + ' @ ~' + (priceCents != null ? priceCents + '¢' : '?') + ' ($' + stake + ' paper). No exchange order.',
      intent,
      fill: {
        status: 'paper_filled',
        pick,
        units,
        stake,
        priceCents,
        venue,
      },
    });
  }

  // —— LIVE ——
  const apiKey = body.apiKey || body.pmApiKey || '';
  const apiSecret = body.apiSecret || body.pmApiSecret || '';
  const apiPass = body.apiPass || body.pmApiPass || '';

  if (venue === 'kalshi' || venue.indexOf('kalshi') >= 0) {
    if (!apiKey || !apiSecret) {
      return res.status(200).json({
        ok: false,
        mode: 'live',
        error: 'Kalshi live needs API Key ID + private key (Settings).',
        intent,
      });
    }
    // Best-effort: client should use official Kalshi signing; we attempt demo-style post if secret is PEM
    try {
      const crypto = require('crypto');
      const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
      const path = '/trade-api/v2/portfolio/orders';
      const timestamp = String(Date.now());
      const method = 'POST';
      const count = Math.max(1, Math.round(stake / Math.max(0.01, price01 || 0.5)));
      const yesPrice = Math.round((price01 != null ? price01 : 0.5) * 100);
      const order = {
        ticker: ticker,
        client_order_id: 'eo-' + Date.now(),
        action: 'buy',
        side: side === 'NO' ? 'no' : 'yes',
        count: count,
        type: 'limit',
        yes_price: side === 'NO' ? undefined : yesPrice,
        no_price: side === 'NO' ? yesPrice : undefined,
      };
      let signature = '';
      try {
        const signPayload = timestamp + method + path;
        const key = apiSecret.includes('BEGIN') ? apiSecret : apiSecret;
        signature = crypto.createSign('RSA-SHA256').update(signPayload).sign(
          key.includes('BEGIN') ? key : '-----BEGIN PRIVATE KEY-----\n' + key + '\n-----END PRIVATE KEY-----',
          'base64'
        );
      } catch (sigErr) {
        return res.status(200).json({
          ok: false,
          mode: 'live',
          error: 'Kalshi key sign failed: ' + (sigErr.message || sigErr) + '. Check PEM private key format.',
          intent,
        });
      }
      const r = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'KALSHI-ACCESS-KEY': apiKey,
          'KALSHI-ACCESS-SIGNATURE': signature,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
        },
        body: JSON.stringify(order),
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      if (!r.ok) {
        return res.status(200).json({
          ok: false,
          mode: 'live',
          error: 'Kalshi order rejected: ' + (data.error || data.message || text.slice(0, 200)),
          intent,
          response: data,
        });
      }
      return res.status(200).json({
        ok: true,
        mode: 'live',
        live: true,
        message: 'LIVE Kalshi order submitted for ' + pick,
        intent,
        order: data,
      });
    } catch (e) {
      return res.status(200).json({
        ok: false,
        mode: 'live',
        error: 'Kalshi live error: ' + (e.message || e),
        intent,
      });
    }
  }

  // Polymarket US live
  if (!apiKey) {
    return res.status(200).json({
      ok: false,
      mode: 'live',
      error: 'Polymarket live needs API key in Settings (and secret/passphrase when required).',
      intent,
    });
  }

  try {
    const base = process.env.POLYMARKET_US_API || 'https://api.polymarket.us';
    // Resolve market
    let marketMeta = null;
    if (slug) {
      try {
        const mr = await fetch('https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug), {
          headers: { Accept: 'application/json' },
        });
        if (mr.ok) marketMeta = await mr.json();
      } catch (eM) {}
    }

    const qty = Math.max(1, Math.round(stake / Math.max(0.01, price01 || 0.5)));
    const orderBody = {
      marketSlug: slug,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: String(price01 != null ? price01.toFixed(3) : '0.50'), currency: 'USD' },
      quantity: qty,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
      intent: side === 'NO' ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_BUY_LONG',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    };

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    if (apiPass) headers['X-API-PASS'] = apiPass;
    if (apiSecret) headers['X-API-SECRET'] = apiSecret;

    const r = await fetch(base + '/v1/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify(orderBody),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 400) }; }

    if (!r.ok) {
      return res.status(200).json({
        ok: false,
        mode: 'live',
        error: 'Polymarket order not accepted (' + r.status + '): ' + (data.message || data.error || text.slice(0, 180)),
        intent,
        orderBody,
        marketMeta: marketMeta ? { slug: marketMeta.slug || slug } : null,
        hint: 'Confirm API key is a Polymarket US trading key. Card Trade still works for manual fills.',
      });
    }

    return res.status(200).json({
      ok: true,
      mode: 'live',
      live: true,
      message: 'LIVE Polymarket order submitted for ' + pick,
      intent,
      order: data,
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      mode: 'live',
      error: 'Polymarket live error: ' + (e.message || e),
      intent,
    });
  }
};
