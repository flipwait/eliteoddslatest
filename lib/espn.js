/**
 * ESPN public site API — form helpers (no key)
 * L10 / L5 home-away splits, H2H, rest days, logistic win probability
 */

const SPORT_PATH = {
  mlb: 'baseball/mlb',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  nfl: 'football/nfl',
  cfb: 'football/college-football',
  cbb: 'basketball/mens-college-basketball',
  nhl: 'hockey/nhl',
};

const teamCache = globalThis.__espnTeams || (globalThis.__espnTeams = {});
const schedCache = globalThis.__espnSched || (globalThis.__espnSched = {});

function pathFor(league) {
  return SPORT_PATH[String(league || '').toLowerCase()] || null;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('ESPN ' + r.status);
  return r.json();
}

async function listTeams(league) {
  const key = String(league || '').toLowerCase();
  if (teamCache[key] && Date.now() - teamCache[key].t < 6 * 3600 * 1000) return teamCache[key].teams;
  const sp = pathFor(key);
  if (!sp) return [];
  const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams?limit=400');
  const leaguesArr = (((d.sports || [])[0] || {}).leagues) || [];
  const teams = (leaguesArr[0] && leaguesArr[0].teams) || [];
  const out = teams.map((x) => x.team || x).filter(Boolean);
  teamCache[key] = { t: Date.now(), teams: out };
  return out;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamMatch(team, query) {
  const q = norm(query);
  if (!q || !team) return false;
  const names = [team.displayName, team.shortDisplayName, team.name, team.nickname, team.abbreviation, team.location]
    .map(norm)
    .filter(Boolean);
  return names.some((n) => n === q || n.includes(q) || q.includes(n));
}

async function findTeam(league, nameHint) {
  const teams = await listTeams(league);
  return teams.find((t) => teamMatch(t, nameHint)) || null;
}

function parseEventResult(ev, teamId) {
  const c = (ev.competitions || [])[0] || {};
  const comps = c.competitors || [];
  if (comps.length < 2) return null;
  const me = comps.find((x) => String(x.team && x.team.id) === String(teamId));
  const opp = comps.find((x) => String(x.team && x.team.id) !== String(teamId));
  if (!me) return null;
  const completed =
    (c.status && c.status.type && c.status.type.completed) ||
    (ev.status && ev.status.type && ev.status.type.completed);
  if (!completed) return null;
  const scoreNum = (sc) => {
    if (sc == null) return 0;
    if (typeof sc === 'number') return sc;
    if (typeof sc === 'object' && sc.value != null) return Number(sc.value) || 0;
    return Number(sc) || 0;
  };
  const myScore = scoreNum(me.score);
  const oppScore = scoreNum(opp && opp.score);
  const homeAway = me.homeAway || (me.isHome ? 'home' : 'away');
  const date = c.date || ev.date || null;
  return {
    won: myScore > oppScore,
    for: myScore,
    against: oppScore,
    homeAway,
    oppId: opp && opp.team && opp.team.id,
    date,
  };
}

async function teamSchedule(league, teamId) {
  const key = String(league) + ':' + String(teamId);
  if (schedCache[key] && Date.now() - schedCache[key].t < 30 * 60 * 1000) return schedCache[key].events;
  const sp = pathFor(league);
  const d = await fetchJson(
    'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams/' + teamId + '/schedule'
  );
  const events = d.events || [];
  schedCache[key] = { t: Date.now(), events };
  return events;
}

function packSplit(arr) {
  if (!arr.length) return null;
  const w = arr.filter((x) => x.won).length;
  const l = arr.length - w;
  const rf = Math.round((arr.reduce((s, x) => s + x.for, 0) / arr.length) * 10) / 10;
  const ra = Math.round((arr.reduce((s, x) => s + x.against, 0) / arr.length) * 10) / 10;
  return { w, l, rf, ra, n: arr.length, wr: Math.round((w / arr.length) * 1000) / 1000 };
}

function lastNSplit(results, n) {
  const completed = (results || []).filter(Boolean);
  const home = completed.filter((r) => r.homeAway === 'home').slice(-n);
  const away = completed.filter((r) => r.homeAway === 'away').slice(-n);
  const all = completed.slice(-n);
  return { home: packSplit(home), away: packSplit(away), all: packSplit(all) };
}

function h2hFromResults(homeResults, awayTeamId) {
  const vs = (homeResults || []).filter((r) => String(r.oppId) === String(awayTeamId)).slice(-10);
  if (!vs.length) return null;
  const homeWins = vs.filter((r) => r.won).length;
  const awayWins = vs.length - homeWins;
  const avgTotal = Math.round((vs.reduce((s, r) => s + r.for + r.against, 0) / vs.length) * 10) / 10;
  return {
    homeWins,
    awayWins,
    n: vs.length,
    avgTotal,
    homeWr: Math.round((homeWins / vs.length) * 1000) / 1000,
  };
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / (24 * 3600 * 1000) * 10) / 10;
}

