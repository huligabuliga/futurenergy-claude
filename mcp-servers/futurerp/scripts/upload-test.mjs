// futurerp_upload_file (src/uploads.ts) against a LOCAL Supabase, through the running server.
// Needs, from pronto-resolver-61: the firebase-token function served locally
//   npx supabase functions serve firebase-token --no-verify-jwt --env-file supabase/functions/.env
// and the Firebase Auth + Storage emulators (the real storage rules), e.g.
//   firebase emulators:start --only auth,storage --project tickets-futurenergy  (auth on :9099)
// (the Auth emulator is strict: firebase-token must emit base64url JWT segments; on 2026-10-23 it used
// plain btoa, so patch that locally if sign-in says "Invalid assertion format")
// with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 set
// here. Without those two vars the test hits the REAL bucket (it still deletes every blob it made).
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//   FIREBASE_API_KEY=… node scripts/upload-test.mjs
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!PUB || !SVC) { console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (local)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(SB)) { console.error(`Refusing to run against ${SB}: local only.`); process.exit(2); }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const PASS = "Up-" + randomBytes(6).toString("hex");
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? " — " + x : ""}`); if (!c) fails++; };
const j = async (u, i = {}) => { const r = await fetch(u, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const rest = (path, init = {}) => j(`${SB}/rest/v1${path}`, { ...init, headers: { ...H, Prefer: "return=representation", ...(init.headers || {}) } });

async function mkUser(email, { admin = false, roles = [] } = {}) {
  const u = (await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password: PASS, email_confirm: true }) })).b;
  await rest(`/profiles?on_conflict=user_id`, { method: "POST", headers: { Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: u.id, email, first_name: "Up", last_name: "Test", is_active: true, is_admin: admin, department: "Ventas" }) });
  for (const name of roles) {
    const r = (await rest(`/crm_roles?name=eq.${encodeURIComponent(name)}&select=id`)).b[0];
    if (!r) throw new Error(`role ${name} missing — apply the pronto migration 20261023170000_mcp_upload.sql locally`);
    await rest(`/user_crm_roles`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: u.id, role_id: r.id }) });
  }
  return u.id;
}
const rmUser = async (id) => { await rest(`/user_crm_roles?user_id=eq.${id}`, { method: "DELETE" }); await rest(`/profiles?user_id=eq.${id}`, { method: "DELETE" }); await j(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H }); };
const signIn = async (email) => (await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).b.access_token;

let MCP = process.env.MCP_URL, child;
if (!MCP) {
  const here = dirname(fileURLToPath(import.meta.url));
  child = spawn(process.execPath, [resolve(here, "../dist/index.js")], { env: { ...process.env, PORT: "3214", MCP_SKIP_AS_METADATA: "1", SUPABASE_URL: SB }, stdio: ["ignore", "ignore", "inherit"] });
  MCP = "http://127.0.0.1:3214/mcp";
  for (let i = 0; i < 50; i++) { try { await fetch(MCP); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
}
let rpcId = 1;
async function mcp(tok, method, params = {}) {
  const r = await j(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  let data = r.b; if (typeof r.b === "string") data = r.b.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop();
  return data;
}
async function tools(tok) { await mcp(tok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }); return ((await mcp(tok, "tools/list")).result?.tools || []).map((t) => t.name); }
async function call(tok, name, args) { const r = (await mcp(tok, "tools/call", { name, arguments: args })).result; return { text: r?.content?.[0]?.text ?? JSON.stringify(r), isError: !!r?.isError }; }


const FB_KEY = process.env.FIREBASE_API_KEY;
if (!FB_KEY) { console.error("Set FIREBASE_API_KEY (pronto .env VITE_FIREBASE_API_KEY)"); process.exit(2); }
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "tickets-futurenergy.firebasestorage.app";
const STORAGE = process.env.FIREBASE_STORAGE_EMULATOR_HOST ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}` : "https://firebasestorage.googleapis.com";
async function fbToken(tok) {
  const c = (await j(`${SB}/functions/v1/firebase-token`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, apikey: PUB } })).b.token;
  const idt = process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";
  return (await j(`${idt}/v1/accounts:signInWithCustomToken?key=${FB_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: c, returnSecureToken: true }) })).b.idToken;
}
const blobs = []; // [path, firebaseIdToken]
const b64 = (s) => Buffer.from(s).toString("base64");

const users = [], leads = [], fileRows = [], activityRows = [];
try {
  const s = randomBytes(3).toString("hex");
  const eU = `up-uploader-${s}@futurenergy.mx`, eW = `up-writer-${s}@futurenergy.mx`, eA = `up-admin-${s}@futurenergy.mx`, eP = `up-plain-${s}@futurenergy.mx`;
  const uploader = await mkUser(eU, { roles: ["Vendedor", "MCP Subir archivos"] });
  const writer = await mkUser(eW, { roles: ["Vendedor", "MCP Escritura"] });
  const plain = await mkUser(eP, { roles: ["Vendedor"] });
  const admin = await mkUser(eA, { admin: true });
  users.push(uploader, writer, plain, admin);
  const mine = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Propio", last_name: `Up ${s}`, assigned_to: uploader, created_by: uploader }) })).b[0];
  const other = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Ajeno", last_name: `Up ${s}`, assigned_to: plain, created_by: plain }) })).b[0];
  if (!mine?.id || !other?.id) throw new Error("fixture leads: " + JSON.stringify({ uploader, plain, mine, other }).slice(0, 400));
  leads.push(mine.id, other.id);
  const [tU, tW, tA] = [await signIn(eU), await signIn(eW), await signIn(eA)];
  const fbU = await fbToken(tU), fbA = await fbToken(tA);
  ok(!!fbU && !!fbA, "test can mint Firebase sessions (firebase-token served locally)");

  console.log("# visibility");
  ok((await tools(tU)).includes("futurerp_upload_file"), "uploader (MCP Subir archivos) sees futurerp_upload_file");
  ok(!(await tools(tW)).includes("futurerp_upload_file"), "MCP Escritura alone does NOT see it");
  ok((await tools(tA)).includes("futurerp_upload_file"), "admin sees it (has_crm_permission admin pass)");

  console.log("\n# lead");
  let r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id, document_type: "otro" }, file_name: "prueba mcp.txt", base64: b64("hola desde el MCP") });
  let path = r.text.match(/Storage path: (\S+)/)?.[1];
  if (path) blobs.push([path, fbU]);
  ok(!r.isError && !!path, "uploader attaches a file to own lead", r.text.slice(0, 90));
  const lf = (await rest(`/lead_files?lead_id=eq.${mine.id}&select=*`)).b;
  fileRows.push(...lf.map((x) => ["lead_files", x.id]));
  ok(lf.length === 1 && lf[0].file_name === "prueba mcp.txt" && lf[0].mime_type === "text/plain" && lf[0].file_size === 17 && lf[0].firebase_url?.includes(encodeURIComponent(path)), "lead_files row has url, name, mime, size", JSON.stringify(lf[0] && { n: lf[0].file_name, m: lf[0].mime_type, z: lf[0].file_size }));
  ok(lf[0]?.created_by === uploader, "created_by = uploader (insert ran with the caller's token)");

  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: other.id }, file_name: "x.txt", base64: b64("no") });
  ok(r.isError && /removed again/.test(r.text), "someone else's lead: refused by RLS and the blob is deleted", r.text.slice(0, 140));
  ok((await rest(`/lead_files?lead_id=eq.${other.id}&select=id`)).b.length === 0, "no row on the other lead");

  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id }, file_name: "robots.txt", url: "https://www.google.com/robots.txt" });
  path = r.text.match(/Storage path: (\S+)/)?.[1];
  if (path) blobs.push([path, fbU]);
  ok(!r.isError && /robots\.txt \(\d+ KB\)/.test(r.text), "uploads from a public https URL", r.text.slice(0, 90));
  fileRows.push(...(await rest(`/lead_files?lead_id=eq.${mine.id}&file_name=eq.robots.txt&select=id`)).b.map((x) => ["lead_files", x.id]));

  console.log("\n# ticket (admin)");
  const ticket = (await rest(`/tickets?select=id&limit=1`)).b[0];
  r = await call(tA, "futurerp_upload_file", { table: "ticket_activities", values: { ticket_id: ticket.id }, file_name: "foto.png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" });
  path = r.text.match(/Storage path: (\S+)/)?.[1];
  if (path) blobs.push([path, fbA]);
  const actId = r.text.match(/row ([0-9a-f-]{36})/)?.[1];
  if (actId) activityRows.push(actId);
  const act = actId ? (await rest(`/ticket_activities?id=eq.${actId}&select=*`)).b[0] : null;
  const att = act?.metadata?.attachments?.[0];
  ok(!r.isError && act?.activity_type === "comment" && act?.user_id === admin && att?.is_image === true && att?.mime_type === "image/png" && att?.storage_path === path, "ticket comment carries metadata.attachments", r.text.slice(0, 90));

  console.log("\n# guardrails");
  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id }, file_name: "IMG_1.HEIC", base64: b64("x") });
  ok(r.isError && /HEIC/.test(r.text), "HEIC refused");
  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id }, file_name: "a.pdf", url: "http://example.com/a.pdf" });
  ok(r.isError && /https/.test(r.text), "http:// refused");
  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id }, file_name: "a.pdf", url: "https://localhost/a.pdf" });
  ok(r.isError && /not a public address/.test(r.text), "loopback host refused (SSRF)", r.text.slice(0, 90));
  r = await call(tU, "futurerp_upload_file", { table: "leads", values: {}, file_name: "a.txt", base64: b64("x") });
  ok(r.isError && /no file column/.test(r.text), "table without a file column refused");
  r = await call(tU, "futurerp_upload_file", { table: "lead_files", values: { lead_id: mine.id, created_by: admin }, file_name: "a.txt", base64: b64("x") });
  ok(r.isError && /created_by/.test(r.text) && !/removed/.test(r.text), "audit column refused BEFORE uploading");
  ok((await rest(`/mcp_write_log?user_id=eq.${uploader}&select=op,table_name`)).b.length === 2, "one ledger row per successful upload");
} catch (e) { console.error("ERROR", e); fails++; }
finally {
  for (const [t, id] of fileRows) await rest(`/${t}?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
  for (const id of activityRows) await rest(`/ticket_activities?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
  for (const [p, t] of blobs) {
    const d = await fetch(`${STORAGE}/v0/b/${BUCKET}/o/${encodeURIComponent(p)}`, { method: "DELETE", headers: { Authorization: `Firebase ${t}` } });
    ok(d.ok, `blob existed and was cleaned up: ${p}`);
  }
  for (const id of leads) await rest(`/leads?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
  for (const id of users) { await rest(`/mcp_write_log?user_id=eq.${id}`, { method: "DELETE" }).catch(() => {}); await rmUser(id).catch((e) => console.error("cleanup", id, e.message)); }
  child?.kill();
  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAIL"}`);
  process.exit(fails ? 1 : 0);
}
