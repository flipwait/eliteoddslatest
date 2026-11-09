/**
 * Kalshi + Novig board under one Hobby-safe function.
 * Rewrites: /api/kalshi-games → venues?v=kalshi, /api/novig-games → venues?v=novig
 */
'use strict';

function which(req) {
  const q = req.query || {};
  if (q.v) return String(q.v).toLowerCase();
  if (q.venue) return String(q.venue).toLowerCase();
  const u = String(req.url || '').toLowerCase();
  if (u.indexOf('novig') >= 0) return 'novig';
  if (u.indexOf('kalshi') >= 0) return 'kalshi';
  return 'kalshi';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const v = which(req);
  try {
    if (v === 'novig') return require('../lib/routes/novig-games')(req, res);
    return require('../lib/routes/kalshi-games')(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e), venue: v });
  }
};