/**
 * Logistic-style home win probability from form components.
 * Output ~0.15–0.85; independent of market price.
 */
function formWinProbability(matchup) {
  if (!matchup || matchup.error) return null;
  const homeL10 = matchup.homeL10;
  const awayL10 = matchup.awayL10;
  const homeL5 = matchup.homeL5;
  const awayL5 = matchup.awayL5;
  const h2h = matchup.h2h;
  if (!homeL10 && !awayL10 && !h2h) return null;

  const league = String(matchup.league || '').toLowerCase();
  // League-tuned weights (NFL sharper market; CFB stronger home)
  let wL10 = 1.4, wL5 = 0.9, wPD = 0.6, wH2H = 0.7, wRest = 0.04, homePrior = 0.08;
  if (league === 'nfl') {
    wL10 = 1.4; wL5 = 0.9; wPD = 0.8; wH2H = 0.7; wRest = 0.07; homePrior = 0.08; // ~+2pp
  } else if (league === 'cfb') {
    wL10 = 1.5; wL5 = 1.0; wPD = 1.0; wH2H = 0.6; wRest = 0.035; homePrior = 0.14; // ~+3.5pp
  } else if (league === 'nba' || league === 'wnba') {
    homePrior = 0.1; wRest = 0.05;
  } else if (league === 'mlb') {
    homePrior = 0.06; wRest = 0.03;
  } else if (league === 'nhl') {
    // Home ice modest; goal differential matters; B2B / rest important in NHL
    wL10 = 1.35; wL5 = 1.0; wPD = 1.1; wH2H = 0.65; wRest = 0.06; homePrior = 0.08;
  }

  let z = homePrior;
  const parts = [{ k: 'homePrior', league, homePrior }];

  if (homeL10 && homeL10.n >= 3) {
    const wr = homeL10.wr != null ? homeL10.wr : homeL10.w / ((homeL10.w + homeL10.l) || 1);
    z += (wr - 0.5) * wL10;
    parts.push({ k: 'homeL10', wr, w: wL10 });
  }
  if (awayL10 && awayL10.n >= 3) {
    const wr = awayL10.wr != null ? awayL10.wr : awayL10.w / ((awayL10.w + awayL10.l) || 1);
    z -= (wr - 0.5) * wL10;
    parts.push({ k: 'awayL10', wr, w: wL10 });
  }
  if (homeL5 && homeL5.n >= 2) {
    const wr = homeL5.wr != null ? homeL5.wr : homeL5.w / ((homeL5.w + homeL5.l) || 1);
    z += (wr - 0.5) * wL5;
    parts.push({ k: 'homeL5', wr, w: wL5 });
  }
  if (awayL5 && awayL5.n >= 2) {
    const wr = awayL5.wr != null ? awayL5.wr : awayL5.w / ((awayL5.w + awayL5.l) || 1);
    z -= (wr - 0.5) * wL5;
    parts.push({ k: 'awayL5', wr, w: wL5 });
  }
  // PF/PA or RF/RA differential
  if (homeL10 && homeL10.rf != null && homeL10.ra != null) {
    const margin = (homeL10.rf - homeL10.ra) / Math.max(3, (homeL10.rf + homeL10.ra) / 2);
    z += Math.max(-0.25, Math.min(0.25, margin)) * wPD;
  }
  if (awayL10 && awayL10.rf != null && awayL10.ra != null) {
    const margin = (awayL10.rf - awayL10.ra) / Math.max(3, (awayL10.rf + awayL10.ra) / 2);
    z -= Math.max(-0.25, Math.min(0.25, margin)) * wPD;
  }
  if (h2h && h2h.n >= 3) {
    const wr = h2h.homeWr != null ? h2h.homeWr : h2h.homeWins / (h2h.n || 1);
    const w = h2h.n >= 6 ? wH2H : wH2H * 0.55;
    z += (wr - 0.5) * w * 2;
    parts.push({ k: 'h2h', wr, w });
  }
  // Rest / short week (NFL sensitive)
  if (matchup.homeRestDays != null && matchup.awayRestDays != null) {
    const diff = matchup.homeRestDays - matchup.awayRestDays;
    z += Math.max(-3, Math.min(3, diff)) * wRest;
    parts.push({ k: 'restDiff', diff });
    if (league === 'nfl' && matchup.homeRestDays <= 6) {
      z -= 0.04; // short week home
      parts.push({ k: 'shortWeekHome' });
    }
    if (league === 'nfl' && matchup.awayRestDays <= 6) {
      z += 0.04;
      parts.push({ k: 'shortWeekAway' });
    }
    // NHL back-to-back (0 days rest)
    if (league === 'nhl' && matchup.homeRestDays != null && matchup.homeRestDays <= 0) {
      z -= 0.05;
      parts.push({ k: 'nhlB2BHome' });
    }
    if (league === 'nhl' && matchup.awayRestDays != null && matchup.awayRestDays <= 0) {
      z += 0.05;
      parts.push({ k: 'nhlB2BAway' });
    }
  } else if (matchup.homeRestDays != null && matchup.homeRestDays <= 1) {
    z -= 0.05;
  } else if (matchup.awayRestDays != null && matchup.awayRestDays <= 1) {
    z += 0.05;
  }

  let p = 1 / (1 + Math.exp(-z));
  p = Math.max(0.18, Math.min(0.82, p));
  return {
    homeWinProb: Math.round(p * 1000) / 1000,
    awayWinProb: Math.round((1 - p) * 1000) / 1000,
    logit: Math.round(z * 1000) / 1000,
    parts,
  };
}

