module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }
  body = body || {};

  const pick = body.pick || q.pick || '';
  const market = body.market || q.market || '';
  const result = String(body.result || q.result || 'won').toLowerCase();
  const alertId = body.alertId || q.alertId || '';
  const score = body.score || q.score || '';

  const isSubmit = req.method === 'POST' || q.submit === '1';

  if (!isSubmit) {
    const isWon = result !== 'lost';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${isWon ? 'I hit this' : 'I missed this'}</title>
<style>
body{font-family:system-ui;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b12;color:#e8eef7;padding:1rem;box-sizing:border-box}
.card{max-width:400px;width:100%;background:#0f1623;border:1px solid #243044;border-radius:16px;padding:1.25rem}
h1{font-size:1.15rem;margin:0 0 .5rem}
.pick{color:${isWon ? '#22c55e' : '#f87171'};font-weight:600;margin:.5rem 0}
label{display:block;font-size:.75rem;color:#94a3b8;margin-top:.75rem}
input{width:100%;margin-top:.25rem;padding:.55rem .65rem;border-radius:.5rem;border:1px solid #243044;background:#070b12;color:#fff;box-sizing:border-box}
button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:.6rem;background:${isWon ? '#22c55e' : '#ef4444'};color:#04120a;font-weight:700;cursor:pointer}
.muted{font-size:.75rem;color:#8b9bb4;margin-top:1rem}
</style></head><body><div class="card">
<h1>${isWon ? '✅ I hit this bet' : '❌ Tough luck — I missed'}</h1>
<p class="pick">${String(pick).replace(/</g,'')}</p>
<p style="font-size:.85rem;color:#94a3b8">${String(market).replace(/</g,'')}</p>
${score ? `<p style="font-size:.8rem;color:#94a3b8">Final: ${String(score).replace(/</g,'')}</p>` : ''}
<form method="GET" action="">
<input type="hidden" name="submit" value="1"/>
<input type="hidden" name="result" value="${isWon ? 'won' : 'lost'}"/>
<input type="hidden" name="pick" value="${String(pick).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="market" value="${String(market).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="alertId" value="${String(alertId).replace(/"/g,'&quot;')}"/>
<input type="hidden" name="score" value="${String(score).replace(/"/g,'&quot;')}"/>
<label>Your name<input name="name" required placeholder="e.g. Mike" autocomplete="name"/></label>
<label>Note (optional)<input name="note" placeholder="units / book"/></label>
<button type="submit">${isWon ? 'Post: I cashed →' : 'Post: I missed →'}</button>
</form>
<p class="muted">Optional — only if you want the group to know you were on it.</p>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  const name = body.name || q.name || 'Someone';
  const note = body.note || q.note || '';
  const isWon = result !== 'lost';
  const webhookUrl =
    process.env.DISCORD_WEBHOOK_PLACED ||
    process.env.DISCORD_WEBHOOK_WON ||
    process.env.DISCORD_WEBHOOK_URL ||
    null;

  if (!webhookUrl) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#070b12;color:#fff;padding:2rem">
<h1>Webhook not configured</h1>
<p>Set DISCORD_WEBHOOK_PLACED on Vercel.</p></body></html>`);
  }

  const embed = {
    author: { name: isWon ? '✅ HIT CLAIM' : '❌ MISS CLAIM' },
    title: isWon ? `${name} cashed` : `${name} missed`,
    description: `**${pick || 'Pick'}**\n${market || ''}`.slice(0, 1800),
    color: isWon ? 0x22c55e : 0xef4444,
    fields: [
      { name: 'Who', value: `**${String(name).slice(0, 80)}**`, inline: true },
      { name: 'Result', value: isWon ? '**WON**' : '**LOST**', inline: true },
    ],
    footer: { text: alertId ? `alert ${alertId}` : 'BetBetter claim' },
    timestamp: new Date().toISOString(),
  };
  if (score) embed.fields.push({ name: 'Final', value: String(score).slice(0, 80), inline: true });
  if (note) embed.fields.push({ name: 'Note', value: String(note).slice(0, 200), inline: false });

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: isWon
          ? `✅ **${name}** hit · **${pick || 'pick'}**`
          : `❌ **${name}** missed · **${pick || 'pick'}**`,
        embeds: [embed],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(r.status).send(`<p style="font-family:system-ui;color:#fff;background:#070b12;padding:2rem">Discord error: ${t}</p>`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#070b12;color:#e8eef7;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="text-align:center"><h1 style="color:${isWon ? '#22c55e' : '#f87171'}">Posted ✓</h1>
<p>${String(name)} · ${String(pick)}</p>
<p style="color:#8b9bb4">You can close this tab.</p></div></body></html>`);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
