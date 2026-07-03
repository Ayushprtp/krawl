import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fstatic from "@fastify/static";
import httpProxy from "http-proxy";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, steelBaseUrl } from "./config.js";
import { q } from "./db/pool.js";
import {
  generateApiKey,
  sha256,
  signSession,
  verifyPassword,
  verifySession,
} from "./auth/util.js";
import { allocateContainer, fleetHealth } from "./fleet/pool.js";
import { createSteelSession, releaseSteelSession } from "./fleet/steel.js";
import { runAgent, observe } from "./agent/loop.js";
import { liveViewHtml, resolveCastTarget } from "./proxy/liveview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, trustProxy: true });

await app.register(cookie);
await app.register(formbody);
await app.register(fstatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/static/",
});

// ---- auth helpers ----
const isAdmin = (req: any) => !!verifySession(req.cookies?.fc_admin);

const requireApiKey = async (req: any, reply: any) => {
  const auth = req.headers["authorization"] || "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!raw) {
    reply.code(401).send({ error: "Missing API key" });
    return null;
  }
  const r = await q<{ id: number; concurrency: number; enabled: boolean }>(
    `SELECT id, concurrency, enabled FROM api_keys WHERE key_hash = $1`,
    [sha256(raw)],
  );
  const key = r.rows[0];
  if (!key || !key.enabled) {
    reply.code(401).send({ error: "Invalid API key" });
    return null;
  }
  await q(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [key.id]);
  return key;
};

const enforceConcurrency = async (keyId: number, limit: number, reply: any) => {
  const r = await q<{ n: string }>(
    `SELECT count(*) n FROM sessions WHERE api_key_id = $1 AND status = 'live'`,
    [keyId],
  );
  if (Number(r.rows[0].n) >= limit) {
    reply
      .code(429)
      .send({ error: `Concurrency limit reached (${limit} live sessions)` });
    return false;
  }
  return true;
};

const publicLiveUrl = (sessionId: string) =>
  `${config.publicBaseUrl}/live/${sessionId}`;

// ---- health ----
app.get("/health", async () => ({ ok: true }));
app.get("/", async (_req, reply) => reply.redirect("/admin"));

// ---- admin auth ----
app.post("/admin/login", async (req: any, reply) => {
  const { email, password } = (req.body || {}) as any;
  if (
    email === config.admin.email &&
    config.admin.passwordHash &&
    verifyPassword(password || "", config.admin.passwordHash)
  ) {
    reply.setCookie("fc_admin", signSession(email), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: config.publicBaseUrl.startsWith("https"),
      maxAge: 12 * 3600,
    });
    return { ok: true };
  }
  reply.code(401).send({ error: "Invalid credentials" });
});

app.post("/admin/logout", async (_req, reply) => {
  reply.clearCookie("fc_admin", { path: "/" });
  return { ok: true };
});

app.get("/admin", async (_req, reply) => {
  reply.type("text/html").send(adminPage());
});

// ---- admin API ----
const adminGuard = (req: any, reply: any) => {
  if (!isAdmin(req)) {
    reply.code(401).send({ error: "admin auth required" });
    return false;
  }
  return true;
};

app.get("/admin/api/keys", async (req: any, reply) => {
  if (!adminGuard(req, reply)) return;
  const r = await q(
    `SELECT id, name, key_prefix, concurrency, enabled, created_at, last_used_at FROM api_keys ORDER BY id DESC`,
  );
  return r.rows;
});

