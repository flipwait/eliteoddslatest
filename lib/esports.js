/**
 * Esports form helpers
 * - Series format: Bo1 / Bo3 / Bo5 from title
 * - Dota2: OpenDota (free, no key)
 * - CS2 / LoL / Valorant / CoD / Dota2 fallback: PandaScore (token from Settings or env)
 */

const UA = { 'User-Agent': 'EliteOdds/1.0 (form research)', Accept: 'application/json' };
const teamCache = globalThis.__esportsTeams || (globalThis.__esportsTeams = {});
const matchCache = globalThis.__esportsMatches || (globalThis.__esportsMatches = {});
const psTeamCache = globalThis.__psTeams || (globalThis.__psTeams = {});
const psMatchCache = globalThis.__psMatches || (globalThis.__psMatches = {});

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and|team|esports|gaming|gg)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/** Common Polymarket tags ↔ official / PandaScore names */
const ESPORTS_ALIASES = {
  navi: ['natus vincere', 'navi', 'natus'],
  'natus vincere': ['navi', 'natus'],
  faze: ['faze clan', 'faze'],
  'faze clan': ['faze'],
  g2: ['g2 esports', 'g2'],
  'g2 esports': ['g2'],
  fnc: ['fnatic'],
  fnatic: ['fnc'],
  c9: ['cloud9', 'cloud 9'],
  cloud9: ['c9'],
  t1: ['t1', 'sk telecom', 'skt'],
  gen: ['gen g', 'geng', 'gen.g'],
  'gen g': ['gen.g', 'geng', 'gen'],
  'gen.g': ['gen g', 'geng'],
  geng: ['gen g', 'gen.g'],
  liquid: ['team liquid', 'tl'],
  'team liquid': ['liquid', 'tl'],
  tl: ['team liquid', 'liquid'],
  vitality: ['team vitality'],
  'team vitality': ['vitality'],
  spirit: ['team spirit'],
  'team spirit': ['spirit'],
  mouz: ['mousesports'],
  furia: ['furia'],
  eg: ['evil geniuses'],
  'evil geniuses': ['eg'],
  '100t': ['100 thieves'],
  '100 thieves': ['100t'],
  sen: ['sentinels'],
  sentinels: ['sen'],
  mad: ['mad lions'],
  'mad lions': ['mad'],
  nrg: ['nrg'],
  optic: ['optic gaming', 'optic'],
  blg: ['bilibili gaming'],
  jdg: ['jd gaming'],
  tes: ['top esports'],
  edg: ['edward gaming'],
  ig: ['invictus gaming'],
  lng: ['lng esports'],
};

