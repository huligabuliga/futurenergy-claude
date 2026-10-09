// Trámite write tools (src/tramites.ts) against a LOCAL Supabase, through the
// running server as two throwaway users: an admin (has tramites.manage) and a
// plain user (must not even see the tools). Creates one fixture project and
// deletes everything it wrote at the end.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/write-tools-test.mjs
//
// Spawns dist/index.js on :3211 with MCP_SKIP_AS_METADATA=1 unless MCP_URL is set.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY, SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!PUB || !SVC) { console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (local)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(SB)) { console.error(`Refusing to run against ${SB}: local only.`); process.exit(2); }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
const PASS = "Wt-" + randomBytes(6).toString("hex");
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? " — " + x : ""}`); if (!c) fails++; };
const j = async (u, i = {}) => { const r = await fetch(u, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const rest = (path, init = {}) => j(`${SB}/rest/v1${path}`, { headers: { ...H, Prefer: "return=representation", ...(init.headers || {}) }, ...init });

async function mkUser(email, { admin = false } = {}) {
  const u = (await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password: PASS, email_confirm: true }) })).b;
  await j(`${SB}/rest/v1/profiles?on_conflict=user_id`, { method: "POST", headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: u.id, email, first_name: "Wt", last_name: "Test", is_active: true, is_admin: admin, department: "Operaciones" }) });
  return u.id;
}
const rmUser = async (id) => { await j(`${SB}/rest/v1/user_crm_roles?user_id=eq.${id}`, { method: "DELETE", headers: H }); await j(`${SB}/rest/v1/profiles?user_id=eq.${id}`, { method: "DELETE", headers: H }); await j(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H }); };
const signIn = async (email) => (await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).b.access_token;

let MCP_URL = process.env.MCP_URL, child = null;
async function startServer() {
  const PORT = 3211;
  const here = dirname(fileURLToPath(import.meta.url));
  child = spawn(process.execPath, [resolve(here, "../dist/index.js")], {
    env: { ...process.env, SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SERVICE_ROLE_KEY: SVC, PORT: String(PORT), MCP_PUBLIC_URL: `http://localhost:${PORT}/mcp`, MCP_SKIP_AS_METADATA: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { const s = String(d); if (!/WARNING: MCP_SKIP_AS_METADATA/.test(s)) process.stderr.write(`[server] ${s}`); });
  MCP_URL = `http://localhost:${PORT}/mcp`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
async function mcp(tok, method, params = {}, id = 1) {
  const r = await j(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  let d = r.b; if (typeof r.b === "string" && (r.b.startsWith("event:") || r.b.startsWith("data:"))) d = r.b.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop();
  return { status: r.s, data: d };
}
async function tools(tok) { await mcp(tok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }); return (await mcp(tok, "tools/list", {}, 2)).data?.result?.tools?.map((t) => t.name) ?? []; }
async function call(tok, name, args) { await mcp(tok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }); const r = await mcp(tok, "tools/call", { name, arguments: args }, 9); return { text: r.data?.result?.content?.[0]?.text ?? JSON.stringify(r.data), isError: r.data?.result?.isError === true || !!r.data?.error }; }

