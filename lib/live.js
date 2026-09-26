/**
 * Live Focus — multi-sport live edge desk
 * Situation ideas by phase/score + live O/U lean. Not a second full pregame model.
 */

function parsePeriodPhase(league, period, live) {
  const p = String(period || '').toLowerCase();
  const lg = String(league || '').toLowerCase();
  const out = { phase: 'live', phaseLabel: p || 'Live', timeFactor: 0.7, almostDone: false, inning: null, quarter: null, half: null };

  if (!live) {
    return { phase: 'pre', phaseLabel: 'Pregame', timeFactor: 1, almostDone: false, inning: null, quarter: null, half: null };
  }

  // Baseball
  if (lg === 'mlb') {
    const innM = p.match(/(\d+)/);
    const inn = innM ? parseInt(innM[1], 10) : null;
    out.inning = inn;
    out.phaseLabel = p || (inn != null ? 'Inn ' + inn : 'Live');
    if (inn != null && inn <= 3) return Object.assign(out, { phase: 'early', timeFactor: 0.9, almostDone: false });
    if (inn != null && inn <= 5) return Object.assign(out, { phase: 'mid', timeFactor: 0.7, almostDone: false });
    if (inn != null && inn <= 7) return Object.assign(out, { phase: 'late', timeFactor: 0.45, almostDone: false });
    if (inn != null && inn >= 8) return Object.assign(out, { phase: 'late', timeFactor: 0.25, almostDone: true });
    if (/extra/.test(p)) return Object.assign(out, { phase: 'late', phaseLabel: p, timeFactor: 0.2, almostDone: true });
  }

  // Football
  if (lg === 'nfl' || lg === 'cfb') {
    if (/q1|1st|first/.test(p)) return Object.assign(out, { phase: 'early', phaseLabel: p || 'Q1', timeFactor: 0.9, quarter: 1, half: 1 });
    if (/q2|2nd/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: p || 'Q2', timeFactor: 0.65, quarter: 2, half: 1 });
    if (/half|ht|halftime/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: 'HT', timeFactor: 0.55, half: 1 });
    if (/q3|3rd/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: p || 'Q3', timeFactor: 0.45, quarter: 3, half: 2 });
    if (/q4|4th|ot|overtime/.test(p)) return Object.assign(out, { phase: 'late', phaseLabel: p || 'Q4', timeFactor: 0.25, quarter: 4, half: 2, almostDone: /ot|4th|q4/.test(p) });
  }

  // Basketball
  if (lg === 'nba' || lg === 'wnba' || lg === 'cbb') {
    if (/q1|1st/.test(p)) return Object.assign(out, { phase: 'early', phaseLabel: p || 'Q1', timeFactor: 0.9, quarter: 1 });
    if (/q2|2nd|half/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: p || 'Q2', timeFactor: 0.65, quarter: 2 });
    if (/q3|3rd/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: p || 'Q3', timeFactor: 0.5, quarter: 3 });
    if (/q4|4th|ot/.test(p)) return Object.assign(out, { phase: 'late', phaseLabel: p || 'Q4', timeFactor: 0.25, quarter: 4, almostDone: true });
  }

  // Hockey
  if (lg === 'nhl') {
    if (/1st|p1/.test(p)) return Object.assign(out, { phase: 'early', phaseLabel: p || 'P1', timeFactor: 0.9 });
    if (/2nd|p2/.test(p)) return Object.assign(out, { phase: 'mid', phaseLabel: p || 'P2', timeFactor: 0.6 });
    if (/3rd|p3|ot|so/.test(p)) return Object.assign(out, { phase: 'late', phaseLabel: p || 'P3', timeFactor: 0.3, almostDone: /ot|so|3rd/.test(p) });
  }

  // Tennis / UFC — simpler clock
  if (lg === 'atp' || lg === 'wta' || lg === 'ufc') {
    return Object.assign(out, { phase: 'live', phaseLabel: p || 'Live', timeFactor: 0.6, almostDone: false });
  }

  if (/q4|4th|ot|final|end/.test(p)) return Object.assign(out, { phase: 'late', phaseLabel: p, timeFactor: 0.3, almostDone: true });
  if (/q1|1st|first/.test(p)) return Object.assign(out, { phase: 'early', phaseLabel: p, timeFactor: 0.9 });
  return out;
}

