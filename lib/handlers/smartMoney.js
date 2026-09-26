const { getBook, setBook, getMove, pushPrice } = require('../store');

async function tryBook(slug) {
  if (!slug) return null;
  const r = await fetch(
    'https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/book',
    { headers: { Accept: 'application/json' } }
  );
  let data = {};
  try {
    data = await r.json();
  } catch (e) {
    data = {};
  }
  if (!r.ok) return { ok: false, slug, error: data.message || 'book failed', status: r.status };
  return { ok: true, slug, data };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const slug = req.query.slug;
  const id = req.query.id || slug;
  const workerUrl = (req.query.workerUrl || process.env.SMART_WORKER_URL || '').replace(/\/$/, '');
  const workerSecret = process.env.WORKER_SECRET || '';

  if (!slug && req.query.status === '1') {
    return res.status(200).json({
      ok: true,
      keysConfigured: !!(process.env.POLYMARKET_KEY_ID && process.env.POLYMARKET_SECRET_KEY),
      workerConfigured: !!workerUrl,
      note: workerUrl
        ? 'Worker URL set — Smart$ uses market slugs + tape'
        : 'Book-only Smart$. Pass real market slug (not event slug).',
    });
  }

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'slug required (market slug, not event slug)' });
  }

  // Worker tape
  let tape = null;
  if (workerUrl) {
    try {
      const u =
        workerUrl +
        '/aggregate?slug=' +
        encodeURIComponent(slug) +
        '&windowMs=' +
        encodeURIComponent(String(15 * 60 * 1000));
      const r = await fetch(u, {
        headers: workerSecret ? { 'X-Worker-Secret': workerSecret } : {},
      });
      if (r.ok) tape = await r.json();
    } catch (e) {
      tape = { ok: false, error: e.message };
    }
  }

  try {
    const extra = String(req.query.slugs || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = [];
    const seen = new Set();
    function addC(s) {
      if (!s || seen.has(s)) return;
      seen.add(s);
      candidates.push(s);
    }
    // Prefer non-event slugs first
    const isEvent = /^(mlb|nba|nfl|cfb|nhl|wnba|cbb)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/i.test(slug);
    if (!isEvent) addC(slug);
    extra.forEach(addC);
    if (isEvent) addC(slug);

    let bookResult = null;
    let lastErr = null;
    for (const c of candidates.slice(0, 15)) {
      bookResult = await tryBook(c);
      if (bookResult && bookResult.ok) break;
      lastErr = bookResult;
      bookResult = null;
    }

    if (!bookResult || !bookResult.ok) {
      if (tape && tape.hasTape) {
        return res.status(200).json({
          ok: true,
          slug,
          source: 'worker',
          lean: tape.lean,
          strength: tape.strength,
          score: tape.score,
          tags: tape.tags || [],
          tape,
          note: 'Book not found; worker tape only',
          bookError: (lastErr && lastErr.error) || 'book failed',
          tried: candidates.slice(0, 15),
        });
      }
      return res.status(200).json({
        ok: false,
        error: (lastErr && lastErr.error) || 'market not found',
        slug,
        tried: candidates.slice(0, 15),
        tape,
        hint: 'Event slugs fail on book API. Need market slug like tsc-mlb-... or asc-mlb-... Passed slugs= from card.',
      });
    }

    const data = bookResult.data;
    const slugUsed = bookResult.slug;
    const md = data.marketData || data;
    const bids = md.bids || [];
    const offers = md.offers || [];
    const bidQty = bids.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const askQty = offers.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const imbalance =
      bidQty + askQty > 0 ? Math.round(((bidQty - askQty) / (bidQty + askQty)) * 1000) / 10 : 0;
    let lastPx = null;
    if (md.stats && md.stats.lastTradePx) {
      const v = md.stats.lastTradePx.value != null ? md.stats.lastTradePx.value : md.stats.lastTradePx;
      lastPx = typeof v === 'object' ? Number(v.value) : Number(v);
      if (lastPx > 1) lastPx = lastPx / 100;
    }
    if (lastPx) pushPrice(id || slugUsed, lastPx);
    setBook(id || slugUsed, { imbalance, bidQty, askQty, lastTradePx: lastPx, slug: slugUsed });

    const lm15 = getMove(id || slugUsed, 15 * 60 * 1000);
    const lean = imbalance > 5 ? 'bid' : imbalance < -5 ? 'ask' : 'mixed';
    let strength = 0;
    if (Math.abs(imbalance) >= 25) strength += 2;
    else if (Math.abs(imbalance) >= 10) strength += 1;
    if (bidQty + askQty > 5000) strength += 1;
    if (tape && tape.hasTape) strength = Math.max(strength, tape.strength || 0);
    strength = Math.min(5, strength);

    const tags = [
      lean !== 'mixed' ? lean + '-heavy book' : 'balanced book',
      Math.abs(imbalance) >= 20 ? 'book pressure' : null,
      'book:' + slugUsed,
    ];
    if (tape && tape.tags) tags.push(...tape.tags);

    return res.status(200).json({
      ok: true,
      slug,
      slugUsed,
      imbalancePct: imbalance,
      bidQty,
      askQty,
      lean: (tape && tape.lean) || lean,
      strength,
      score: Math.round(15 + (strength / 5) * 70),
      tags: tags.filter(Boolean),
      lm: { m15: lm15 },
      tape: tape,
      source: tape && tape.hasTape ? 'worker+book' : 'book',
      note:
        tape && tape.hasTape
          ? 'Tape + book'
          : workerUrl
            ? 'Book OK · worker may still be filling tape for this market slug'
            : 'Book only',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, tape });
  }
};
