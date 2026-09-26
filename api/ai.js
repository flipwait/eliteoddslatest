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

  const apiKey = body.apiKey || process.env.OPENAI_API_KEY;
  const model = body.model || process.env.OPENAI_MODEL || 'gpt-4o';
  const game = body.game || {};

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'OpenAI key required (Settings)' });
  }

  let system;
  let userContent;

  if (action === 'research' || action === 'deep' || action === 'deep-research') {
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
    system = `You are BetBetter AI Verdict — unbiased analyst for moneyline and over/under.

RULES:
- Do NOT force a bet. PASS when edge is unclear.
- Do NOT invent injuries, lineups, or weather. Unknown stays unknown.
- Prefer quantitative payload (model %, market %, form, L10, H2H, projection).
- Short, professional, no cheerleading.

OUTPUT FORMAT (exact headings):

VERDICT: LEAN_PICK | LEAN_OTHER | PASS
(For totals: LEAN_OVER | LEAN_UNDER | PASS)

CONFIDENCE: Low | Medium | High

ONE-LINER:
One sentence call.

THESIS:
2–4 sentences. Mechanism of the edge (or why none). Use form/L10/H2H/price; optional one non-obvious angle only if supported by data. No essay.

WHY (data):
- 3–5 bullets with numbers from the payload

RISKS:
- 1–3 real risks (or "None material")

WOULD CHANGE MY MIND IF:
- 1–2 concrete conditions

No "lock" / "guaranteed". No EV sales language.`;
    userContent = JSON.stringify({
      task: 'Unbiased verdict for this market',
      marketType: game.marketType,
      league: game.league,
      event: game.eventTitle || game.title,
      question: game.question || game.title,
      modelPick: game.modelPick,
      rank: game.rank,
      model_probability: game.model_probability,
      market_probability: game.market_probability,
      no_vig_probability: game.no_vig_probability,
      probability_edge: game.probability_edge,
      netEdge: game.netEdge,
      score10: game.score10,
      formWinProb: game.formWinProb,
      formAwayWinProb: game.formAwayWinProb,
      breakdown: game.breakdown || null,
      matchup: game.matchup || null,
      totalsProjection: game.totalsProjection || (game.matchup && game.matchup.totalsProjection) || null,
      live: !!game.live,
      venue: game.venue || 'polymarket',
    }, null, 0);
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
        max_tokens: action === 'research' ? 1400 : 900,
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