function parseScoreDiff(score) {
  if (!score || typeof score !== 'string') return { diff: null, total: null, a: null, b: null, away: null, home: null };
  const parts = score.match(/(\d+)\s*[-–]\s*(\d+)/g);
  if (!parts || !parts.length) return { diff: null, total: null, a: null, b: null };
  const last = parts[parts.length - 1].match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!last) return { diff: null, total: null, a: null, b: null };
  const a = parseInt(last[1], 10);
  const b = parseInt(last[2], 10);
  return { diff: Math.abs(a - b), total: a + b, a, b, away: a, home: b };
}

function extractOuLine(game) {
  if (game.totalLine != null && Number.isFinite(Number(game.totalLine))) return Number(game.totalLine);
  const blob = String(game.question || '') + ' ' + String(game.title || '') + ' ' + String(game.modelPick || '') + ' ' + String(game.eventTitle || '');
  const m = blob.match(/(?:o\/u|over\/under|total)\s*([0-9]+\.?[0-9]*)/i) || blob.match(/\b([0-9]{1,3}\.[05])\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Build sport-specific opportunity ideas for the Live Edge desk
 */
function buildOpportunities(game, phase, sc) {
  const lg = String(game.league || '').toLowerCase();
  const mt = String(game.marketType || '').toLowerCase();
  const pick = String(game.modelPick || '').toLowerCase();
  const line = extractOuLine(game);
  const opps = [];
  const inn = phase.inning;
  const total = sc.total;
  const diff = sc.diff;

  // --- Shared: live total pace (prefer ESPN remainingFrac when present) ---
  const elapsedEspn = game.elapsedFrac != null ? Number(game.elapsedFrac) : (game.espnLive && game.espnLive.elapsedFrac != null ? Number(game.espnLive.elapsedFrac) : null);
  const clockStr = game.clock || (game.espnLive && game.espnLive.displayClock) || null;
  if (line != null && total != null && ((elapsedEspn != null && elapsedEspn > 0.05) || (phase.timeFactor > 0 && phase.timeFactor < 1))) {
    const elapsed = elapsedEspn != null && elapsedEspn > 0.05 ? elapsedEspn : Math.max(0.15, Math.min(0.95, 1 - phase.timeFactor));
    const frac = Math.max(0.12, Math.min(0.95, elapsed));
    const projTotal = total / frac;
    const vsLine = Math.round((projTotal - line) * 10) / 10;
    const lean = vsLine > 0.8 ? 'OVER lean' : vsLine < -0.8 ? 'UNDER lean' : 'ON PACE';
    const clockBit = clockStr ? (' · clock ' + clockStr) : '';
    const src = elapsedEspn != null ? 'ESPN clock' : 'period phase';
    opps.push({
      kind: 'live_ou',
      level: Math.abs(vsLine) >= 1.5 ? 'hot' : Math.abs(vsLine) >= 0.8 ? 'warm' : 'info',
      title: 'Live total vs line',
      detail:
        'Score Σ ' +
        total +
        ' · line ' +
        line +
        ' · elapsed ' +
        Math.round(frac * 100) +
        '% (' +
        src +
        ')' +
        clockBit +
        ' · pace proj ~' +
        Math.round(projTotal * 10) / 10 +
        ' (' +
        (vsLine >= 0 ? '+' : '') +
        vsLine +
        ') → ' +
        lean,
    });
  } else if (line != null && total != null) {
    opps.push({
      kind: 'live_ou',
      level: 'info',
      title: 'Current score vs O/U line',
      detail: 'Runs/points so far ' + total + ' · market line ' + line + (total > line ? ' · already OVER the number' : total < line ? ' · still UNDER the number' : ' · sitting on the number'),
    });
  }

  // --- MLB ---
  if (lg === 'mlb') {
    if (inn != null && inn === 1) {
      opps.push({ kind: 'nrfi', level: 'info', title: '1st inning', detail: 'NRFI/YRFI settles this inning — only trade if market still open and price is live.' });
    }
    if (inn != null && inn <= 5) {
      opps.push({ kind: 'f5', level: 'warm', title: 'F5 still active', detail: 'First-5 totals/winner still in play through end of 5th. After 5th, F5 is dead — ignore F5 Elites.' });
    }
    if (inn != null && inn >= 6) {
      opps.push({ kind: 'f5_dead', level: 'warn', title: 'F5 expired', detail: 'Past 5th — do not bet F5. Focus FG total/ML only if price is real.' });
    }
    if (inn != null && inn >= 7 && diff != null && diff >= 3) {
      opps.push({ kind: 'mlb_late', level: 'warn', title: 'Late + margin', detail: 'Bullpen/outs dominate. Pregame SP form is weak here. ML underdogs need a path; favorites may be clock/outs.' });
    }
    if (line != null && total != null && inn != null) {
      const remainInn = Math.max(0, 9 - inn);
      const rate = inn > 0 ? total / inn : 0;
      const proj = total + rate * remainInn;
      opps.push({
        kind: 'mlb_pace',
        level: Math.abs(proj - line) >= 1.5 ? 'hot' : 'info',
        title: 'Inning pace → FG total',
        detail:
          '~' +
          Math.round(rate * 10) / 10 +
          ' runs/inn so far · project ~' +
          Math.round(proj * 10) / 10 +
          ' through 9 vs line ' +
          line,
      });
    }
  }

  // --- NFL / CFB ---
  if (lg === 'nfl' || lg === 'cfb') {
    if (phase.quarter === 1 || phase.phase === 'early') {
      opps.push({ kind: 'fb_early', level: 'info', title: 'Early script', detail: 'Opening script matters more than final. Live ML can be noisy; totals need a few drives of data.' });
    }
    if (phase.half === 1 && (phase.quarter === 2 || /half|ht/.test(String(phase.phaseLabel).toLowerCase()))) {
      opps.push({ kind: 'fb_ht', level: 'warm', title: 'Halftime window', detail: 'Best live window for 2H totals/spreads after adjustments. Compare 1H scoring pace to FG number.' });
    }
    if (diff != null && diff >= 14 && phase.phase === 'late') {
      opps.push({ kind: 'fb_blowout', level: 'warn', title: 'Blowout clock', detail: 'Large lead late — favorite ML often low EV (kneel-downs). Consider opposing team total / unders if market lags.' });
    }
    if (diff != null && diff <= 3 && phase.phase === 'late') {
      opps.push({ kind: 'fb_close', level: 'hot', title: 'One-score late', detail: 'Close late game — variance high. Prefer defined prices (spread/total) over chasing steam without a number.' });
    }
    if (line != null && total != null) {
      const elapsed = (game.elapsedFrac != null && game.elapsedFrac > 0.08)
        ? Math.max(0.12, Math.min(0.95, Number(game.elapsedFrac)))
        : Math.max(0.15, Math.min(0.92, 1 - phase.timeFactor));
      const proj = total / elapsed;
      const clk = game.clock || (game.espnLive && game.espnLive.displayClock);
      opps.push({
        kind: 'fb_pace',
        level: Math.abs(proj - line) >= 4 ? 'hot' : 'warm',
        title: 'Football pace vs FG total',
        detail: 'Points ' + total + ' · elapsed ' + Math.round(elapsed * 100) + '%' +
          (clk ? ' · ' + clk : '') +
          ' · proj ~' + Math.round(proj) + ' vs line ' + line +
          (proj > line + 3 ? ' → OVER pressure' : proj < line - 3 ? ' → UNDER pressure' : ' → near number'),
      });
    }
  }

  // --- Basketball ---
  if (lg === 'nba' || lg === 'wnba' || lg === 'cbb') {
    if (diff != null && diff >= 15 && phase.phase === 'late') {
      opps.push({ kind: 'bb_blowout', level: 'warn', title: 'Garbage time risk', detail: 'Large late margin — ML favorites can be traps; unders sometimes live if pace dies.' });
    }
    if (line != null && total != null) {
      const elapsed = Math.max(0.15, Math.min(0.92, 1 - phase.timeFactor));
      const proj = total / elapsed;
      opps.push({
        kind: 'bb_pace',
        level: Math.abs(proj - line) >= 8 ? 'hot' : 'info',
        title: 'Pace vs total',
        detail: 'Points ' + total + ' · proj ~' + Math.round(proj) + ' vs ' + line,
      });
    }
  }

  // --- Market type specific ---
  if (/total|over|under/.test(mt + pick) && line != null && total != null) {
    if (total > line) {
      opps.push({ kind: 'ou_side', level: 'hot', title: 'Already over the number', detail: 'Current score exceeds the total line. OVER may be near settled; UNDER needs a path that no longer exists for FG.' });
    }
  }
  if (/nrfi|yrfi/.test(mt + pick) && inn != null && inn >= 2) {
    opps.push({ kind: 'nrfi_dead', level: 'warn', title: 'NRFI window closed', detail: 'Past 1st inning — NRFI/YRFI should not be a new live entry.' });
  }

  // --- Generic ML ---
  if (/moneyline|ml|winner/.test(mt) || (!/total|spread|prop|nrfi/.test(mt) && game.modelPick)) {
    if (phase.almostDone) {
      opps.push({ kind: 'ml_late', level: 'warn', title: 'Late ML', detail: 'Little time left — only act if price is still misaligned with a realistic finish path.' });
    }
  }

  if (!opps.length) {
    opps.push({ kind: 'watch', level: 'info', title: 'Monitor', detail: 'Watch next score change and whether live price moves with or against the board pick.' });
  }

  return opps;
}

function buildLiveAnalysis(game) {
  const live = !!game.live;
  const lg = String(game.league || '').toLowerCase();
  const phase = parsePeriodPhase(game.league, game.period, live);
  const sc = parseScoreDiff(game.score);
  const liq = Number(game.liquidity || 0);
  const netEdge = Number(game.netEdge || 0);
  const mkt = game.market_probability != null ? Number(game.market_probability) : null;
  const model = game.model_probability != null ? Number(game.model_probability) : null;
  const mktPct = mkt != null ? (mkt <= 1 ? mkt * 100 : mkt) : null;
  const modelPct = model != null ? (model <= 1 ? model * 100 : model) : null;
  const ouLine = extractOuLine(game);

  const badges = [];
  const tips = [];
  const zones = {
    state: {},
    market: {},
    signals: [],
    actions: [],
    honesty: {},
    opportunities: [],
  };

  zones.state = {
    live,
    period: game.period || null,
    score: game.score || null,
    phase: phase.phaseLabel,
    phaseKey: phase.phase,
    almostDone: !!phase.almostDone,
    inning: phase.inning,
    quarter: phase.quarter,
    diff: sc.diff,
    total: sc.total,
    ouLine,
    clock: game.clock || (game.espnLive && game.espnLive.displayClock) || null,
    remainingFrac: game.remainingFrac != null ? game.remainingFrac : (game.espnLive && game.espnLive.remainingFrac),
    elapsedFrac: game.elapsedFrac != null ? game.elapsedFrac : (game.espnLive && game.espnLive.elapsedFrac),
  };

  zones.market = {
    pick: game.modelPick || null,
    marketType: game.marketType || null,
    mktPct: mktPct != null ? Math.round(mktPct * 10) / 10 : null,
    modelPct: modelPct != null ? Math.round(modelPct * 10) / 10 : null,
    edgePp: game.probability_edge != null ? game.probability_edge : null,
    netEdge: netEdge,
    rank: game.rank || 'Pass',
  };

  zones.honesty = {
    pregameModel: modelPct,
    liveMarket: mktPct,
    note: live
      ? 'Pregame form is dampened live — opportunities are situation guides, not a new full model.'
      : 'Pin this game when it goes live for pace, phase, and live O/U ideas.',
  };

  if (!live) {
    badges.push('Pre-game');
    tips.push('Live Focus is strongest after kickoff / tip / first pitch.');
    tips.push('Once live: phase + score total vs O/U line drive the desk.');
    zones.signals.push({ level: 'info', text: 'Waiting for live state' });
    zones.actions.push('Open again once live for full Live Edge desk');
    zones.opportunities = [
      { kind: 'pre', level: 'info', title: 'Stand by', detail: 'Live Edge unlocks with live score + period from the feed.' },
    ];
    return {
      live: false,
      phase,
      score: sc,
      badges,
      tips,
      zones,
      opportunities: zones.opportunities,
      liveScoreAdjust: 0,
      trapRisk: false,
      liqCrush: liq > 0 && liq < 800,
    };
  }

  // Phase badges
  if (phase.almostDone) {
    badges.push('Almost done');
    tips.push('Little variance left — only act with clear price and liquidity.');
    zones.signals.push({ level: 'warn', text: 'Late game — clock/outs dominate form' });
  } else if (phase.phase === 'late') {
    badges.push('Late phase');
    tips.push('Late: game state > pregame form.');
  } else if (phase.phase === 'early') {
    badges.push('Early');
    tips.push('Still early — full-game models remain somewhat relevant.');
  } else {
    badges.push('In progress');
  }

  // Score traps by sport
  if (sc.diff != null) {
    if (sc.diff >= 14 && (lg === 'nfl' || lg === 'cfb')) {
      badges.push('Large lead');
      tips.push('Large football lead: favorite ML often low-upside.');
      zones.signals.push({ level: 'warn', text: 'Blowout risk — ML may be a trap' });
    } else if (sc.diff >= 7 && (lg === 'nfl' || lg === 'cfb')) {
      badges.push('Solid lead');
      zones.signals.push({ level: 'info', text: 'Lead ≥ 7 — price should reflect clock' });
    }
    if (sc.diff >= 15 && (lg === 'nba' || lg === 'wnba' || lg === 'cbb')) {
      badges.push('Big margin');
      tips.push('Large margin live — favorite ML can be a trap.');
    }
    if (sc.diff >= 4 && lg === 'mlb' && phase.inning != null && phase.inning >= 7) {
      badges.push('Late deficit/lead');
      tips.push('Late MLB: bullpen + outs matter more than pregame SP form.');
    }
  }

  // Price vs model
  if (mktPct != null && modelPct != null) {
    const gap = modelPct - mktPct;
    if (gap <= -8) {
      zones.signals.push({ level: 'warn', text: 'Market > model — invalidating lean' });
    } else if (gap >= 6) {
      zones.signals.push({ level: 'ok', text: 'Live price still softer than pregame model' });
    } else {
      zones.signals.push({ level: 'info', text: 'Price near pregame model' });
    }
  }

  if (netEdge != null && Math.abs(netEdge) > 20) {
    zones.signals.push({ level: 'warn', text: 'Treat large live EV with suspicion' });
  }
  if (liq > 0 && liq < 800) {
    zones.signals.push({ level: 'warn', text: 'Liquidity thin' });
  }

  // Opportunities engine
  const opportunities = buildOpportunities(game, phase, sc);
  zones.opportunities = opportunities;

  zones.actions = [
    phase.almostDone ? 'Prefer no new risk unless hedge' : 'Re-check after next score / clock change',
    ouLine != null ? 'Compare live pace to O/U line ' + ouLine : 'Watch total scoring pace',
    'Log only what you actually trade',
  ];

  tips.push('Live Edge ideas are situational — confirm the market is still open and the price is real.');

  return {
    live: true,
    phase,
    score: sc,
    badges,
    tips,
    zones,
    opportunities,
    liveScoreAdjust: 0,
    trapRisk: badges.indexOf('Large lead') >= 0 || badges.indexOf('Big margin') >= 0,
    liqCrush: liq > 0 && liq < 800,
  };
}

module.exports = {
  buildLiveAnalysis,
  parsePeriodPhase,
  parseScoreDiff,
  extractOuLine,
  buildOpportunities,
};
