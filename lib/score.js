/**
 * BetBetter Evaluate
 * 1 Real EV — true EV from probabilities + decimal odds
 * 2 Matchup — H2H / L10 when available
 * 3 Edge — probability edge (model vs market / no-vig)
 * LM badge only · Smart$ button only · Liq is soft info not a tile
 */

function clamp(x, a = 0.01, b = 0.99) {
  return Math.max(a, Math.min(b, x));
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}
function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

/** EV as % of stake: model_prob * decimal_odds - 1 */
function trueEV(modelProb, marketProb) {
  if (modelProb == null || marketProb == null || marketProb <= 0) return null;
  const decimalOdds = 1 / marketProb;
  return round1((modelProb * decimalOdds - 1) * 100);
}

function scoreFromEdgePp(edgePp) {
  const e = Number(edgePp) || 0;
  const t = 1 / (1 + Math.exp(-(e - 0.8) / 3.5));
  return Math.round(clamp01(t) * 100);
}

function scoreFromTrueEv(evPct) {
  const e = Number(evPct) || 0;
  const t = 1 / (1 + Math.exp(-(e - 1.0) / 4.0));
  return Math.round(clamp01(t) * 100);
}

function matchupScore(matchup, pickSide, marketType) {
  if (!matchup || (!matchup.homeL10 && !matchup.awayL10 && !matchup.h2h)) {
    return {
      name: 'Matchup',
      score: 50,
      label: 'No form data',
      confidence: 'low',
      detail: null,
      supportsPick: null,
    };
  }
  let pts = 50;
  const lines = [];
  const home = matchup.homeL10;
  const away = matchup.awayL10;
  const h2h = matchup.h2h;

  if (home && home.w != null) {
    const g = (home.w || 0) + (home.l || 0) || 1;
    const wr = home.w / g;
    pts += (wr - 0.5) * 40;
    lines.push(
      'Home L10 ' +
        home.w +
        '-' +
        home.l +
        (home.rf != null ? ' · ' + home.rf + ' RF / ' + (home.ra != null ? home.ra : '?') + ' RA' : '')
    );
  }
  if (away && away.w != null) {
    const g = (away.w || 0) + (away.l || 0) || 1;
    const wr = away.w / g;
    pts -= (wr - 0.5) * 40;
    lines.push(
      'Away L10 ' +
        away.w +
        '-' +
        away.l +
        (away.rf != null ? ' · ' + away.rf + ' RF / ' + (away.ra != null ? away.ra : '?') + ' RA' : '')
    );
  }
  if (h2h && h2h.n >= 3) {
    const hw = h2h.homeWins || 0;
    const aw = h2h.awayWins || 0;
    const tot = hw + aw || 1;
    pts += (hw / tot - 0.5) * 25;
    lines.push(
      'H2H ' +
        hw +
        '-' +
        aw +
        ' (n=' +
        h2h.n +
        ')' +
        (h2h.avgTotal != null ? ' · avg tot ' + h2h.avgTotal : '')
    );
  } else if (h2h) {
    lines.push('H2H sample thin');
  }

  pts = Math.round(clamp01(pts / 100) * 100);
  let supportsPick = null;
  if (pickSide) {
    const leanHome = pts >= 58;
    const leanAway = pts <= 42;
    const ps = String(pickSide).toLowerCase();
    if (leanHome && (ps.includes('home') || (matchup.homeName && ps.includes(String(matchup.homeName).toLowerCase().slice(0, 5)))))
      supportsPick = true;
    else if (leanAway && (ps.includes('away') || (matchup.awayName && ps.includes(String(matchup.awayName).toLowerCase().slice(0, 5)))))
      supportsPick = true;
    else if (pts >= 45 && pts <= 55) supportsPick = null;
    else supportsPick = false;
  }

  if (matchup.homeRestDays != null || matchup.awayRestDays != null) {
    lines.push(
      'Rest H' +
        (matchup.homeRestDays != null ? matchup.homeRestDays + 'd' : '?') +
        ' / A' +
        (matchup.awayRestDays != null ? matchup.awayRestDays + 'd' : '?')
    );
  }
  if (matchup.winProb && matchup.winProb.homeWinProb != null) {
    lines.push(
      'Form WP home ' +
        Math.round(matchup.winProb.homeWinProb * 1000) / 10 +
        '% / away ' +
        Math.round(matchup.winProb.awayWinProb * 1000) / 10 +
        '%'
    );
    // Align score somewhat with form WP
    pts = Math.round(pts * 0.5 + matchup.winProb.homeWinProb * 100 * 0.5);
    pts = Math.max(5, Math.min(95, pts));
  }

  return {
    name: 'Matchup',
    score: pts,
    label: pts >= 62 ? 'Supports home lean' : pts <= 38 ? 'Supports away lean' : 'Mixed / neutral',
    confidence: home && away ? 'medium' : 'low',
    detail: lines.join(' · ') || null,
    supportsPick,
    formWinProb: matchup.winProb || null,
    raw: matchup,
  };
}

