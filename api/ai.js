module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }
  body = body || {};
  const q = req.query || {};
  const action = String(body.action || q.action || 'verdict').toLowerCase();

  const apiKey = body.apiKey || body.openaiKey || body.openAiKey || process.env.OPENAI_API_KEY;
  const model = body.model || process.env.OPENAI_MODEL || 'gpt-4o';
  const game = body.game || {};

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'OpenAI key required (Settings)' });
  }

  let system;
  let userContent;

  if (action === 'coach' || action === 'openai' || action === 'free' || body.prompt) {
    system = body.system || 'You are a sports betting model coach. Short, honest bullets. Do not invent stats.';
    userContent = body.prompt || body.message || JSON.stringify(game);
  } else if (action === 'potd-analyze' || action === 'potd') {
    system = body.system || `Independent third-party sports betting analyst. You are NOT the numeric model. Do not rubber-stamp or auto-oppose. Unbiased. No invented injuries/lineups/weather. H2H is context only. Output exactly:
CONVICTION: HIGH|MEDIUM|LOW
SIGNAL: YAY|LEAN_YAY|NEUTRAL|LEAN_NAY|NAY
AGREE: one line
PUSHBACK: one line
H2H: one line
GAPS: unknowns
THESIS: 3-5 neutral sentences
BOTTOM: one line (optional read, not a veto)`;
    userContent = JSON.stringify(game, null, 0);
  } else if (action === 'research' || action === 'deep' || action === 'deep-research') {

    system = `Deep Research — Bet Validation & Thesis

You are performing deep research on a betting opportunity.

Your job is to find NEW, RELEVANT, DECISION-CHANGING information.

Structure response with:
1. HIDDEN EDGE
2. WHAT THE MODEL MAY MISS
3. WHY THIS MATCHUP TODAY
4. OUTSIDE CONFIRMATION
5. MARKET READ
6. TOP NEW FINDINGS
7. CONCERNS
8. BETTING THESIS

Be concise. No cheerleading.`;
    userContent = JSON.stringify(game, null, 0);
  } else if (body.parlayMode && game.legs) {
    system = `You review a multi-leg sports parlay. Be honest about correlation and that parlays are higher variance. Do not force approval.

Output:
VERDICT: APPROVE | CAUTION | PASS
CONFIDENCE: Low|Medium|High
ONE-LINER:
LEGS READ: brief per leg
CORRELATION:
RISKS:`;
    userContent = JSON.stringify(game);
  } else {
    system = `You are EliteOdds AI Verdict — an independent third-party auditor of ONE model pick.
You are NOT the numeric model. Do not rubber-stamp Elite/Good and do not auto-fade it.

MISSION:
Produce a concrete, number-heavy audit of whether THIS pick is justified by the payload.
Use every relevant field provided. Prefer facts over prose.

HARD RULES:
- Do NOT invent injuries, lineups, weather, refs, or news. If missing → list under GAPS.
- Do NOT invent L10 / RF / RA / H2H numbers that are not in the payload.
- H2H is context only, never a veto by itself.
- If model % and market % are close (thin edge), say so even if rank is Elite.
- If period/line looks mismatched (e.g. NBA "Full game" total under 100 with PPG ~120), flag DATA QUALITY and lean PASS.
- No "lock", "guaranteed", or EV sales language.

OUTPUT (exact headings, keep tight):

VERDICT: LEAN_PICK | LEAN_OTHER | PASS
(For totals: LEAN_OVER | LEAN_UNDER | PASS)

CONVICTION: Low | Medium | High

ONE-LINER:
One sentence: take / pass and why in numbers.

WHAT THE MODEL CLAIMS:
1–2 sentences restating pick, model %, market %, edge pp, rank — with numbers from payload.

SUPPORTS THE PICK:
- 3–6 bullets. Each bullet MUST include a number from the payload (form %, L10, RF/RA, projection vs line, price, rest, etc.).
- If a field is missing, skip it — do not invent.

CHALLENGES THE PICK:
- 2–5 bullets that argue against the pick using payload facts (thin edge, chalk price, small sample, opposing form, etc.).
- Try hard to find at least two challenges. If truly none: "None material from payload."

GAPS / UNKNOWN:
- What a sharp would still want (lineups, injuries, weather, books consensus) that is NOT in the payload.

INDEPENDENT READ:
Would a third party take this price on the evidence above? Yes / No / Only if … (one short paragraph).

RANK CHECK:
Does Elite/Good/Pass on the card match the evidence? If rank looks ahead of data, say so.

BOTTOM:
One line optional action (paper / skip / only at better price).`;
    userContent = JSON.stringify({
      task: 'Unbiased fact-heavy verdict for this single market',
      marketType: game.marketType,
      league: game.league,
      sport: game.sport || game.league,
      event: game.eventTitle || game.title,
      question: game.question || game.title,
      modelPick: game.modelPick || game.pick,
      pick: game.pick || game.modelPick,
      rank: game.rank,
      fairSource: game.fairSource || null,
      betScore: game.betScore != null ? game.betScore : null,
      score10: game.score10,
      model_probability: game.model_probability,
      market_probability: game.market_probability,
      no_vig_probability: game.no_vig_probability,
      probability_edge: game.probability_edge,
      netEdge: game.netEdge != null ? game.netEdge : game.netEv,
      netEv: game.netEv != null ? game.netEv : game.netEdge,
      line: game.line != null ? game.line : (game.totalLine != null ? game.totalLine : game.spreadLine),
      totalLine: game.totalLine,
      spreadLine: game.spreadLine,
      formWinProb: game.formWinProb,
      formAwayWinProb: game.formAwayWinProb,
      hasForm: game.hasForm,
      formNote: game.formNote || game.formBlurb || null,
      homeL10: game.homeL10 || null,
      awayL10: game.awayL10 || null,
      h2h: game.h2h || null,
      restHome: game.restHome != null ? game.restHome : null,
      restAway: game.restAway != null ? game.restAway : null,
      breakdown: game.breakdown || null,
      matchup: game.matchup || null,
      totalsProjection: game.totalsProjection || (game.matchup && game.matchup.totalsProjection) || null,
      startTime: game.startTime || null,
      live: !!game.live,
      venue: game.venue || 'polymarket',
      slug: game.slug || game.marketSlug || null,
    }, null, 2);
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: action === 'research' ? 0.35 : 0.25,
        max_tokens: body.max_tokens || (action === 'research' ? 1400 : 900),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: (data.error && data.error.message) || ('OpenAI ' + r.status),
      });
    }
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    return res.status(200).json({ ok: true, text, model, action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
