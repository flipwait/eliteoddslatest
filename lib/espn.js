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
  // Soccer (ESPN soccer/{leagueCode})
  mls: 'soccer/usa.1',
  usa: 'soccer/usa.1',
  'usa.1': 'soccer/usa.1',
  epl: 'soccer/eng.1',
  eng: 'soccer/eng.1',
  'eng.1': 'soccer/eng.1',
  soccer: 'soccer/usa.1', // default MLS; title match may still resolve teams
  ucl: 'soccer/uefa.champions',
  champions: 'soccer/uefa.champions',
  'uefa.champions': 'soccer/uefa.champions',
  laliga: 'soccer/esp.1',
  esp: 'soccer/esp.1',
  'esp.1': 'soccer/esp.1',
  bundesliga: 'soccer/ger.1',
  ger: 'soccer/ger.1',
  'ger.1': 'soccer/ger.1',
  seriea: 'soccer/ita.1',
  ita: 'soccer/ita.1',
  'ita.1': 'soccer/ita.1',
  ligue1: 'soccer/fra.1',
  fra: 'soccer/fra.1',
  'fra.1': 'soccer/fra.1',
  // Polymarket US slugs
  lal: 'soccer/esp.1',
  bun: 'soccer/ger.1',
  sea: 'soccer/ita.1',
  ucl: 'soccer/uefa.champions',
  uefa: 'soccer/uefa.champions',
  fwc: 'soccer/fifa.world',
};

const teamCache = globalThis.__espnTeams || (globalThis.__espnTeams = {});
const schedCache = globalThis.__espnSched || (globalThis.__espnSched = {});