function buildFair(price01, matchupModel, norm) {
  // fair ≈ (1-w)*market + w*formHomeWP  then + power/SP pp (capped)
  const raw = norm && norm.matchup;
  const wp = raw && raw.winProb;
  const hasWp = wp && wp.homeWinProb != null;

  if ((!matchupModel || matchupModel.confidence === 'low' || matchupModel.score === 50) && !hasWp) {
    return {
      fair: clamp(price01),
      source: 'market-only',
      nudgePp: 0,
      hasForm: false,
      formWinProb: null,
      powerNudgePp: 0,
      spNudgePp: 0,
      layers: ['market'],
    };
  }

  let formP = null;
  if (hasWp) {
    formP = wp.homeWinProb;
  } else if (matchupModel && matchupModel.score != null) {
    formP = clamp(0.3 + (matchupModel.score / 100) * 0.4, 0.2, 0.8);
  }

  if (formP == null) {
    return {
      fair: clamp(price01),
      source: 'market-only',
      nudgePp: 0,
      hasForm: false,
      formWinProb: null,
      powerNudgePp: 0,
      spNudgePp: 0,
      layers: ['market'],
    };
  }

  const lg = String((norm && norm.league) || (raw && raw.league) || '').toLowerCase();
  const isKalshi = String((norm && (norm.venue || norm.source)) || '').toLowerCase() === 'kalshi';
  // Winner-first: form leads fair; market only adjusts (old 0.35 caused ~44% when form was 73%)
  let wForm = 0.62;
  if (lg === 'nfl') wForm = 0.58;
  if (lg === 'cfb') wForm = 0.6;
  if (lg === 'mlb') wForm = 0.64;
  if (hasWp && raw.h2h && raw.h2h.n >= 6) wForm = Math.max(wForm, 0.66);
  if (hasWp && raw.homeL10 && raw.homeL10.n >= 8 && raw.awayL10 && raw.awayL10.n >= 8) wForm = Math.max(wForm, 0.65);
  // Kalshi slightly tighter form weight (less market pull on longshot dogs)
  if (isKalshi) wForm = Math.min(0.78, wForm + 0.06);
  if (norm && norm.live) wForm = Math.min(wForm, 0.18);
  // Mild shrink only — do not crush strong form toward 50%
  formP = 0.5 + (formP - 0.5) * 0.95;

  let signal = formP;
  const layers = ['market', 'form'];
  let powerNudgePp = 0;
  let spNudgePp = 0;

  if (raw && raw.power && raw.power.nudgePp != null) {
    powerNudgePp = Number(raw.power.nudgePp) || 0;
    powerNudgePp = Math.max(-4, Math.min(4, powerNudgePp));
    signal = clamp(signal + powerNudgePp / 100);
    layers.push('power');
  }
  if (raw && raw.sp && raw.sp.nudgePp != null) {
    spNudgePp = Number(raw.sp.nudgePp) || 0;
    spNudgePp = Math.max(-3, Math.min(3, spNudgePp));
    signal = clamp(signal + spNudgePp / 100);
    layers.push('sp');
  }

  // Total signal vs 0.5 capped so we don't explode
  const signalLean = signal - 0.5;
  signal = clamp(0.5 + Math.max(-0.22, Math.min(0.22, signalLean)));

  const fair = clamp((1 - wForm) * price01 + wForm * signal);
  const nudgePp = Math.round((fair - price01) * 1000) / 10;
  const source =
    layers.indexOf('power') >= 0 || layers.indexOf('sp') >= 0
      ? 'market+form+power+sp'
      : 'market+form';

  return {
    fair,
    source,
    nudgePp,
    hasForm: true,
    formWinProb: Math.round(formP * 1000) / 1000,
    blendWeight: wForm,
    powerNudgePp,
    spNudgePp,
    layers,
    spKnown: !!(raw && raw.sp && raw.sp.anyKnown),
    spBothKnown: !!(raw && raw.sp && raw.sp.bothKnown),
  };
}


function parseTotalLine(text) {
  const s = String(text || '');
  let m = s.match(/(?:o\/u|over\/under|total)\s*([0-9]+\.?[0-9]*)/i);
  if (m) return Number(m[1]);
  m = s.match(/\b([0-9]{1,2}\.[05])\b/);
  if (m) return Number(m[1]);
  return null;
}

function parseSpreadLine(text) {
  const s = String(text || '');
  const m = s.match(/([+-]?\d+\.?\d*)\s*$/) || s.match(/([+-]\d+\.?\d*)/);
  if (m) return Number(m[1]);
  if (/run\s*line/i.test(s)) return -1.5; // default RL context
  return null;
}

/** Totals / F5 totals model */
function evaluateTotalsSide(norm, yesPrice, noPrice, options) {
  const mt = String(norm.marketType || '');
  const tp = norm.matchup && norm.matchup.totalsProjection;
  const line = parseTotalLine(norm.question || norm.title || '') || parseTotalLine(norm.eventTitle || '') || parseTotalLine(norm.subTitle || '');
  const isF5 = mt === 'f5_total' || /f5|first\s*5|first five/i.test(String(norm.question || ''));
  const proj = tp && (isF5 ? tp.projectedF5 : tp.projectedFg);
  if (proj == null || line == null) {
    return null; // fall back to generic
  }
  const diff = proj - line; // positive => lean over
  // Map run differential to over-probability
  const scale = isF5 ? 1.1 : 0.85;
  let pOver = 1 / (1 + Math.exp(-(diff * scale)));
  pOver = clamp(Math.max(0.22, Math.min(0.78, pOver)));

  // Assume YES is Over when question contains over, else try to detect
  const q = String(norm.question || '').toLowerCase();
  let yesIsOver = true;
  if (/\bunder\b/.test(q) && !/\bover\b/.test(q)) yesIsOver = false;
  if (/\bover\b/.test(q)) yesIsOver = true;

  const modelYes = yesIsOver ? pOver : 1 - pOver;
  const pickSide = modelYes >= 0.5 ? 'YES' : 'NO';
  const modelProb = Math.max(modelYes, 1 - modelYes);
  const mktForPick = pickSide === 'YES' ? yesPrice : noPrice;
  const edgePp = Math.round((modelProb - mktForPick) * 1000) / 10;
  const netEv = trueEV(modelProb, mktForPick);
  let rank = 'Pass';
  let betScore = 50;
  if (edgePp >= 4 && netEv >= 3) {
    rank = 'Good';
    betScore = 68;
  }
  if (edgePp >= 7 && netEv >= 6 && Math.abs(diff) >= 0.6) {
    rank = 'Elite';
    betScore = 78;
  }
  if (options && options.strictTruth && Math.abs(diff) < 0.35) {
    rank = 'Pass';
    betScore = Math.min(betScore, 55);
  }
  const pickName = pickSide === 'YES'
    ? (yesIsOver ? 'Over' : 'Under')
    : (yesIsOver ? 'Under' : 'Over');

  return {
    side: pickSide,
    pickName,
    modelProb,
    marketProb: mktForPick,
    edgePp,
    netEv,
    rank,
    betScore,
    line,
    proj,
    diff: Math.round(diff * 10) / 10,
    isF5,
    fairSource: 'totals-L10',
    hasForm: true,
  };
}

