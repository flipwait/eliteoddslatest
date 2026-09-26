module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  let body = {};
  if (req.method === 'POST') {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  }

  const pick = body.pick || q.pick || '';
  const market = body.market || q.market || q.title || '';
  const rank = body.rank || q.rank || '';
  const alertId = body.alertId || q.alertId || q.id || '';
  const odds = body.odds || q.odds || '';
  const price = body.price != null ? body.price : q.price != null ? q.price : '';
  const tradeUrl = body.url || q.url || 'https://polymarket.us';

  // GET without submit → HTML form for friends
  if (req.method === 'GET' && q.submit !== '1') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BetBetter · I took this</title>
<style>
body{font-family:system-ui,sans-serif;background:#070b12;color:#e8eef7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#0c121c;border:1px solid #243044;border-radius:1rem;padding:1.25rem;max-width:22rem;width:100%}
h1{font-size:1.05rem;margin:0 0 .5rem}
p{color:#8b9bb4;font-size:.85rem;line-height:1.45;margin:.35rem 0}
label{display:block;font-size:.75rem;color:#8b9bb4;margin-top:.75rem}
input{width:100%;margin-top:.35rem;padding:.55rem .65rem;border-radius:.5rem;border:1px solid #243044;background:#070b12;color:#fff;box-sizing:border-box}
button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:.6rem;background:#22c55e;color:#04120a;font-weight:700;cursor:pointer}
.pick{color:#22c55e;font-weight:600}
</style></head><body><div class="card">
<h1>I took this bet</h1>
<p class="pick">${String(pick).replace(/</g,'')}</p>
<p>${String(market).replace(/</g,'')}</p>
<form method="GET" action="">
<input type="hidden" name="submit" value="1"/>
<input type="hidden" name="pick" value="${String(pick).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="market" value="${String(market).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="rank" value="${String(rank).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="alertId" value="${String(alertId).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="odds" value="${String(odds).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="price" value="${String(price).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="url" value="${String(tradeUrl).replace(/"/g,'&quot;')}"/>
<label>Your name<input name="name" required placeholder="e.g. Mike" autocomplete="name"/></label>
<label>Stake (units or $)<input name="stake" required placeholder="e.g. 1 or 25"/></label>
<label>Note (optional)<input name="note" placeholder="ticket / book"/></label>
<button type="submit">Notify group →</button>
</form>
<p style="margin-top:1rem;font-size:.75rem">Sends a message to the group placed-bet webhook. Admin updates ledger manually.</p>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  const name = body.name || q.name || 'Someone';
  const stake = body.stake || q.stake || '?';
  const note = body.note || q.note || '';

  // Prefer env for public form (friends); body.webhookUrl only from trusted app posts
  const webhookUrl =
    body.webhookUrl ||
    process.env.DISCORD_WEBHOOK_PLACED ||
    process.env.DISCORD_WEBHOOK_URL ||
    null;

  if (!webhookUrl) {
    const msg = `<!DOCTYPE html><html><body style="font-family:system-ui;background:#070b12;color:#e8eef7;padding:2rem">
<h1>Webhook not configured</h1>
<p>Set <code>DISCORD_WEBHOOK_PLACED</code> in Vercel env so friend clicks can notify the group.</p>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(msg);
  }

  const embed = {
    author: { name: '💸 PLACED BET' },
    title: `${name} placed a bet`,
    description: `**${pick || 'Pick'}**\n${market || ''}`.slice(0, 2000),
    color: 0xf59e0b,
    fields: [
      { name: 'Who', value: `**${String(name).slice(0, 80)}**`, inline: true },
      { name: 'Stake', value: `**${String(stake).slice(0, 40)}**`, inline: true },
      { name: 'Rank', value: rank ? String(rank) : '—', inline: true },
      { name: 'Odds / price', value: [odds, price !== '' ? String(price) : ''].filter(Boolean).join(' · ') || '—', inline: true },
    ],
    footer: { text: alertId ? `alert ${alertId}` : 'BetBetter placed' },
    timestamp: new Date().toISOString(),
  };
  if (note) embed.fields.push({ name: 'Note', value: String(note).slice(0, 200), inline: false });
  if (tradeUrl) embed.url = tradeUrl;

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `💸 **${name}** placed a bet · **${pick || 'pick'}** · stake **${stake}**`,
        embeds: [embed],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      if (req.method === 'POST' && body.webhookUrl) return res.status(r.status).json({ error: t });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(r.status).send(`<p style="font-family:system-ui">Discord error: ${t}</p>`);
    }
    if (req.method === 'POST' && body.json) return res.status(200).json({ ok: true });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#070b12;color:#e8eef7;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="text-align:center"><h1 style="color:#22c55e">Sent ✓</h1><p>${String(name)} · ${String(pick)} · stake ${String(stake)}</p><p style="color:#8b9bb4">Group was notified. You can close this tab.</p></div></body></html>`);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
