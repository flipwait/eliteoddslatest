const { finalResultForEvent, pickWonMoneyline, pickWonTotal } = require('../lib/espn');

function isMoneylineType(mt) {
  const t = String(mt || '').toLowerCase();
  if (!t || t === 'all') return true;
  return /moneyline|^ml$|winner/.test(t) && !/spread|total|prop|nrfi/.test(t);
}

function isTotalType(mt, pick) {
  const t = String(mt || '').toLowerCase();
  const p = String(pick || '').toLowerCase();
  if (/f5/.test(t) || /f5|first\s*5/.test(p)) return false; // FG only for auto
  if (/total|totals|over|under/.test(t)) return true;
  if (/\bover\b|\bunder\b|o\/u/.test(p)) return true;
  return false;
}

/**
 * POST { picks: [{ key, league, title, pick, marketType, totalLine, startTime }] }
 * Settles moneyline + full-game over/under from ESPN finals.
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
    const out = [];

    for (const p of picks) {
      const league = String(p.league || 'mlb').toLowerCase();
      const title = p.title || p.eventTitle || '';
      const pick = p.pick || p.modelPick || '';
      const mt = String(p.marketType || 'moneyline').toLowerCase();
      const totalLine = p.totalLine != null ? p.totalLine : null;

      const asTotal = isTotalType(mt, pick);
      const asMl = !asTotal && (isMoneylineType(mt) || (!mt || mt === 'moneyline'));

      if (!asTotal && !asMl) {
        out.push({ key: p.key, skipped: true, reason: 'market type not auto-settled (spread/prop/F5) — settle manually' });
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
        if (asTotal) {
          outcome = pickWonTotal(pick, result, totalLine);
        } else {
          outcome = pickWonMoneyline(pick, result);
        }

        const totalPts =
          result.homeScore != null && result.awayScore != null
            ? Number(result.homeScore) + Number(result.awayScore)
            : null;

        out.push({
          key: p.key,
          completed: true,
          kind: asTotal ? 'total' : 'moneyline',
          outcome, // won | lost | push | null
          winnerName: result.winnerName,
          totalPoints: totalPts,
          score:
            result.awayName +
            ' ' +
            result.awayScore +
            ' @ ' +
            result.homeName +
            ' ' +
            result.homeScore +
            (totalPts != null ? ' (Σ' + totalPts + ')' : ''),
          date: result.date,
          lineUsed: asTotal ? (parseFloat(totalLine) || null) : null,
        });
      } catch (e) {
        out.push({ key: p.key, completed: false, error: e.message, kind: asTotal ? 'total' : 'moneyline' });
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    return res.status(200).json({ ok: true, results: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