/** NRFI / YRFI model — 1st-inning run rates from MLB linescores */
function evaluateNrfiSide(norm, yesPrice, noPrice) {
  const nr = norm.matchup && norm.matchup.nrfi;
  if (!nr || nr.thin || nr.nrfiProxy == null) return null;
  const mt = String(norm.marketType || '');
  const q = String(norm.question || norm.title || '').toLowerCase();
  // Detect which contract this market is
  let marketIsNrfi = mt === 'nrfi' || /\bnrfi\b|no run first|no runs? in (the )?first/.test(q);
  if (mt === 'yrfi' || /\byrfi\b|yes run first|run in (the )?first/.test(q)) marketIsNrfi = false;

  // Model P(no run either side in 1st)
  let modelNrfi = Number(nr.nrfiProxy);
  // Blend with combined "someone scores" rates when available
  const h = nr.home || {};
  const a = nr.away || {};
  if (h.scorePct != null && a.scorePct != null) {
    // P(at least one team scores) ≈ 1 - (1-ph)(1-pa) using each team's "scored in 1st" rate
    const pEitherScores = 1 - (1 - Number(h.scorePct)) * (1 - Number(a.scorePct));
    const fromScore = 1 - Math.max(0.05, Math.min(0.95, pEitherScores));
    modelNrfi = 0.55 * modelNrfi + 0.45 * fromScore;
  }
  if (nr.yrfiProxy != null && modelNrfi == null) modelNrfi = 1 - Number(nr.yrfiProxy);
  modelNrfi = Math.max(0.35, Math.min(0.92, modelNrfi));

  // YES price on this market
  const modelYes = marketIsNrfi ? modelNrfi : 1 - modelNrfi;
  const pickSide = modelYes >= 0.5 ? 'YES' : 'NO';
  const modelProb = Math.max(modelYes, 1 - modelYes);
  const mktForPick = pickSide === 'YES' ? yesPrice : noPrice;
  const edgePp = Math.round((modelProb - mktForPick) * 1000) / 10;
  const netEv = trueEV(modelProb, mktForPick);

  // Prefer NRFI when both teams rarely score/allow in 1st; YRFI when either scores often
  const pickedNrfi = (pickSide === 'YES' && marketIsNrfi) || (pickSide === 'NO' && !marketIsNrfi);
  const pickName = pickedNrfi ? 'NRFI (no run 1st)' : 'YRFI (run in 1st)';

  let rank = 'Pass';
  let betScore = 52;
  if (edgePp >= 4 && netEv >= 3) {
    rank = 'Good';
    betScore = 68;
  }
  if (edgePp >= 7 && netEv >= 5.5 && !nr.thin) {
    rank = 'Elite';
    betScore = 78;
  }
  // Soften if sample tiny
  if ((h.n != null && h.n < 8) || (a.n != null && a.n < 8)) {
    if (rank === 'Elite') { rank = 'Good'; betScore = Math.min(betScore, 70); }
  }

  const why =
    'NRFI model ' +
    Math.round(modelNrfi * 1000) / 10 +
    '% · H 1st NRFI ' +
    (h.nrfiPct != null ? Math.round(h.nrfiPct * 1000) / 10 + '%' : '—') +
    (h.n != null ? ' (n=' + h.n + ')' : '') +
    ' · A 1st NRFI ' +
    (a.nrfiPct != null ? Math.round(a.nrfiPct * 1000) / 10 + '%' : '—') +
    (a.n != null ? ' (n=' + a.n + ')' : '') +
    (h.scorePct != null ? ' · H scores 1st ' + Math.round(h.scorePct * 1000) / 10 + '%' : '') +
    (a.scorePct != null ? ' · A scores 1st ' + Math.round(a.scorePct * 1000) / 10 + '%' : '');

  return {
    side: pickSide,
    pickName,
    modelProb,
    marketProb: mktForPick,
    edgePp,
    netEv,
    rank,
    betScore,
    nrfiProxy: Math.round(modelNrfi * 1000) / 1000,
    yrfiProxy: Math.round((1 - modelNrfi) * 1000) / 1000,
    fairSource: 'nrfi-1st-L15',
    hasForm: true,
    detail: why,
    limits: nr.limits || null,
  };
}