/**
 * Find true home/away for two teams from ESPN schedule (not title order).
 * Polymarket "A vs B" is unreliable for home; ESPN competition homeAway is truth.
 */
function resolveVenueFromSchedules(eventsA, teamAId, teamBId) {
  const a = String(teamAId);
  const b = String(teamBId);
  const now = Date.now();
  const candidates = [];
  for (const ev of eventsA || []) {
    const c = (ev.competitions || [])[0] || {};
    const comps = c.competitors || [];
    if (comps.length < 2) continue;
    const ids = comps.map((x) => String(x.team && x.team.id));
    if (!ids.includes(a) || !ids.includes(b)) continue;
    const home = comps.find((x) => x.homeAway === 'home');
    const away = comps.find((x) => x.homeAway === 'away');
    if (!home || !away) continue;
    const start = ev.date || c.date || null;
    const t = start ? new Date(start).getTime() : 0;
    const completed = (c.status && c.status.type && c.status.type.completed) || false;
    candidates.push({
      homeId: String(home.team.id),
      awayId: String(away.team.id),
      start,
      completed,
      dist: Math.abs((t || now) - now),
      future: t >= now - 3 * 3600 * 1000,
    });
  }
  if (!candidates.length) return null;
  // Prefer upcoming/live, else nearest
  candidates.sort((x, y) => {
    if (x.future !== y.future) return x.future ? -1 : 1;
    if (x.completed !== y.completed) return x.completed ? 1 : -1;
    return x.dist - y.dist;
  });
  return candidates[0];
}


function buildTotalsProjection(matchup) {
  if (!matchup) return null;
  const hAll = matchup.homeAllL10 || matchup.homeL10;
  const aAll = matchup.awayAllL10 || matchup.awayL10;
  const hHome = matchup.homeL10; // home team at home scoring
  const aAway = matchup.awayL10; // away team on road
  function avgTotal(split) {
    if (!split || split.rf == null || split.ra == null) return null;
    return Math.round((Number(split.rf) + Number(split.ra)) * 10) / 10;
  }
  function avgRf(split) {
    return split && split.rf != null ? Number(split.rf) : null;
  }
  const homeL10GameTotal = avgTotal(hHome) != null ? avgTotal(hHome) : avgTotal(hAll);
  const awayL10GameTotal = avgTotal(aAway) != null ? avgTotal(aAway) : avgTotal(aAll);
  const homeRpg = avgRf(hHome) != null ? avgRf(hHome) : avgRf(hAll);
  const awayRpg = avgRf(aAway) != null ? avgRf(aAway) : avgRf(aAll);
  let projected = null;
  if (homeRpg != null && awayRpg != null) {
    // Simple: home R/G (at home) + away R/G (on road)
    projected = Math.round((homeRpg + awayRpg) * 10) / 10;
  } else if (homeL10GameTotal != null && awayL10GameTotal != null) {
    projected = Math.round(((homeL10GameTotal + awayL10GameTotal) / 2) * 10) / 10;
  }
  // Rough F5 ~ 55% of full game runs historically (soft)
  const projectedF5 = projected != null ? Math.round(projected * 0.55 * 10) / 10 : null;
  return {
    homeL10GameTotal,
    awayL10GameTotal,
    homeRpg,
    awayRpg,
    projectedFg: projected,
    projectedF5,
    h2hAvgTotal: matchup.h2h && matchup.h2h.avgTotal != null ? matchup.h2h.avgTotal : null,
    note: 'L10 team scoring · not a full totals model',
  };
}

