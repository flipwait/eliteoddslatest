const { finalResultForEvent, pickWonMoneyline, pickWonTotal } = require('../lib/espn');
const { settleMlbSpecial, isNrfiType, isF5Type } = require('../lib/mlb-settle');
const { settleEsportsSpecial, isEsportsLeague } = require('../lib/esports-settle');

function isMoneylineType(mt) {
  const t = String(mt || '').toLowerCase();
  if (!t || t === 'all') return true;
  return /moneyline|^ml$|winner/.test(t) && !/spread|total|prop|nrfi|f5/.test(t);
}

function isTotalType(mt, pick) {
  const t = String(mt || '').toLowerCase();
  const p = String(pick || '').toLowerCase();
  if (/f5/.test(t) || /f5|first\s*5/.test(p)) return false;
  if (/total|totals|over|under/.test(t)) return true;
  if (/\bover\b|\bunder\b|o\/u/.test(p)) return true;
  return false;
}

/**
 * POST { picks: [...] }
 * Settles moneyline + full-game O/U from ESPN finals,
 * plus MLB NRFI/YRFI + F5 from MLB Stats API linescore.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};
    const picks = Array.isArray(body.picks) ? body.picks.slice(0, 50) : [];
    const pandascoreToken = (body.pandascoreToken || body.pandascore || process.env.PANDASCORE_TOKEN || '').trim();
    const out = [];

    for (const p of picks) {
      const league = String(p.league || 'mlb').toLowerCase();
      const title = p.title || p.eventTitle || '';
      const pick = p.pick || p.modelPick || '';
      const mt = String(p.marketType || 'moneyline').toLowerCase();
      const totalLine = p.totalLine != null ? p.totalLine : null;

      // Esports series / match winner
      if (isEsportsLeague(league)) {
        try {
          out.push(await settleEsportsSpecial(p, { pandascoreToken }));
        } catch (e) {
          out.push({
            key: p.key,
            completed: false,
            error: e.message || 'esports settle failed',
            kind: 'esports-ml',
          });
        }
        continue;
      }

      if (isNrfiType(mt, pick) || isF5Type(mt, pick)) {
        try {
          out.push(await settleMlbSpecial(p));
        } catch (e) {
          out.push({
            key: p.key,
            completed: false,
            error: e.message || 'mlb special settle failed',
            kind: isNrfiType(mt, pick) ? 'nrfi' : 'f5',
          });
        }
        continue;
      }

      const asTotal = isTotalType(mt, pick);
      const asMl = !asTotal && (isMoneylineType(mt) || !mt || mt === 'moneyline');

      if (!asTotal && !asMl) {
        out.push({
          key: p.key,
          skipped: true,
          reason: 'market type not auto-settled (spread/prop) — settle manually',
        });
        continue;
      }

      try {
        const result = await finalResultForEvent(league, title, {
          startTime: p.startTime || p.scheduled || null,
          loggedAt: p.loggedAt || p.at || null,
        });
        if (!result || !result.completed) {
          out.push({
            key: p.key,
            completed: false,
            error: (result && result.error) || 'not final',
            kind: asTotal ? 'total' : 'moneyline',
          });
          continue;
        }

        let outcome = null;
        if (asTotal) outcome = pickWonTotal(pick, result, totalLine);
        else outcome = pickWonMoneyline(pick, result);

        if (!outcome) {
          out.push({
            key: p.key,
            completed: true,
            outcome: null,
            error: 'could not map pick to result',
            score: result.awayScore != null
              ? (result.awayName + ' ' + result.awayScore + ' - ' + result.homeName + ' ' + result.homeScore)
              : null,
            kind: asTotal ? 'total' : 'moneyline',
          });
          continue;
        }

        out.push({
          key: p.key,
          completed: true,
          outcome,
          score: (result.awayName || 'A') + ' ' + result.awayScore + ' - ' + (result.homeName || 'H') + ' ' + result.homeScore,
          kind: asTotal ? 'total' : 'moneyline',
          source: 'espn',
        });
      } catch (e) {
        out.push({
          key: p.key,
          completed: false,
          error: e.message || 'settle failed',
          kind: asTotal ? 'total' : 'moneyline',
        });
      }
    }

    return res.status(200).json({ ok: true, results: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'settle-ml failed' });
  }
};