function expandEsportsHints(nameHint) {
  const raw = String(nameHint || '').trim();
  if (!raw) return [];
  const out = new Set();
  // Strip roster suffixes / academy noise for search
  let cleaned = raw
    .replace(/\b(academy|youth|female|women|unis|uni|team)\b/gi, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const q = norm(raw);
  const qc = norm(cleaned);
  [q, qc, norm(raw.replace(/\d+/g, ' '))].forEach((x) => { if (x) out.add(x); });
  // First token often is the org tag: "VP.Future 3" → vp, "EAC Extra" → eac
  const first = (cleaned.split(/\s+/)[0] || '').trim();
  if (first.length >= 2) out.add(norm(first));
  const direct = ESPORTS_ALIASES[q] || ESPORTS_ALIASES[qc] || ESPORTS_ALIASES[norm(first)];
  if (direct) direct.forEach((x) => out.add(norm(x)));
  (qc || q).split(/\s+/).forEach((tok) => {
    if (tok.length < 2) return;
    out.add(tok);
    const al = ESPORTS_ALIASES[tok];
    if (al) al.forEach((x) => out.add(norm(x)));
  });
  return [...out].filter(Boolean);
}

function esportsNameInTitle(teamName, title) {
  if (!teamName || !title) return false;
  const blob = norm(title);
  if (!blob) return false;
  const nameN = norm(teamName);
  if (nameN && (blob.includes(nameN) || (nameN.length >= 4 && nameN.includes(blob)))) return true;
  const stop = new Set(['the', 'and', 'team', 'esports', 'gaming', 'club', 'org']);
  const parts = nameN.split(/\s+/).filter((w) => w.length >= 2 && !stop.has(w));
  for (const w of parts) {
    if (blob.includes(w)) return true;
    const al = ESPORTS_ALIASES[w];
    if (al) {
      for (const a of al) {
        if (blob.includes(norm(a))) return true;
      }
    }
  }
  for (const tok of blob.split(/\s+/)) {
    if (tok.length < 2) continue;
    if (parts.some((p) => p === tok || p.startsWith(tok) || tok.startsWith(p))) return true;
    const al = ESPORTS_ALIASES[tok];
    if (!al) continue;
    for (const a of al) {
      const an = norm(a);
      if (nameN.includes(an) || parts.some((p) => an.includes(p) || p.includes(an))) return true;
    }
  }
  return false;
}

function detectSeriesFormat(title) {
  const t = String(title || '');
  if (/\bbo5\b|best[\s-]*of[\s-]*5/i.test(t)) return { format: 'bo5', mapsTarget: 5, label: 'Bo5' };
  if (/\bbo3\b|best[\s-]*of[\s-]*3/i.test(t)) return { format: 'bo3', mapsTarget: 3, label: 'Bo3' };
  if (/\bbo1\b|best[\s-]*of[\s-]*1/i.test(t)) return { format: 'bo1', mapsTarget: 1, label: 'Bo1' };
  return { format: 'bo3', mapsTarget: 3, label: 'Bo3?', inferred: true };
}

function parseTitleTeams(title) {
  const t = String(title || '').replace(/\s*[\|\-–].*$/, '').trim();
  const vs = t.split(/\s+vs\.?\s+/i);
  if (vs.length >= 2) return { a: vs[0].trim(), b: vs[1].trim() };
  const at = t.split(/\s+at\s+/i);
  if (at.length >= 2) return { a: at[0].trim(), b: at[1].trim() };
  return { a: null, b: null };
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers: headers || UA });
  if (!r.ok) throw new Error('esports fetch ' + r.status);
  return r.json();
}

function leagueToVideogame(league) {
  const lg = String(league || '').toLowerCase();
  if (lg === 'cs2' || lg === 'csgo' || lg === 'cs') return 'cs-go';
  if (lg === 'lol' || lg === 'league') return 'league-of-legends';
  if (lg === 'dota2' || lg === 'dota') return 'dota-2';
  if (lg === 'valorant' || lg === 'val') return 'valorant';
  if (lg === 'cod' || lg === 'warzone') return 'cod-mw';
  if (lg === 'rl' || lg === 'rocket') return 'rocket-league';
  return null;
}

/* ---------- OpenDota (Dota2) ---------- */
async function listDotaTeams() {
  const key = 'dota_teams';
  if (teamCache[key] && Date.now() - teamCache[key].t < 6 * 3600 * 1000) return teamCache[key].list;
  const list = await fetchJson('https://api.opendota.com/api/teams');
  teamCache[key] = { t: Date.now(), list: list || [] };
  return teamCache[key].list;
}

function teamNameMatch(team, query) {
  const q = norm(query);
  if (!q || !team) return false;
  const names = [team.name, team.tag, team.acronym, team.slug].map(norm).filter(Boolean);
  return names.some((n) => n === q || n.includes(q) || q.includes(n) || (q.length >= 3 && n.startsWith(q.slice(0, 3))));
}

/** Score 0–100 how well a team record matches a title hint */
function teamMatchScore(team, query) {
  const q = norm(query);
  if (!q || !team) return 0;
  const names = [team.name, team.tag, team.acronym, team.slug].map(norm).filter(Boolean);
  let best = 0;
  for (const n of names) {
    if (n === q) best = Math.max(best, 100);
    else if (n.startsWith(q) || q.startsWith(n)) best = Math.max(best, 90);
    else if (n.includes(q) || q.includes(n)) best = Math.max(best, 80);
    else {
      // token overlap (Yangon Galacticos vs Yangon)
      const qt = q.split(' ').filter((w) => w.length > 2);
      const nt = n.split(' ').filter((w) => w.length > 2);
      if (qt.length && nt.length) {
        let hit = 0;
        for (const t of qt) {
          if (nt.some((x) => x === t || x.includes(t) || t.includes(x))) hit += 1;
        }
        const ratio = hit / qt.length;
        if (ratio >= 0.5) best = Math.max(best, Math.round(55 + ratio * 35));
      }
      // 4-char prefix
      if (q.length >= 4 && n.length >= 4 && q.slice(0, 4) === n.slice(0, 4)) best = Math.max(best, 50);
    }
  }
  return best;
}

