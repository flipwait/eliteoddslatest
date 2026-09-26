const { fetchAllSportsEvents, fetchLeagueEvents } = require('../polymarket');
const { pushPrice, store } = require('../store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    const league = (req.query.league || '').toLowerCase();
    let events;
    if (league) {
      events = await fetchLeagueEvents(league, { limit: 40 });
    } else {
      events = await fetchAllSportsEvents({ limitPerLeague: 10 });
    }
    let n = 0;
    for (const ev of events) {
      for (const m of ev.markets || []) {
        if (m.yesPrice == null) continue;
        const id = String(m.id || m.slug || m.question || ev.id);
        pushPrice(id, m.yesPrice);
        if (m.slug) pushPrice(String(m.slug), m.yesPrice);
        if (ev.id) pushPrice(String(ev.id), m.yesPrice);
        n++;
      }
    }
    store.meta = store.meta || {};
    store.meta.lastSnapshot = new Date().toISOString();
    return res.status(200).json({
      ok: true,
      snapped: n,
      marketsTracked: Object.keys(store.prices || {}).length,
      at: store.meta.lastSnapshot,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