app.post("/admin/api/keys", async (req: any, reply) => {
  if (!adminGuard(req, reply)) return;
  const { name, concurrency } = (req.body || {}) as any;
  const { key, prefix, hash } = generateApiKey();
  const r = await q<{ id: number }>(
    `INSERT INTO api_keys (name, key_prefix, key_hash, concurrency) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name || "key", prefix, hash, Number(concurrency) || 3],
  );
  return { id: r.rows[0].id, key }; // full key shown once
});

app.delete("/admin/api/keys/:id", async (req: any, reply) => {
  if (!adminGuard(req, reply)) return;
  await q(`DELETE FROM api_keys WHERE id = $1`, [Number(req.params.id)]);
  return { ok: true };
});

app.get("/admin/api/fleet", async (req: any, reply) => {
  if (!adminGuard(req, reply)) return;
  const health = await fleetHealth();
  const live = await q<{ n: string }>(
    `SELECT count(*) n FROM sessions WHERE status='live'`,
  );
  return {
    ...health,
    liveSessions: Number(live.rows[0].n),
    portStart: config.fleet.portStart,
    portEnd: config.fleet.portEnd,
  };
});

app.get("/admin/api/sessions", async (req: any, reply) => {
  if (!adminGuard(req, reply)) return;
  const r = await q(
    `SELECT s.id, s.status, s.container_idx, s.task, s.current_url, s.page_title, s.created_at, k.name key_name
     FROM sessions s LEFT JOIN api_keys k ON k.id=s.api_key_id
     ORDER BY s.created_at DESC LIMIT 50`,
  );
  return r.rows;
});

// ---- public API (key-authed) ----
const connectPage = async (websocketUrl: string) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(websocketUrl, { timeout: 20000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { browser, page };
};

const openSession = async (keyId: number, task?: string) => {
  const index = await allocateContainer();
  const s = await createSteelSession(index);
  const r = await q<{ id: string }>(
    `INSERT INTO sessions (id, api_key_id, container_idx, steel_id, status, task)
     VALUES (gen_random_uuid(), $1, $2, $3, 'live', $4) RETURNING id`,
    [keyId, index, s.id, task || null],
  );
  await q(
    `INSERT INTO usage_events (api_key_id, session_id, kind) VALUES ($1,$2,'session_create')`,
    [keyId, r.rows[0].id],
  );
  return { sessionId: r.rows[0].id, index, steel: s };
};

app.post("/v1/sessions", async (req: any, reply) => {
  const key = await requireApiKey(req, reply);
  if (!key) return;
  if (!(await enforceConcurrency(key.id, key.concurrency, reply))) return;
  const { sessionId, steel } = await openSession(key.id);
  return {
    sessionId,
    liveViewUrl: publicLiveUrl(sessionId),
    websocketUrl: steel.websocketUrl,
  };
});

app.post("/v1/agent", async (req: any, reply) => {
  const key = await requireApiKey(req, reply);
  if (!key) return;
  const { task, startUrl, maxSteps, sessionId: reuseId } = (req.body || {}) as any;
  if (!task) {
    reply.code(400).send({ error: "task is required" });
    return;
  }

  let sessionId = reuseId as string | undefined;
  let index: number;
  let websocketUrl: string;

  if (sessionId) {
    const row = await q<{ container_idx: number; steel_id: string }>(
      `SELECT container_idx, steel_id FROM sessions WHERE id=$1 AND status='live'`,
      [sessionId],
    );
    if (!row.rows[0]) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    index = row.rows[0].container_idx;
    websocketUrl = steelBaseUrl(index).replace("http", "ws") + "/";
  } else {
    if (!(await enforceConcurrency(key.id, key.concurrency, reply))) return;
    const opened = await openSession(key.id, task);
    sessionId = opened.sessionId;
    index = opened.index;
    websocketUrl = opened.steel.websocketUrl;
  }

  const { browser, page } = await connectPage(websocketUrl);
  try {
    const { summary, steps } = await runAgent({
      page,
      task,
      startUrl: reuseId ? undefined : startUrl,
      maxSteps: Number(maxSteps) || undefined,
    });
    const obs = await observe(page);
    await q(
      `UPDATE sessions SET current_url=$1, page_title=$2 WHERE id=$3`,
      [obs.url, obs.title, sessionId],
    );
    await q(
      `INSERT INTO usage_events (api_key_id, session_id, kind, meta) VALUES ($1,$2,'agent_done',$3)`,
      [key.id, sessionId, JSON.stringify({ steps: steps.length })],
    );
    return {
      sessionId,
      liveViewUrl: publicLiveUrl(sessionId!),
      summary,
      steps,
      currentUrl: obs.url,
      pageTitle: obs.title,
    };
  } finally {
    await browser.close().catch(() => {});
  }
});

app.post("/v1/sessions/:id/release", async (req: any, reply) => {
  const key = await requireApiKey(req, reply);
  if (!key) return;
  const row = await q<{ container_idx: number; steel_id: string }>(
    `SELECT container_idx, steel_id FROM sessions WHERE id=$1 AND api_key_id=$2`,
    [req.params.id, key.id],
  );
  if (row.rows[0]) {
    await releaseSteelSession(row.rows[0].container_idx, row.rows[0].steel_id);
    await q(
      `UPDATE sessions SET status='released', released_at=now() WHERE id=$1`,
      [req.params.id],
    );
  }
  return { ok: true };
});

// ---- live view page ----
app.get("/live/:sessionId", async (req: any, reply) => {
  reply.type("text/html").send(liveViewHtml(req.params.sessionId));
});

// ---- WS proxy for the cast stream ----
const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on("error", (err) => app.log.error({ err }, "cast proxy error"));

app.server.on("upgrade", async (req, socket, head) => {
  const m = (req.url || "").match(/^\/live\/([^/]+)\/cast/);
  if (!m) return; // let other upgrade handlers (if any) deal with it
  const target = await resolveCastTarget(m[1]);
  if (!target) {
    socket.destroy();
    return;
  }
  // Steel's WS registry matches on url.startsWith("/v1/sessions/cast"); the
  // session id in the path is ignored (single-session per container). pageIndex
  // is required or it enters tab-discovery mode and streams no frames.
  req.url = `/v1/sessions/cast?pageIndex=0`;
  proxy.ws(req, socket, head, {
    target: `ws://${config.fleet.host}:${target.port}`,
  });
});

