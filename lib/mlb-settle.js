/**
 * MLB Stats API linescore settle for NRFI/YRFI and F5 markets.
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and|mlb)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameHit(a, b) {
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.length >= 4 && y.includes(x.slice(0, 6))) return true;
  if (y.length >= 4 && x.includes(y.slice(0, 6))) return true;
  const ax = x.split(' ').filter((w) => w.length > 3);
  const ay = y.split(' ').filter((w) => w.length > 3);
  if (!ax.length || !ay.length) return false;
  return ax.some((w) => ay.some((v) => v.includes(w) || w.includes(v)));
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('MLB API ' + r.status);
  return r.json();
}

function parseTeamsFromTitle(title) {
  const t = String(title || '');
  const m = t.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+)/i);
  if (m) return { a: m[1].trim(), b: m[2].trim() };
  return { a: t, b: '' };
}

async function findMlbGameWithLinescore(title, opts) {
  opts = opts || {};
  const { a, b } = parseTeamsFromTitle(title);
  const dates = [];
  const base = opts.startTime ? new Date(opts.startTime) : new Date();
  if (isNaN(base.getTime())) {
    for (let i = -1; i <= 1; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
  } else {
    for (let i = -1; i <= 1; i++) {
      const d = new Date(base.getTime() + i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }
  }

  let best = null;
  for (const date of dates) {
    let sched;
    try {
      sched = await fetchJson(
        'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' +
          date +
          '&hydrate=linescore,team'
      );
    } catch (e) {
      continue;
    }
    for (const day of sched.dates || []) {
      for (const g of day.games || []) {
        const home = (g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.name) || '';
        const away = (g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.name) || '';
        const blob = norm(home + ' ' + away);
        const hitStrict =
          (nameHit(home, a) && nameHit(away, b)) ||
          (nameHit(home, b) && nameHit(away, a));
        const hitLoose =
          a &&
          b &&
          norm(a).split(' ').some((w) => w.length > 3 && blob.includes(w)) &&
          norm(b).split(' ').some((w) => w.length > 3 && blob.includes(w));
        if (!hitStrict && !hitLoose) continue;

        const status = (g.status && g.status.detailedState) || '';
        const abstract = (g.status && g.status.abstractGameState) || '';
        const ls = g.linescore || {};
        const innings = ls.innings || [];
        const curInning = Number(ls.currentInning) || innings.length || 0;
        const isFinal = abstract === 'Final' || /final|completed/i.test(status);

        let dist = 0;
        if (opts.startTime) {
          const gs = new Date(g.gameDate).getTime();
          const ts = new Date(opts.startTime).getTime();
          if (!isNaN(gs) && !isNaN(ts)) dist = Math.abs(gs - ts);
        }

        const row = {
          gamePk: g.gamePk,
          homeName: home,
          awayName: away,
          status,
          isFinal,
          curInning,
          innings,
          teams: g.teams,
          linescore: ls,
          dist,
          gameDate: g.gameDate,
        };
        if (!best || dist < best.dist) best = row;
      }
    }
  }
  return best;
}

function runsInInning(innings, inningNum, side) {
  const inn = (innings || []).find((x) => Number(x.num) === Number(inningNum));
  if (!inn) return null;
  const v = inn[side];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function runsThroughInning(innings, throughNum, side) {
  let sum = 0;
  let seen = 0;
  for (let i = 1; i <= throughNum; i++) {
    const r = runsInInning(innings, i, side);
    if (r == null) return null;
    sum += r;
    seen++;
  }
  if (seen < throughNum) return null;
  return sum;
}

function settleNrfiPick(pickName, marketType, game) {
  if (!game || !game.innings || !game.innings.length) {
    return { outcome: null, error: 'no linescore' };
  }
  const h1 = runsInInning(game.innings, 1, 'home');
  const a1 = runsInInning(game.innings, 1, 'away');
  if (h1 == null || a1 == null) {
    if (!game.isFinal && (game.curInning || 0) < 2) {
      return { outcome: null, error: '1st inning not complete' };
    }
    return { outcome: null, error: 'missing 1st inning runs' };
  }
  const nrfiHit = h1 + a1 === 0;
  const pick = String(pickName || '').toLowerCase();
  const mt = String(marketType || '').toLowerCase();
  let wantNrfi =
    mt === 'nrfi' ||
    /\bnrfi\b|no run first|no runs? in (the )?first/.test(pick);
  if (mt === 'yrfi' || /\byrfi\b|yes run first|run in (the )?first/.test(pick)) {
    wantNrfi = false;
  }
  if (/\byrfi\b|run in 1st|run in the 1st/.test(pick) && !/\bnrfi\b|no run/.test(pick)) {
    wantNrfi = false;
  }
  const outcome = wantNrfi ? (nrfiHit ? 'won' : 'lost') : nrfiHit ? 'lost' : 'won';
  return {
    outcome,
    score: '1st A' + a1 + ' H' + h1 + (nrfiHit ? ' NRFI' : ' YRFI'),
    detail: { h1, a1, nrfiHit, wantNrfi },
  };
}

function settleF5Pick(pickName, marketType, totalLine, game) {
  if (!game || !game.innings) return { outcome: null, error: 'no linescore' };
  const needPast5 =
    game.isFinal || (game.curInning || 0) >= 6 || (game.innings || []).length >= 5;
  if (!needPast5) {
    return { outcome: null, error: 'F5 not complete yet' };
  }
  const homeF5 = runsThroughInning(game.innings, 5, 'home');
  const awayF5 = runsThroughInning(game.innings, 5, 'away');
  if (homeF5 == null || awayF5 == null) {
    return { outcome: null, error: 'incomplete F5 linescore' };
  }

  const pick = String(pickName || '');
  const mt = String(marketType || '').toLowerCase();
  const isTotal =
    /f5_total|total/.test(mt) || /\bover\b|\bunder\b|o\/u/i.test(pick);

  if (isTotal) {
    const total = homeF5 + awayF5;
    let side = null;
    if (/\bunder\b/i.test(pick)) side = 'under';
    if (/\bover\b/i.test(pick)) side = 'over';
    let line = totalLine != null ? Number(totalLine) : null;
    if (line == null || !Number.isFinite(line)) {
      const m =
        pick.match(/(?:over|under|o\/u|total)\s*([0-9]+(?:\.[0-9]+)?)/i) ||
        pick.match(/\b([0-9]{1,2}\.[05])\b/);
      if (m) line = Number(m[1]);
    }
    if (!side || line == null) {
      return { outcome: null, error: 'could not parse F5 total side/line' };
    }
    if (total === line) {
      return {
        outcome: 'push',
        score: 'F5 ' + awayF5 + '-' + homeF5 + ' tot ' + total,
      };
    }
    const overHit = total > line;
    const won = side === 'over' ? overHit : !overHit;
    return {
      outcome: won ? 'won' : 'lost',
      score: 'F5 ' + awayF5 + '-' + homeF5 + ' tot ' + total + ' line ' + line,
    };
  }

  const home = game.homeName || '';
  const away = game.awayName || '';
  let pickHome = null;
  if (nameHit(pick, home)) pickHome = true;
  else if (nameHit(pick, away)) pickHome = false;
  else {
    if (/\bhome\b/i.test(pick)) pickHome = true;
    if (/\baway\b/i.test(pick)) pickHome = false;
  }
  if (pickHome == null) {
    return { outcome: null, error: 'could not map F5 pick to team' };
  }
  if (homeF5 === awayF5) {
    return { outcome: 'push', score: 'F5 ' + awayF5 + '-' + homeF5 + ' tie' };
  }
  const homeWins = homeF5 > awayF5;
  const won = pickHome ? homeWins : !homeWins;
  return {
    outcome: won ? 'won' : 'lost',
    score: 'F5 ' + awayF5 + '-' + homeF5,
  };
}

function isNrfiType(mt, pick) {
  const t = String(mt || '').toLowerCase();
  const p = String(pick || '').toLowerCase();
  return (
    /nrfi|yrfi/.test(t) ||
    /\bnrfi\b|\byrfi\b|no run first|yes run first|run in (the )?first/.test(p)
  );
}

function isF5Type(mt, pick) {
  const t = String(mt || '').toLowerCase();
  const p = String(pick || '').toLowerCase();
  return /f5/.test(t) || /\bf5\b|first\s*5|first five/.test(p);
}

async function settleMlbSpecial(p) {
  const title = p.title || p.eventTitle || '';
  const pick = p.pick || p.modelPick || '';
  const mt = String(p.marketType || '').toLowerCase();
  const league = String(p.league || 'mlb').toLowerCase();
  if (league && league !== 'mlb' && league !== 'baseball') {
    return { key: p.key, skipped: true, reason: 'NRFI/F5 auto-settle is MLB only' };
  }
  const asNrfi = isNrfiType(mt, pick);
  const asF5 = isF5Type(mt, pick);
  if (!asNrfi && !asF5) {
    return { key: p.key, skipped: true, reason: 'not NRFI/F5' };
  }

  let game;
  try {
    game = await findMlbGameWithLinescore(title, {
      startTime: p.startTime || p.scheduled || null,
    });
  } catch (e) {
    return { key: p.key, completed: false, error: e.message || 'MLB lookup failed' };
  }
  if (!game) {
    return { key: p.key, completed: false, error: 'no matching MLB game' };
  }

  const settled = asNrfi
    ? settleNrfiPick(pick, mt, game)
    : settleF5Pick(pick, mt, p.totalLine, game);

  if (!settled || !settled.outcome) {
    return {
      key: p.key,
      completed: false,
      error: (settled && settled.error) || 'not ready',
      score: settled && settled.score,
      kind: asNrfi ? 'nrfi' : 'f5',
    };
  }
  return {
    key: p.key,
    completed: true,
    outcome: settled.outcome,
    score: settled.score,
    kind: asNrfi ? 'nrfi' : 'f5',
    source: 'mlb-linescore',
  };
}

module.exports = {
  settleMlbSpecial,
  isNrfiType,
  isF5Type,
  findMlbGameWithLinescore,
  settleNrfiPick,
  settleF5Pick,
};
