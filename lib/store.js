/** Ephemeral store (warm lambda). Not multi-region durable. */
const g = globalThis;
if (!g.__bbStore) {
  g.__bbStore = {
    prices: {},
    books: {},
    meta: { lastSnapshot: null, lastSmart: null },
    betLogs: {}, // alertId -> [{ user, pick, market, price, at }]
  };
}
const store = g.__bbStore;
if (!store.betLogs) store.betLogs = {};

function pushPrice(id, p, max = 48) {
  if (!id || p == null || isNaN(p)) return;
  const px = Number(p);
  if (px <= 0 || px >= 1) return;
  if (!store.prices[id]) store.prices[id] = [];
  store.prices[id].push({ t: Date.now(), p: px });
  if (store.prices[id].length > max) store.prices[id] = store.prices[id].slice(-max);
}

function getPriceHistory(id) {
  return store.prices[id] || [];
}

function getMove(id, windowMs) {
  const h = getPriceHistory(id);
  if (h.length < 2) return null;
  const now = Date.now();
  const current = h[h.length - 1];
  let past = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (now - h[i].t >= windowMs) {
      past = h[i];
      break;
    }
  }
  if (!past) past = h[0];
  if (!past || !current) return null;
  return {
    movePp: Math.round((current.p - past.p) * 1000) / 10,
    from: past.p,
    to: current.p,
    ageMs: current.t - past.t,
  };
}

function setBook(id, data) {
  store.books[id] = { ...data, t: Date.now() };
}

function getBook(id) {
  return store.books[id] || null;
}

function logBetAlert(alertId, entry) {
  const id = String(alertId || 'unknown');
  if (!store.betLogs[id]) store.betLogs[id] = [];
  const userKey = String((entry && entry.user) || 'anon').toLowerCase();
  // one log per user per alert
  const exists = store.betLogs[id].find((x) => String(x.user || '').toLowerCase() === userKey);
  if (exists) {
    return { already: true, count: store.betLogs[id].length, logs: store.betLogs[id] };
  }
  store.betLogs[id].push({
    user: entry.user || 'anon',
    pick: entry.pick || '',
    market: entry.market || '',
    price: entry.price != null ? entry.price : null,
    odds: entry.odds || null,
    at: new Date().toISOString(),
    alertId: id,
  });
  // cap
  if (store.betLogs[id].length > 200) store.betLogs[id] = store.betLogs[id].slice(-200);
  return { already: false, count: store.betLogs[id].length, logs: store.betLogs[id] };
}

function getBetLogs(alertId) {
  return store.betLogs[String(alertId)] || [];
}

module.exports = {
  store,
  pushPrice,
  getPriceHistory,
  getMove,
  setBook,
  getBook,
  logBetAlert,
  getBetLogs,
};