// ---- minimal admin UI ----
function adminPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlareCrawl Admin</title>
<style>body{font:14px system-ui;margin:0;background:#0b0b0f;color:#eee}header{padding:14px 20px;background:#15151c;font-weight:600}main{padding:20px;max-width:900px;margin:auto}input,button{font:14px system-ui;padding:8px;border-radius:6px;border:1px solid #333;background:#1b1b24;color:#eee}button{cursor:pointer;background:#2b6cff;border:0}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border-bottom:1px solid #222;padding:8px;text-align:left}.card{background:#14141b;padding:16px;border-radius:10px;margin-bottom:16px}code{background:#000;padding:2px 6px;border-radius:4px}</style></head>
<body><header>🔥 FlareCrawl — Admin</header><main>
<div id="login" class="card"><h3>Admin login</h3><input id="email" placeholder="email" value="${config.admin.email}"> <input id="pw" type="password" placeholder="password"> <button onclick="login()">Login</button></div>
<div id="app" style="display:none">
 <div class="card"><b>Fleet</b> <span id="fleet"></span></div>
 <div class="card"><h3>API keys</h3><input id="kn" placeholder="name"> <input id="kc" type="number" value="3" style="width:70px" title="concurrency"> <button onclick="mk()">Create key</button><div id="newkey"></div><table id="keys"></table></div>
 <div class="card"><h3>Recent sessions</h3><table id="sess"></table></div>
</div>
<script>
const j=(u,o)=>fetch(u,Object.assign({headers:{'Content-Type':'application/json'}},o)).then(r=>r.json());
async function login(){const r=await j('/admin/login',{method:'POST',body:JSON.stringify({email:email.value,password:pw.value})});if(r.ok){show()}else alert('bad login')}
async function show(){login_.style.display='none';app.style.display='';load()}
const login_=document.getElementById('login');
async function load(){
 const f=await j('/admin/api/fleet');document.getElementById('fleet').textContent='healthy '+f.healthy+'/'+f.total+' · live '+f.liveSessions+' · ports '+f.portStart+'-'+f.portEnd;
 const ks=await j('/admin/api/keys');document.getElementById('keys').innerHTML='<tr><th>name</th><th>prefix</th><th>concurrency</th><th></th></tr>'+ks.map(k=>'<tr><td>'+k.name+'</td><td><code>'+k.key_prefix+'…</code></td><td>'+k.concurrency+'</td><td><button onclick=del('+k.id+')>del</button></td></tr>').join('');
 const ss=await j('/admin/api/sessions');document.getElementById('sess').innerHTML='<tr><th>status</th><th>key</th><th>task</th><th>url</th></tr>'+ss.map(s=>'<tr><td>'+s.status+'</td><td>'+(s.key_name||'')+'</td><td>'+(s.task||'').slice(0,40)+'</td><td>'+(s.current_url||'').slice(0,50)+'</td></tr>').join('');
}
async function mk(){const r=await j('/admin/api/keys',{method:'POST',body:JSON.stringify({name:kn.value,concurrency:+kc.value})});document.getElementById('newkey').innerHTML='<p>New key (copy now): <code>'+r.key+'</code></p>';load()}
async function del(id){if(confirm('delete key?')){await fetch('/admin/api/keys/'+id,{method:'DELETE'});load()}}
j('/admin/api/fleet').then(r=>{if(!r.error)show()}).catch(()=>{});
</script></main></body></html>`;
}

app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  app.log.info(`FlareCrawl gateway on :${config.port} (${config.publicBaseUrl})`);
});

// ---- idle session cleanup (runs every 5 min, releases Steel + DB) ----
const IDLE_MIN = config.sessionIdleTimeoutMin;
app.log.info(`session idle timeout = ${IDLE_MIN} min`);
setInterval(async () => {
  try {
    const rows = await q<{ id: string; container_idx: number; steel_id: string }>(
      `SELECT id, container_idx, steel_id FROM sessions
       WHERE status='live' AND created_at < now() - interval '${IDLE_MIN} minutes'`,
    );
    for (const r of rows) {
      await releaseSteelSession(r.container_idx, r.steel_id);
      await q(`UPDATE sessions SET status='released', released_at=now() WHERE id=$1`, [r.id]);
      app.log.warn({ sessionId: r.id, container: r.container_idx }, "released idle session");
    }
    if (rows.length) app.log.info(`cleanup: released ${rows.length} idle sessions`);
  } catch (e: any) {
    app.log.error({ err: e.message }, "idle cleanup cycle failed");
  }
}, 5 * 60 * 1000);
