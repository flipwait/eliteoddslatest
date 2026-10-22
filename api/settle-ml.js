const { finalResultForEvent, pickWonMoneyline, pickWonTotal, pickWonPlayerProp } = require('../lib/espn');
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
  if (/total|totals|over|under|total_1h|total_2h|total_q|total_p|team_total/.test(t)) return true;
  if (/\bover\b|\bunder\b|o\/u|\b1h\b|\b2h\b/.test(p)) return true;
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

      function isPlayerPropType(mt, pick) {
        const t = String(mt || '').toLowerCase();
        const pk = String(pick || '').toLowerCase();
        if (/^player_|^pitcher_|player_prop|\bprop\b/.test(t)) return true;
        if (/\d+\+|at least\s+\d+|over\s+\d+|under\s+\d+/.test(pk) && /pts|points|reb|ast|pra|yard|reception|strikeout|hits|hr/.test(pk + t)) return true;
        return false;
      }

      const asProp = isPlayerPropType(mt, pick);
      const asTotal = !asProp && isTotalType(mt, pick);
      const asMl = !asProp && !asTotal && (isMoneylineType(mt) || !mt || mt === 'moneyline');

      if (!asTotal && !asMl && !asProp) {
        out.push({
          key: p.key,
          skipped: true,
          reason: 'market type not auto-settled (spread/map) — settle manually',
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
            kind: asProp ? 'player_prop' : (asTotal ? 'total' : 'moneyline'),
          });
          continue;
        }

        let outcome = null;
        if (asProp) {
          outcome = await pickWonPlayerProp(pick, result, {
            marketType: mt,
            totalLine,
            league,
          });
        } else if (asTotal) outcome = pickWonTotal(pick, result, totalLine, mt);
        else outcome = pickWonMoneyline(pick, result);

        if (!outcome) {
          // Period O/U without period linescores must stay OPEN — never grade as FG win
          const needPeriod = /1h|2h|q1|q2|q3|q4|period|total_1h|total_2h|total_q/i.test(mt + ' ' + pick);
          out.push({
            key: p.key,
            completed: needPeriod ? false : true,
            outcome: null,
            error: needPeriod
              ? 'period score missing — left open (not full-game grade)'
              : 'could not map pick to result',
            score: result.awayScore != null
              ? (result.awayName + ' ' + result.awayScore + ' - ' + result.homeName + ' ' + result.homeScore)
              : null,
            kind: asProp ? 'player_prop' : (asTotal ? 'total' : 'moneyline'),
            window: needPeriod ? 'period' : 'fg',
          });
          continue;
        }

        const scoreNote = (result.awayName || 'A') + ' ' + result.awayScore + ' - ' + (result.homeName || 'H') + ' ' + result.homeScore;
        out.push({
          key: p.key,
          completed: true,
          outcome,
          score: scoreNote,
          kind: asProp ? 'player_prop' : (asTotal ? 'total' : 'moneyline'),
          source: 'espn',
          // outcome is won|lost|push only — never invent CASHOUT here
          status: outcome === 'won' ? 'WIN' : outcome === 'lost' ? 'LOSS' : outcome === 'push' ? 'PUSH' : null,
        });
      } catch (e) {
        out.push({
          key: p.key,
          completed: false,
          error: e.message || 'settle failed',
          kind: asProp ? 'player_prop' : (asTotal ? 'total' : 'moneyline'),
        });
      }
    }

    return res.status(200).json({ ok: true, results: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'settle-ml failed' });
  }
};
