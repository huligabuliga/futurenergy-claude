// Nancy catalog tools (src/catalogo.ts) against a LOCAL Supabase, through the running server.
// Same harness as lead-actions-test.mjs. Works inside the existing local draft and takes its
// package back out at the end; it never publishes.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/catalogo-test.mjs
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
const rmUser = async (id) => { await rest(`/user_crm_roles?user_id=eq.${id}`, { method: "DELETE" }); await rest(`/profiles?user_id=eq.${id}`, { method: "DELETE" }); await j(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H }); };
const signIn = async (email) => (await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).b.access_token;

let MCP = process.env.MCP_URL, child;
if (!MCP) {
  const here = dirname(fileURLToPath(import.meta.url));
  child = spawn(process.execPath, [resolve(here, "../dist/index.js")], { env: { ...process.env, PORT: "3216", MCP_SKIP_AS_METADATA: "1", SUPABASE_URL: SB }, stdio: ["ignore", "ignore", "inherit"] });
  MCP = "http://127.0.0.1:3216/mcp";
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const users = [];
let flyerPath = null;
try {
  const s = randomBytes(3).toString("hex");
  const eM = `cat-mkt-${s}@futurenergy.mx`, eP = `cat-plain-${s}@futurenergy.mx`;
  users.push(await mkUser(eM, ["Nancy · Catálogo"]), await mkUser(eP, ["Vendedor"]));
  const [tM, tP] = [await signIn(eM), await signIn(eP)];
  const NAMES = ["futurerp_nancy_catalogo", "futurerp_nancy_paquete_guardar", "futurerp_nancy_catalogo_publicar"];
  const PKG = "Batería 10 kWh + 4 paneles";
  const pkg = (await rest(`/sales_packages?name=eq.${encodeURIComponent(PKG)}&select=id`)).b[0];
  const live = (await rest(`/rpc/get_nancy_catalog`, { method: "POST", body: "{}" })).b.packages;
  const livePkg = live.find((p) => p.package_id === pkg.id), otherPrice = live.find((p) => p.package_id !== pkg.id).price_mxn;
  const version = async () => (await rest(`/sales_package_versions?package_id=eq.${pkg.id}&select=*,release:sales_catalog_releases!inner(status),items:sales_package_items(customer_label)&release.status=eq.draft`)).b[0];
  if (await version()) throw new Error(`${PKG} is already in the local draft; take it out first`);

  console.log("# visibility");
  const seen = await tools(tM);
  ok(NAMES.every((n) => seen.includes(n)), "Nancy · Catálogo role sees the 3 tools");
  ok(!(await tools(tP)).some((n) => NAMES.includes(n)), "a plain Vendedor sees none");

  console.log("\n# read");
  let r = await call(tM, "futurerp_nancy_catalogo", {});
  ok(!r.isError && r.text.includes(PKG) && /VIGENTE/.test(r.text), "lists what Nancy quotes", r.text.slice(0, 80));

  console.log("\n# draft a promotion");
  r = await call(tM, "futurerp_nancy_paquete_guardar", { paquete: "10 kwh + 4", precio: 239900, vigente_hasta: "2099-12-31", al_terminar: "volver_al_precio_anterior", flyer_base64: PNG });
  let v = await version();
  flyerPath = v?.flyer_path ?? null;
  ok(!r.isError && /NO lo usa/.test(r.text), "saved in the draft, found by a name fragment", r.text.slice(0, 120));
  ok(Number(v?.price_mxn) === 239900 && v?.valid_until === "2099-12-31" && v?.on_end === "revert", "price, end date and on_end written");
  ok(Number(v?.battery_kwh) === Number(livePkg.battery_kwh) && v?.panel_count === livePkg.panel_count && v?.items.length === livePkg.items.length, "fields not passed keep their live values (battery, panels, equipment)");
  ok(v?.created_by === users[0] || v?.updated_by === users[0], "written with the caller's token (audit columns)");
  const img = flyerPath ? await fetch(`${SB}/storage/v1/object/public/nancy-catalogo/${flyerPath}`) : null;
  ok(flyerPath?.startsWith(`${pkg.id}/`) && flyerPath.endsWith(".png") && img?.status === 200, "flyer uploaded to the public bucket under the package", flyerPath ?? "");
  ok((await rest(`/rpc/get_nancy_catalog`, { method: "POST", body: "{}" })).b.packages.find((p) => p.package_id === pkg.id).price_mxn === livePkg.price_mxn, "what Nancy quotes did not change");

  r = await call(tM, "futurerp_nancy_paquete_guardar", { paquete: PKG, nota_para_nancy: "Promo de prueba" });
  v = await version();
  ok(!r.isError && Number(v?.price_mxn) === 239900 && v?.flyer_path === flyerPath && v?.nancy_notes === "Promo de prueba", "a second call changes only what it passes");

  console.log("\n# guardrails");
  r = await call(tM, "futurerp_nancy_paquete_guardar", { paquete: PKG, flyer_base64: Buffer.from("not an image").toString("base64") });
  ok(r.isError && /JPG o PNG/.test(r.text), "a non-image flyer is refused");
  r = await call(tM, "futurerp_nancy_paquete_guardar", { paquete: "batería" });
  ok(r.isError && /varios paquetes/.test(r.text), "an ambiguous name asks for the full one", r.text.slice(0, 90));
  r = await call(tM, "futurerp_nancy_paquete_guardar", { paquete: PKG, precio: otherPrice });
  ok(!r.isError && /BLOQUEA: .*mismo precio/.test(r.text), "the reply names what blocks publishing (duplicate price)");
  r = await call(tM, "futurerp_nancy_catalogo_publicar", { accion: "publicar" });
  ok(r.isError && /No se puede publicar/.test(r.text), "publicar is refused while the review has errors", r.text.slice(0, 90));
  ok((await rest(`/sales_catalog_releases?status=eq.draft&select=id`)).b.length === 1, "the draft is still a draft");

  console.log("\n# undo");
  r = await call(tM, "futurerp_nancy_catalogo_publicar", { accion: "quitar_paquete", paquete: PKG });
  ok(!r.isError && !(await version()), "quitar_paquete takes it back out of the draft", r.text.slice(0, 80));
} catch (e) { console.error("ERROR", e); fails++; }
finally {
  const pkgId = flyerPath?.split("/")[0];
  if (pkgId) await rest(`/sales_package_versions?package_id=eq.${pkgId}&flyer_path=eq.${encodeURIComponent(flyerPath)}`, { method: "DELETE" });
  if (flyerPath) await fetch(`${SB}/storage/v1/object/nancy-catalogo/${flyerPath}`, { method: "DELETE", headers: H });
  for (const id of users) await rmUser(id);
  child?.kill();
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