async function matchupForEvent(league, eventTitle) {
  const sp = pathFor(league);
  if (!sp || !eventTitle) return null;
  const title = String(eventTitle || '').replace(/\s*[\|\-–].*$/, '').trim();
  const at = title.split(/\s+at\s+/i);
  const vs = title.split(/\s+vs\.?\s+/i);
  let hintA = null;
  let hintB = null;
  let titleImpliesHome = null; // team that title claims is home (may be wrong for "vs")
  if (at.length === 2) {
    // "Away at Home" — usually correct
    hintA = at[1].trim(); // claimed home
    hintB = at[0].trim(); // claimed away
    titleImpliesHome = hintA;
  } else if (vs.length === 2) {
    // "A vs B" — order is NOT reliable; resolve via ESPN
    hintA = vs[0].trim();
    hintB = vs[1].trim();
    titleImpliesHome = null;
  } else return null;

  try {
    const [teamA, teamB] = await Promise.all([findTeam(league, hintA), findTeam(league, hintB)]);
    if (!teamA || !teamB) {
      return {
        homeName: titleImpliesHome || hintA,
        awayName: titleImpliesHome ? hintB : hintB,
        note: 'ESPN team id not matched',
        hasForm: false,
        venueSource: 'unmatched',
      };
    }

    const [schedA, schedB] = await Promise.all([
      teamSchedule(league, teamA.id),
      teamSchedule(league, teamB.id),
    ]);

    let venue = resolveVenueFromSchedules(schedA, teamA.id, teamB.id);
    if (!venue) venue = resolveVenueFromSchedules(schedB, teamB.id, teamA.id);

    let homeTeam;
    let awayTeam;
    let venueSource = 'espn-schedule';
    if (venue) {
      homeTeam = String(venue.homeId) === String(teamA.id) ? teamA : teamB;
      awayTeam = String(venue.awayId) === String(teamA.id) ? teamA : teamB;
    } else if (titleImpliesHome) {
      // "at" title only
      homeTeam = teamMatch(teamA, titleImpliesHome) || teamA;
      awayTeam = homeTeam.id === teamA.id ? teamB : teamA;
      // fix if teamA was away hint
      if (at.length === 2) {
        homeTeam = teamA; // hintA was home from "at"
        awayTeam = teamB;
      }
      venueSource = 'title-at';
    } else {
      // last resort: do not invent home — still need labels; use ESPN next game home if any
      homeTeam = teamA;
      awayTeam = teamB;
      venueSource = 'title-vs-unverified';
    }

    const [homeEv, awayEv] = await Promise.all([
      teamSchedule(league, homeTeam.id),
      teamSchedule(league, awayTeam.id),
    ]);
    const homeRes = homeEv.map((e) => parseEventResult(e, homeTeam.id)).filter(Boolean);
    const awayRes = awayEv.map((e) => parseEventResult(e, awayTeam.id)).filter(Boolean);

    // CRITICAL: homeL10 = home team's games WHEN HOME; awayL10 = away team's games WHEN AWAY
    const homeL10 = lastNSplit(homeRes, 10);
    const awayL10 = lastNSplit(awayRes, 10);
    const homeL5 = lastNSplit(homeRes, 5);
    const awayL5 = lastNSplit(awayRes, 5);
    const h2h = h2hFromResults(homeRes, awayTeam.id);

    const homeLast = homeRes.slice(-1)[0];
    const awayLast = awayRes.slice(-1)[0];
    const homeRestDays = homeLast ? daysSince(homeLast.date) : null;
    const awayRestDays = awayLast ? daysSince(awayLast.date) : null;

    const matchup = {
      homeName: homeTeam.displayName || homeTeam.name,
      awayName: awayTeam.displayName || awayTeam.name,
      homeId: homeTeam.id,
      awayId: awayTeam.id,
      homeL10: homeL10.home, // only home games
      awayL10: awayL10.away, // only away games
      homeL5: homeL5.home || homeL5.all,
      awayL5: awayL5.away || awayL5.all,
      homeAllL10: homeL10.all,
      awayAllL10: awayL10.all,
      h2h,
      homeRestDays,
      awayRestDays,
      source: 'espn',
      league: String(league || '').toLowerCase(),
      venueSource,
      venueVerified: venueSource === 'espn-schedule',
      hasForm: true,
      espnGameStart: venue && venue.start ? venue.start : null,
    };
    matchup.winProb = formWinProbability(matchup);
    // Game totals from L10 scoring (RF+RA style)
    matchup.totalsProjection = buildTotalsProjection(matchup);
    return matchup;
  } catch (e) {
    return { error: e.message, homeName: hintA, awayName: hintB, hasForm: false };
  }
}