const WRITE_TOOLS = ["futurerp_tramite_create", "futurerp_tramite_update", "futurerp_project_set_zona_cfe", "futurerp_project_tramites_requeridos_set", "futurerp_activity_add", "futurerp_tramite_link_file", "futurerp_bloqueo_open"];
const users = []; let projectId = null;
try {
  if (!MCP_URL) await startServer();
  const stamp = randomBytes(3).toString("hex");
  const adminEmail = `wt-admin-${stamp}@futurenergy.mx`, plainEmail = `wt-plain-${stamp}@futurenergy.mx`;
  const adminId = await mkUser(adminEmail, { admin: true }); const plainId = await mkUser(plainEmail);
  users.push(adminId, plainId);
  const aTok = await signIn(adminEmail), pTok = await signIn(plainEmail);

  // 1 visibility
  const pTools = await tools(pTok), aTools = await tools(aTok);
  ok(WRITE_TOOLS.every((t) => !pTools.includes(t)), "plain user sees no write tools");
  ok(WRITE_TOOLS.every((t) => aTools.includes(t)), "tramites.manage user sees all 7 write tools", WRITE_TOOLS.filter((t) => !aTools.includes(t)).join(","));

  // fixture project (admin owns it)
  const proj = (await rest("/projects", { method: "POST", body: JSON.stringify({ name: `WT fixture ${stamp}`, created_by: adminId, owner_id: adminId, stage: "Generación De Contrato" }) })).b;
  projectId = proj?.[0]?.id; ok(!!projectId, "fixture project created", JSON.stringify(proj).slice(0, 120));

  // 2 zona
  let r = await call(aTok, "futurerp_project_set_zona_cfe", { project_id: projectId, zona: "DD10", motivo: "recibo" });
  ok(!r.isError && /→ DD10/.test(r.text), "set_zona_cfe DD10", r.text);
  ok((await rest(`/projects?id=eq.${projectId}&select=zona_cfe`)).b[0].zona_cfe === "DD10", "projects.zona_cfe = DD10");
  r = await call(aTok, "futurerp_project_set_zona_cfe", { project_id: projectId, zona: "DD10" });
  ok(!r.isError && /Sin cambios/.test(r.text), "set_zona_cfe same value is a no-op");

  // 3 create
  r = await call(aTok, "futurerp_tramite_create", { project_id: projectId, tipo: "primary_dd12", comentarios: "x" });
  ok(r.isError && /zona/.test(r.text), "create refuses a primary tipo that does not match the zona", r.text);
  r = await call(aTok, "futurerp_tramite_create", { project_id: projectId, tipo: "primary_dd10", comentarios: "Etiqueta requerida sin fila" });
  ok(!r.isError && /etapa expediente_integracion/.test(r.text), "create primary_dd10 in first stage", r.text);
  const tr = (await rest(`/project_tramites?project_id=eq.${projectId}&select=id,tipo,stage,created_by`)).b;
  ok(tr.length === 1 && tr[0].stage === "expediente_integracion" && tr[0].created_by === adminId, "one trámite row, created_by = caller");
  const tramiteId = tr[0].id;
  const docs = (await rest(`/project_documents?project_id=eq.${projectId}&select=name,requerido&order=name`)).b.map((d) => `${d.name}:${d.requerido}`);
  ok(["Comprobante de ingreso:false", "INE del titular:true", "Imagenes Instalacion:false", "Recibo CFE:true"].every((d) => docs.includes(d)), "document slots seeded", docs.join(" | "));
  r = await call(aTok, "futurerp_tramite_create", { project_id: projectId, tipo: "primary_dd10" });
  ok(r.isError && /ya tiene/.test(r.text), "second primary refused");
  r = await call(aTok, "futurerp_tramite_create", { project_id: projectId, tipo: "cambio_nombre" });
  ok(!r.isError, "a second tipo (cambio_nombre) is allowed", r.text);

  // 4 update
  r = await call(aTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { stage: "en_seguimiento_cfe", numero_si: "SI123", gestor_cfe: "Iris Reyna", type_data: { fecha_envio_gestor: "2026-10-09" } }, motivo: "Iris mandó el comprobante" });
  ok(!r.isError && /stage: expediente_integracion → en_seguimiento_cfe/.test(r.text) && /numero_si/.test(r.text), "update moves forward + sets SI", r.text);
  const row = (await rest(`/project_tramites?id=eq.${tramiteId}&select=stage,numero_si,gestor_cfe,type_data`)).b[0];
  ok(row.stage === "en_seguimiento_cfe" && row.numero_si === "SI123" && row.type_data?.fecha_envio_gestor === "2026-10-09", "row updated incl. merged type_data");
  const acts = (await rest(`/crm_activities?entity_id=eq.${projectId}&select=subject,activity_type,old_value,new_value,performed_by,metadata&order=created_at`)).b;
  const mine = acts.filter((a) => a.metadata?.source === "mcp" && a.subject.startsWith("Etapa de trámite"));
  ok(mine.length === 1 && mine[0].old_value === "expediente_integracion" && mine[0].new_value === "en_seguimiento_cfe" && mine[0].performed_by === adminId, "stage move logged once like the card (other fields come from the DB trigger)", acts.map((a) => a.subject).join(" | "));
  ok(acts.some((a) => a.subject === "Trámite · numero_si"), "DB trigger logged numero_si on its own");
  r = await call(aTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { stage: "en_seguimiento_cfe", numero_si: "SI123" } });
  ok(!r.isError && /Sin cambios/.test(r.text), "same values are a no-op");
  r = await call(aTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { stage: "folio_ingresado" } });
  ok(r.isError && /hacia atrás/.test(r.text), "backwards stage refused");
  r = await call(aTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { stage: "concluido" } });
  ok(r.isError && /Etapa inválida/.test(r.text), "stage from another tipo refused");
  r = await call(aTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { enviado: true } });
  const sent = (await rest(`/project_tramites?id=eq.${tramiteId}&select=enviado,enviado_by`)).b[0];
  ok(!r.isError && sent.enviado === true && sent.enviado_by === adminId, "enviado stamps enviado_by");

  // 5 requeridos
  r = await call(aTok, "futurerp_project_tramites_requeridos_set", { project_id: projectId, labels: ["Trámite de medidor bidireccional", "Cambio de nombre"] });
  ok(!r.isError, "requeridos set", r.text);
  const sel = "tramites_requeridos_manual,tramites_requeridos_vetados";
  let pr = (await rest(`/projects?id=eq.${projectId}&select=${sel}`)).b[0];
  ok((pr.tramites_requeridos_manual ?? []).includes("Cambio de nombre") && (pr.tramites_requeridos_manual ?? []).includes("Trámite de medidor bidireccional"), "projects.tramites_requeridos_manual written", JSON.stringify(pr));
  r = await call(aTok, "futurerp_project_tramites_requeridos_set", { project_id: projectId, labels: ["UVIE"] });
  pr = (await rest(`/projects?id=eq.${projectId}&select=${sel}`)).b[0];
  ok(!r.isError && (pr.tramites_requeridos_manual ?? []).length === 3 && (pr.tramites_requeridos_vetados ?? []).length === 0, "additive: adding UVIE keeps the other two, vetoes nothing", JSON.stringify(pr));
  r = await call(aTok, "futurerp_project_tramites_requeridos_set", { project_id: projectId, labels: [], remove: ["Cambio de nombre"] });
  pr = (await rest(`/projects?id=eq.${projectId}&select=${sel}`)).b[0];
  ok(!r.isError && (pr.tramites_requeridos_vetados ?? []).includes("Cambio de nombre") && !(pr.tramites_requeridos_manual ?? []).includes("Cambio de nombre"), "explicit remove unticks and records the veto", JSON.stringify(pr));
  r = await call(aTok, "futurerp_project_tramites_requeridos_set", { project_id: projectId, labels: ["Cambio de nombre"] });
  pr = (await rest(`/projects?id=eq.${projectId}&select=${sel}`)).b[0];
  ok(!r.isError && /Vetados por una persona/.test(r.text) && !(pr.tramites_requeridos_manual ?? []).includes("Cambio de nombre"), "vetoed label is not re-added and is reported", r.text);

  // 6 activity
  r = await call(aTok, "futurerp_activity_add", { project_id: projectId, subject: "Pregunta para Flor", description: "¿Es este proyecto?" });
  ok(!r.isError && (await rest(`/crm_activities?entity_id=eq.${projectId}&subject=eq.Pregunta%20para%20Flor&select=id`)).b.length === 1, "activity_add writes a note");

  // 7 link file
  r = await call(aTok, "futurerp_tramite_link_file", { tramite_id: tramiteId, url: "https://evil.example.com/x.pdf", name: "x.pdf", doc_key: "Comprobante de ingreso" });
  ok(r.isError && /Firebase/.test(r.text), "non-Firebase url refused");
  const fbUrl = `https://firebasestorage.googleapis.com/v0/b/tickets-futurenergy.firebasestorage.app/o/projects%2F${projectId}%2Fcomprobante.pdf?alt=media`;
  r = await call(aTok, "futurerp_tramite_link_file", { tramite_id: tramiteId, url: fbUrl, name: "comprobante.pdf", doc_key: "Comprobante de ingreso" });
  ok(!r.isError, "link by Firebase url", r.text);
  const links = (await rest(`/tramite_file_links?tramite_id=eq.${tramiteId}&select=doc_key,file_id,created_by`)).b;
  ok(links.length === 1 && links[0].doc_key === "Comprobante de ingreso" && links[0].created_by === adminId, "project_files + tramite_file_links written");
  r = await call(aTok, "futurerp_tramite_link_file", { tramite_id: tramiteId, file_id: links[0].file_id, doc_key: "Comprobante de ingreso" });
  ok(!r.isError && (await rest(`/tramite_file_links?tramite_id=eq.${tramiteId}&select=id`)).b.length === 1, "re-linking the same file is idempotent");

  // 8 bloqueo
  r = await call(aTok, "futurerp_bloqueo_open", { project_id: projectId, categoria: "cfe_tramite", dependencia: "tercero", motivo: "SI123 lleva 95 días en CFE" });
  ok(!r.isError, "bloqueo_open cfe_tramite", r.text);
  const bl = (await rest(`/project_bloqueos?project_id=eq.${projectId}&select=categoria,estado,stage,created_by`)).b;
  ok(bl.length === 1 && bl[0].estado === "activo" && bl[0].created_by === adminId, "bloqueo row active at the project's stage");
  r = await call(aTok, "futurerp_bloqueo_open", { project_id: projectId, categoria: "cfe_tramite", dependencia: "tercero", motivo: "otra vez" });
  ok(r.isError && /Ya hay un bloqueo/.test(r.text), "second active bloqueo of same categoria refused");

  // 9 plain user cannot reach the tools at all
  r = await call(pTok, "futurerp_tramite_update", { tramite_id: tramiteId, patch: { numero_si: "HACK" } });
  ok(r.isError, "plain user: tool call rejected", r.text.slice(0, 80));
  ok((await rest(`/project_tramites?id=eq.${tramiteId}&select=numero_si`)).b[0].numero_si === "SI123", "plain user changed nothing");
} catch (e) {
  console.error("ERROR", e); fails++;
} finally {
  if (projectId) {
    for (const p of [`/project_bloqueos?project_id=eq.${projectId}`, `/tramite_file_links?tramite_id=in.(select)`, `/crm_activities?entity_id=eq.${projectId}`, `/project_documents?project_id=eq.${projectId}`, `/project_tramites?project_id=eq.${projectId}`, `/project_files?project_id=eq.${projectId}`, `/projects?id=eq.${projectId}`]) {
      if (p.includes("in.(select)")) continue;
      await rest(p, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
  }
  for (const id of users) await rmUser(id);
  if (child) child.kill("SIGTERM");
  console.log(fails ? `\n${fails} FAILED` : "\nwrite-tools-test: all passed");
  process.exit(fails ? 1 : 0);
}