/** FG / period spread: soft lean from form WP (league-aware margin scale) */
function evaluateSpreadSide(norm, yesPrice, noPrice, homeWinP) {
  if (homeWinP == null) return null;
  const q = String(norm.question || norm.title || '' + ' ' + (norm.slug || ''));
  let line = norm.line != null && !isNaN(Number(norm.line)) ? Number(norm.line) : parseSpreadLine(q);
  // "cover 17.5" / "cover -1.5" → use API/text (all sports)
  if (line == null) {
    const cm = q.match(/cover\s*([+-]?[0-9]+\.?[0-9]*)/i);
    if (cm) line = Number(cm[1]);
  }
  const lg = String((norm && norm.league) || '').toLowerCase();
  // Expected margin scale by sport (points or runs)
  // MLB ~4.5 runs full scale; NFL/CFB ~14–16 pts; NBA ~10 pts
  let marginScale = 4.5;
  if (lg === 'nfl' || lg === 'cfb') marginScale = 15;
  else if (lg === 'nba' || lg === 'cbb' || lg === 'wnba') marginScale = 10;
  else if (lg === 'nhl') marginScale = 2.2;
  const expMargin = (homeWinP - 0.5) * marginScale;
  const defaultLine = (lg === 'nfl' || lg === 'cfb') ? -3 : (lg === 'nba' || lg === 'cbb' ? -3.5 : -1.5);
  const spreadLine = line != null ? line : defaultLine;
  // P(home covers) from expected margin vs line magnitude
  const coverDiff = expMargin - Math.abs(spreadLine);
  const steep = (lg === 'nfl' || lg === 'cfb') ? 0.35 : 0.9;
  let pHomeCover = 1 / (1 + Math.exp(-(coverDiff * steep)));
  pHomeCover = clamp(Math.max(0.25, Math.min(0.75, pHomeCover)));
  // Detect if YES is home
  const mu = norm.matchup || {};
  let yesIsHome = norm.yesIsHome;
  if (yesIsHome == null && mu.homeName && /will|cover|spread/i.test(q)) {
    if (String(q).toLowerCase().includes(String(mu.homeName).toLowerCase().split(' ').pop())) yesIsHome = true;
  }
  if (yesIsHome == null) yesIsHome = true;
  const modelYes = yesIsHome ? pHomeCover : 1 - pHomeCover;
  const pickSide = modelYes >= 0.5 ? 'YES' : 'NO';
  const modelProb = Math.max(modelYes, 1 - modelYes);
  const mktForPick = pickSide === 'YES' ? yesPrice : noPrice;
  const edgePp = Math.round((modelProb - mktForPick) * 1000) / 10;
  const netEv = trueEV(modelProb, mktForPick);
  let rank = 'Pass';
  let betScore = 50;
  if (edgePp >= 5 && netEv >= 4) {
    rank = 'Good';
    betScore = 66;
  }
  // Cap Elite on spreads — soft model
  if (edgePp >= 9 && netEv >= 8) {
    rank = 'Good';
    betScore = 72;
  }
  function shortTeam(n) {
    n = String(n || '').trim();
    if (!n) return '';
    const parts = n.split(/\s+/);
    return parts[parts.length - 1] || n;
  }
  const home = mu.homeName || norm.homeName || 'Home';
  const away = mu.awayName || norm.awayName || 'Away';
  const slug = String(norm.slug || '');
  let yesSign = 1;
  if (line != null && line < 0) yesSign = -1;
  else if (line != null && line > 0) yesSign = 1;
  else if (/neg[-_]?\d/i.test(slug)) yesSign = -1;
  else if (/pos[-_]?\d/i.test(slug)) yesSign = 1;
  else if (/wins by over/i.test(q)) yesSign = -1;
  else if (/cover\s*[0-9]/i.test(q)) yesSign = 1;
  let yesTeam = null;
  const ct = q.match(/will\s+(?:the\s+)?(.+?)\s+cover/i);
  if (ct) yesTeam = ct[1].trim();
  if (!yesTeam) yesTeam = yesIsHome ? home : away;
  const noTeam = (yesTeam && home && String(yesTeam).toLowerCase().includes(String(home).toLowerCase().split(' ').pop()))
    ? away : home;
  const mag = Math.abs(spreadLine);
  let teamPick, dispLine;
  if (pickSide === 'YES') {
    teamPick = yesTeam;
    dispLine = yesSign * mag;
  } else {
    teamPick = noTeam;
    dispLine = -yesSign * mag;
  }
  const lineStr = (dispLine > 0 ? '+' : '') + (Number.isInteger(dispLine) ? String(dispLine) : String(Math.round(dispLine * 10) / 10));
  const pickLabel = (shortTeam(teamPick) || teamPick || 'Spread') + ' ' + lineStr;

  return {
    side: pickSide,
    pickName: pickLabel,
    spreadLine: dispLine,
    teamName: teamPick,
    modelProb,
    marketProb: mktForPick,
    edgePp,
    netEv,
    rank,
    betScore,
    fairSource: 'spread-form',
    hasForm: true,
  };
}