async function findDotaTeam(nameHint) {
  const teams = await listDotaTeams();
  let best = null;
  let bestScore = 0;
  for (const t of teams) {
    const sc = teamMatchScore(t, nameHint);
    // Prefer higher rating when scores close
    const ratingBoost = t.rating != null ? Math.min(5, Number(t.rating) / 500) : 0;
    const total = sc + (sc >= 50 ? ratingBoost : 0);
    if (total > bestScore) {
      bestScore = total;
      best = t;
    }
  }
  // Require a minimum confidence so "Ivory" does not match a random IV... team
  if (bestScore < 50) return null;
  return best;
}

async function dotaTeamMatches(teamId, limit) {
  const key = 'm_' + teamId;
  if (matchCache[key] && Date.now() - matchCache[key].t < 2 * 3600 * 1000) {
    return matchCache[key].list.slice(0, limit || 15);
  }
  const list = await fetchJson('https://api.opendota.com/api/teams/' + encodeURIComponent(teamId) + '/matches');
  matchCache[key] = { t: Date.now(), list: list || [] };
  return matchCache[key].list.slice(0, limit || 15);
}

function summarizeDotaMaps(matches) {
  let wins = 0;
  let n = 0;
  for (const m of matches || []) {
    const wasRadiant = !!m.radiant;
    const radiantWin = !!m.radiant_win;
    const won = wasRadiant ? radiantWin : !radiantWin;
    n += 1;
    if (won) wins += 1;
    if (n >= 10) break;
  }
  return { n, w: wins, l: n - wins, wr: n ? wins / n : null };
}

function h2hDota(matchesA, teamBName) {
  const bn = norm(teamBName);
  let w = 0;
  let n = 0;
  for (const m of matchesA || []) {
    const opp = norm(m.opposing_team_name);
    if (!opp.includes(bn) && !bn.includes(opp)) continue;
    const wasRadiant = !!m.radiant;
    const radiantWin = !!m.radiant_win;
    const won = wasRadiant ? radiantWin : !radiantWin;
    n += 1;
    if (won) w += 1;
    if (n >= 10) break;
  }
  return n ? { n, homeWins: w, awayWins: n - w, wr: w / n } : null;
}

/* ---------- PandaScore ---------- */
function psHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
    'User-Agent': 'EliteOdds/1.0',
  };
}

async function psFetch(path, token) {
  const url = path.startsWith('http') ? path : 'https://api.pandascore.co' + path;
  // Prefer Bearer; also support token query for older tokens
  try {
    return await fetchJson(url, psHeaders(token));
  } catch (e) {
    const join = url.includes('?') ? '&' : '?';
    return fetchJson(url + join + 'token=' + encodeURIComponent(token), UA);
  }
}

