// Tado X → KeukenDashboard doorgeefluik (Cloudflare Worker)
//
// Waarom: de Tado-API laat alleen app.tado.com toe als herkomst (CORS), dus de
// iPad kan niet rechtstreeks bij Tado. Deze Worker haalt de gegevens op via een
// cron (elke 5 min, zie wrangler.toml / Triggers) en bewaart ze in KV. Het
// dashboard leest alleen die bewaarde JSON, zodat we ruim binnen de Tado-limiet
// van ±100 verzoeken per dag blijven, hoe vaak het dashboard ook ververst.
//
// Benodigd:
//   KV-binding  TADO_KV
//   Secret      KEY      (vrij te kiezen wachtwoord; dashboard en /setup gebruiken het)
//
// Endpoints (allemaal met ?key=KEY):
//   /            → laatst opgehaalde gegevens als JSON
//   /setup       → eenmalig koppelen met je Tado-account
//   /refresh     → nu direct ophalen (kost 1 Tado-verzoek)
//   /?raw=1      → ruwe Tado-respons, handig om velden te zoeken

const CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46'; // publieke client-id van Tado voor de device-flow
const LOGIN = 'https://login.tado.com/oauth2';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (!env.KEY || url.searchParams.get('key') !== env.KEY) return json({ error: 'geen toegang' }, 401);

    try {
      switch (url.pathname) {
        case '/':            return await getData(env, url.searchParams.has('raw'));
        case '/refresh':     await update(env); return await getData(env, false);
        case '/setup':       return await setupStart(env, url);
        case '/setup/check': return await setupCheck(env);
        default:             return json({ error: 'onbekend pad' }, 404);
      }
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(update(env).catch(e => console.error('Tado update mislukt:', e)));
  },
};

// ─── Gegevens ────────────────────────────────────────────────────────

async function getData(env, raw) {
  const cached = await env.TADO_KV.get('data', 'json');
  if (!cached) {
    const linked = await env.TADO_KV.get('refresh_token');
    return json({ error: linked ? 'nog geen gegevens, wacht op de eerste ophaalronde' : 'nog niet gekoppeld, open /setup' }, 503);
  }
  if (!raw) delete cached.raw;
  return json(cached);
}

async function update(env) {
  const token = await accessToken(env);
  const homeId = await getHomeId(env, token);

  const r = await fetch(`https://hops.tado.com/homes/${homeId}/rooms`, { headers: { Authorization: `Bearer ${token}` } });
  const quota = r.headers.get('ratelimit'); // bv. "perday";r=71;t=…  (r = resterend vandaag)
  if (!r.ok) {
    await markError(env, `Tado rooms: HTTP ${r.status}`);
    throw new Error(`Tado rooms: HTTP ${r.status} ${await r.text()}`);
  }
  const rooms = await r.json();

  const data = {
    updated: new Date().toISOString(),
    quota,
    rooms: rooms.map(room => ({
      id: room.id,
      name: room.name,
      temp: room.sensorDataPoints?.insideTemperature?.value ?? null,
      humidity: room.sensorDataPoints?.humidity?.percentage ?? null,
      target: room.setting?.power === 'ON' ? (room.setting?.temperature?.value ?? null) : null,
      power: room.setting?.power ?? null,                 // ON / OFF
      heating: room.heatingPower?.percentage ?? 0,         // stookvraag van deze ruimte in %
      manual: !!room.manualControlTermination,             // handmatig overschreven
      boost: !!room.boostMode,
      openWindow: !!room.openWindow,
      connected: room.connection?.state ? room.connection.state === 'CONNECTED' : null,
      away: !!room.awayMode,
      holiday: !!room.holidayMode,
      next: room.nextScheduleChange?.start ? {                // volgende wissel in het schema
        start: room.nextScheduleChange.start,
        power: room.nextScheduleChange.setting?.power ?? null,
        target: room.nextScheduleChange.setting?.temperature?.value ?? null,
      } : null,
    })),
    raw: rooms,
  };
  // Ketel: Tado X geeft geen aparte ketelstatus; de hoogste stookvraag van de ruimtes is wat de ketel doet
  data.boiler = { heating: Math.max(0, ...data.rooms.map(x => x.heating || 0)) };

  await env.TADO_KV.put('data', JSON.stringify(data));
  return data;
}

