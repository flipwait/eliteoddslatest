/**
 * MLB Stats API helpers — probable SPs + simple power from season W%
 * Public endpoints, cached ~30 min
 */

const cache = globalThis.__mlbCache || (globalThis.__mlbCache = { schedule: null, standings: null });

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameHit(a, b) {
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  return x === y || x.includes(y.slice(0, 6)) || y.includes(x.slice(0, 6));
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('MLB API ' + r.status);
  return r.json();
}

function todayDates() {
  const out = [];
  const base = new Date();
  for (let i = -1; i <= 2; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function loadScheduleWindow() {
  if (cache.schedule && Date.now() - cache.schedule.t < 30 * 60 * 1000) return cache.schedule.games;
  const dates = todayDates();
  const games = [];
  for (const date of dates) {
    try {
      const d = await fetchJson(
        'https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=probablePitcher,team&date=' + date
      );
      for (const day of d.dates || []) {
        for (const g of day.games || []) games.push(g);
      }
    } catch (e) {
      /* skip day */
    }
  }
  cache.schedule = { t: Date.now(), games };
  return games;
}

async function loadStandingsPower() {
  if (cache.standings && Date.now() - cache.standings.t < 60 * 60 * 1000) return cache.standings.map;
  const map = {};
  try {
    const d = await fetchJson(
      'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=' + new Date().getUTCFullYear() + '&standingsTypes=regularSeason'
    );
    for (const rec of d.records || []) {
      for (const tr of rec.teamRecords || []) {
        const name = tr.team && tr.team.name;
        const pct = tr.winningPercentage != null ? Number(tr.winningPercentage) : null;
        const w = tr.wins != null ? Number(tr.wins) : null;
        const l = tr.losses != null ? Number(tr.losses) : null;
        if (name && pct != null) {
          // power 0-100 centered: 50 = .500 team
          const power = Math.round((0.5 + (pct - 0.5) * 1.2) * 1000) / 10; // mild stretch
          map[norm(name)] = {
            name,
            pct,
            w,
            l,
            power: Math.max(35, Math.min(65, power)),
          };
        }
      }
    }
  } catch (e) {
    /* empty map */
  }
  cache.standings = { t: Date.now(), map };
  return map;
}

function findGame(games, homeName, awayName) {
  for (const g of games) {
    const home = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.name;
    const away = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.name;
    if (nameHit(home, homeName) && nameHit(away, awayName)) return g;
    if (nameHit(home, homeName) || nameHit(away, awayName)) {
      // partial — require both when possible
      if (nameHit(home, homeName) && nameHit(away, awayName)) return g;
    }
  }
  // looser second pass
  for (const g of games) {
    const home = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.name;
    const away = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.name;
    if (nameHit(home, homeName) && nameHit(away, awayName)) return g;
  }
  return null;
}

/**
 * Enrich matchup with power + SP for MLB
 * Returns same matchup object with power, sp, breakdown fields
 */
async function enrichMlbMatchup(matchup) {
  if (!matchup || !matchup.homeName || !matchup.awayName) return matchup;
  try {
    const [games, powerMap] = await Promise.all([loadScheduleWindow(), loadStandingsPower()]);
    const g = findGame(games, matchup.homeName, matchup.awayName);

    const homeP = Object.values(powerMap).find((x) => nameHit(x.name, matchup.homeName));
    const awayP = Object.values(powerMap).find((x) => nameHit(x.name, matchup.awayName));

    let powerHome = homeP ? homeP.power : 50;
    let powerAway = awayP ? awayP.power : 50;
    // Convert power gap to home win nudge in probability points (capped ±4pp)
    const powerGap = (powerHome - powerAway) / 100; // e.g. 0.04
    const powerNudgePp = Math.round(Math.max(-4, Math.min(4, powerGap * 100)) * 10) / 10;

    let homeSp = null;
    let awaySp = null;
    let spConfirmed = false;
    if (g && g.teams) {
      const hp = g.teams.home && g.teams.home.probablePitcher;
      const ap = g.teams.away && g.teams.away.probablePitcher;
      homeSp = hp && (hp.fullName || hp.lastName) ? { id: hp.id, name: hp.fullName || hp.lastName } : null;
      awaySp = ap && (ap.fullName || ap.lastName) ? { id: ap.id, name: ap.fullName || ap.lastName } : null;
      spConfirmed = !!(homeSp && awaySp);
    }

    // SP edge without deep ERA: known both sides = small home-field SP neutral 0;
    // if only one side listed, slight uncertainty; if both TBD, flag missing
    // Heuristic: if both listed, no automatic pp (need ERA later); placeholder 0 unless we only have one
    let spNudgePp = 0;
    let spNote = 'TBD';
    if (homeSp && awaySp) {
      spNote = homeSp.name + ' vs ' + awaySp.name;
      spNudgePp = 0; // names only until ERA/FIP added — still shows on card
    } else if (homeSp && !awaySp) {
      spNote = homeSp.name + ' vs TBD';
      spNudgePp = 1; // slight home SP known
    } else if (!homeSp && awaySp) {
      spNote = 'TBD vs ' + awaySp.name;
      spNudgePp = -1;
    } else {
      spNote = 'TBD vs TBD';
      spNudgePp = 0;
    }

    matchup.power = {
      home: powerHome,
      away: powerAway,
      homePct: homeP ? homeP.pct : null,
      awayPct: awayP ? awayP.pct : null,
      homeRecord: homeP ? homeP.w + '-' + homeP.l : null,
      awayRecord: awayP ? awayP.w + '-' + awayP.l : null,
      nudgePp: powerNudgePp, // applied to home win prob
    };
    matchup.sp = {
      home: homeSp,
      away: awaySp,
      homeId: (homeSp && (homeSp.id || homeSp.personId)) || null,
      awayId: (awaySp && (awaySp.id || awaySp.personId)) || null,
      homeName: (homeSp && (homeSp.fullName || homeSp.name)) || null,
      awayName: (awaySp && (awaySp.fullName || awaySp.name)) || null,
      confirmed: spConfirmed,
      bothKnown: !!(homeSp && awaySp),
      anyKnown: !!(homeSp || awaySp),
      nudgePp: spNudgePp,
      note: spNote,
    };
    matchup.mlbGamePk = g && g.gamePk ? g.gamePk : null;
  } catch (e) {
    matchup.mlbError = e.message;
  }
  try {
    await attachNrfi(matchup);
  } catch (e2) {
    matchup.nrfi = { error: e2.message, thin: true };
  }
  return matchup;
}

async function firstInningRates(teamId, lastN) {
  lastN = lastN || 15;
  if (!teamId) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 50 * 86400000);
  const url =
    'https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=' +
    teamId +
    '&startDate=' +
    start.toISOString().slice(0, 10) +
    '&endDate=' +
    end.toISOString().slice(0, 10) +
    '&hydrate=linescore';
  try {
    const d = await fetchJson(url);
    let gamesWith1st = 0;
    let scoredIn1st = 0;
    let allowedIn1st = 0;
    let nrfiBoth = 0;
    const days = (d.dates || []).slice().reverse();
    for (const day of days) {
      for (const g of (day.games || []).slice().reverse()) {
        if (!g.linescore || !g.linescore.innings || !g.linescore.innings.length) continue;
        const inn1 = g.linescore.innings[0];
        if (!inn1) continue;
        // inn1.home/away are { runs, hits, errors } objects
        function innRuns(side) {
          if (side == null) return null;
          if (typeof side === 'number' && Number.isFinite(side)) return side;
          if (typeof side === 'object' && side.runs != null && Number.isFinite(Number(side.runs))) return Number(side.runs);
          return null;
        }
        const homeTeam = g.teams && g.teams.home && g.teams.home.team;
        const isHome = homeTeam && String(homeTeam.id) === String(teamId);
        const myRuns = innRuns(isHome ? inn1.home : inn1.away);
        const oppRuns = innRuns(isHome ? inn1.away : inn1.home);
        if (myRuns == null || oppRuns == null) continue;
        gamesWith1st++;
        if (myRuns > 0) scoredIn1st++;
        if (oppRuns > 0) allowedIn1st++;
        if (myRuns === 0 && oppRuns === 0) nrfiBoth++;
        if (gamesWith1st >= lastN) break;
      }
      if (gamesWith1st >= lastN) break;
    }
    if (gamesWith1st < 5) return { n: gamesWith1st, thin: true };
    return {
      n: gamesWith1st,
      thin: false,
      scorePct: Math.round((scoredIn1st / gamesWith1st) * 1000) / 1000,
      allowPct: Math.round((allowedIn1st / gamesWith1st) * 1000) / 1000,
      nrfiPct: Math.round((nrfiBoth / gamesWith1st) * 1000) / 1000,
    };
  } catch (e) {
    return null;
  }
}

async function attachNrfi(matchup) {
  if (!matchup || !matchup.homeName || !matchup.awayName) return matchup;
  try {
    let homeId = null;
    let awayId = null;
    const year = new Date().getUTCFullYear();
    const teams = await fetchJson('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=' + year);
    for (const tm of teams.teams || []) {
      if (!homeId && nameHit(tm.name, matchup.homeName)) homeId = tm.id;
      if (!awayId && nameHit(tm.name, matchup.awayName)) awayId = tm.id;
    }
    if (!homeId || !awayId) {
      matchup.nrfi = { thin: true, note: 'team id not resolved', limits: ['Could not map team names to MLB IDs', 'No 1st-inning rates / park / SP model for this card'] };
      return matchup;
    }
    const [h, a] = await Promise.all([firstInningRates(homeId), firstInningRates(awayId)]);
    if (!h || !a || h.thin || a.thin) {
      matchup.nrfi = { home: h, away: a, thin: true, limits: ['Thin 1st-inning sample (<5 games with linescore)', 'No park / weather / batter-vs-pitcher layer'] };
      return matchup;
    }
    const raw = (h.nrfiPct + a.nrfiPct) / 2;
    const LEAGUE_NRFI = 0.72;
    const nEff = Math.min(h.n || 0, a.n || 0);
    const w = Math.min(0.85, nEff / 25);
    let nrfiProxy = w * raw + (1 - w) * LEAGUE_NRFI;

    const LIMITS = [
      'No park 1st-inning factor (Coors / bandbox not modeled)',
      'No batter vs pitcher 1st-inning history',
      'No weather / wind / temperature',
      'No lineup order or intentional small-ball effects',
      'SP ERA is season-level, not 1st-inning only (when available)',
      'Team rates are ~last 15 linescores, not full-season park-adjusted',
    ];

    // Soft SP ERA nudge when probable pitcher IDs exist
    let spCtx = { home: null, away: null, nudge: 0, note: null };
    try {
      const sp = matchup.sp || {};
      async function pitcherEra(pid) {
        if (!pid) return null;
        const year = new Date().getUTCFullYear();
        const st = await fetchJson(
          'https://statsapi.mlb.com/api/v1/people/' + pid +
            '?hydrate=stats(group=[pitching],type=[season],season=' + year + ')'
        );
        const person = st.people && st.people[0];
        const splits = person && person.stats && person.stats[0] && person.stats[0].splits;
        const era = splits && splits[0] && splits[0].stat && splits[0].stat.era;
        return {
          name: person && person.fullName,
          era: era != null ? Number(era) : null,
        };
      }
      const hPid = sp.homeId || (sp.home && (sp.home.id || sp.home.personId)) || null;
      const aPid = sp.awayId || (sp.away && (sp.away.id || sp.away.personId)) || null;
      const [hP, aP] = await Promise.all([pitcherEra(hPid), pitcherEra(aPid)]);
      if (hP) spCtx.home = hP;
      if (aP) spCtx.away = aP;
      function eraNudge(p) {
        if (!p || p.era == null) return 0;
        if (p.era >= 5.0) return -0.02;
        if (p.era >= 4.5) return -0.01;
        if (p.era <= 3.0) return 0.015;
        if (p.era <= 3.5) return 0.008;
        return 0;
      }
      spCtx.nudge = eraNudge(hP) + eraNudge(aP);
      const bits = [];
      if (hP) bits.push('H SP ' + (hP.name || '?') + (hP.era != null ? ' ERA ' + hP.era : ''));
      if (aP) bits.push('A SP ' + (aP.name || '?') + (aP.era != null ? ' ERA ' + aP.era : ''));
      if (bits.length) spCtx.note = bits.join(' · ');
      nrfiProxy = nrfiProxy + spCtx.nudge;
    } catch (eSp) {
      spCtx.note = null;
    }

    nrfiProxy = Math.round(Math.max(0.4, Math.min(0.95, nrfiProxy)) * 1000) / 1000;
    matchup.nrfi = {
      home: h,
      away: a,
      thin: false,
      rawAvg: Math.round(raw * 1000) / 1000,
      nrfiProxy,
      yrfiProxy: Math.round((1 - nrfiProxy) * 1000) / 1000,
      sp: spCtx,
      note: 'L15 1st-inning blank rates + soft SP ERA nudge when available',
      limits: LIMITS,
    };
  } catch (e) {
    matchup.nrfi = {
      error: e.message,
      thin: true,
      limits: [
        'NRFI data unavailable for this matchup',
        'No park / weather / true SP vs lineup model until rates resolve',
      ],
    };
  }
  return matchup;
}


module.exports = {
  enrichMlbMatchup,
  loadScheduleWindow,
  loadStandingsPower,
  firstInningRates,
  attachNrfi,
};
