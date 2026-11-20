// Lead action tools (src/leadActions.ts) against a LOCAL Supabase, through the running server.
// Same harness as write-generic-test.mjs. Google Calendar is not connected for the test user,
// so the push must report it and the rest must still save.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/lead-actions-test.mjs
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!PUB || !SVC) { console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (local)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(SB)) { console.error(`Refusing to run against ${SB}: local only.`); process.exit(2); }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const PASS = "La-" + randomBytes(6).toString("hex");
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? " — " + x : ""}`); if (!c) fails++; };
const j = async (u, i = {}) => { const r = await fetch(u, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const rest = (path, init = {}) => j(`${SB}/rest/v1${path}`, { ...init, headers: { ...H, Prefer: "return=representation", ...(init.headers || {}) } });

async function mkUser(email, roles) {
  const u = (await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password: PASS, email_confirm: true }) })).b;
  await rest(`/profiles?on_conflict=user_id`, { method: "POST", headers: { Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: u.id, email, first_name: "La", last_name: "Test", is_active: true, department: "Ventas" }) });
  for (const name of roles) {
    const r = (await rest(`/crm_roles?name=eq.${encodeURIComponent(name)}&select=id`)).b[0];
    if (!r) throw new Error(`role ${name} missing locally`);
    await rest(`/user_crm_roles`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: u.id, role_id: r.id }) });
  }
  return u.id;
}
const rmUser = async (id) => { await rest(`/reminders?user_id=eq.${id}`, { method: "DELETE" }); await rest(`/user_crm_roles?user_id=eq.${id}`, { method: "DELETE" }); await rest(`/profiles?user_id=eq.${id}`, { method: "DELETE" }); await j(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H }); };
const signIn = async (email) => (await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).b.access_token;

let MCP = process.env.MCP_URL, child;
if (!MCP) {
  const here = dirname(fileURLToPath(import.meta.url));
  child = spawn(process.execPath, [resolve(here, "../dist/index.js")], { env: { ...process.env, PORT: "3215", MCP_SKIP_AS_METADATA: "1", SUPABASE_URL: SB }, stdio: ["ignore", "ignore", "inherit"] });
  MCP = "http://127.0.0.1:3215/mcp";
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
  const eW = `la-writer-${s}@futurenergy.mx`, eP = `la-plain-${s}@futurenergy.mx`;
  const writer = await mkUser(eW, ["Vendedor", "MCP Escritura"]);
  const plain = await mkUser(eP, ["Vendedor"]);
  users.push(writer, plain);
  const mine = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Propio", last_name: `La ${s}`, assigned_to: writer, created_by: writer, status: "primer_contacto" }) })).b[0];
  const other = (await rest(`/leads`, { method: "POST", body: JSON.stringify({ first_name: "Ajeno", last_name: `La ${s}`, assigned_to: plain, created_by: plain, status: "primer_contacto" }) })).b[0];
  leads.push(mine.id, other.id);
  const [tW, tP] = [await signIn(eW), await signIn(eP)];

  console.log("# visibility");
  const lw = await tools(tW), lp = await tools(tP);
  ok(lw.includes("futurerp_lead_set_stage") && lw.includes("futurerp_lead_schedule_next_contact"), "writer sees lead action tools");
  ok(!lp.includes("futurerp_lead_set_stage"), "plain Vendedor does not");

  console.log("\n# set stage");
  let r = await call(tW, "futurerp_lead_set_stage", { lead_id: mine.id, stage: "seguimiento" });
  ok(!r.isError && /Primer Contacto → Seguimiento/.test(r.text), "stage changed", r.text.slice(0, 80));
  ok((await rest(`/leads?id=eq.${mine.id}&select=status`)).b[0].status === "seguimiento", "DB status = seguimiento");
  const acts = (await rest(`/crm_activities?entity_id=eq.${mine.id}&activity_type=eq.status_change&select=*`)).b;
  // The DB trigger (track_lead_stage_change) logs raw keys; the app, and this tool, add the labelled line.
  const labelled = acts.filter((a) => a.old_value === "Primer Contacto" && a.new_value === "Seguimiento" && a.performed_by === writer);
  ok(labelled.length === 1, "labelled Cambio de etapa row in Actividad, like the app", `${acts.length} status_change rows`);
  r = await call(tW, "futurerp_lead_set_stage", { lead_id: mine.id, stage: "seguimiento" });
  ok(/^No changes/.test(r.text), "same stage: no changes");
  r = await call(tW, "futurerp_lead_set_stage", { lead_id: other.id, stage: "seguimiento" });
  ok(r.isError && (await rest(`/leads?id=eq.${other.id}&select=status`)).b[0].status === "primer_contacto", "someone else's lead refused", r.text.slice(0, 80));

  console.log("\n# next contact");
  const when = new Date(Date.now() + 2 * 86400e3);
  const local = new Date(when.getTime() - 6 * 3600e3).toISOString().slice(0, 16); // Monterrey wall clock
  r = await call(tW, "futurerp_lead_schedule_next_contact", { lead_id: mine.id, at: local, note: "Llamar para cotizar", vendor_qualification: "Hot" });
  ok(!r.isError && /scheduled/.test(r.text) && /Google Calendar/.test(r.text), "scheduled + calendar status reported", r.text.replace(/\n/g, " | ").slice(0, 160));
  let lead = (await rest(`/leads?id=eq.${mine.id}&select=next_contact_at,next_contact_note,next_contact_reminder_id,vendor_qualification`)).b[0];
  ok(Math.abs(new Date(lead.next_contact_at) - new Date(`${local}:00-06:00`)) < 1000 && lead.next_contact_note === "Llamar para cotizar" && lead.vendor_qualification === "Hot", "lead fields saved, Monterrey time honoured", JSON.stringify(lead));
  const rem1 = (await rest(`/reminders?id=eq.${lead.next_contact_reminder_id}&select=*`)).b[0];
  ok(rem1?.user_id === writer && rem1.title === `Contactar a Propio La ${s}`, "reminder created for the writer", rem1?.title);

  r = await call(tW, "futurerp_lead_schedule_next_contact", { lead_id: mine.id, at: new Date(when.getTime() + 86400e3).toISOString() });
  ok(!r.isError && /rescheduled/.test(r.text), "reschedule");
  lead = (await rest(`/leads?id=eq.${mine.id}&select=next_contact_reminder_id`)).b[0];
  ok(lead.next_contact_reminder_id !== rem1.id && (await rest(`/reminders?id=eq.${rem1.id}`)).b.length === 0, "old reminder replaced");
  r = await call(tW, "futurerp_lead_schedule_next_contact", { lead_id: mine.id, at: "2020-01-01T10:00" });
  ok(r.isError && /future/.test(r.text), "past date refused");
  r = await call(tW, "futurerp_lead_schedule_next_contact", { lead_id: other.id, at: local });
  ok(r.isError && (await rest(`/reminders?user_id=eq.${writer}`)).b.length === 1, "someone else's lead refused, no stray reminder", r.text.slice(0, 80));

  console.log("\n# disqualify");
  r = await call(tW, "futurerp_lead_set_stage", { lead_id: mine.id, stage: "descalificado" });
  ok(r.isError && /reason/.test(r.text), "descalificado without reason refused");
  const remId = lead.next_contact_reminder_id;
  r = await call(tW, "futurerp_lead_set_stage", { lead_id: mine.id, stage: "descalificado", reason: "Sin presupuesto" });
  lead = (await rest(`/leads?id=eq.${mine.id}&select=status,disqualification_reason,next_contact_at,next_contact_reminder_id`)).b[0];
  ok(!r.isError && lead.status === "descalificado" && lead.disqualification_reason === "Sin presupuesto" && !lead.next_contact_at && !lead.next_contact_reminder_id, "disqualified and next contact cleared", JSON.stringify(lead));
  ok((await rest(`/reminders?id=eq.${remId}`)).b.length === 0, "next-contact reminder deleted");
  const last = (await rest(`/crm_activities?entity_id=eq.${mine.id}&activity_type=eq.status_change&order=created_at.desc&limit=1&select=new_value`)).b[0];
  ok(last?.new_value === "Descalificado — Sin presupuesto", "Actividad line carries the reason", last?.new_value);
} catch (e) { console.error("ERROR", e); fails++; }
finally {
  for (const id of leads) { await rest(`/crm_activities?entity_id=eq.${id}`, { method: "DELETE" }).catch(() => {}); await rest(`/leads?id=eq.${id}`, { method: "DELETE" }).catch(() => {}); }
  for (const id of users) { await rest(`/mcp_write_log?user_id=eq.${id}`, { method: "DELETE" }).catch(() => {}); await rmUser(id).catch((e) => console.error("cleanup", id, e.message)); }
  child?.kill();
  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAIL"}`);
  process.exit(fails ? 1 : 0);
}
