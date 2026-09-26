/**
 * The Odds API — shortlist only, cached ~20m
 * Improved team matching for MLB/NFL/NBA nicknames
 */

const cache = globalThis.__oddsCache || (globalThis.__oddsCache = new Map());
const TTL = 20 * 60 * 1000;

const SPORT = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  nfl: 'americanfootball_nfl',
  cfb: 'americanfootball_ncaaf',
  cbb: 'basketball_ncaab',
  nhl: 'icehockey_nhl',
};

/** Expand short / city / nickname tokens for matching */
const ALIASES = {
  // MLB
  yankees: ['new york yankees', 'nyy', 'new york y'],
  mets: ['new york mets', 'nym'],
  dodgers: ['los angeles dodgers', 'lad', 'la dodgers'],
  angels: ['los angeles angels', 'laa', 'la angels'],
  cubs: ['chicago cubs', 'chc'],
  'white sox': ['chicago white sox', 'chw', 'cws'],
  'red sox': ['boston red sox', 'bos'],
  giants: ['san francisco giants', 'sf giants', 'sfg'],
  athletics: ['oakland athletics', 'oakland a', 'ath', "a's"],
  guardians: ['cleveland guardians', 'cle'],
  diamondbacks: ['arizona diamondbacks', 'ari', 'd-backs', 'dbacks'],
  'blue jays': ['toronto blue jays', 'tor'],
  'ray': ['tampa bay rays', 'tb rays', 'tampa bay'],
  rays: ['tampa bay rays', 'tb rays'],
  mariners: ['seattle mariners', 'sea'],
  rangers: ['texas rangers', 'tex'],
  astros: ['houston astros', 'hou'],
  braves: ['atlanta braves', 'atl'],
  phillies: ['philadelphia phillies', 'phi'],
  nationals: ['washington nationals', 'wsh', 'was'],
  orioles: ['baltimore orioles', 'bal'],
  twins: ['minnesota twins', 'min'],
  tigers: ['detroit tigers', 'det'],
  royals: ['kansas city royals', 'kc royals', 'kan'],
  'reds': ['cincinnati reds', 'cin'],
  pirates: ['pittsburgh pirates', 'pit'],
  brewers: ['milwaukee brewers', 'mil'],
  cardinals: ['st louis cardinals', 'stl', 'st. louis cardinals'],
  padres: ['san diego padres', 'sd padres', 'sdp'],
  rockies: ['colorado rockies', 'col'],
  marlins: ['miami marlins', 'mia'],
  // NFL short
  chiefs: ['kansas city chiefs', 'kc chiefs'],
  bills: ['buffalo bills'],
  eagles: ['philadelphia eagles'],
  cowboys: ['dallas cowboys'],
  '49ers': ['san francisco 49ers', 'sf 49ers'],
  niners: ['san francisco 49ers'],
  packers: ['green bay packers'],
  patriots: ['new england patriots'],
  jets: ['new york jets'],
  giants: ['new york giants', 'ny giants'], // conflict with SF giants — context by league
};

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 1 && !['the', 'at', 'vs', 'and'].includes(t));
}

function expandQuery(name) {
  const n = norm(name);
  const out = new Set([n]);
  if (!n) return out;
  // last word nickname
  const parts = n.split(' ');
  const last = parts[parts.length - 1];
  out.add(last);
  if (parts.length >= 2) out.add(parts.slice(-2).join(' '));
  const al = ALIASES[last] || ALIASES[n];
  if (al) al.forEach((x) => out.add(norm(x)));
  // reverse: if full name matches alias value
  for (const [k, vals] of Object.entries(ALIASES)) {
    if (vals.some((v) => n.includes(norm(v)) || norm(v).includes(n))) {
      out.add(k);
      vals.forEach((v) => out.add(norm(v)));
    }
  }
  return out;
}

function teamScore(queryName, bookName) {
  const qSet = expandQuery(queryName);
  const b = norm(bookName);
  if (!b) return 0;
  let best = 0;
  for (const q of qSet) {
    if (!q) continue;
    if (b === q) best = Math.max(best, 100);
    else if (b.includes(q) || q.includes(b)) best = Math.max(best, 80);
    else {
      const qt = tokens(q);
      const bt = tokens(b);
      if (!qt.length || !bt.length) continue;
      const hit = qt.filter((t) => bt.some((x) => x.includes(t) || t.includes(x))).length;
      const sc = (hit / Math.max(qt.length, bt.length)) * 70;
      best = Math.max(best, sc);
    }
  }
  return best;
}