function pathFor(league) {
  let lg = String(league || '').toLowerCase().trim();
  if (lg === 'soccer' || lg === 'football') lg = 'mls';
  if (lg === 'premier' || lg === 'premier-league' || lg === 'premier_league') lg = 'epl';
  if (lg === 'la-liga' || lg === 'laliga' || lg === 'la_liga') lg = 'lal';
  if (lg === 'bundesliga' || lg === 'bundes') lg = 'bun';
  if (lg === 'seriea' || lg === 'serie-a' || lg === 'serie_a') lg = 'sea';
  return SPORT_PATH[lg] || null;
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
  let out = [];
  // CFB: FBS (80) then FCS (81) so Power-conference schools beat D-III name collisions
  if (key === 'cfb' || sp === 'football/college-football') {
    const seen = new Set();
    for (const groups of ['80', '81', '']) {
      const q = groups
        ? 'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams?groups=' + groups + '&limit=500'
        : 'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams?limit=500';
      try {
        const d = await fetchJson(q);
        const leaguesArr = (((d.sports || [])[0] || {}).leagues) || [];
        const teams = (leaguesArr[0] && leaguesArr[0].teams) || [];
        for (const x of teams) {
          const t = x.team || x;
          if (!t || !t.id || seen.has(String(t.id))) continue;
          seen.add(String(t.id));
          t._cfbTier = groups === '80' ? 3 : groups === '81' ? 2 : 1;
          out.push(t);
        }
      } catch (err) {
        /* try next */
      }
    }
  } else {
    const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams?limit=500');
    const leaguesArr = (((d.sports || [])[0] || {}).leagues) || [];
    const teams = (leaguesArr[0] && leaguesArr[0].teams) || [];
    out = teams.map((x) => x.team || x).filter(Boolean);
  }
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

/** Scored match 0–100 — full names beat weak location-only hits */
function teamMatchScore(team, query) {
  const q = norm(query);
  if (!q || !team) return 0;
  const display = norm(team.displayName);
  const shortN = norm(team.shortDisplayName);
  const name = norm(team.name);
  const nick = norm(team.nickname);
  const abbr = norm(team.abbreviation);
  const loc = norm(team.location);
  let best = 0;
  if (display === q || shortN === q || name === q) best = Math.max(best, 100);
  if (nick && nick === q) best = Math.max(best, 88);
  if (abbr && abbr === q) best = Math.max(best, 92);
  if (display && (display.startsWith(q + ' ') || display === q)) best = Math.max(best, 96);
  if (display && q.length >= 5 && display.includes(q)) best = Math.max(best, 90);
  if (shortN && q.length >= 4 && (shortN === q || shortN.startsWith(q))) best = Math.max(best, 88);
  const qt = q.split(' ').filter((w) => w.length > 0);
  // Abbr + nickname/short: "okc thunder", "ny knicks", "sf 49ers"
  if (qt.length >= 2 && abbr) {
    const first = qt[0];
    const rest = qt.slice(1).join(' ');
    if (first === abbr || abbr.startsWith(first) || first.startsWith(abbr)) {
      if (shortN && (shortN === rest || shortN.includes(rest) || rest.includes(shortN))) best = Math.max(best, 98);
      if (nick && (nick === rest || nick.includes(rest) || rest.includes(nick))) best = Math.max(best, 96);
      if (display && rest && display.includes(rest)) best = Math.max(best, 97);
      if (name && rest && name.includes(rest)) best = Math.max(best, 95);
    }
  }
  // Multi-word queries: require ALL tokens in displayName OR (abbr + remaining in display)
  if (qt.length >= 2 && display) {
    const hit = qt.filter((t) => display.includes(t) || (abbr && t === abbr) || (shortN && shortN.includes(t))).length;
    if (hit === qt.length) best = Math.max(best, 95);
    else if (hit >= qt.length - 1 && abbr && qt.some((t) => t === abbr)) best = Math.max(best, 93);
    else best = Math.max(best, Math.min(best, 30));
  }
  if (qt.length === 1 && loc && loc === q) best = Math.max(best, 72);
  if (qt.length === 1 && nick && nick === q) best = Math.max(best, 86);
  if (qt.length === 1 && shortN && shortN === q) best = Math.max(best, 90);
  if (qt.length >= 2 && loc === qt[0] && !qt.slice(1).every((t) => (display || '').includes(t) || (shortN || '').includes(t))) {
    best = Math.min(best, 40);
  }
  return best;
}

function teamMatch(team, query) {
  return teamMatchScore(team, query) >= 55;
}


/** Polymarket / Kalshi short labels → ESPN display names */
const TEAM_ALIASES = {
  nba: {
    'okc thunder': 'Oklahoma City Thunder',
    'okc': 'Oklahoma City Thunder',
    'ny knicks': 'New York Knicks',
    'nyk': 'New York Knicks',
    'gs warriors': 'Golden State Warriors',
    'gsw': 'Golden State Warriors',
    'no pelicans': 'New Orleans Pelicans',
    'nop': 'New Orleans Pelicans',
    'sa spurs': 'San Antonio Spurs',
    'sas': 'San Antonio Spurs',
    'phi 76ers': 'Philadelphia 76ers',
    'sixers': 'Philadelphia 76ers',
    'la clippers': 'LA Clippers',
    'lac': 'LA Clippers',
    'la lakers': 'Los Angeles Lakers',
    'lal': 'Los Angeles Lakers',
    'ny nets': 'Brooklyn Nets',
    'bkn': 'Brooklyn Nets',
    'brooklyn': 'Brooklyn Nets',
    'uta jazz': 'Utah Jazz',
    'utah jazz': 'Utah Jazz',
    'por trail blazers': 'Portland Trail Blazers',
    'portland': 'Portland Trail Blazers',
    'wsh wizards': 'Washington Wizards',
    'was wizards': 'Washington Wizards',
  },
  nfl: {
    'sf 49ers': 'San Francisco 49ers',
    'sf': 'San Francisco 49ers',
    'niners': 'San Francisco 49ers',
    'tb buccaneers': 'Tampa Bay Buccaneers',
    'tb bucs': 'Tampa Bay Buccaneers',
    'tb': 'Tampa Bay Buccaneers',
    'wsh commanders': 'Washington Commanders',
    'was commanders': 'Washington Commanders',
    'washington': 'Washington Commanders',
    'ne patriots': 'New England Patriots',
    'kc chiefs': 'Kansas City Chiefs',
    'lv raiders': 'Las Vegas Raiders',
    'la rams': 'Los Angeles Rams',
    'la chargers': 'Los Angeles Chargers',
    'lac chargers': 'Los Angeles Chargers',
    'ny giants': 'New York Giants',
    'nyg': 'New York Giants',
    'ny jets': 'New York Jets',
    'nyj': 'New York Jets',
    'jac jaguars': 'Jacksonville Jaguars',
    'jax jaguars': 'Jacksonville Jaguars',
    'jax': 'Jacksonville Jaguars',
    'no saints': 'New Orleans Saints',
    'gb packers': 'Green Bay Packers',
  },
  mlb: {
    'lad dodgers': 'Los Angeles Dodgers',
    'la dodgers': 'Los Angeles Dodgers',
    'lad': 'Los Angeles Dodgers',
    'ny yankees': 'New York Yankees',
    'nyy': 'New York Yankees',
    'ny mets': 'New York Mets',
    'nym': 'New York Mets',
    'wsh nationals': 'Washington Nationals',
    'was nationals': 'Washington Nationals',
    'sf giants': 'San Francisco Giants',
    'sd padres': 'San Diego Padres',
    'tb rays': 'Tampa Bay Rays',
    'chi cubs': 'Chicago Cubs',
    'chi white sox': 'Chicago White Sox',
    'cws': 'Chicago White Sox',
    'bos red sox': 'Boston Red Sox',
    'stl cardinals': 'St. Louis Cardinals',
    'kc royals': 'Kansas City Royals',
  },
  nhl: {
    'ny rangers': 'New York Rangers',
    'ny islanders': 'New York Islanders',
    'nj devils': 'New Jersey Devils',
    'la kings': 'Los Angeles Kings',
    'tb lightning': 'Tampa Bay Lightning',
    'sj sharks': 'San Jose Sharks',
    'vgk': 'Vegas Golden Knights',
    'vegas': 'Vegas Golden Knights',
  },
};

const WNBA_ALIASES = {
  'golden state': 'Golden State Valkyries',
  'valkyries': 'Golden State Valkyries',
  'atlanta': 'Atlanta Dream',
  'dream': 'Atlanta Dream',
  'las vegas': 'Las Vegas Aces',
  'aces': 'Las Vegas Aces',
  'new york': 'New York Liberty',
  'liberty': 'New York Liberty',
  'connecticut': 'Connecticut Sun',
  'sun': 'Connecticut Sun',
  'minnesota': 'Minnesota Lynx',
  'lynx': 'Minnesota Lynx',
  'phoenix': 'Phoenix Mercury',
  'mercury': 'Phoenix Mercury',
  'seattle': 'Seattle Storm',
  'storm': 'Seattle Storm',
  'chicago': 'Chicago Sky',
  'sky': 'Chicago Sky',
  'dallas': 'Dallas Wings',
  'wings': 'Dallas Wings',
  'indiana': 'Indiana Fever',
  'fever': 'Indiana Fever',
  'washington': 'Washington Mystics',
  'mystics': 'Washington Mystics',
  'los angeles': 'Los Angeles Sparks',
  'sparks': 'Los Angeles Sparks',
};

async function findTeam(league, nameHint) {
  let hint = String(nameHint || '').trim();
  const lg0 = String(league || '').toLowerCase();
  // Resolve Polymarket/Kalshi short codes before scoring
  const aliasMap = TEAM_ALIASES[lg0] || {};
  const aliasKey = norm(hint);
  if (aliasMap[aliasKey]) hint = aliasMap[aliasKey];
  else {
    for (const [k, v] of Object.entries(aliasMap)) {
      if (aliasKey === k || aliasKey.indexOf(k) === 0 || (k.length >= 3 && aliasKey.indexOf(k) >= 0)) {
        // Prefer exact / prefix over loose contains for short keys
        if (aliasKey === k || aliasKey.startsWith(k + ' ') || aliasKey.endsWith(' ' + k)) {
          hint = v;
          break;
        }
      }
    }
  }
  if (lg0 === 'wnba' && hint) {
    const key = hint.toLowerCase().replace(/^game\s*\d+:\s*/i, '').trim();
    // "Golden State" / "Atlanta" short names
    for (const [k, v] of Object.entries(WNBA_ALIASES)) {
      if (key === k || key.indexOf(k) === 0 || k.indexOf(key) === 0) {
        hint = v;
        break;
      }
    }
  }
  // Strip "Game 3:" prefixes from playoff titles
  hint = hint.replace(/^Game\s*\d+:\s*/i, '').trim();
  const teams = await listTeams(league);
  const lg = String(league || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  const queryForScore = hint || nameHint;
  for (const t of teams) {
    let sc = Math.max(teamMatchScore(t, queryForScore), teamMatchScore(t, nameHint));
    if (sc <= 0) continue;
    if (lg === 'cfb') {
      sc += (t._cfbTier || 0) * 5;
      if (/\([a-z]{2}\)/i.test(String(t.displayName || ''))) sc -= 12;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }
  if (bestScore >= 55) return best;
  // WNBA / CFB fallback: ESPN text search when list miss
  if ((lg === 'cfb' || lg === 'wnba' || lg === 'nba' || lg === 'nfl' || lg === 'mlb' || lg === 'nhl') && (hint || nameHint)) {
    try {
      const qName = String(hint || nameHint).trim();
      const q = encodeURIComponent(qName);
      const d = await fetchJson(
        'https://site.web.api.espn.com/apis/common/v3/search?region=us&lang=en&query=' + q + '&limit=8&type=team'
      );
      const items = d.items || d.results || [];
      for (const it of items) {
        const id = it.id || (it.team && it.team.id);
        const dn = it.displayName || (it.team && it.team.displayName) || '';
        if (!id || !dn) continue;
        const blob = JSON.stringify(it.type || it) + dn + (it.defaultLeagueSlug || '');
        if (lg === 'wnba' && !/wnba/i.test(blob + (it.league || ''))) {
          if (teamMatchScore({ displayName: dn }, qName) < 85) continue;
        }
        if (lg === 'nba' && /wnba/i.test(blob)) continue;
        if (teamMatchScore({ displayName: dn, shortDisplayName: dn }, qName) < 65) continue;
        const sportPath = pathFor(league);
        if (!sportPath) continue;
        try {
          const td = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + sportPath + '/teams/' + id);
          if (td && td.team) return td.team;
        } catch (e2) {
          return { id: String(id), displayName: dn, location: String(dn).split(' ')[0], nickname: dn };
        }
      }
    } catch (err) { /* ignore */ }
  }
  if (lg === 'cfb' && nameHint) {
    try {
      const q = encodeURIComponent(String(nameHint).trim());
      const d = await fetchJson(
        'https://site.web.api.espn.com/apis/common/v3/search?region=us&lang=en&query=' + q + '&limit=8&type=team'
      );
      const items = d.items || d.results || [];
      for (const it of items) {
        const id = it.id || (it.team && it.team.id);
        const dn = it.displayName || (it.team && it.team.displayName) || '';
        if (!id || !/college-football|ncaa/i.test(JSON.stringify(it.type || it) + dn + (it.defaultLeagueSlug || ''))) {
          // still accept if name matches strongly
          if (teamMatchScore({ displayName: dn, location: dn.split(' ')[0], nickname: dn }, nameHint) < 80) continue;
        }
        if (teamMatchScore({ displayName: dn, shortDisplayName: dn, location: String(dn).split(' ')[0] }, nameHint) < 70) continue;
        // hydrate full team record for schedule API
        try {
          const td = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/' + id);
          if (td && td.team) {
            td.team._cfbTier = 3;
            return td.team;
          }
        } catch (e2) {
          return {
            id: String(id),
            displayName: dn,
            location: String(dn).split(' ')[0],
            nickname: dn,
            _cfbTier: 3,
          };
        }
      }
    } catch (err) {
      /* ignore */
    }
  }
  return null;
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
  const lg = String(league || '').toLowerCase();
  let events = [];
  try {
    const d = await fetchJson(
      'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams/' + teamId + '/schedule'
    );
    events = d.events || [];
  } catch (e0) {}
  // NBA / WNBA: also pull preseason (seasontype=1) + regular (2) so early form is not empty
  if (lg === 'nba' || lg === 'wnba') {
    const byId = new Map();
    for (const e of events) {
      if (e && e.id) byId.set(String(e.id), e);
    }
    for (const st of [1, 2]) {
      try {
        const d2 = await fetchJson(
          'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams/' + teamId +
            '/schedule?seasontype=' + st
        );
        for (const e of d2.events || []) {
          if (e && e.id) byId.set(String(e.id), e);
        }
      } catch (e1) {}
    }
    events = Array.from(byId.values()).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''));
    });
  }
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
  const league = String(matchup.league || '').toLowerCase();
  const isNba = league === 'nba' || league === 'wnba' || league === 'cbb';
  // Prefer true home/away splits; for NBA preseason fall back to all-games L10 when split is thin
  let homeL10 = matchup.homeL10;
  let awayL10 = matchup.awayL10;
  let homeL5 = matchup.homeL5;
  let awayL5 = matchup.awayL5;
  const h2h = matchup.h2h;
  if (isNba) {
    if ((!homeL10 || homeL10.n < 2) && matchup.homeAllL10 && matchup.homeAllL10.n >= 1) {
      homeL10 = matchup.homeAllL10;
    }
    if ((!awayL10 || awayL10.n < 2) && matchup.awayAllL10 && matchup.awayAllL10.n >= 1) {
      awayL10 = matchup.awayAllL10;
    }
  }
  if (!homeL10 && !awayL10 && !h2h) return null;

  // Football (NFL + CFB): same winner formula — L10/L5, margin, H2H, rest, modest home
  let wL10 = 1.4, wL5 = 0.9, wPD = 0.6, wH2H = 0.7, wRest = 0.04, homePrior = 0.08;
  // Min games to count a split (NBA preseason: 1 game still informs)
  const minL10 = isNba ? 1 : 3;
  const minL5 = isNba ? 1 : 2;
  if (league === 'nfl' || league === 'cfb') {
    wL10 = 1.4; wL5 = 0.9; wPD = 0.8; wH2H = 0.7; wRest = 0.07; homePrior = 0.08; // NFL baseline (~+2pp home)
  } else if (league === 'nba' || league === 'wnba') {
    // NBA: home court ~+3pp, rest/B2B matters, scoring margin useful
    wL10 = 1.35; wL5 = 1.05; wPD = 0.9; wH2H = 0.7; wRest = 0.1; homePrior = 0.12;
  } else if (league === 'cbb') {
    wL10 = 1.3; wL5 = 1.0; wPD = 0.75; wH2H = 0.6; wRest = 0.05; homePrior = 0.1;
  } else if (league === 'mlb') {
    homePrior = 0.06; wRest = 0.03;
  } else if (league === 'nhl') {
    // Home ice modest; goal differential matters; B2B / rest important in NHL
    wL10 = 1.35; wL5 = 1.0; wPD = 1.1; wH2H = 0.65; wRest = 0.06; homePrior = 0.08;
  }

  let z = homePrior;
  const parts = [{ k: 'homePrior', league, homePrior }];

  if (homeL10 && homeL10.n >= minL10) {
    const wr = homeL10.wr != null ? homeL10.wr : homeL10.w / ((homeL10.w + homeL10.l) || 1);
    // Thin NBA sample: scale weight by sqrt(n/5) so 1–2 games don't dominate
    const thinScale = isNba && homeL10.n < 5 ? Math.sqrt(homeL10.n / 5) : 1;
    z += (wr - 0.5) * wL10 * thinScale;
    parts.push({ k: 'homeL10', wr, w: wL10 * thinScale, n: homeL10.n });
  }
  if (awayL10 && awayL10.n >= minL10) {
    const wr = awayL10.wr != null ? awayL10.wr : awayL10.w / ((awayL10.w + awayL10.l) || 1);
    const thinScale = isNba && awayL10.n < 5 ? Math.sqrt(awayL10.n / 5) : 1;
    z -= (wr - 0.5) * wL10 * thinScale;
    parts.push({ k: 'awayL10', wr, w: wL10 * thinScale, n: awayL10.n });
  }
  if (homeL5 && homeL5.n >= minL5) {
    const wr = homeL5.wr != null ? homeL5.wr : homeL5.w / ((homeL5.w + homeL5.l) || 1);
    const thinScale = isNba && homeL5.n < 3 ? Math.sqrt(homeL5.n / 3) : 1;
    z += (wr - 0.5) * wL5 * thinScale;
    parts.push({ k: 'homeL5', wr, w: wL5 * thinScale, n: homeL5.n });
  }
  if (awayL5 && awayL5.n >= minL5) {
    const wr = awayL5.wr != null ? awayL5.wr : awayL5.w / ((awayL5.w + awayL5.l) || 1);
    const thinScale = isNba && awayL5.n < 3 ? Math.sqrt(awayL5.n / 3) : 1;
    z -= (wr - 0.5) * wL5 * thinScale;
    parts.push({ k: 'awayL5', wr, w: wL5 * thinScale, n: awayL5.n });
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
    if ((league === 'nfl' || league === 'cfb') && matchup.homeRestDays <= 6) {
      z -= 0.04; // short week home (football)
      parts.push({ k: 'shortWeekHome' });
    }
    if ((league === 'nfl' || league === 'cfb') && matchup.awayRestDays <= 6) {
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

  // Soccer: home advantage + rest; soft league-strength prior when present
  if (['mls', 'epl', 'ucl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'soccer', 'usa.1', 'eng.1'].includes(league)
      || String(matchup.sportPath || '').includes('soccer')) {
    z += 0.12; // home field soccer
    if (matchup.homeRestDays != null && matchup.awayRestDays != null) {
      const rd = matchup.homeRestDays - matchup.awayRestDays;
      z += Math.max(-0.08, Math.min(0.08, rd * 0.02));
    }
    // League strength differential (0-100 scale if provided)
    if (matchup.homeLeagueStrength != null && matchup.awayLeagueStrength != null) {
      z += ((matchup.homeLeagueStrength - matchup.awayLeagueStrength) / 100) * 0.25;
      parts.push({ k: 'leagueStrength', h: matchup.homeLeagueStrength, a: matchup.awayLeagueStrength });
    }
    parts.push({ k: 'soccerHome' });
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
  const lg = String(matchup.league || '').toLowerCase();
  const isNba = lg === 'nba' || lg === 'wnba' || lg === 'cbb';
  const hAll = matchup.homeAllL10 || matchup.homeL10;
  const aAll = matchup.awayAllL10 || matchup.awayL10;
  let hHome = matchup.homeL10; // home team at home scoring
  let aAway = matchup.awayL10; // away team on road
  // NBA preseason: prefer all-games L10 when home/away splits are thin
  if (isNba) {
    if ((!hHome || hHome.n < 2) && hAll) hHome = hAll;
    if ((!aAway || aAway.n < 2) && aAll) aAway = aAll;
  }
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
    // Home PPG (at home) + away PPG (on road) ≈ game total
    projected = Math.round((homeRpg + awayRpg) * 10) / 10;
  } else if (homeL10GameTotal != null && awayL10GameTotal != null) {
    projected = Math.round(((homeL10GameTotal + awayL10GameTotal) / 2) * 10) / 10;
  }
  // NBA: 1H ~ 50% of full; MLB F5 ~ 55% of runs
  const halfFrac = isNba ? 0.5 : 0.55;
  const projectedF5 = projected != null ? Math.round(projected * halfFrac * 10) / 10 : null;
  return {
    homeL10GameTotal,
    awayL10GameTotal,
    homeRpg,
    awayRpg,
    projectedFg: projected,
    projectedF5,
    h2hAvgTotal: matchup.h2h && matchup.h2h.avgTotal != null ? matchup.h2h.avgTotal : null,
    note: isNba ? 'NBA L10 scoring (preseason OK) · form totals' : 'L10 team scoring · not a full totals model',
  };
}

async function matchupForEvent(league, eventTitle) {
  const sp = pathFor(league);
  if (!sp || !eventTitle) return null;
  const title = String(eventTitle || '').replace(/^Game\s*\d+:\s*/i, '').replace(/\s*[\|\-–].*$/, '').trim();
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
    // Soccer league strength soft prior (relative tier 0-100)
  if (pathFor(league) && String(pathFor(league)).includes('soccer')) {
    const tier = { epl: 92, eng: 92, 'eng.1': 92, ucl: 95, champions: 95, laliga: 88, bundesliga: 86, seriea: 85, ligue1: 82, mls: 72, usa: 72, 'usa.1': 72, soccer: 72 };
    const t = tier[String(league).toLowerCase()] || 75;
    matchup.homeLeagueStrength = t;
    matchup.awayLeagueStrength = t; // same league → neutral; cross-league later
    matchup.sportPath = pathFor(league);
  }
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
  const title = String(eventTitle || '').replace(/^Game\s*\d+:\s*/i, '').replace(/\s*[\|\-–].*$/, '').trim();
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

    // Period / quarter linescores when ESPN provides them on the competitor
    function linesFromComp(comp) {
      const ls = (comp && comp.linescores) || [];
      return ls.map((x) => {
        if (x == null) return null;
        if (typeof x === 'number') return x;
        if (typeof x === 'object' && x.value != null) return Number(x.value);
        return Number(x) || 0;
      }).filter((n) => n != null && Number.isFinite(n));
    }
    const homePeriods = linesFromComp(home);
    const awayPeriods = linesFromComp(away);
    const eventId = ev.id || c.id || null;

    candidates.push({
      completed: true,
      winnerName,
      homeName,
      awayName,
      homeScore: hs,
      awayScore: as,
      homePeriods,
      awayPeriods,
      eventId,
      league: String(league || '').toLowerCase(),
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
  let best = candidates[0];
  // Enrich period scores from ESPN summary when schedule omitted linescores
  if (best && best.eventId && (!(best.homePeriods && best.homePeriods.length) || !(best.awayPeriods && best.awayPeriods.length))) {
    try {
      const path = pathFor(league);
      if (path) {
        const sum = await fetchJson(
          'https://site.api.espn.com/apis/site/v2/sports/' + path + '/summary?event=' + encodeURIComponent(best.eventId)
        );
        const comp = ((sum.header && sum.header.competitions) || [])[0]
          || ((sum.competitions) || [])[0]
          || null;
        const comps = (comp && comp.competitors) || [];
        const homeC = comps.find((x) => x.homeAway === 'home') || comps[0];
        const awayC = comps.find((x) => x.homeAway === 'away') || comps[1];
        function ls(comp) {
          return ((comp && comp.linescores) || []).map((x) => {
            if (x == null) return null;
            if (typeof x === 'number') return x;
            if (typeof x === 'object' && x.value != null) return Number(x.value);
            return Number(x) || 0;
          }).filter((n) => n != null && Number.isFinite(n));
        }
        if (homeC) best.homePeriods = ls(homeC);
        if (awayC) best.awayPeriods = ls(awayC);
      }
    } catch (e) { /* keep final only */ }
  }
  return best;
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
 * Detect scoring window from marketType + pick text.
 * Returns: 'fg' | '1h' | '2h' | 'q1' | 'q2' | 'q3' | 'q4' | 'p1' | 'p2' | 'p3'
 */
function detectTotalWindow(pickName, marketType) {
  const blob = (String(marketType || '') + ' ' + String(pickName || '')).toLowerCase();
  if (/\bq1\b|1st\s*quarter|first\s*quarter|total_q1|spread_q1/.test(blob)) return 'q1';
  if (/\bq2\b|2nd\s*quarter|second\s*quarter|total_q2|spread_q2/.test(blob)) return 'q2';
  if (/\bq3\b|3rd\s*quarter|third\s*quarter|total_q3|spread_q3/.test(blob)) return 'q3';
  if (/\bq4\b|4th\s*quarter|fourth\s*quarter|total_q4|spread_q4/.test(blob)) return 'q4';
  if (/\b1h\b|1st\s*half|first\s*half|total_1h|spread_1h|team_total_1h/.test(blob)) return '1h';
  if (/\b2h\b|2nd\s*half|second\s*half|total_2h|spread_2h|team_total_2h/.test(blob)) return '2h';
  if (/1st\s*period|period\s*1|total_p1|p1\b/.test(blob)) return 'p1';
  if (/2nd\s*period|period\s*2|total_p2|p2\b/.test(blob)) return 'p2';
  if (/3rd\s*period|period\s*3|total_p3|p3\b/.test(blob)) return 'p3';
  return 'fg';
}

/**
 * Combined points for a window from period arrays (homePeriods/awayPeriods).
 * Football/NBA: index 0=Q1 … 3=Q4. NHL: 0=P1 … 2=P3.
 * Returns null if required periods are missing (do not invent).
 */
function combinedForWindow(result, window) {
  const hp = Array.isArray(result.homePeriods) ? result.homePeriods : [];
  const ap = Array.isArray(result.awayPeriods) ? result.awayPeriods : [];
  const sumIdx = (idxs) => {
    let t = 0;
    for (const i of idxs) {
      if (hp[i] == null || ap[i] == null || !Number.isFinite(Number(hp[i])) || !Number.isFinite(Number(ap[i]))) {
        return null;
      }
      t += Number(hp[i]) + Number(ap[i]);
    }
    return t;
  };
  if (window === 'fg') {
    const hs = Number(result.homeScore);
    const as = Number(result.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
    return hs + as;
  }
  if (window === '1h') return sumIdx([0, 1]);
  if (window === '2h') {
    // Prefer Q3+Q4; if only 2 halves stored, use index 1
    if (hp.length >= 4 && ap.length >= 4) return sumIdx([2, 3]);
    if (hp.length === 2 && ap.length === 2) return sumIdx([1]);
    return sumIdx([2, 3]);
  }
  if (window === 'q1' || window === 'p1') return sumIdx([0]);
  if (window === 'q2' || window === 'p2') return sumIdx([1]);
  if (window === 'q3' || window === 'p3') return sumIdx([2]);
  if (window === 'q4') return sumIdx([3]);
  return null;
}

/**
 * Settle total from the correct score window (FG / 1H / 2H / Qx / period).
 * outcome: won | lost | push | null
 * null when period data required but missing — caller should leave OPEN (not wrong W/L).
 */
function pickWonTotal(pickName, result, totalLine, marketType) {
  if (!result || !result.completed) return null;
  const parsed = parseTotalSideAndLine(pickName, totalLine);
  if (!parsed) return null;
  const window = detectTotalWindow(pickName, marketType);
  const total = combinedForWindow(result, window);
  if (total == null) {
    // Period market without period linescores — refuse to grade on full game
    if (window !== 'fg') return null;
    return null;
  }
  const line = parsed.line;
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
  const typeName = String((st.type && st.type.name) || '');
  const typeDesc = String((st.type && (st.type.description || st.type.detail)) || st.detail || '');
  const live = state === 'in' || /STATUS_IN_PROGRESS|STATUS_HALFTIME|STATUS_END_PERIOD|STATUS_DELAYED/i.test(typeName);
  const ended =
    state === 'post' ||
    !!(st.type && st.type.completed) ||
    /STATUS_FINAL|STATUS_FULL_TIME|STATUS_FINAL_OT|STATUS_FINAL_AET/i.test(typeName) ||
    /\bfinal\b/i.test(typeDesc);
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
    if (ls.ended) {
      game.ended = true;
      game.live = false;
      if (ls.periodLabel) game.period = ls.periodLabel;
      else game.period = game.period || 'Final';
    } else if (ls.live) {
      game.live = true;
      game.ended = false;
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
      ended: !!ls.ended,
      live: !!ls.live,
    };
  } catch (e) {
    /* non-fatal */
  }
  return applyStaleLiveRules(game);
}

/**
 * Batch attach for a list (one scoreboard fetch per league)
 */

/**
 * Clear false "live" when game should be over.
 * - ESPN matched & not live → not live (already handled)
 * - No ESPN live confirm + past max duration since start → ended
 * - remainingFrac 0 → ended
 */
function applyStaleLiveRules(game) {
  if (!game) return game;
  const league = String(game.league || '').toLowerCase();
  const maxHours =
    league === 'mlb' ? 5.5 :
    league === 'nfl' || league === 'cfb' ? 5 :
    league === 'nhl' ? 4.5 :
    league === 'nba' || league === 'wnba' || league === 'cbb' ? 4 :
    5;
  const startMs = game.startTime ? new Date(game.startTime).getTime() : NaN;
  const ageH = Number.isFinite(startMs) ? (Date.now() - startMs) / 3600000 : null;

  // ESPN said final
  if (game.espnLive && (game.espnLive.ended || game.espnLive.remainingFrac === 0)) {
    game.ended = true;
    game.live = false;
    if (!game.period || !/final/i.test(String(game.period))) game.period = game.period || 'Final';
    return game;
  }
  // Explicit period Final
  if (/\\bfinal\\b|\\bft\\b/i.test(String(game.period || ''))) {
    game.ended = true;
    game.live = false;
    return game;
  }
  // Stale live: past max duration and ESPN did not confirm in-progress
  const espnConfirmedLive = !!(game.espnLive && game.espnLive.detail && game.live && !game.ended);
  if (game.live && ageH != null && ageH > maxHours) {
    // If we have espnLive object from a match that is not live, already handled
    // If no ESPN match or ESPN not live — kill stale poly live flag
    if (!game.espnLive || game.espnLive.remainingFrac === 0 || !espnConfirmedLive) {
      // Only force end if age is clearly past; require either no espn live clock or ended
      const stillLiveEspn = game.espnLive && game.espnLive.displayClock != null && game.espnLive.remainingFrac > 0.02;
      if (!stillLiveEspn) {
        game.ended = true;
        game.live = false;
        game.period = game.period && /final/i.test(String(game.period)) ? game.period : 'Final';
        game.staleLiveCleared = true;
      }
    }
  }
  // Age > max+1h always end (safety)
  if (ageH != null && ageH > maxHours + 1.5) {
    game.ended = true;
    game.live = false;
    game.period = 'Final';
  }
  return game;
}


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
      // Prefer ESPN scheduled tip/kickoff over Kalshi occurrence (often ~end-of-game)
      try {
        const c0 = (ev.competitions && ev.competitions[0]) || {};
        const espnDate = c0.date || ev.date || null;
        if (espnDate) {
          const ems = new Date(espnDate).getTime();
          if (Number.isFinite(ems)) {
            const venue = String(g.venue || g.source || '').toLowerCase();
            const cur = g.startTime ? new Date(g.startTime).getTime() : NaN;
            // Always trust ESPN for Kalshi; for others only if missing or >90m off
            if (venue === 'kalshi' || !Number.isFinite(cur) || Math.abs(cur - ems) > 90 * 60 * 1000) {
              g.startTime = new Date(ems).toISOString();
              g.startTimeSource = 'espn';
            }
          }
        }
      } catch (eDate) {}
      if (ls.ended) {
        g.ended = true;
        g.live = false;
        if (ls.periodLabel) g.period = ls.periodLabel;
        else g.period = g.period || 'Final';
      } else if (ls.live) {
        g.live = true;
        g.ended = false;
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
        ended: !!ls.ended,
        live: !!ls.live,
      };
    }
  }
  list.forEach((g) => applyStaleLiveRules(g));
  return list;
}




/**
 * Player prop settle from ESPN game summary boxscore.
 * Supports points / rebounds / assists / PRA when boxscore lists them.
 */
function parsePlayerPropPick(pickName, marketType, totalLine) {
  const pick = String(pickName || '');
  const mt = String(marketType || '').toLowerCase();
  const blob = (pick + ' ' + mt).toLowerCase();
  let side = 'over';
  if (/\bunder\b/.test(blob)) side = 'under';
  let line = totalLine != null && Number.isFinite(Number(totalLine)) ? Number(totalLine) : null;
  if (line == null) {
    const m = pick.match(/(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || pick.match(/(\d+(?:\.\d+)?)\+/)
      || pick.match(/at least\s+(\d+(?:\.\d+)?)/i)
      || pick.match(/\b(\d+(?:\.\d+)?)\b/);
    if (m) line = Number(m[1]);
  }
  // Player name: "Victor Wembanyama Over 20" / "Landry Shamet 15+"
  let player = null;
  let pm = pick.match(/^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.'\-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.'\-]+){0,3})\s+(?:over|under|\d)/i);
  if (!pm) pm = pick.match(/will\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.'\-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.'\-]+){0,3})\s+record/i);
  if (!pm) pm = pick.match(/^([^:]+):\s*\d+/);
  if (pm) player = pm[1].replace(/\s+ML$/i, '').trim();
  let stat = 'points';
  if (/reb|rebound/.test(blob)) stat = 'rebounds';
  else if (/ast|assist/.test(blob)) stat = 'assists';
  else if (/pra|points.*rebound|combined points/.test(blob)) stat = 'pra';
  else if (/three|3pt|3-pt/.test(blob)) stat = 'threes';
  else if (/steal/.test(blob)) stat = 'steals';
  else if (/block/.test(blob)) stat = 'blocks';
  else if (/pass(ing)?\s*yard/.test(blob)) stat = 'passingYards';
  else if (/rush(ing)?\s*yard/.test(blob)) stat = 'rushingYards';
  else if (/receiv(ing)?\s*yard/.test(blob)) stat = 'receivingYards';
  else if (/reception/.test(blob)) stat = 'receptions';
  else if (/\bpts\b|points/.test(blob)) stat = 'points';
  if (!player || line == null || !Number.isFinite(line)) return null;
  return { player, line, side, stat };
}

