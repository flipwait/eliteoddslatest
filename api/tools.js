module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const action = String(q.action || (req.body && req.body.action) || '').toLowerCase();
  // route by path leftover or action
  try {
    if (action === 'smart' || action === 'smart-money' || q.slug != null || q.status === '1') {
      if (action === 'odds' || action === 'snapshot' || action === 'logo') {
        /* fall through intentional only if action set */
      } else {
        return require('../lib/handlers/smartMoney')(req, res);
      }
    }
    if (action === 'odds' || action === 'odds-consensus') {
      return require('../lib/handlers/oddsConsensus')(req, res);
    }
    if (action === 'snapshot') {
      return require('../lib/handlers/snapshot')(req, res);
    }
    if (action === 'logo') {
      return require('../lib/handlers/logo')(req, res);
    }
    if (action === 'openai' || action === 'coach' || action === 'ai') {
      return require('./ai')(req, res);
    }
    // default: if POST body looks like odds consensus
    if (req.method === 'POST') {
      const b = req.body || {};
      if (b.action === 'openai' || b.prompt || b.openaiKey || b.apiKey) {
        return require('./ai')(req, res);
      }
      return require('../lib/handlers/oddsConsensus')(req, res);
    }
    return require('../lib/handlers/smartMoney')(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
