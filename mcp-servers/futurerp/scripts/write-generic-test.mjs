// Generic write tools (src/writes.ts) against a LOCAL Supabase, through the running server.
// Throwaway users: a Vendedor WITH the "MCP Escritura" role, a Vendedor without it, and an admin.
// Creates two fixture leads and deletes everything it wrote at the end.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/write-generic-test.mjs
//
// Spawns dist/index.js on :3214 with MCP_SKIP_AS_METADATA=1 unless MCP_URL is set.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!PUB || !SVC) { console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (local)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(SB)) { console.error(`Refusing to run against ${SB}: local only.`); process.exit(2); }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const PASS = "Wg-" + randomBytes(6).toString("hex");
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? " — " + x : ""}`); if (!c) fails++; };
const j = async (u, i = {}) => { const r = await fetch(u, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const rest = (path, init = {}) => j(`${SB}/rest/v1${path}`, { ...init, headers: { ...H, Prefer: "return=representation", ...(init.headers || {}) } });

async function mkUser(email, { admin = false, roles = [] } = {}) {
  const u = (await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password: PASS, email_confirm: true }) })).b;
  await rest(`/profiles?on_conflict=user_id`, { method: "POST", headers: { Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: u.id, email, first_name: "Wg", last_name: "Test", is_active: true, is_admin: admin, department: "Ventas" }) });
  for (const name of roles) {
    const r = (await rest(`/crm_roles?name=eq.${encodeURIComponent(name)}&select=id`)).b[0];
    if (!r) throw new Error(`role ${name} missing — apply the pronto migration 20261022120000_mcp_write.sql locally`);
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

const users = [], leads = [];
try {
  const s = randomBytes(3).toString("hex");
  const eW = `wg-writer-${s}@futurenergy.mx`, eP = `wg-plain-${s}@futurenergy.mx`, eA = `wg-admin-${s}@futurenergy.mx`;
  const writer = await mkUser(eW, { roles: ["Vendedor", "MCP Escritura"] });
  const plain = await mkUser(eP, { roles: ["Vendedor"] });
  const admin = await mkUser(eA, { admin: true });
  users.push(writer, plain, admin);
  const mine = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Propio", last_name: `Wg ${s}`, assigned_to: writer, created_by: writer }) })).b[0];
  const other = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Ajeno", last_name: `Wg ${s}`, assigned_to: plain, created_by: plain }) })).b[0];
  leads.push(mine.id, other.id);
  const [tW, tP, tA] = [await signIn(eW), await signIn(eP), await signIn(eA)];

  console.log("# visibility");
  const lw = await tools(tW), lp = await tools(tP), la = await tools(tA);
  ok(lw.includes("futurerp_update_record") && lw.includes("futurerp_insert_record"), "writer (MCP Escritura) sees write tools");
  ok(!lp.includes("futurerp_update_record") && !lp.includes("futurerp_insert_record"), "plain Vendedor does NOT see write tools");
  ok(la.includes("futurerp_update_record"), "admin sees write tools (has_crm_permission admin pass)");

  console.log("\n# update");
  const byId = (id) => [{ column: "id", op: "eq", value: id }];
  let r = await call(tW, "futurerp_update_record", { table: "leads", filters: byId(mine.id), patch: { first_name: "Editado" }, dry_run: true });
  ok(!r.isError && /Dry run: 1 leads/.test(r.text), "dry_run reports 1 row", r.text.slice(0, 60));
  ok((await rest(`/leads?id=eq.${mine.id}&select=first_name`)).b[0].first_name === "Propio", "dry_run wrote nothing");
  r = await call(tW, "futurerp_update_record", { table: "leads", filters: byId(mine.id), patch: { first_name: "Editado" } });
  ok(!r.isError && /Updated 1 leads/.test(r.text), "writer updates own lead", r.text.slice(0, 60));
  const row = (await rest(`/leads?id=eq.${mine.id}&select=first_name,updated_by`)).b[0];
  ok(row.first_name === "Editado" && row.updated_by === writer, "DB has new value and updated_by = writer");
  const log = (await rest(`/mcp_write_log?user_id=eq.${writer}&select=*`)).b;
  ok(log.length === 1 && log[0].op === "update" && log[0].antes?.[0]?.first_name === "Propio", "ledger row with previous value", JSON.stringify(log[0]?.antes));

  r = await call(tW, "futurerp_update_record", { table: "leads", filters: byId(other.id), patch: { first_name: "Hackeado" } });
  ok(!r.isError && /^No changes/.test(r.text), "someone else's lead: no changes (RLS)", r.text.slice(0, 70));
  ok((await rest(`/leads?id=eq.${other.id}&select=first_name`)).b[0].first_name === "Ajeno", "other lead untouched");

  console.log("\n# guardrails");
  r = await call(tW, "futurerp_update_record", { table: "leads", filters: [], patch: { first_name: "x" } });
  ok(r.isError && /filters is required/.test(r.text), "update without filter refused");
  r = await call(tA, "futurerp_update_record", { table: "user_crm_roles", filters: byId(writer), patch: { role_id: writer } });
  ok(r.isError && /can't be written/.test(r.text), "denylisted table refused");
  r = await call(tA, "futurerp_update_record", { table: "profiles", filters: [{ column: "user_id", op: "eq", value: plain }], patch: { is_admin: true } });
  ok(r.isError && /is_admin/.test(r.text), "is_admin column refused");
  r = await call(tA, "futurerp_update_record", { table: "leads", filters: [{ column: "id", op: "not.is", value: "null" }], patch: { first_name: "x" } });
  ok(r.isError && /more than 20 rows/.test(r.text), "filter over 20 rows refused", r.text.slice(0, 70));
  r = await call(tW, "futurerp_insert_record", { table: "leads", row: { last_name: "x", created_by: admin } });
  ok(r.isError && /created_by/.test(r.text), "audit column refused on insert");

  console.log("\n# insert");
  r = await call(tW, "futurerp_insert_record", { table: "leads", row: { first_name: "Nuevo", last_name: `Wg ${s}`, assigned_to: writer } });
  const newId = r.text.match(/row ([0-9a-f-]{36})/)?.[1];
  if (newId) leads.push(newId);
  ok(!r.isError && !!newId, "writer inserts a lead", r.text.slice(0, 70));
  const nrow = newId ? (await rest(`/leads?id=eq.${newId}&select=created_by`)).b[0] : null;
  ok(nrow?.created_by === writer, "created_by stamped by the audit trigger");
  r = await call(tW, "futurerp_insert_record", { table: "crm_roles", row: { name: "x" } });
  ok(r.isError, "insert into denylisted table refused");
} catch (e) { console.error("ERROR", e); fails++; }
finally {
  for (const id of leads) await rest(`/leads?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
  for (const id of users) { await rest(`/mcp_write_log?user_id=eq.${id}`, { method: "DELETE" }).catch(() => {}); await rmUser(id).catch((e) => console.error("cleanup", id, e.message)); }
  child?.kill();
  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAIL"}`);
  process.exit(fails ? 1 : 0);
}
