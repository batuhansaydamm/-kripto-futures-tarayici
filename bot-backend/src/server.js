import { createServer } from "node:http";

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const html = `<!doctype html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#080b10"><title>V13.2 Bot</title>
<style>
:root{color-scheme:dark;--bg:#080b10;--panel:#111722;--line:#283244;--text:#edf2f7;--dim:#8792a5;--green:#25d07f;--red:#ff5268;--amber:#ffb238;--cyan:#22c7e6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:env(safe-area-inset-top) 14px env(safe-area-inset-bottom)}
main{max-width:760px;margin:auto}.head{padding:24px 4px 18px}.eyebrow{color:var(--cyan);font:700 11px ui-monospace;letter-spacing:.08em}.head h1{font-size:24px;margin:8px 0}.dim{color:var(--dim)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.stat{border:1px solid var(--line);border-radius:10px;padding:11px;color:var(--dim);font-size:11px}.stat b{display:block;color:var(--text);font-size:18px;margin-top:5px}
input,button{width:100%;border-radius:10px;padding:13px;font:700 13px ui-monospace}input{background:#090d14;color:var(--text);border:1px solid var(--line)}button{border:0;background:var(--cyan);color:#031317;margin-top:9px}button.secondary{background:#222a38;color:var(--text)}button.danger{background:var(--red);color:white}.row{display:grid;grid-template-columns:1fr 1fr;gap:9px}.pill{display:inline-block;padding:7px 9px;border-radius:8px;background:#202838;color:var(--dim);font:700 11px ui-monospace}.pill.on{background:#123a28;color:var(--green)}.pill.kill{background:#401820;color:#ff8b9b}
pre{white-space:pre-wrap;word-break:break-word;color:var(--dim);font:11px/1.55 ui-monospace;margin:0}.error{color:#ff8b9b}.good{color:var(--green)}@media(min-width:600px){.grid{grid-template-columns:repeat(4,1fr)}}
</style></head><body><main>
<div class="head"><div class="eyebrow">V13.2 · BINANCE FUTURES TESTNET</div><h1>Bot Kontrol Paneli</h1><div class="dim">50 USDT · x10 · isolated · toplam 5 işlem · eşzamanlı 1</div></div>
<div class="card" id="login"><b>Panel anahtarı</b><input id="token" type="password" autocomplete="current-password" placeholder="DASHBOARD_TOKEN"><button onclick="connect()">BAĞLAN</button></div>
<div id="app" hidden>
 <div class="card"><span class="pill" id="mode"></span> <span class="pill" id="enabled"></span> <span class="pill" id="kill"></span></div>
 <div class="grid">
  <div class="stat">İŞLEM<b id="trades">—</b></div><div class="stat">AÇIK POZİSYON<b id="open">—</b></div>
  <div class="stat">ARDIŞIK ZARAR<b id="losses">—</b></div><div class="stat">GÜNLÜK PNL<b id="pnl">—</b></div>
 </div>
 <div class="card"><b>Son aday</b><pre id="candidate">—</pre></div>
 <div class="card"><b>Açık işlem / kanıt</b><pre id="trade">—</pre></div>
 <div class="card"><b>Son hata</b><pre class="error" id="error">Yok</pre></div>
 <div class="card"><div class="row"><button onclick="control(true)">BOTU AÇ</button><button class="secondary" onclick="control(false)">BOTU KAPAT</button></div><button class="secondary" onclick="scan()">ŞİMDİ TARA</button><button class="danger" onclick="kill()">ACİL DURDUR</button></div>
 <div class="card"><b>Son olaylar</b><pre id="events">—</pre></div>
</div>
</main><script>
let key=localStorage.getItem("v132_token")||"";token.value=key;
async function api(path,options={}){const r=await fetch(path,{...options,headers:{"content-type":"application/json","x-dashboard-token":key,...options.headers}});const j=await r.json();if(!r.ok)throw Error(j.error||"HTTP "+r.status);return j}
async function connect(){key=token.value.trim();localStorage.setItem("v132_token",key);await refresh();login.hidden=true;app.hidden=false}
async function refresh(){try{const x=await api("/api/status");mode.textContent=x.config.dryRun?"DRY-RUN":"TESTNET EMİR";mode.className="pill "+(x.config.dryRun?"":"on");enabled.textContent=x.state.enabled?"BOT AÇIK":"BOT KAPALI";enabled.className="pill "+(x.state.enabled?"on":"");kill.textContent=x.state.killSwitch?"KILL SWITCH":"KORUMA NORMAL";kill.className="pill "+(x.state.killSwitch?"kill":"on");trades.textContent=x.state.totalTrades+"/5";open.textContent=x.state.openTrade?"1/1":"0/1";losses.textContent=x.state.consecutiveLosses+"/2";pnl.textContent=Number(x.state.daily.realizedPnl||0).toFixed(2)+" USDT";candidate.textContent=JSON.stringify(x.state.lastCandidate,null,2);trade.textContent=JSON.stringify(x.state.openTrade,null,2);error.textContent=x.state.lastError||"Yok";events.textContent=x.state.events.slice(-15).reverse().map(e=>new Date(e.at).toLocaleString("tr-TR")+" · "+e.type+" "+JSON.stringify(e)).join("\\n")}catch(e){alert(e.message)}}
async function control(enabled){await api("/api/control",{method:"POST",body:JSON.stringify({enabled})});refresh()}
async function scan(){const x=await api("/api/scan",{method:"POST",body:"{}"});alert(x.result?.candidate?"Aday: "+x.result.candidate.symbol+" "+x.result.candidate.side:"Uygun aday yok");refresh()}
async function kill(){if(!confirm("Botu acil durdurmak istediğine emin misin?"))return;await api("/api/kill",{method:"POST",body:JSON.stringify({reason:"iPhone paneli"})});refresh()}
if(key)connect().catch(()=>{});setInterval(()=>{if(!app.hidden)refresh()},15000);
</script></body></html>`;

function publicState(store, config, busy) {
  return {
    config: {
      dryRun: config.dryRun,
      baseUrl: config.baseUrl,
      marginUsdt: config.marginUsdt,
      leverage: config.leverage,
      maxTotalTrades: config.maxTotalTrades,
      maxOpenPositions: config.maxOpenPositions,
    },
    busy,
    state: store.state,
  };
}

export function startServer({ bot, store, config }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, {
        ok: true,
        engine: "V13.2_STRUCTURE_EXECUTION",
        dryRun: config.dryRun,
      });
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(html);
    }
    if (req.headers["x-dashboard-token"] !== config.dashboardToken)
      return json(res, 401, { error: "Panel anahtarı geçersiz" });
    try {
      if (req.method === "GET" && url.pathname === "/api/status")
        return json(res, 200, publicState(store, config, bot.busy));
      if (req.method === "POST" && url.pathname === "/api/scan") {
        const result = await bot.cycle({ forceScan: true });
        return json(res, 200, { ok: true, result });
      }
      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readJson(req);
        await bot.setEnabled(Boolean(body.enabled));
        return json(res, 200, { ok: true, enabled: store.state.enabled });
      }
      if (req.method === "POST" && url.pathname === "/api/kill") {
        const body = await readJson(req);
        await bot.kill(body.reason || "Panelden durduruldu");
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Bulunamadı" });
    } catch (error) {
      return json(res, 500, {
        error: error.message,
        emergency: error.emergency || null,
      });
    }
  });
  server.listen(config.port);
  return server;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 32_000)
    throw new Error("İstek çok büyük");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
