const { findTeam } = require('../espn');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const league = String(req.query.league || 'mlb').toLowerCase();
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });

  try {
    const team = await findTeam(league, name);
    if (!team) return res.status(200).json({ ok: false, error: 'team not found' });
    const logos = team.logos || [];
    const preferred =
      logos.find((l) => l.rel && l.rel.includes('full')) ||
      logos.find((l) => l.rel && l.rel.includes('default')) ||
      logos[0];
    const href = preferred && preferred.href;
    return res.status(200).json({
      ok: !!href,
      logo: href || null,
      name: team.displayName || team.shortDisplayName,
      abbreviation: team.abbreviation,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