function evaluateMarket(norm, options) {
  options = options || {};
  let rawP = Number(norm.yesPrice);
  if (rawP > 1 && rawP <= 100) rawP = rawP / 100;
  let yesPrice = clamp(rawP || 0.5);
  // Extreme longshot/favorite prices: keep math stable
  const extremePrice = yesPrice <= 0.05 || yesPrice >= 0.95;
  const noPrice = norm.noPrice != null ? clamp(Number(norm.noPrice) > 1 ? Number(norm.noPrice) / 100 : Number(norm.noPrice)) : clamp(1 - yesPrice);

  const vol = Number(norm.volume || 0);
  const liq = Number(norm.liquidity || 0);
  const vol24 = Number(norm.volume24hr || vol || 0);
  const priorP = norm.priorPrice != null ? clamp(Number(norm.priorPrice)) : null;
  const marketType = norm.marketType || 'moneyline';

  const matchupModel = matchupScore(norm.matchup, norm.pickHint || null, marketType);
  const fairBuilt = buildFair(yesPrice, matchupModel, norm);
  let fairYes = fairBuilt.fair;
  let fairSource = fairBuilt.source; // market-only | market+form
  let formNudgePp = fairBuilt.nudgePp;
  const hasForm = !!fairBuilt.hasForm;
  let pickName = null;

  // --- SPECIAL MARKETS: totals / NRFI / spreads ---
  let special = null;
  const mtLow = String(marketType || '').toLowerCase();
  if (mtLow === 'total' || mtLow === 'f5_total' || mtLow === 'totals') {
    special = evaluateTotalsSide(norm, yesPrice, noPrice, options);
  } else if (mtLow === 'nrfi' || mtLow === 'yrfi') {
    special = evaluateNrfiSide(norm, yesPrice, noPrice);
  }

  // --- WINNER-FIRST PICK (data), not EV-first ---
  // 1) Decide who we think wins from form/power/SP (home WP)
  // 2) Map that team to YES/NO for pricing only
  // 3) EV/rank = whether that pick is good value (can be Pass if expensive)
  const titleBlob = String(norm.question || norm.eventTitle || norm.title || '').toLowerCase();
  function teamInEvent(name) {
    if (!name || !titleBlob) return false;
    const n = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const parts = n.split(/\s+/).filter((w) => w.length > 3);
    const nick = parts[parts.length - 1] || '';
    return (nick && titleBlob.includes(nick)) || titleBlob.includes(n.slice(0, 10));
  }
  const muOk =
    norm.matchup &&
    norm.matchup.homeName &&
    norm.matchup.awayName &&
    teamInEvent(norm.matchup.homeName) &&
    teamInEvent(norm.matchup.awayName);

  // Our win probs for home/away after form blend layers (before market)
  let homeWinP = null;
  if (hasForm && fairBuilt.formWinProb != null) {
    homeWinP = fairBuilt.formWinProb;
    if (fairBuilt.powerNudgePp) homeWinP = clamp(homeWinP + fairBuilt.powerNudgePp / 100);
    if (fairBuilt.spNudgePp) homeWinP = clamp(homeWinP + fairBuilt.spNudgePp / 100);
  } else if (hasForm && fairBuilt.formWinProb != null) {
    homeWinP = fairBuilt.formWinProb;
  }

  // Live: do not trust pregame form to "pick the winner" — lean market favorite
  let pickHome = null; // true = home, false = away, null = unknown
  if (norm.live) {
    // Prefer market favorite as displayed winner lean; form only soft
    if (norm.yesIsHome === true) pickHome = yesPrice >= noPrice;
    else if (norm.yesIsHome === false) pickHome = noPrice >= yesPrice; // home is NO
    else pickHome = yesPrice >= 0.5; // weak
    if (homeWinP != null && Math.abs(homeWinP - 0.5) > 0.08) {
      // mild form influence live only if strong
      pickHome = homeWinP >= 0.5;
    }
  } else if (homeWinP != null) {
    pickHome = homeWinP >= 0.5;
  } else {
    // market-only: pick market favorite (who market thinks wins), not the dog for EV
    if (norm.yesIsHome === true) pickHome = yesPrice >= (noPrice || 1 - yesPrice);
    else if (norm.yesIsHome === false) pickHome = (noPrice || 1 - yesPrice) >= yesPrice;
    else pickHome = yesPrice >= 0.5;
  }

  // Map winner to YES/NO token
  let side = 'YES';
  if (norm.yesIsHome === true) {
    side = pickHome ? 'YES' : 'NO';
  } else if (norm.yesIsHome === false) {
    side = pickHome ? 'NO' : 'YES'; // YES is away
  } else {
    // unknown mapping: if we have form home and prefer home, we can't map reliably —
    // fall back to higher model fair on YES vs NO using home as YES assumption
    if (homeWinP != null) {
      const fairHomeOnYes = fairBuilt.fair; // built vs yes price as home-ish
      side = homeWinP >= 0.5 ? 'YES' : 'NO';
    } else {
      side = yesPrice >= (noPrice || 1 - yesPrice) ? 'YES' : 'NO';
    }
  }

  // Model probability = our win% for the PICKED side (not the value side)
  let model_probability;
  let market_probability;
  if (side === 'YES') {
    market_probability = yesPrice;
    if (homeWinP != null && norm.yesIsHome === true) model_probability = homeWinP;
    else if (homeWinP != null && norm.yesIsHome === false) model_probability = clamp(1 - homeWinP);
    else model_probability = fairYes;
  } else {
    market_probability = noPrice > 0 ? noPrice : clamp(1 - yesPrice);
    if (homeWinP != null && norm.yesIsHome === true) model_probability = clamp(1 - homeWinP);
    else if (homeWinP != null && norm.yesIsHome === false) model_probability = homeWinP;
    else model_probability = clamp(1 - fairYes);
  }

  // Rebuild fairYes for downstream no-vig/edge relative to YES token only when needed
  fairYes = norm.yesIsHome === false && homeWinP != null
    ? clamp((1 - (fairBuilt.blendWeight || 0.35)) * yesPrice + (fairBuilt.blendWeight || 0.35) * clamp(1 - homeWinP))
    : fairBuilt.fair;

  if (muOk) {
    pickName = pickHome ? norm.matchup.homeName : norm.matchup.awayName;
  }

  if (norm.forcedSide === 'NO') {
    side = 'NO';
    market_probability = noPrice > 0 ? noPrice : clamp(1 - yesPrice);
    model_probability = homeWinP != null && norm.yesIsHome === true ? clamp(1 - homeWinP) : clamp(1 - fairYes);
  } else if (norm.forcedSide === 'YES') {
    side = 'YES';
    market_probability = yesPrice;
    model_probability = homeWinP != null && norm.yesIsHome === true ? homeWinP : fairYes;
  }

  // No-vig: normalize YES/NO implied so they sum to 1
  const rawYes = yesPrice;
  const rawNo = noPrice > 0 ? noPrice : clamp(1 - yesPrice);
  const sumImp = rawYes + rawNo;
  const no_vig_yes = sumImp > 0 ? rawYes / sumImp : rawYes;
  const no_vig_no = sumImp > 0 ? rawNo / sumImp : rawNo;
  const no_vig_probability = side === 'YES' ? no_vig_yes : no_vig_no;

  const probability_edge = round1((model_probability - no_vig_probability) * 100); // pp
  const probability_edge_vs_market = round1((model_probability - market_probability) * 100);
  const decimal_odds = market_probability > 0 ? round2(1 / market_probability) : null;
  const evPct = trueEV(model_probability, market_probability); // true EV % of stake
  const feeBufferPp = 0.5; // light fee buffer in pp on edge story
  const netEvPct = evPct != null ? round1(evPct - feeBufferPp * (decimal_odds ? 1 : 1) * 0.5) : null;
  // Simpler net: reduce true EV by small fee drag (~0.5–1% of stake)
  let netEvFinal = evPct != null ? round1(evPct - 0.8) : null;

  const evModel = {
    name: 'Real EV',
    market_probability: round1(market_probability * 100),
    no_vig_probability: round1(no_vig_probability * 100),
    model_probability: round1(model_probability * 100),
    probability_edge: probability_edge,
    probability_edge_vs_market: probability_edge_vs_market,
    decimal_odds: decimal_odds,
    evPct: evPct,
    netEvPct: netEvFinal,
    grossEvPct: evPct,
    fairPct: round1(model_probability * 100),
    marketPct: round1(market_probability * 100),
    edgePp: probability_edge,
    feeBufferPp: 0.8,
    score: scoreFromTrueEv(netEvFinal != null ? netEvFinal : 0),
    note: 'EV = model_p × decimal_odds − 1',
  };

  // Edge tile (replaces Liq on card)
  const edgeScore = scoreFromEdgePp(probability_edge);
  const edgeModel = {
    name: 'Edge',
    score: edgeScore,
    probability_edge: probability_edge,
    probability_edge_vs_market: probability_edge_vs_market,
    label:
      probability_edge >= 3
        ? 'Edge +' + probability_edge + 'pp'
        : probability_edge <= -2
          ? 'Against ' + probability_edge + 'pp'
          : 'Thin ' + (probability_edge >= 0 ? '+' : '') + probability_edge + 'pp',
  };

  // Liq kept as soft metadata only (not a rank tile)
  let liqPts = 0;
  if (liq >= 25000) liqPts = 80;
  else if (liq >= 10000) liqPts = 65;
  else if (liq >= 3000) liqPts = 50;
  else if (liq >= 800) liqPts = 40;
  else liqPts = 25;
  const liqVolModel = {
    name: 'Liq / Fill',
    liquidity: liq,
    volume24: vol24,
    volume: vol,
    score: liqPts,
    fillOk: liq >= 400,
    label: liq >= 3000 ? 'OK depth' : liq >= 400 ? 'Thin ok' : 'Very thin',
  };

  // LM badge
  let lmBadge = { movePp: null, label: 'LM: n/a', againstPick: false };
  if (priorP != null) {
    const rawMove = round1((yesPrice - priorP) * 100);
    const movePp = side === 'YES' ? rawMove : -rawMove;
    let label = 'LM: flat';
    if (Math.abs(movePp) < 0.5) label = 'LM: flat';
    else if (movePp >= 1) label = 'LM: toward +' + movePp + 'pp';
    else label = 'LM: against ' + movePp + 'pp';
    lmBadge = { movePp, label, againstPick: movePp <= -4, priorPrice: priorP, currentPrice: yesPrice };
  }

  // Composite
  let betScore = Math.round(evModel.score * 0.45 + edgeModel.score * 0.3 + matchupModel.score * 0.25);

  // Rank floors — overridable via options (filters)
  const strict = options.strictTruth !== false && options.strictTruth !== 0 && options.strictTruth !== '0';
  const allowMarketGood = options.allowMarketGood === true || options.allowMarketGood === 1 || options.allowMarketGood === '1';
  const minGoodEv = options.minGoodEv != null ? Number(options.minGoodEv) : (strict ? 2.0 : 1.0);
  const minEliteEv = options.minEliteEv != null ? Number(options.minEliteEv) : (strict ? 4.5 : 3.0);
  const minGoodEdge = options.minGoodEdge != null ? Number(options.minGoodEdge) : (strict ? 2.0 : 1.0);
  const minEliteEdge = options.minEliteEdge != null ? Number(options.minEliteEdge) : (strict ? 3.5 : 2.5);
  const minGoodScore = options.minGoodScore != null ? Number(options.minGoodScore) : (strict ? 58 : 50);
  const minEliteScore = options.minEliteScore != null ? Number(options.minEliteScore) : (strict ? 68 : 62);

  // Cap absurd EV before ranking (bad prices / live leftovers)
  if (netEvFinal != null && netEvFinal > 25) netEvFinal = 25;
  if (netEvFinal != null && netEvFinal < -25) netEvFinal = -25;
  if (extremePrice) {
    // almost no true edge claim at 5¢ or 95¢ without special model
    netEvFinal = Math.max(-5, Math.min(5, netEvFinal != null ? netEvFinal : 0));
  }

  let rank = 'Pass';
  const net = netEvFinal != null ? netEvFinal : -99;
  const edge = probability_edge;

  const matchupHardBlock = matchupModel.supportsPick === false && matchupModel.confidence === 'medium';
  const lmHardBlock = lmBadge.againstPick;

  if (matchupHardBlock || lmHardBlock) {
    rank = 'Pass';
    betScore = Math.min(betScore, 52);
  } else if ((!hasForm || fairSource === 'market-only') && strict && !allowMarketGood) {
    // Strict truth: no Good/Elite without form
    rank = 'Pass';
    betScore = Math.min(betScore, 55);
  } else if ((!hasForm || fairSource === 'market-only') && allowMarketGood) {
    // User opted in: market-only can be Good (never Elite)
    if (net >= minGoodEv && edge >= minGoodEdge && betScore >= minGoodScore) {
      rank = 'Good';
    } else {
      rank = 'Pass';
      betScore = Math.min(betScore, 55);
    }
  } else if (net >= minEliteEv && edge >= minEliteEdge && betScore >= minEliteScore && (matchupModel.confidence === 'medium' || !strict)) {
    rank = 'Elite';
  } else if (net >= minGoodEv && edge >= minGoodEdge && betScore >= minGoodScore) {
    rank = 'Good';
  } else {
    rank = 'Pass';
  }

  // Cap fantasy EV display and ranks on extreme prices / live
  if (netEvFinal != null && netEvFinal > 40) {
    netEvFinal = 40;
  }
  // LIVE: monitor only — pregame form must not mint Good/Elite on live dogs
  if (norm && norm.live) {
    rank = 'Pass';
    betScore = Math.min(betScore, 48);
    if (netEvFinal != null) {
      netEvFinal = Math.max(-25, Math.min(25, netEvFinal));
    }
  }
  if (extremePrice) {
    rank = 'Pass';
    betScore = Math.min(betScore, 50);
    if (netEvFinal != null) netEvFinal = Math.max(-15, Math.min(15, netEvFinal));
  }
  if (rank === 'Pass') betScore = Math.min(betScore, 56);


  // Kalshi: tighter Elite — require form agreement (winner-first), not EV-only dogs
  const venueK = String((norm && (norm.venue || norm.source)) || '').toLowerCase();
  if (venueK === 'kalshi' && String(rank).toLowerCase() === 'elite') {
    const formHome = homeWinP;
    if (formHome != null) {
      const pickIsHome = pickHome === true;
      const formAgrees = pickIsHome ? formHome >= 0.55 : formHome <= 0.45;
      const modelOk = model_probability != null && model_probability >= 0.52;
      if (!formAgrees || !modelOk) {
        rank = 'Good';
        betScore = Math.min(betScore, 72);
      }
    }
  }

  // Dedicated totals / NRFI / spread models override ML-form ranks
  // Spread titles: never invent a different line than the market
  const qTitle = String(norm.question || norm.title || '');
  if ((mtLow === 'spread' || mtLow.startsWith('spread_')) && /wins by over|cover/i.test(qTitle)) {
    pickName = qTitle.length < 80 ? qTitle : (pickName || qTitle.slice(0, 60));
  }

  if ((mtLow === 'spread' || mtLow.startsWith('spread_')) && (!hasForm || fairSource === 'market-only')) {
    rank = 'Pass';
    betScore = Math.min(betScore, 52);
    // Display: model tracks market — no fake edge
    if (Math.abs((model_probability || 0) - (market_probability || 0)) < 0.02) {
      model_probability = market_probability;
    }
  }

  if (special && special.modelProb != null) {
    side = special.side || side;
    pickName = special.pickName || pickName;
    rank = special.rank || rank;
    betScore = special.betScore != null ? special.betScore : betScore;
    model_probability = special.modelProb;
    market_probability = special.marketProb != null ? special.marketProb : market_probability;
    const se = special.edgePp != null ? special.edgePp : probability_edge;
    const sn = special.netEv != null ? special.netEv : netEvFinal;
    // rebuild display fields
    evModel.model_probability = round1(model_probability * 100);
    evModel.market_probability = round1(market_probability * 100);
    evModel.probability_edge = se;
    netEvFinal = sn;
    fairSource = special.fairSource || fairSource;
  } else if (mtLow === 'spread' || mtLow === 'f5_spread') {
    const spEval = evaluateSpreadSide(norm, yesPrice, noPrice, homeWinP);
    if (spEval && spEval.modelProb != null) {
      special = spEval;
      side = spEval.side;
      pickName = spEval.pickName;
      rank = spEval.rank;
      betScore = spEval.betScore;
      model_probability = spEval.modelProb;
      market_probability = spEval.marketProb;
      evModel.model_probability = round1(model_probability * 100);
      evModel.market_probability = round1(market_probability * 100);
      evModel.probability_edge = spEval.edgePp;
      netEvFinal = spEval.netEv;
      fairSource = spEval.fairSource;
    }
  }

  // F5 winner: allow Good from form, never force Pass solely for being F5
  if (mtLow === 'f5' && rank === 'Pass' && hasForm && homeWinP != null) {
    // already ranked from form path; no extra block
  }

  // FINAL SAFETY (after special totals/spread overrides)
  // 1) Live games: never Elite/Good from pregame form models
  if (norm && norm.live) {
    rank = 'Pass';
    betScore = Math.min(betScore, 48);
  }
  // 2) Resolved / locked prices — not actionable
  const mktPx = market_probability != null ? market_probability : (typeof yesPrice === 'number' ? yesPrice : null);
  if (mktPx != null && (mktPx >= 0.97 || mktPx <= 0.03)) {
    rank = 'Pass';
    betScore = Math.min(betScore, 40);
  }
  // 3) F5 markets after 5th inning (or period says 6+) are expired
  const periodStr = String(norm.period || norm.status || norm.clock || '').toLowerCase();
  let inningNum = null;
  const innM = periodStr.match(/(\d+)(?:st|nd|rd|th)?\s*\/?\s*inning/) || periodStr.match(/top\s*(\d+)/) || periodStr.match(/bot(?:tom)?\s*(\d+)/) || periodStr.match(/mid\s*(\d+)/);
  if (innM) inningNum = parseInt(innM[1], 10);
  if (inningNum == null && /\b(6th|7th|8th|9th|extra)\b/.test(periodStr)) {
    const n2 = periodStr.match(/\b([6-9]|1[0-2])(?:st|nd|rd|th)?\b/);
    if (n2) inningNum = parseInt(n2[1], 10);
  }
  const isF5Mkt = mtLow === 'f5' || mtLow === 'f5_total' || mtLow === 'f5_spread' || /f5|first\s*5|first five/.test(String(pickName || '') + ' ' + String(norm.question || ''));
  if (isF5Mkt && (inningNum != null && inningNum >= 6)) {
    rank = 'Pass';
    betScore = Math.min(betScore, 35);
  }
  // NRFI/YRFI settles after 1st inning starts/completes
  const isNrfiMkt = mtLow === 'nrfi' || mtLow === 'yrfi' || /nrfi|yrfi|no run first|yes run first/.test(String(pickName || '') + ' ' + String(norm.question || ''));
  if (isNrfiMkt && norm && norm.live && inningNum != null && inningNum >= 2) {
    rank = 'Pass';
    betScore = Math.min(betScore, 35);
  }
  if (isNrfiMkt && norm && norm.live && /mid 1|bot 1|top 2|bot 2|3rd|4th|5th|6th|7th|8th|9th/.test(periodStr)) {
    rank = 'Pass';
    betScore = Math.min(betScore, 35);
  }
  if (rank === 'Pass') betScore = Math.min(betScore, 56);

  const confidence = Math.round(
    clamp01(
      0.3 +
        (matchupModel.confidence === 'medium' ? 0.2 : 0.05) +
        (Math.abs(edge) >= 2 ? 0.15 : 0.05) +
        (liq > 2000 ? 0.1 : 0.05) +
        Math.min(0.2, Math.abs(net) / 15)
    ) * 100
  );

  return {
    side,
    fairProbability: evModel.model_probability,
    marketPriceCents: evModel.market_probability,
    netEdge: netEvFinal,
    grossEdge: evPct,
    ev: netEvFinal,
    probability_edge: probability_edge,
    decimal_odds: decimal_odds,
    market_probability: evModel.market_probability,
    no_vig_probability: evModel.no_vig_probability,
    model_probability: evModel.model_probability,
    fairSource,
    formNudgePp,
    hasForm,
    formWinProb: fairBuilt.formWinProb != null ? fairBuilt.formWinProb : (matchupModel.formWinProb && matchupModel.formWinProb.homeWinProb) || null,
    formAwayWinProb: matchupModel.formWinProb && matchupModel.formWinProb.awayWinProb != null ? matchupModel.formWinProb.awayWinProb : null,
    pickName,
    totalLine: (typeof special !== 'undefined' && special && special.line != null) ? special.line : null,
    powerNudgePp: fairBuilt.powerNudgePp != null ? fairBuilt.powerNudgePp : null,
    spNudgePp: fairBuilt.spNudgePp != null ? fairBuilt.spNudgePp : null,
    fairLayers: fairBuilt.layers || null,
    breakdown: norm.matchup
      ? {
          homeName: norm.matchup.homeName || null,
          awayName: norm.matchup.awayName || null,
          venueVerified: !!norm.matchup.venueVerified,
          venueSource: norm.matchup.venueSource || null,
          homeL10: norm.matchup.homeL10 || null,
          awayL10: norm.matchup.awayL10 || null,
          h2h: norm.matchup.h2h || null,
          homeRestDays: norm.matchup.homeRestDays,
          awayRestDays: norm.matchup.awayRestDays,
          power: norm.matchup.power || null,
          sp: norm.matchup.sp || null,
          winProb: norm.matchup.winProb || null,
          totalsProjection: norm.matchup.totalsProjection || null,
          nrfi: norm.matchup.nrfi || null,
          specialModel: special || null,
        }
      : null,
    confidence,
    rank,
    betScore,
    lmBadge,
    evaluate: {
      realEv: Object.assign({}, evModel, { fairSource, formNudgePp, hasForm }),
      matchup: matchupModel,
      edge: edgeModel,
      liqVol: liqVolModel,
      truth: {
        fairSource,
        hasForm,
        formNudgePp,
        note:
          fairSource === 'market-only'
            ? 'Fair ≈ market — no independent form; Pass only'
            : 'Fair uses market + ESPN form',
      },
    },
  };
}

function buildSignal(norm, options) {
  const ev = evaluateMarket(norm, options);
  return { ...norm, ...ev, polyUrl: norm.url, taggedAt: new Date().toISOString() };
}
function scoreMarket(norm, options) {
  return evaluateMarket(norm, options);
}

module.exports = {
  evaluateMarket,
  buildSignal,
  scoreMarket,
  trueEV,
  clamp,
  matchupScore,
};