/**
 * Final score for a completed game matching event title (ML settlement).
 * Returns { completed, winnerName, homeName, awayName, homeScore, awayScore, date } or null.
 */
async function finalResultForEvent(league, eventTitle, opts) {
  opts = opts || {};
  const sp = pathFor(league);
  if (!sp || !eventTitle) return null;
  const title = String(eventTitle || '').replace(/\s*[\|\-–].*$/, '').trim();
  const at = title.split(/\s+at\s+/i);
  const vs = title.split(/\s+vs\.?\s+/i);
  let hintA, hintB;
  if (at.length === 2) {
    hintA = at[1].trim();
    hintB = at[0].trim();
  } else if (vs.length === 2) {
    hintA = vs[0].trim();
    hintB = vs[1].trim();
  } else return null;

  const scheduledMs = opts.startTime ? new Date(opts.startTime).getTime() : null;
  const loggedMs = opts.loggedAt ? new Date(opts.loggedAt).getTime() : null;
  const now = Date.now();

  // Game has not started yet → stay OPEN
  if (scheduledMs && Number.isFinite(scheduledMs) && scheduledMs > now + 5 * 60 * 1000) {
    return {
      completed: false,
      error: 'game not started yet',
      startTime: opts.startTime,
    };
  }

  const [teamA, teamB] = await Promise.all([findTeam(league, hintA), findTeam(league, hintB)]);
  if (!teamA || !teamB) return { completed: false, error: 'teams not matched', hintA, hintB };

  const sched = await teamSchedule(league, teamA.id);
  const candidates = [];
  for (const ev of sched || []) {
    const c = (ev.competitions || [])[0] || {};
    const comps = c.competitors || [];
    if (comps.length < 2) continue;
    const ids = comps.map((x) => String(x.team && x.team.id));
    if (!ids.includes(String(teamA.id)) || !ids.includes(String(teamB.id))) continue;

    const statusName = String(
      (c.status && c.status.type && (c.status.type.name || c.status.type.description)) ||
        (ev.status && ev.status.type && ev.status.type.name) ||
        ''
    ).toLowerCase();
    const completed =
      (c.status && c.status.type && c.status.type.completed) ||
      (ev.status && ev.status.type && ev.status.type.completed) ||
      statusName === 'final' ||
      statusName === 'status_final';
    // Explicitly skip scheduled / in-progress
    if (/scheduled|pre|in progress|halftime|status_in_progress|status_halftime|status_scheduled/.test(statusName) && !completed) {
      continue;
    }
    if (!completed) continue;

    const home = comps.find((x) => x.homeAway === 'home') || comps[0];
    const away = comps.find((x) => x.homeAway === 'away') || comps[1];
    const scoreNum = (sc) => {
      if (sc == null) return 0;
      if (typeof sc === 'number') return sc;
      if (typeof sc === 'object' && sc.value != null) return Number(sc.value) || 0;
      return Number(sc) || 0;
    };
    const hs = scoreNum(home.score);
    const as = scoreNum(away.score);
    // Require real scores (0-0 final is rare but allowed only if status final)
    const homeName = (home.team && (home.team.displayName || home.team.name)) || '';
    const awayName = (away.team && (away.team.displayName || away.team.name)) || '';
    let winnerName = null;
    if (hs > as) winnerName = homeName;
    else if (as > hs) winnerName = awayName;
    else winnerName = null;

    const t = ev.date || c.date || null;
    const gameMs = t ? new Date(t).getTime() : null;
    if (!gameMs || !Number.isFinite(gameMs)) continue;

    // Must not be a future tipoff marked wrong
    if (gameMs > now + 30 * 60 * 1000) continue;

    // If we know scheduled start, only accept finals near THAT start (not last series game)
    if (scheduledMs && Number.isFinite(scheduledMs)) {
      const delta = Math.abs(gameMs - scheduledMs);
      // within 16 hours of listed start
      if (delta > 16 * 3600 * 1000) continue;
      // final should be after start (or very close)
      if (gameMs < scheduledMs - 3 * 3600 * 1000) continue;
    } else {
      // No startTime: only settle games that tipped in the last 36h (avoid random prior series)
      if (now - gameMs > 36 * 3600 * 1000) continue;
    }

    // Don't match a game that finished before the pick was logged (stale)
    if (loggedMs && Number.isFinite(loggedMs) && gameMs < loggedMs - 6 * 3600 * 1000) continue;

    const dist = scheduledMs && Number.isFinite(scheduledMs)
      ? Math.abs(gameMs - scheduledMs)
      : Math.abs(now - gameMs);

    candidates.push({
      completed: true,
      winnerName,
      homeName,
      awayName,
      homeScore: hs,
      awayScore: as,
      date: t,
      dist,
    });
  }

  if (!candidates.length) {
    return {
      completed: false,
      error: scheduledMs && scheduledMs > now
        ? 'game not started yet'
        : 'no matching final for this scheduled game yet — left open',
      startTime: opts.startTime || null,
    };
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0];
}


