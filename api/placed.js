module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};
  const kind = String(q.kind || q.action || 'placed').toLowerCase();
  try {
    if (kind === 'claim' || kind === 'claim-result' || q.result === 'won' || q.result === 'lost') {
      return require('../lib/handlers/claimResult')(req, res);
    }
    return require('../lib/handlers/placedBet')(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
