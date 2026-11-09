/**
 * Kalshi + Novig boards (Hobby-safe single function).
 * Prefer client calls: /api/venues?v=kalshi|novig&league=...&marketType=...
 */
'use strict';

function which(req) {
  const q = req.query || {};
  const v = String(q.v || q.venue || '').toLowerCase();
  if (v === 'novig' || v === 'kalshi') return v;
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
    if (v === 'novig') {
      return require('../lib/routes/novig-games')(req, res);
    }
    return require('../lib/routes/kalshi-games')(req, res);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      venue: v,
      error: String(e.message || e),
      games: [],
      summary: { total: 0, elite: 0, good: 0, live: 0, upcoming: 0 },
    });
  }
};
