/**
 * EXPERIMENTAL — Polymarket US Combos
 * POST /v1/combos create instrument from legs
 * Does NOT place the trade by default — create only; user confirms in PM app or later order step
 * Docs: docs.polymarket.us/api-reference/combos
 */
const crypto = require('crypto');

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) {}
  }
  if (Buffer.isBuffer(req.body) && req.body.length) {
    try { return JSON.parse(req.body.toString('utf8')); } catch (e) {}
  }
  try {
    if (typeof req[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {}
  return {};
}

function decodePmSecretBytes(secretRaw) {
  let secret = String(secretRaw || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  if (!secret) throw new Error('Empty secret key');
  function b64(s) {
    let x = s.replace(/-/g, '+').replace(/_/g, '/');
    while (x.length % 4) x += '=';
    return Buffer.from(x, 'base64');
  }
  if (secret.includes('BEGIN')) return { kind: 'pem', pem: String(secretRaw) };
  let bytes = b64(secret);
  if (bytes.length === 64) bytes = bytes.subarray(0, 32);
  if (bytes.length === 32) return { kind: 'seed', seed: bytes };
  if (bytes.length > 32) {
    try {
      crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
      return { kind: 'der', der: bytes };
    } catch (e) {}
  }
  throw new Error('Bad PM secret length ' + bytes.length);
}

function pmPrivateKey(secretRaw) {
  const d = decodePmSecretBytes(secretRaw);
  if (d.kind === 'pem') return crypto.createPrivateKey(d.pem);
  if (d.kind === 'der') return crypto.createPrivateKey({ key: d.der, format: 'der', type: 'pkcs8' });
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return crypto.createPrivateKey({ key: Buffer.concat([prefix, d.seed]), format: 'der', type: 'pkcs8' });
}

function signPolymarket(method, path, secretRaw) {
  const timestamp = String(Date.now());
  const message = timestamp + String(method).toUpperCase() + path;
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), pmPrivateKey(secretRaw)).toString('base64');
  return { timestamp, signature };
}

function estimateCombo(legs) {
  // Rough independent product — NOT the RFQ price PM shows
  let p = 1;
  let n = 0;
  const detail = [];
  for (const leg of legs || []) {
    let px = Number(leg.price01 != null ? leg.price01 : leg.price);
    if (px > 1) px = px / 100;
    if (!(px > 0.02 && px < 0.98)) continue;
    p *= px;
    n += 1;
    detail.push({ symbol: leg.symbol || leg.slug, price: Math.round(px * 1000) / 10 });
  }
  if (n < 2) return { ok: false, error: 'Need at least 2 priced legs' };
  const mult = p > 0 ? 1 / p : null;
  return {
    ok: true,
    experimental: true,
    disclaimer: 'Estimate only (product of leg prices). Polymarket Combo uses RFQ — live quote will differ.',
    legCount: n,
    impliedProb: Math.round(p * 1000) / 10,
    roughMultiplier: mult != null ? Math.round(mult * 100) / 100 : null,
    stake10Pays: mult != null ? Math.round(10 * mult * 100) / 100 : null,
    legs: detail,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        experimental: true,
        service: 'combo',
        note: 'POST { action: estimate|create, legs: [{ symbol, side, price01? }] }',
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const body = await parseBody(req);
    const action = String(body.action || 'estimate').toLowerCase();
    const legsIn = Array.isArray(body.legs) ? body.legs : [];

    if (action === 'estimate') {
      return res.status(200).json(estimateCombo(legsIn));
    }

    if (action === 'create') {
      // Normalize legs for PM API
      const legs = [];
      for (const L of legsIn) {
        const symbol = String(L.symbol || L.slug || L.marketSlug || '').trim();
        if (!symbol) continue;
        let side = String(L.side || 'SIDE_BUY').toUpperCase();
        if (side === 'BUY' || side === 'YES' || side === 'LONG') side = 'SIDE_BUY';
        if (side === 'SELL' || side === 'NO' || side === 'SHORT') side = 'SIDE_SELL';
        if (side !== 'SIDE_BUY' && side !== 'SIDE_SELL') side = 'SIDE_BUY';
        legs.push({ symbol, side });
      }
      // dedupe symbols
      const seen = {};
      const uniq = [];
      for (const L of legs) {
        if (seen[L.symbol]) continue;
        seen[L.symbol] = 1;
        uniq.push(L);
      }
      if (uniq.length < 2) {
        return res.status(400).json({
          ok: false,
          experimental: true,
          error: 'Need at least 2 unique market symbols for a combo',
        });
      }
      if (uniq.length > 10) {
        return res.status(400).json({ ok: false, error: 'Max 10 legs in experimental mode' });
      }

      const est = estimateCombo(legsIn);

      // Dry / paper — no API call
      const mode = String(body.mode || 'dry-run').toLowerCase();
      if (mode === 'paper' || mode === 'dry-run' || mode === 'dry' || body.dryRun) {
        return res.status(200).json({
          ok: true,
          experimental: true,
          mode: mode === 'paper' ? 'paper' : 'dry-run',
          message: 'Combo NOT created on Polymarket (experimental dry-run). Use mode:live with keys to POST /v1/combos.',
          wouldCreate: { legs: uniq },
          estimate: est,
          manualHint: 'Open polymarket.us → Build a Combo → add these markets manually if you prefer.',
        });
      }

      const apiKey = String(body.apiKey || body.pmApiKey || process.env.PM_API_KEY || '').trim();
      const apiSecret = String(body.apiSecret || body.pmApiSecret || process.env.PM_API_SECRET || '').trim();
      if (!apiKey || !apiSecret) {
        return res.status(400).json({
          ok: false,
          experimental: true,
          error: 'Live create needs Polymarket API Key + Secret in Settings (same as auto-trade).',
          estimate: est,
          wouldCreate: { legs: uniq },
        });
      }

      const base = process.env.POLYMARKET_US_API || 'https://api.polymarket.us';
      const path = '/v1/combos';
      const { timestamp, signature } = signPolymarket('POST', path, apiSecret);
      const payload = JSON.stringify({ legs: uniq });

      const r = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PM-Access-Key': apiKey,
          'X-PM-Timestamp': timestamp,
          'X-PM-Signature': signature,
        },
        body: payload,
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }

      if (!r.ok) {
        return res.status(200).json({
          ok: false,
          experimental: true,
          mode: 'live',
          httpStatus: r.status,
          error: (data && (data.error || data.message)) || ('HTTP ' + r.status),
          detail: data,
          estimate: est,
          wouldCreate: { legs: uniq },
          manualHint: 'API create failed — build the same legs in the Polymarket app under Build a Combo.',
        });
      }

      const combo = data.combo || data;
      return res.status(200).json({
        ok: true,
        experimental: true,
        mode: 'live',
        message: 'Combo instrument created/retrieved. Open Polymarket to RFQ/trade it, or use Orders on the combo symbol.',
        combo,
        estimate: est,
        legs: uniq,
      });
    }

    return res.status(400).json({ error: 'action must be estimate or create' });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      experimental: true,
      error: String(e.message || e),
    });
  }
};
