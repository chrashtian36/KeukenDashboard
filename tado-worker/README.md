# Tado X → keukendashboard

Een kleine Cloudflare Worker die de gegevens van de Tado X ophaalt en klaarzet voor het dashboard.
Het dashboard kan Tado niet rechtstreeks aanroepen, omdat Tado alleen verzoeken van app.tado.com toelaat.

## Eenmalig instellen (via het Cloudflare-dashboard)

1. Maak een gratis account aan op <https://dash.cloudflare.com>.
2. **KV-opslag:** ga naar *Storage & Databases → KV* en klik **Create**. Noem het bijvoorbeeld `tado`.
3. **Worker:** ga naar *Compute (Workers) → Create → Start with Hello World*. Noem hem `keuken-tado` en klik **Deploy**.
4. Klik **Edit code**, vervang alles door de inhoud van `worker.js` en klik **Deploy**.
5. Open in de Worker het tabblad **Settings** en stel daar in:
   - **Bindings → Add → KV namespace**: variabelenaam `TADO_KV`, kies de KV-opslag uit stap 2.
   - **Variables and Secrets → Add**: type *Secret*, naam `KEY`, waarde: zelfgekozen lang wachtwoord.
   - **Trigger events → Add → Cron trigger**: `*/20 * * * *` (elke 20 minuten).
6. Open `https://keuken-tado.<jouw-subdomein>.workers.dev/setup?key=<KEY>`. Log in bij Tado en bevestig de code.
   De pagina meldt "Gekoppeld!" en meteen daarna staan de eerste gegevens klaar.
7. Ga op de iPad naar het dashboard → ⚙ en vul in:
   - **Tado Worker URL:** `https://keuken-tado.<jouw-subdomein>.workers.dev`
   - **Tado sleutel:** de `KEY` uit stap 5

## Goed om te weten

- **Daglimiet:** Tado noemt ±100 verzoeken per dag zonder Auto-Assist, maar dit account kreeg er ±1000
  (zie `quota` in de JSON: `r=` is wat er vandaag nog over is). Elke 20 minuten kost 72 per dag;
  `*/5 * * * *` kost 288 en past dus ook.
- **Ketel:** Tado X heeft geen aparte ketelstatus. Het dashboard toont de hoogste stookvraag van alle ruimtes.
  Dat is wat de ketel op dat moment doet.
- **Opnieuw koppelen:** blijft de Worker langer dan ongeveer 30 dagen uit, of wijzig je je Tado-wachtwoord,
  dan open je stap 6 opnieuw. Het dashboard meldt dit vanzelf.
- **Controle:** `/?key=<KEY>` toont de opgeslagen gegevens. `/?key=<KEY>&raw=1` toont ook de ruwe Tado-respons.
  `/refresh?key=<KEY>` haalt de gegevens direct op en kost één verzoek.