async function markError(env, msg) {
  const cached = await env.TADO_KV.get('data', 'json');
  if (cached) { cached.error = msg; cached.errorAt = new Date().toISOString(); await env.TADO_KV.put('data', JSON.stringify(cached)); }
}

async function getHomeId(env, token) {
  let id = await env.TADO_KV.get('home_id');
  if (id) return id;
  const r = await fetch('https://my.tado.com/api/v2/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Tado /me: HTTP ${r.status}`);
  const me = await r.json();
  id = String(me.homes?.[0]?.id ?? '');
  if (!id) throw new Error('geen Tado-woning gevonden in dit account');
  await env.TADO_KV.put('home_id', id);
  return id;
}

// ─── Tokens ──────────────────────────────────────────────────────────

// Tado draait het refresh-token bij elk gebruik om; het nieuwe moet dus meteen bewaard worden.
async function accessToken(env) {
  const refresh = await env.TADO_KV.get('refresh_token');
  if (!refresh) throw new Error('nog niet gekoppeld, open /setup');
  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  if (!r.access_token) {
    await markError(env, `token vernieuwen mislukt (${r.error || 'onbekend'}) — opnieuw koppelen via /setup`);
    throw new Error(`token vernieuwen mislukt: ${r.error} ${r.error_description || ''}`);
  }
  await env.TADO_KV.put('refresh_token', r.refresh_token);
  return r.access_token;
}

async function tokenRequest(params) {
  const r = await fetch(`${LOGIN}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  return r.json();
}

// ─── Eenmalig koppelen (device-flow) ─────────────────────────────────

async function setupStart(env, url) {
  const r = await fetch(`${LOGIN}/device_authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'offline_access' }),
  });
  const d = await r.json();
  if (!d.device_code) throw new Error('Tado gaf geen koppelcode: ' + JSON.stringify(d));
  await env.TADO_KV.put('device_code', d.device_code, { expirationTtl: Math.max(60, d.expires_in || 300) });

  const check = `/setup/check?key=${encodeURIComponent(url.searchParams.get('key'))}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tado koppelen</title>
<body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px;line-height:1.5">
<h2>Tado koppelen aan het keukendashboard</h2>
<ol>
  <li>Open <a href="${d.verification_uri_complete}" target="_blank" rel="noopener">deze Tado-inlogpagina</a> en log in.</li>
  <li>Controleer dat de code <b style="font-size:1.3em;letter-spacing:.1em">${d.user_code}</b> getoond wordt en bevestig.</li>
  <li>Laat dit tabblad open; het gaat vanzelf verder. (Code is ${Math.round((d.expires_in || 300) / 60)} minuten geldig.)</li>
</ol>
<p id="s">Wachten op bevestiging…</p>
<script>
const s = document.getElementById('s');
async function poll() {
  const r = await fetch(${JSON.stringify(check)}); const j = await r.json();
  if (j.ok) { s.innerHTML = '✅ Gekoppeld! ' + (j.rooms ? j.rooms + ' ruimte(s) gevonden. ' : '') + 'Je kunt dit tabblad sluiten.'; return; }
  if (j.pending) { setTimeout(poll, ${(d.interval || 5) * 1000}); return; }
  s.textContent = '❌ ' + (j.error || 'mislukt') + ' — herlaad deze pagina om opnieuw te proberen.';
}
setTimeout(poll, ${(d.interval || 5) * 1000});
</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function setupCheck(env) {
  const deviceCode = await env.TADO_KV.get('device_code');
  if (!deviceCode) return json({ error: 'koppelcode verlopen' });
  const r = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  if (r.error === 'authorization_pending' || r.error === 'slow_down') return json({ pending: true });
  if (!r.refresh_token) return json({ error: r.error_description || r.error || 'onbekende fout' });

  await env.TADO_KV.put('refresh_token', r.refresh_token);
  await env.TADO_KV.delete('device_code');
  await env.TADO_KV.delete('home_id'); // ander account kan een andere woning hebben
  try {
    const data = await update(env);
    return json({ ok: true, rooms: data.rooms.length });
  } catch (e) {
    return json({ ok: true, warning: String(e?.message || e) });
  }
}

// ─── Hulpjes ─────────────────────────────────────────────────────────

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() } });
}