/**
 * Parse over/under side + line from pick text and optional totalLine field.
 * Returns { side: 'over'|'under', line: number } or null
 */
function parseTotalSideAndLine(pickName, totalLine) {
  const pick = String(pickName || '');
  const blob = pick.toLowerCase();
  let side = null;
  if (/\bover\b|\bo\s*[\d.]/.test(blob) || /^o\s*\d/.test(blob.trim())) side = 'over';
  if (/\bunder\b|\bu\s*[\d.]/.test(blob) || /^u\s*\d/.test(blob.trim())) side = 'under';
  // "Full game Over 8.5" style
  if (!side && /over/i.test(pick)) side = 'over';
  if (!side && /under/i.test(pick)) side = 'under';

  let line = totalLine != null && Number.isFinite(Number(totalLine)) ? Number(totalLine) : null;
  if (line == null) {
    const m = pick.match(/(?:over|under|o\/u|total)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || pick.match(/\b([0-9]{1,3}\.[05])\b/)
      || pick.match(/\b([0-9]{1,3})\b/);
    if (m) line = Number(m[1]);
  }
  if (!side || line == null || !Number.isFinite(line)) return null;
  return { side, line };
}

/**
 * Settle full-game total from final scores.
 * outcome: won | lost | push | null
 */
function pickWonTotal(pickName, result, totalLine) {
  if (!result || !result.completed) return null;
  const parsed = parseTotalSideAndLine(pickName, totalLine);
  if (!parsed) return null;
  const hs = Number(result.homeScore);
  const as = Number(result.awayScore);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const total = hs + as;
  const line = parsed.line;
  // Standard totals: push on exact integer line when total equals line
  if (total === line) return 'push';
  const wentOver = total > line;
  if (parsed.side === 'over') return wentOver ? 'won' : 'lost';
  return wentOver ? 'lost' : 'won';
}


function pickWonMoneyline(pickName, result) {
  if (!result || !result.completed || !pickName) return null;
  if (result.winnerName == null) return 'push';
  const p = norm(pickName);
  const w = norm(result.winnerName);
  if (!p || !w) return null;
  // fuzzy: last word (mascot) or includes
  if (w.includes(p) || p.includes(w)) return 'won';
  const pw = p.split(/\s+/).filter((x) => x.length > 2);
  const ww = w.split(/\s+/).filter((x) => x.length > 2);
  if (pw.length && ww.length && (pw[pw.length - 1] === ww[ww.length - 1] || w.includes(pw[pw.length - 1]))) return 'won';
  // if pick matches loser
  const losers = [norm(result.homeName), norm(result.awayName)].filter((n) => n && n !== w);
  for (const L of losers) {
    if (L.includes(p) || p.includes(L)) return 'lost';
    const lw = L.split(/\s+/).filter((x) => x.length > 2);
    if (pw.length && lw.length && pw[pw.length - 1] === lw[lw.length - 1]) return 'lost';
  }
  return null;
}



/** Live scoreboard cache per league */
const boardCache = globalThis.__espnBoard || (globalThis.__espnBoard = {});

/**
 * Fetch ESPN scoreboard for a league (live + today)
 */
async function fetchScoreboard(league) {
  const key = String(league || '').toLowerCase();
  const sp = pathFor(key);
  if (!sp) return [];
  if (boardCache[key] && Date.now() - boardCache[key].t < 45 * 1000) {
    return boardCache[key].events;
  }
  try {
    const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + sp + '/scoreboard');
    const events = d.events || [];
    boardCache[key] = { t: Date.now(), events };
    return events;
  } catch (err) {
    return (boardCache[key] && boardCache[key].events) || [];
  }
}

/**
 * Period length helpers for remaining-time fraction
 * Football: 4x15 min regulation (CFB same structure for clock math)
 * NBA/WNBA/CBB: 4 quarters (NBA 12, CBB ~10, WNBA 10) — use period count
 * NHL: 3x20
 * MLB: use inning-based fraction (outs not always available)
 */