async function psFindTeam(token, nameHint, videogame) {
  const q = String(nameHint || '').trim();
  if (!q) return null;
  const cacheKey = (videogame || 'all') + '|' + norm(q);
  if (psTeamCache[cacheKey] && Date.now() - psTeamCache[cacheKey].t < 6 * 3600 * 1000) {
    return psTeamCache[cacheKey].team;
  }
  const hints = expandEsportsHints(q);
  let list = [];
  for (const hint of hints.slice(0, 4)) {
    let path = '/teams?search[name]=' + encodeURIComponent(hint) + '&per_page=15';
    if (videogame) path += '&filter[videogame]=' + encodeURIComponent(videogame);
    try {
      const batch = await psFetch(path, token);
      if (Array.isArray(batch)) list = list.concat(batch);
    } catch (e) {
      try {
        const batch = await psFetch('/teams?search[name]=' + encodeURIComponent(hint) + '&per_page=15', token);
        if (Array.isArray(batch)) list = list.concat(batch);
      } catch (e2) {}
    }
    if (list.length >= 8) break;
  }
  // dedupe by id
  const byId = {};
  for (const t of list) {
    if (t && t.id != null) byId[t.id] = t;
  }
  list = Object.values(byId);
  let team = null;
  let bestSc = 0;
  for (const t of list) {
    let sc = 0;
    for (const hint of hints) {
      sc = Math.max(sc, teamMatchScore(t, hint));
    }
    // acronym / name short match
    const ac = norm(t.acronym || t.slug || '');
    if (ac && hints.some((h) => h === ac || ac.includes(h) || h.includes(ac))) sc = Math.max(sc, 92);
    if (sc > bestSc) {
      bestSc = sc;
      team = t;
    }
  }
  if (bestSc < 35) team = null;
  psTeamCache[cacheKey] = { t: Date.now(), team };
  return team;
}

