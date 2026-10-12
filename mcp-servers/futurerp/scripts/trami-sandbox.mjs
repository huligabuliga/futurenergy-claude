// Trami sandbox: the MCP server with the write tools against the LOCAL stack,
// OpenWA and Google mocked, and a "Trami" user with tramites.manage. Keeps
// running until killed so a person (or a model) can drive the tools with
// scripts/trami-call.mjs and inspect what would have left the building.
//
//   SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/trami-sandbox.mjs <outdir>
//
// Writes <outdir>/sandbox.json (url, token, ids) and appends every mocked
// outbound call to <outdir>/openwa.jsonl and <outdir>/gmail.jsonl.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || resolve(here, "../.sandbox"); mkdirSync(OUT, { recursive: true });
const SB = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!PUB || !SVC) { console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (local)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(SB)) { console.error(`Refusing to run against ${SB}: local only.`); process.exit(2); }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const j = async (u, i = {}) => { const r = await fetch(u, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const rest = (path, { headers, ...init } = {}) => j(`${SB}/rest/v1${path}`, { ...init, headers: { ...H, Prefer: "return=representation", ...(headers || {}) } });
const log = (f, o) => appendFileSync(resolve(OUT, f), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");

// ── mocks ───────────────────────────────────────────────────────────────────
const OPENWA_PORT = 3212, GOOGLE_PORT = 3213, PORT = 3211;
const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
let n = 0;
const openwaMock = createServer(async (req, res) => {
  const body = await readBody(req); n++;
  log("openwa.jsonl", { url: req.url, body: body ? JSON.parse(body) : null });
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ messageId: `wamid.sandbox.${n}` }));
});
const googleMock = createServer(async (req, res) => {
  const body = await readBody(req); res.setHeader("content-type", "application/json");
  if (req.url === "/token") return res.end(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }));
  if (req.url.startsWith("/gmail/v1/users/me/messages?")) return res.end(JSON.stringify({ messages: [] }));
  if (req.url.startsWith("/upload/gmail/v1/users/me/drafts")) {
    // raw = base64url RFC822; decode the headers + text part for the log
    let decoded = ""; try { const m = JSON.parse(body); decoded = Buffer.from(m.raw ?? "", "base64url").toString("utf8"); } catch { decoded = body.slice(0, 4000); }
    log("gmail.jsonl", { raw_bytes: body.length, headers: decoded.split("\r\n\r\n")[0], text: (decoded.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/) || [])[1]?.slice(0, 3000), attachments: [...decoded.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]) });
    return res.end(JSON.stringify({ id: `sent_${Date.now()}` }));
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: `mock ${req.url}` }));
});
await new Promise((r) => openwaMock.listen(OPENWA_PORT, "127.0.0.1", r));
await new Promise((r) => googleMock.listen(GOOGLE_PORT, "127.0.0.1", r));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_JSON = JSON.stringify({ client_email: "trami-sa@mock.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

// ── Trami user: NOT admin; tramites.manage through a crm role like prod ─────
const email = "trami-sandbox@futurenergy.mx", PASS = "Sb-" + randomBytes(6).toString("hex");
let userId = (await j(`${SB}/rest/v1/profiles?email=eq.${email}&select=user_id`, { headers: H })).b?.[0]?.user_id;
if (userId) { await j(`${SB}/auth/v1/admin/users/${userId}`, { method: "PUT", headers: H, body: JSON.stringify({ password: PASS }) }); }
else {
  userId = (await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password: PASS, email_confirm: true }) })).b.id;
  await j(`${SB}/rest/v1/profiles?on_conflict=user_id`, { method: "POST", headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: userId, email, first_name: "Trami", last_name: "Sandbox", is_active: true, is_admin: false, department: "Operaciones" }) });
}
const role = (await rest("/crm_roles?select=id,name,permissions&permissions=cs." + encodeURIComponent('{"tramites.manage":true}') + "&limit=1")).b?.[0];
if (!role) { console.error("no crm role with tramites.manage locally"); process.exit(2); }
await j(`${SB}/rest/v1/user_crm_roles?on_conflict=user_id,role_id`, { method: "POST", headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: userId, role_id: role.id }) });
let channel = (await rest(`/whatsapp_channels?vendor_user_id=eq.${userId}&select=id`)).b?.[0]?.id;
if (!channel) channel = (await rest("/whatsapp_channels", { method: "POST", body: JSON.stringify({ session_id: "trami-sandbox", session_name: "trami-sandbox", label: "Trami (sandbox)", phone: "5218100000000", vendor_user_id: userId, connection_status: "ready" }) })).b?.[0]?.id;
const pv = (await rest("/system_config?config_key=eq.postventa_approvers&select=config_value")).b?.[0]?.config_value;
const list = (() => { try { return JSON.parse(pv ?? "[]"); } catch { return []; } })();
if (!list.includes(email)) await rest("/system_config?config_key=eq.postventa_approvers", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ config_value: JSON.stringify([...list, email]) }) });

// Mode: TRAMI_MODE=live writes for real; default shadow records intentions only.
await rest("/system_config?config_key=eq.trami_mode", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ config_value: process.env.TRAMI_MODE === "live" ? "live" : "shadow" }) });

// ── server ──────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, [resolve(here, "../dist/index.js")], {
  env: { ...process.env, OPENWA_API_URL: `http://127.0.0.1:${OPENWA_PORT}`, OPENWA_API_KEY: "openwa-sandbox", TRAMI_GMAIL_SERVICE_ACCOUNT: SA_JSON, TRAMI_MAILBOX: "tramites@futurenergy.mx", GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`, GMAIL_API_BASE: `http://127.0.0.1:${GOOGLE_PORT}`, SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SERVICE_ROLE_KEY: SVC, PORT: String(PORT), MCP_PUBLIC_URL: `http://localhost:${PORT}/mcp`, MCP_SKIP_AS_METADATA: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
const token = (await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).b.access_token;
writeFileSync(resolve(OUT, "sandbox.json"), JSON.stringify({ mcp: `http://localhost:${PORT}/mcp`, token, userId, email, channel, role: role.name, sb: SB, serviceKey: SVC }, null, 2));
console.log(`trami sandbox up: mcp http://localhost:${PORT}/mcp · user ${email} (${role.name}) · channel ${channel} · out ${OUT}`);
const bye = () => { child.kill(); process.exit(0); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);
