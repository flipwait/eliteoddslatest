/**
 * Esports match settle via PandaScore (finished matches) + OpenDota (Dota2 fallback).
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and|team|esports|gaming|gg|bo1|bo3|bo5)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameHit(a, b) {
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 3 && (y.includes(x) || x.includes(y))) return true;
  const ax = x.split(' ').filter((w) => w.length > 2);
  const ay = y.split(' ').filter((w) => w.length > 2);
  return ax.some((w) => ay.some((v) => v === w || v.includes(w) || w.includes(v)));
}

function parseTitleTeams(title) {
  const t = String(title || '').replace(/\s*[\|\-–].*$/, '').trim();
  let m = t.split(/\s+vs\.?\s+/i);
  if (m.length >= 2) return { a: m[0].trim(), b: m[1].trim() };
  m = t.split(/\s+@\s+/);
  if (m.length >= 2) return { a: m[0].trim(), b: m[1].trim() };
  m = t.split(/\s+at\s+/i);
  if (m.length >= 2) return { a: m[0].trim(), b: m[1].trim() };
  return { a: t, b: '' };
}

function isEsportsLeague(league) {
  const lg = String(league || '').toLowerCase();
  return ['esports', 'lol', 'cs2', 'csgo', 'cs', 'dota2', 'dota', 'valorant', 'val', 'cod', 'rl'].includes(lg);
}

function leagueToVideogame(league) {
  const lg = String(league || '').toLowerCase();
  if (lg === 'cs2' || lg === 'csgo' || lg === 'cs') return 'cs-go';
  if (lg === 'lol' || lg === 'league') return 'league-of-legends';
  if (lg === 'dota2' || lg === 'dota') return 'dota-2';
  if (lg === 'valorant' || lg === 'val') return 'valorant';
  if (lg === 'cod') return 'cod-mw';
  if (lg === 'rl') return 'rocket-league';
  return null;
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers: headers || { Accept: 'application/json' } });
  if (!r.ok) throw new Error('fetch ' + r.status);
  return r.json();
}

async function psFetch(path, token) {
  const url = path.startsWith('http') ? path : 'https://api.pandascore.co' + path;
  try {
    return await fetchJson(url, {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token,
    });
  } catch (e) {
    const join = url.includes('?') ? '&' : '?';
    return fetchJson(url + join + 'token=' + encodeURIComponent(token));
  }
}

/**
 * Find a finished PandaScore match matching both teams near startTime.
 */
async function findPandaScoreMatch(title, league, token, startTime) {
  const { a, b } = parseTitleTeams(title);
  if (!a || !b || !token) return null;
  const vg = leagueToVideogame(league);

  // Search recent past matches for team A, then require opponent B
  let teamA = null;
  try {
    let path = '/teams?search[name]=' + encodeURIComponent(a) + '&per_page=8';
    if (vg) path += '&filter[videogame]=' + encodeURIComponent(vg);
    let list = await psFetch(path, token);
    if (!Array.isArray(list) || !list.length) {
      list = await psFetch('/teams?search[name]=' + encodeURIComponent(a) + '&per_page=8', token);
    }
    if (Array.isArray(list)) {
      for (const t of list) {
        if (nameHit(t.name, a) || nameHit(t.acronym, a) || nameHit(t.slug, a)) {
          teamA = t;
          break;
        }
      }
      if (!teamA && list[0]) teamA = list[0];
    }
  } catch (e) {
    return null;
  }
  if (!teamA || !teamA.id) return null;

  let matches = [];
  try {
    matches = await psFetch(
      '/teams/' +
        encodeURIComponent(teamA.id) +
        '/matches?sort=-begin_at&per_page=20&filter[status]=finished',
      token
    );
  } catch (e) {
    try {
      matches = await psFetch(
        '/teams/' + encodeURIComponent(teamA.id) + '/matches?sort=-begin_at&per_page=20',
        token
      );
    } catch (e2) {
      matches = [];
    }
  }
  if (!Array.isArray(matches)) matches = [];

  const startMs = startTime ? new Date(startTime).getTime() : null;
  let best = null;
  let bestDist = Infinity;

  for (const m of matches) {
    const status = String(m.status || '').toLowerCase();
    if (status && status !== 'finished' && m.winner_id == null && !(m.winner && m.winner.id)) {
      continue;
    }
    // opponents
    const opps = m.opponents || [];
    const names = opps.map((o) => {
      const t = o.opponent || o;
      return t.name || t.acronym || t.slug || '';
    });
    const blob = norm(names.join(' ') + ' ' + (m.name || ''));
    const hitB =
      nameHit(b, names[0]) ||
      nameHit(b, names[1]) ||
      names.some((n) => nameHit(n, b)) ||
      blob.includes(norm(b).slice(0, 6));
    if (!hitB) continue;

    let dist = 0;
    if (startMs && !isNaN(startMs)) {
      const ms = new Date(m.begin_at || m.scheduled_at || m.end_at || 0).getTime();
      if (!isNaN(ms)) dist = Math.abs(ms - startMs);
      // Prefer matches within 3 days of scheduled
      if (dist > 3 * 86400000) continue;
    }

    const winnerId =
      m.winner_id != null
        ? Number(m.winner_id)
        : m.winner && m.winner.id != null
          ? Number(m.winner.id)
          : null;
    if (winnerId == null) continue;

    let winnerName = '';
    for (const o of opps) {
      const t = o.opponent || o;
      if (Number(t.id) === winnerId) {
        winnerName = t.name || t.acronym || '';
        break;
      }
    }
    if (!winnerName && m.winner) winnerName = m.winner.name || m.winner.acronym || '';

    if (dist < bestDist) {
      bestDist = dist;
      best = {
        matchId: m.id,
        winnerId,
        winnerName,
        opponents: names,
        score: m.score || (m.results && JSON.stringify(m.results)) || null,
        begin_at: m.begin_at,
        status: m.status,
        source: 'pandascore',
      };
    }
  }
  return best;
}

