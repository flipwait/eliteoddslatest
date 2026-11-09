/**
 * Hobby-plan consolidation — one function for secondary routes.
 * vercel.json rewrites:
 *   /api/discord /api/combo /api/feed /api/placed /api/settle-ml /api/tools → /api/misc
 */
'use strict';

function pathOf(req) {
  try {
    const u = String(req.url || '');
    // "/api/discord?x=1" or rewritten "/api/misc"
    const path = u.split('?')[0].toLowerCase();
    return path;
  } catch (e) {
    return '';
  }
}

function actionOf(req) {
  const q = req.query || {};
  if (q.action) return String(q.action).toLowerCase();
  if (q.route) return String(q.route).toLowerCase();
  const p = pathOf(req);
  if (p.indexOf('discord') >= 0) return 'discord';
  if (p.indexOf('combo') >= 0) return 'combo';
  if (p.indexOf('feed') >= 0) return 'feed';
  if (p.indexOf('placed') >= 0) return 'placed';
  if (p.indexOf('settle') >= 0) return 'settle-ml';
  if (p.indexOf('tools') >= 0) return 'tools';
  if (p.indexOf('potd') >= 0) return 'potd';
  return String(q.action || 'tools').toLowerCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = actionOf(req);
  try {
    if (action === 'discord') return require('../lib/routes/discord')(req, res);
    if (action === 'combo') return require('../lib/routes/combo')(req, res);
    if (action === 'feed') return require('../lib/routes/feed')(req, res);
    if (action === 'placed') return require('../lib/routes/placed')(req, res);
    if (action === 'settle-ml' || action === 'settle') return require('../lib/routes/settle-ml')(req, res);
    if (action === 'potd') return require('../lib/routes/potd')(req, res);
    // default tools (smart money, odds, snapshot, logo, …)
    return require('../lib/routes/tools')(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e), action });
  }
};