function athleteStatValue(athlete, stat) {
  if (!athlete) return null;
  const stats = athlete.stats || athlete.statistics || [];
  // stats may be array of numbers aligned with labels, or object
  const labels = athlete.labels || athlete.names || [];
  function fromLabels(keys) {
    if (!Array.isArray(stats) || !Array.isArray(labels)) return null;
    for (const k of keys) {
      const idx = labels.findIndex((n) => String(n).toLowerCase() === k || String(n).toLowerCase().indexOf(k) >= 0);
      if (idx >= 0 && stats[idx] != null) {
        const v = parseFloat(String(stats[idx]).replace(/[^0-9.\-]/g, ''));
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  }
  if (stat === 'points') { const v = fromLabels(['pts', 'points']); return v != null ? v : (athlete.points != null ? Number(athlete.points) : null); }
  if (stat === 'rebounds') return fromLabels(['reb', 'rebounds', 'totalrebounds']);
  if (stat === 'assists') return fromLabels(['ast', 'assists']);
  if (stat === 'threes') return fromLabels(['3pt', '3pm', 'threes', 'threePointFieldGoalsMade']);
  if (stat === 'steals') return fromLabels(['stl', 'steals']);
  if (stat === 'blocks') return fromLabels(['blk', 'blocks']);
  if (stat === 'pra') {
    const pts = fromLabels(['pts', 'points']);
    const reb = fromLabels(['reb', 'rebounds']);
    const ast = fromLabels(['ast', 'assists']);
    if (pts == null || reb == null || ast == null) return null;
    return pts + reb + ast;
  }
  if (stat === 'passingYards') return fromLabels(['passingyards', 'pass yards', 'yds']);
  if (stat === 'rushingYards') return fromLabels(['rushingyards', 'rush yards']);
  if (stat === 'receivingYards') return fromLabels(['receivingyards', 'rec yards']);
  if (stat === 'receptions') return fromLabels(['receptions', 'rec']);
  return null;
}

function nameMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const la = na.split(/\s+/).pop();
  const lb = nb.split(/\s+/).pop();
  return la && lb && la === lb && la.length > 2;
}

async function boxscoreAthletesForEvent(league, eventId) {
  const sp = pathFor(league);
  if (!sp || !eventId) return [];
  try {
    const sum = await fetchJson(
      'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/summary?event=' + encodeURIComponent(eventId)
    );
    const players = [];
    const box = sum.boxscore || {};
    const teams = box.players || [];
    for (const team of teams) {
      const statsGroups = team.statistics || [];
      for (const grp of statsGroups) {
        const labels = grp.labels || grp.names || [];
        const aths = grp.athletes || [];
        for (const row of aths) {
          const a = row.athlete || row;
          const display = (a.displayName || a.shortName || a.name || '').trim();
          if (!display) continue;
          players.push({
            name: display,
            labels,
            stats: row.stats || a.stats || [],
          });
        }
      }
    }
    // Alternate shape: boxscore.players[].athletes in older feeds
    if (!players.length && Array.isArray(box.players)) {
      for (const team of box.players) {
        for (const row of team.athletes || []) {
          const a = row.athlete || row;
          players.push({
            name: (a.displayName || a.shortName || '').trim(),
            labels: (team.labels || []),
            stats: row.stats || [],
          });
        }
      }
    }
    return players.filter((p) => p.name);
  } catch (e) {
    return [];
  }
}

/**
 * Settle player prop. Returns won|lost|push|null.
 * null = could not grade (leave open).
 */
async function pickWonPlayerProp(pickName, result, opts) {
  opts = opts || {};
  const parsed = parsePlayerPropPick(pickName, opts.marketType, opts.totalLine);
  if (!parsed) return null;
  if (!result || !result.completed) return null;
  let athletes = [];
  if (result.eventId) {
    athletes = await boxscoreAthletesForEvent(result.league || opts.league, result.eventId);
  }
  if (!athletes.length) return null;
  const hit = athletes.find((a) => nameMatch(a.name, parsed.player));
  if (!hit) return null;
  const val = athleteStatValue(hit, parsed.stat);
  if (val == null || !Number.isFinite(val)) return null;
  // Threshold markets ("15+") count as over line-0.5 style: val >= line for over on integer +
  const line = parsed.line;
  if (parsed.side === 'over') {
    if (val === line) return 'push'; // rare whole-number push
    return val > line || (Number.isInteger(line) && val >= line) ? 'won' : 'lost';
  }
  // under
  if (val === line) return 'push';
  return val < line ? 'won' : 'lost';
}

module.exports = {
  pickWonPlayerProp,
  parsePlayerPropPick,

  matchupForEvent,
  fetchScoreboard,
  attachEspnLive,
  attachEspnLiveBatch,
  applyStaleLiveRules,
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