/** OpenDota fallback for Dota2 team matches */
async function findOpenDotaMatch(title, startTime) {
  const { a, b } = parseTitleTeams(title);
  if (!a || !b) return null;
  let teams;
  try {
    teams = await fetchJson('https://api.opendota.com/api/teams');
  } catch (e) {
    return null;
  }
  if (!Array.isArray(teams)) return null;

  function findTeam(hint) {
    const q = norm(hint);
    let best = null;
    let sc = 0;
    for (const t of teams) {
      const names = [t.name, t.tag].map(norm).filter(Boolean);
      for (const n of names) {
        let s = 0;
        if (n === q) s = 100;
        else if (n.includes(q) || q.includes(n)) s = 70;
        if (s > sc) {
          sc = s;
          best = t;
        }
      }
    }
    return sc >= 50 ? best : null;
  }

  const teamA = findTeam(a);
  if (!teamA) return null;

  let matches;
  try {
    matches = await fetchJson(
      'https://api.opendota.com/api/teams/' + encodeURIComponent(teamA.team_id) + '/matches'
    );
  } catch (e) {
    return null;
  }
  if (!Array.isArray(matches)) return null;

  const startMs = startTime ? new Date(startTime).getTime() : null;
  for (const m of matches.slice(0, 30)) {
    const oppName = m.opposing_team_name || '';
    if (!nameHit(oppName, b) && !norm(oppName).includes(norm(b).slice(0, 5))) continue;
    if (startMs && m.start_time) {
      const dist = Math.abs(m.start_time * 1000 - startMs);
      if (dist > 3 * 86400000) continue;
    }
    // radiant_win relative to team? OpenDota team matches include radiant / dire
    const radiant = !!m.radiant;
    const radiantWin = !!m.radiant_win;
    const teamWon = radiant ? radiantWin : !radiantWin;
    return {
      matchId: m.match_id,
      winnerName: teamWon ? teamA.name : oppName,
      opponents: [teamA.name, oppName],
      score: null,
      source: 'opendota',
      teamWon,
      teamAName: teamA.name,
    };
  }
  return null;
}

function pickWonEsports(pickName, match) {
  if (!match || !match.winnerName) return null;
  const pick = String(pickName || '');
  // Prefer explicit team name in pick
  if (nameHit(pick, match.winnerName)) return 'won';
  // If pick matches a losing opponent
  const opps = match.opponents || [];
  for (const n of opps) {
    if (nameHit(pick, n) && !nameHit(n, match.winnerName)) return 'lost';
  }
  // OpenDota teamWon path when pick is team A
  if (match.teamAName && nameHit(pick, match.teamAName)) {
    return match.teamWon ? 'won' : 'lost';
  }
  return null;
}

/**
 * @param {object} p - pick row
 * @param {{ pandascoreToken?: string }} opts
 */
async function settleEsportsSpecial(p, opts) {
  opts = opts || {};
  const title = p.title || p.eventTitle || '';
  const pick = p.pick || p.modelPick || '';
  const league = String(p.league || 'esports').toLowerCase();
  const mt = String(p.marketType || 'moneyline').toLowerCase();

  // Only series/match winner for now (map markets need map-level scores)
  if (/map_|map\s*[123]|spread|total|handicap/.test(mt + ' ' + pick)) {
    return {
      key: p.key,
      skipped: true,
      reason: 'esports map/spread/total auto-settle not supported yet — settle manually',
    };
  }

  const token = (opts.pandascoreToken || process.env.PANDASCORE_TOKEN || '').trim();
  let match = null;

  if (token) {
    try {
      match = await findPandaScoreMatch(title, league, token, p.startTime || p.scheduled || null);
    } catch (e) {
      match = null;
    }
  }

  // Dota2 free fallback
  if (!match && (league === 'dota2' || league === 'dota' || /dota/i.test(title))) {
    try {
      match = await findOpenDotaMatch(title, p.startTime || null);
    } catch (e) {
      match = null;
    }
  }

  if (!match) {
    return {
      key: p.key,
      completed: false,
      error: token
        ? 'no finished esports match found yet'
        : 'add PandaScore token in Settings for CS2/LoL/Val settle (Dota2 can use OpenDota)',
      kind: 'esports-ml',
    };
  }

  const outcome = pickWonEsports(pick, match);
  if (!outcome) {
    return {
      key: p.key,
      completed: true,
      outcome: null,
      error: 'could not map pick to match winner',
      score: match.winnerName ? 'W: ' + match.winnerName : null,
      kind: 'esports-ml',
      source: match.source,
    };
  }

  return {
    key: p.key,
    completed: true,
    outcome,
    score: match.winnerName
      ? 'W: ' + match.winnerName + (match.opponents && match.opponents.length ? ' (' + match.opponents.join(' vs ') + ')' : '')
      : null,
    kind: 'esports-ml',
    source: match.source,
  };
}

module.exports = {
  settleEsportsSpecial,
  isEsportsLeague,
  findPandaScoreMatch,
  pickWonEsports,
};