async function psTeamMatches(token, teamId, limit) {
  const key = 'ps_m_' + teamId;
  if (psMatchCache[key] && Date.now() - psMatchCache[key].t < 2 * 3600 * 1000) {
    return psMatchCache[key].list.slice(0, limit || 15);
  }
  let list = [];
  try {
    list = await psFetch(
      '/teams/' + encodeURIComponent(teamId) + '/matches?sort=-begin_at&per_page=' + (limit || 15) + '&filter[status]=finished',
      token
    );
  } catch (e) {
    try {
      list = await psFetch('/teams/' + encodeURIComponent(teamId) + '/matches?sort=-begin_at&per_page=' + (limit || 15), token);
    } catch (e2) {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];
  psMatchCache[key] = { t: Date.now(), list };
  return list.slice(0, limit || 15);
}

function summarizePsMatches(matches, teamId) {
  const id = Number(teamId);
  let wins = 0;
  let n = 0;
  const recent = [];
  for (const m of matches || []) {
    if (m.status && m.status !== 'finished' && m.winner_id == null) continue;
    const winnerId = m.winner_id != null ? Number(m.winner_id) : null;
    // opponents may be under opponents or teams
    const opps = m.opponents || [];
    const names = opps.map((o) => (o.opponent && (o.opponent.name || o.opponent.acronym)) || o.name).filter(Boolean);
    let won = null;
    if (winnerId != null) {
      won = winnerId === id;
    } else if (m.winner && m.winner.id != null) {
      won = Number(m.winner.id) === id;
    }
    if (won == null) continue;
    n += 1;
    if (won) wins += 1;
    recent.push({ opp: names.find((x) => norm(x) !== '') || 'opp', won, begin: m.begin_at });
    if (n >= 10) break;
  }
  return { n, w: wins, l: n - wins, wr: n ? wins / n : null, recent };
}

function h2hPs(matches, teamId, otherTeamId, otherName) {
  const id = Number(teamId);
  const oid = otherTeamId != null ? Number(otherTeamId) : null;
  const on = norm(otherName);
  let w = 0;
  let n = 0;
  for (const m of matches || []) {
    const opps = m.opponents || [];
    const oppIds = opps.map((o) => Number((o.opponent && o.opponent.id) || o.id)).filter((x) => !Number.isNaN(x));
    const oppNames = opps.map((o) => norm((o.opponent && (o.opponent.name || o.opponent.acronym)) || o.name || ''));
    const isH2H =
      (oid != null && oppIds.includes(oid)) ||
      oppNames.some((x) => x && (x.includes(on) || on.includes(x)));
    if (!isH2H) continue;
    const winnerId = m.winner_id != null ? Number(m.winner_id) : m.winner && m.winner.id != null ? Number(m.winner.id) : null;
    if (winnerId == null) continue;
    n += 1;
    if (winnerId === id) w += 1;
    if (n >= 10) break;
  }
  return n ? { n, homeWins: w, awayWins: n - w, wr: w / n } : null;
}

function formWinProbFromMaps(homeL10, awayL10, h2h, format) {
  let z = 0;
  const parts = [];
  if (homeL10 && homeL10.n >= 2 && homeL10.wr != null) {
    z += (homeL10.wr - 0.5) * 1.4;
    parts.push({ k: 'homeMaps', wr: homeL10.wr, n: homeL10.n });
  }
  if (awayL10 && awayL10.n >= 2 && awayL10.wr != null) {
    z -= (awayL10.wr - 0.5) * 1.4;
    parts.push({ k: 'awayMaps', wr: awayL10.wr, n: awayL10.n });
  }
  if (h2h && h2h.n >= 2) {
    z += (h2h.wr - 0.5) * 0.9;
    parts.push({ k: 'h2hMaps', wr: h2h.wr, n: h2h.n });
  }
  const fmt = (format && format.format) || 'bo3';
  if (fmt === 'bo1') {
    z *= 0.55;
    parts.push({ k: 'bo1Shrink' });
  } else if (fmt === 'bo5') {
    z *= 1.1;
    parts.push({ k: 'bo5Stretch' });
  }
  let p = 1 / (1 + Math.exp(-z));
  p = Math.max(0.22, Math.min(0.78, p));
  return {
    homeWinProb: Math.round(p * 1000) / 1000,
    awayWinProb: Math.round((1 - p) * 1000) / 1000,
    parts,
  };
}

async function matchupFromPandaScore(league, eventTitle, token) {
  const lg = String(league || '').toLowerCase();
  const format = detectSeriesFormat(eventTitle);
  const { a: hintA, b: hintB } = parseTitleTeams(eventTitle);
  if (!hintA || !hintB) return { league: lg, error: 'parse', seriesFormat: format, hasForm: false };
  const vg = leagueToVideogame(lg);
  const [teamA, teamB] = await Promise.all([
    psFindTeam(token, hintA, vg),
    psFindTeam(token, hintB, vg),
  ]);
  if (!teamA || !teamB) {
    const missing = [!teamA ? hintA : null, !teamB ? hintB : null].filter(Boolean).join(' + ');
    return {
      league: lg,
      homeName: hintA,
      awayName: hintB,
      seriesFormat: format,
      hasForm: false,
      formSource: 'pandascore',
      note: 'PandaScore no team match: ' + missing + ' (small/academy orgs often missing)',
      formNote: 'No PandaScore team for ' + missing,
    };
  }
  const [mA, mB] = await Promise.all([
    psTeamMatches(token, teamA.id, 20),
    psTeamMatches(token, teamB.id, 20),
  ]);
  const homeL10 = summarizePsMatches(mA, teamA.id);
  const awayL10 = summarizePsMatches(mB, teamB.id);
  const h2h =
    h2hPs(mA, teamA.id, teamB.id, teamB.name || teamB.acronym) ||
    h2hPs(mB, teamB.id, teamA.id, teamA.name || teamA.acronym);
  const matchup = {
    league: lg,
    homeName: teamA.name || hintA,
    awayName: teamB.name || hintB,
    homeL10: { n: homeL10.n, w: homeL10.w, l: homeL10.l, rf: null, ra: null, wr: homeL10.wr },
    awayL10: { n: awayL10.n, w: awayL10.w, l: awayL10.l, rf: null, ra: null, wr: awayL10.wr },
    h2h,
    seriesFormat: format,
    rating: { source: 'PandaScore' },
    hasForm: !!(homeL10.n >= 2 || awayL10.n >= 2),
    formSource: 'pandascore',
  };
  if (matchup.hasForm) {
    matchup.winProb = formWinProbFromMaps(homeL10, awayL10, h2h, format);
  }
  return matchup;
}

async function matchupFromOpenDota(eventTitle) {
  const format = detectSeriesFormat(eventTitle);
  const { a: hintA, b: hintB } = parseTitleTeams(eventTitle);
  if (!hintA || !hintB) return { league: 'dota2', error: 'parse', seriesFormat: format, hasForm: false };
  const teamA = await findDotaTeam(hintA);
  const teamB = await findDotaTeam(hintB);
  if (!teamA || !teamB) {
    return {
      league: 'dota2',
      homeName: hintA,
      awayName: hintB,
      seriesFormat: format,
      hasForm: false,
      note: 'Team not found on OpenDota',
    };
  }
  const [mA, mB] = await Promise.all([
    dotaTeamMatches(teamA.team_id, 20),
    dotaTeamMatches(teamB.team_id, 20),
  ]);
  const homeL10 = summarizeDotaMaps(mA);
  const awayL10 = summarizeDotaMaps(mB);
  const h2h = h2hDota(mA, teamB.name) || h2hDota(mB, teamA.name);
  const matchup = {
    league: 'dota2',
    homeName: teamA.name || hintA,
    awayName: teamB.name || hintB,
    homeL10: { n: homeL10.n, w: homeL10.w, l: homeL10.l, rf: null, ra: null, wr: homeL10.wr },
    awayL10: { n: awayL10.n, w: awayL10.w, l: awayL10.l, rf: null, ra: null, wr: awayL10.wr },
    h2h,
    seriesFormat: format,
    rating: {
      home: teamA.rating != null ? teamA.rating : null,
      away: teamB.rating != null ? teamB.rating : null,
      source: 'OpenDota',
    },
    hasForm: !!(homeL10.n >= 2 || awayL10.n >= 2),
    formSource: 'opendota-maps',
  };
  let wp = formWinProbFromMaps(homeL10, awayL10, h2h, format);
  if (matchup.rating.home != null && matchup.rating.away != null) {
    const diff = (Number(matchup.rating.home) - Number(matchup.rating.away)) / 400;
    let p = wp.homeWinProb;
    p = Math.max(0.22, Math.min(0.78, p + Math.max(-0.08, Math.min(0.08, diff * 0.05))));
    wp = { homeWinProb: p, awayWinProb: 1 - p, parts: wp.parts.concat([{ k: 'rating', diff }]) };
  }
  matchup.winProb = wp;
  return matchup;
}

/**
 * @param {string} league
 * @param {string} eventTitle
 * @param {{ pandascoreToken?: string }} [opts]
 */
async function matchupForEsports(league, eventTitle, opts) {
  opts = opts || {};
  const lg = String(league || '').toLowerCase();
  const title = String(eventTitle || '');
  const format = detectSeriesFormat(title);
  const token = (opts.pandascoreToken || opts.token || process.env.PANDASCORE_TOKEN || '').trim();

  // Dota2: prefer OpenDota (no key); fall back to PandaScore if token present
  if (lg === 'dota2' || lg === 'dota' || /dota/i.test(title)) {
    try {
      const m = await matchupFromOpenDota(title);
      if (m && m.hasForm) return m;
      if (token) {
        const ps = await matchupFromPandaScore('dota2', title, token);
        if (ps && ps.hasForm) return ps;
      }
      return m;
    } catch (err) {
      if (token) {
        try {
          return await matchupFromPandaScore('dota2', title, token);
        } catch (e2) {
          /* fall through */
        }
      }
      return {
        league: 'dota2',
        seriesFormat: format,
        hasForm: false,
        error: String(err.message || err),
      };
    }
  }

  // CS2 / LoL / Valorant / CoD — PandaScore when token available
  if (token) {
    try {
      return await matchupFromPandaScore(lg || 'esports', title, token);
    } catch (err) {
      return {
        league: lg || 'esports',
        seriesFormat: format,
        hasForm: false,
        formSource: 'pandascore',
        error: String(err.message || err),
      };
    }
  }

  // No token: format only
  const { a: hintA, b: hintB } = parseTitleTeams(title);
  return {
    league: lg || 'esports',
    homeName: hintA,
    awayName: hintB,
    seriesFormat: format,
    hasForm: false,
    formSource: 'format-only',
    note: 'No PandaScore token on this request — Save key in Settings and rescan.',
    formNote: 'Missing PandaScore token on scan',
  };
}

function isEsportsLeague(league) {
  const lg = String(league || '').toLowerCase();
  return ['esports', 'lol', 'cs2', 'csgo', 'dota2', 'dota', 'valorant', 'cod', 'rl'].includes(lg);
}

module.exports = {
  matchupForEsports,
  detectSeriesFormat,
  isEsportsLeague,
  parseTitleTeams,
  leagueToVideogame,
  esportsNameInTitle,
  expandEsportsHints,
};