function regulationSeconds(league) {
  const lg = String(league || '').toLowerCase();
  if (lg === 'nfl' || lg === 'cfb') return 4 * 15 * 60;
  if (lg === 'nba') return 4 * 12 * 60;
  if (lg === 'wnba' || lg === 'cbb') return 4 * 10 * 60;
  if (lg === 'nhl') return 3 * 20 * 60;
  return null;
}

function periodLengthSec(league) {
  const lg = String(league || '').toLowerCase();
  if (lg === 'nfl' || lg === 'cfb') return 15 * 60;
  if (lg === 'nba') return 12 * 60;
  if (lg === 'wnba' || lg === 'cbb') return 10 * 60;
  if (lg === 'nhl') return 20 * 60;
  return null;
}

function parseClockToSeconds(clock) {
  if (clock == null) return null;
  const s = String(clock).trim();
  if (!s || s === '0:00' || s === '0.0') return 0;
  // MM:SS or M:SS
  const m = s.match(/^(\d+):(\d{2})$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const sec = parseFloat(s);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * Compute remainingFrac (1 = start, 0 = end of regulation)
 */
function remainingFracFromStatus(league, status) {
  if (!status) return null;
  const lg = String(league || '').toLowerCase();
  const period = status.period != null ? Number(status.period) : null;
  const clockSec = parseClockToSeconds(status.displayClock || status.clock);
  const completed = !!(status.type && (status.type.completed || status.type.name === 'STATUS_FINAL'));
  if (completed) return 0;

  // MLB: period is inning
  if (lg === 'mlb') {
    if (period == null || !Number.isFinite(period)) return null;
    // Assume middle of inning if no outs detail
    const innFrac = Math.min(0.95, Math.max(0.05, (period - 0.5) / 9));
    return Math.max(0, Math.min(1, 1 - innFrac));
  }

  const reg = regulationSeconds(lg);
  const pLen = periodLengthSec(lg);
  if (reg == null || pLen == null || period == null || !Number.isFinite(period)) return null;
  const periodsTotal = lg === 'nhl' ? 3 : 4;
  const periodsDone = Math.max(0, Math.min(periodsTotal, period - 1));
  const clockLeft = clockSec != null ? clockSec : pLen * 0.5;
  const remainingInPeriod = Math.max(0, Math.min(pLen, clockLeft));
  const remaining = (periodsTotal - period) * pLen + remainingInPeriod;
  // when period is last and clock runs, remainingInPeriod handles it
  const rem = Math.max(0, (periodsTotal - periodsDone - 1) * pLen + remainingInPeriod);
  return Math.max(0, Math.min(1, rem / reg));
}

function liveStateFromEvent(league, ev) {
  const c = (ev.competitions || [])[0] || {};
  const st = c.status || ev.status || {};
  const comps = c.competitors || [];
  const home = comps.find((x) => x.homeAway === 'home') || comps[0];
  const away = comps.find((x) => x.homeAway === 'away') || comps[1];
  const scoreNum = (x) => {
    if (!x) return null;
    const sc = x.score;
    if (sc == null) return null;
    if (typeof sc === 'number') return sc;
    if (typeof sc === 'object' && sc.value != null) return Number(sc.value);
    return Number(sc);
  };
  const hs = scoreNum(home);
  const as = scoreNum(away);
  const detail = (st.type && st.type.detail) || (st.type && st.type.shortDetail) || st.detail || '';
  const state = (st.type && st.type.state) || ''; // in, pre, post
  const live = state === 'in' || /STATUS_IN_PROGRESS|STATUS_HALFTIME|STATUS_END_PERIOD/i.test(String(st.type && st.type.name || ''));
  const ended = state === 'post' || !!(st.type && st.type.completed);
  const period = st.period != null ? st.period : null;
  const displayClock = st.displayClock || null;
  const remainingFrac = remainingFracFromStatus(league, st);
  const elapsedFrac = remainingFrac != null ? Math.max(0, Math.min(1, 1 - remainingFrac)) : null;
  let scoreStr = null;
  if (as != null && hs != null) scoreStr = as + '-' + hs; // away-home common on boards
  return {
    live,
    ended,
    period,
    periodLabel: detail || (period != null ? String(period) : null),
    displayClock,
    remainingFrac,
    elapsedFrac,
    score: scoreStr,
    homeScore: hs,
    awayScore: as,
    homeName: home && home.team && (home.team.displayName || home.team.name),
    awayName: away && away.team && (away.team.displayName || away.team.name),
    espnEventId: ev.id || null,
  };
}

/**
 * Match a board event to home/away names
 */
function matchBoardEvent(events, homeName, awayName, eventTitle) {
  const hn = norm(homeName);
  const an = norm(awayName);
  const title = norm(eventTitle);
  for (const ev of events || []) {
    const st = liveStateFromEvent('', ev);
    // recompute names from event
    const c = (ev.competitions || [])[0] || {};
    const comps = c.competitors || [];
    const names = comps.map((x) => norm(x.team && (x.team.displayName || x.team.name || x.team.abbreviation))).filter(Boolean);
    if (hn && an) {
      const hitH = names.some((n) => n.includes(hn.slice(0, 6)) || hn.includes(n.slice(0, 6)));
      const hitA = names.some((n) => n.includes(an.slice(0, 6)) || an.includes(n.slice(0, 6)));
      if (hitH && hitA) return ev;
    }
    if (title && names.length >= 2) {
      if (names.some((n) => title.includes(n.slice(0, 5))) && names.filter((n) => title.includes(n.slice(0, 5))).length >= 1) {
        // weak match — require both fragments
        const hits = names.filter((n) => title.includes(n.slice(0, 5)) || n.includes(title.slice(0, 5)));
        if (hits.length >= 2) return ev;
      }
    }
  }
  return null;
}

/**
 * Attach ESPN live clock/score onto a game object
 */
async function attachEspnLive(game) {
  if (!game) return game;
  const league = String(game.league || '').toLowerCase();
  if (!pathFor(league)) return game;
  try {
    const events = await fetchScoreboard(league);
    const ev = matchBoardEvent(events, game.homeName, game.awayName, game.eventTitle || game.title);
    if (!ev) return game;
    const ls = liveStateFromEvent(league, ev);
    if (ls.live) {
      game.live = true;
      game.ended = false;
    } else if (ls.ended) {
      game.ended = true;
      game.live = false;
    }
    if (ls.score) game.score = ls.score;
    if (ls.periodLabel) game.period = ls.periodLabel;
    else if (ls.period != null) game.period = String(ls.period);
    if (ls.displayClock) game.clock = ls.displayClock;
    game.remainingFrac = ls.remainingFrac;
    game.elapsedFrac = ls.elapsedFrac;
    game.espnLive = {
      displayClock: ls.displayClock,
      period: ls.period,
      remainingFrac: ls.remainingFrac,
      elapsedFrac: ls.elapsedFrac,
      detail: ls.periodLabel,
      eventId: ls.espnEventId,
    };
  } catch (e) {
    /* non-fatal */
  }
  return game;
}

/**
 * Batch attach for a list (one scoreboard fetch per league)
 */
async function attachEspnLiveBatch(games) {
  const list = games || [];
  const byLg = {};
  list.forEach((g, i) => {
    const lg = String(g.league || '').toLowerCase();
    if (!pathFor(lg)) return;
    if (!byLg[lg]) byLg[lg] = [];
    byLg[lg].push(i);
  });
  for (const lg of Object.keys(byLg)) {
    let events = [];
    try {
      events = await fetchScoreboard(lg);
    } catch (e) {
      continue;
    }
    for (const i of byLg[lg]) {
      const g = list[i];
      const ev = matchBoardEvent(events, g.homeName, g.awayName, g.eventTitle || g.title);
      if (!ev) continue;
      const ls = liveStateFromEvent(lg, ev);
      if (ls.live) {
        g.live = true;
        g.ended = false;
      } else if (ls.ended) {
        g.ended = true;
        g.live = false;
      }
      if (ls.score) g.score = ls.score;
      if (ls.periodLabel) g.period = ls.periodLabel;
      else if (ls.period != null) g.period = String(ls.period);
      if (ls.displayClock) g.clock = ls.displayClock;
      g.remainingFrac = ls.remainingFrac;
      g.elapsedFrac = ls.elapsedFrac;
      g.espnLive = {
        displayClock: ls.displayClock,
        period: ls.period,
        remainingFrac: ls.remainingFrac,
        elapsedFrac: ls.elapsedFrac,
        detail: ls.periodLabel,
        eventId: ls.espnEventId,
      };
    }
  }
  return list;
}


module.exports = {
  matchupForEvent,
  fetchScoreboard,
  attachEspnLive,
  attachEspnLiveBatch,
  remainingFracFromStatus,
  formWinProbability,
  findTeam,
  listTeams,
  pathFor,
  SPORT_PATH,
  finalResultForEvent,
  pickWonMoneyline,
  pickWonTotal,
  parseTotalSideAndLine,
};