function matchEvent(events, home, away, title) {
  let best = null;
  let bestScore = 0;
  for (const e of events) {
    const hn = e.home_team || '';
    const an = e.away_team || '';
    let sc = 0;
    if (home && away) {
      // try both orientations
      const s1 = teamScore(home, hn) + teamScore(away, an);
      const s2 = teamScore(home, an) + teamScore(away, hn);
      sc = Math.max(s1, s2);
    } else if (title) {
      sc = teamScore(title, hn + ' ' + an);
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = e;
    }
  }
  // need a minimum confidence
  if (bestScore < 50) return null;
  return best;
}

function americanToProb(am) {
  const a = Number(am);
  if (!Number.isFinite(a) || a === 0) return null;
  if (a > 0) return 100 / (a + 100);
  return -a / (-a + 100);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const q = { ...req.query, ...body };
    const apiKey = q.apiKey || process.env.ODDS_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: 'Odds API key required (Settings or ODDS_API_KEY env)' });
    }

    const league = String(q.league || 'mlb').toLowerCase();
    const sportKey = SPORT[league];
    if (!sportKey) {
      return res.status(400).json({ ok: false, error: 'Unsupported league for Odds API: ' + league });
    }

    let home = String(q.home || '').trim();
    let away = String(q.away || '').trim();
    const title = String(q.title || '').trim();

    // Parse title "A vs B" if home/away missing
    if ((!home || !away) && title) {
      const parts = title.split(/\s+vs\.?\s+/i);
      if (parts.length === 2) {
        if (!home) home = parts[0].trim();
        if (!away) away = parts[1].trim();
      }
    }

    const cacheKey = sportKey + '|' + norm(home) + '@' + norm(away) + '|' + norm(title);
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.t < TTL) {
      return res.status(200).json({ ok: true, cached: true, cacheAgeSec: Math.round((Date.now() - hit.t) / 1000), ...hit.data });
    }

    const url =
      'https://api.the-odds-api.com/v4/sports/' +
      encodeURIComponent(sportKey) +
      '/odds?apiKey=' +
      encodeURIComponent(apiKey) +
      '&regions=us&markets=h2h&oddsFormat=american';

    const r = await fetch(url);
    const remaining = r.headers.get('x-requests-remaining');
    const used = r.headers.get('x-requests-used');
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({
        ok: false,
        error: 'Odds API ' + r.status,
        detail: errText.slice(0, 200),
        remaining,
        used,
      });
    }
    const events = await r.json();
    if (!Array.isArray(events)) {
      return res.status(500).json({ ok: false, error: 'Unexpected Odds API payload' });
    }

    const event = matchEvent(events, home, away, title);

    if (!event) {
      const data = {
        found: false,
        message: 'No matching book event',
        tried: { home, away, title },
        eventsSample: events.slice(0, 8).map((e) => e.away_team + ' @ ' + e.home_team),
        remaining,
        used,
      };
      cache.set(cacheKey, { t: Date.now(), data });
      return res.status(200).json({ ok: true, cached: false, ...data });
    }

    const homePrices = [];
    const awayPrices = [];
    const books = [];
    for (const bk of event.bookmakers || []) {
      const mkt = (bk.markets || []).find((m) => m.key === 'h2h');
      if (!mkt) continue;
      let hp = null;
      let ap = null;
      for (const o of mkt.outcomes || []) {
        if (o.name === event.home_team) hp = o.price;
        if (o.name === event.away_team) ap = o.price;
      }
      if (hp == null || ap == null) continue;
      homePrices.push(hp);
      awayPrices.push(ap);
      books.push({ book: bk.title, home: hp, away: ap });
    }

    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const homeAm = avg(homePrices);
    const awayAm = avg(awayPrices);
    const homeProb = americanToProb(homeAm);
    const awayProb = americanToProb(awayAm);
    let noVigHome = null;
    let noVigAway = null;
    if (homeProb != null && awayProb != null && homeProb + awayProb > 0) {
      const s = homeProb + awayProb;
      noVigHome = Math.round((homeProb / s) * 1000) / 10;
      noVigAway = Math.round((awayProb / s) * 1000) / 10;
    }

    const data = {
      found: true,
      event: event.away_team + ' @ ' + event.home_team,
      commence: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      consensus: {
        homeAmerican: homeAm != null ? Math.round(homeAm) : null,
        awayAmerican: awayAm != null ? Math.round(awayAm) : null,
        homeImplied: homeProb != null ? Math.round(homeProb * 1000) / 10 : null,
        awayImplied: awayProb != null ? Math.round(awayProb * 1000) / 10 : null,
        noVigHome,
        noVigAway,
        books: books.length,
      },
      books: books.slice(0, 12),
      remaining,
      used,
    };
    cache.set(cacheKey, { t: Date.now(), data });
    return res.status(200).json({ ok: true, cached: false, ...data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
