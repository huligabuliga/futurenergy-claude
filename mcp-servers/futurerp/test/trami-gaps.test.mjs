// Trami gap fixes: per-tool live, checks in shadow, contexto lines, chat history, re-ingreso.
// Runs against dist/ with a fake MCP server and a fake PostgREST (global fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { resetModeCache } from "../dist/guard.js";
import { registerTramiteTools, fueraDeHorario } from "../dist/tramites.js";
import { registerMailTools } from "../dist/mail.js";
import { registerContextoTool, sinSlot } from "../dist/contexto.js";
import { registerHistorialTool, horaMty } from "../dist/historial.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REST = "http://rest";
const T1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";

/** db: path prefix → rows (or fn(url) → rows). Records every write. */
function harness(db) {
  const writes = [];
  const reads = [];
  const lookup = (url) => {
    const path = url.replace(REST, "");
    reads.push(path);
    const key = Object.keys(db).find((k) => path.startsWith(k));
    const v = key ? db[key] : [];
    return typeof v === "function" ? v(path) : v;
  };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, path: String(url).replace(REST, ""), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      const body = JSON.stringify([{ id: "new", stage: JSON.parse(init.body ?? "{}").stage }]);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(lookup(String(url))), { status: 200, headers: { "content-range": "0-0/0" } });
  };
  const sbApi = async (path, headers) => { const rows = lookup(REST + path); if (headers?.Authorization === "service") reads[reads.length - 1] += " [service]"; return rows; };
  const tools = {};
  const server = { tool: (name, _d, _s, h) => { tools[name] = h; } };
  const deps = {
    userId: "trami-uid", restBase: REST, uuidRx: UUID,
    authHeaders: (x = {}) => ({ Authorization: "user", ...x }),
    serviceHeaders: (x = {}) => ({ Authorization: "service", ...x }),
    sbApi, sbRpc: async () => ({}),
  };
  return { server, tools, deps, writes, reads };
}
const txt = (r) => r.content[0].text;
const shadowRows = (w) => w.filter((x) => x.path.startsWith("/agent_shadow_calls"));
// 12:00 Monterrey = 18:00 UTC; 22:00 Monterrey = 04:00 UTC next day.
const atUtc = (iso, fn) => async () => { const real = Date.now; Date.now = () => Date.parse(iso); try { await fn(); } finally { Date.now = real; } };

const GESTORA_TEL = "5218100000009";
const gestoraDice = (body) => ({
  "/gestoras": [{ nombre: "Gestora A", email: "gestora@example.com", activo: true, telefono: GESTORA_TEL, whatsapp_chat_ids: ["120363420531947860@g.us"] }],
  "/whatsapp_messages": [{ conversation_id: "cv-g", media_url: null, body, sender_phone: GESTORA_TEL }],
});
const TRAMITE = { id: T1, project_id: P1, tipo: "primary_bidireccional_dd11", stage: "en_seguimiento_cfe", numero_si: "SI-OLD", fecha_ingreso: "2026-10-01", type_data: {} };

test("fix 7: a tool in trami_tools_live runs while the global mode is shadow; the rest stays shadow", async () => {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }, { config_key: "trami_tools_live", config_value: '["futurerp_tramite_update"]' }],
    "/project_tramites": [TRAMITE],
    "/projects": [{ id: P1, efu: "EFU-1", owner_id: null }],
  });
  registerTramiteTools(h.server, h.deps);
  const live = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { ultimo_estatus_cfe: "en revisión" } });
  assert.match(txt(live), /actualizado/);
  assert.ok(h.writes.some((w) => w.method === "PATCH" && w.path.startsWith("/project_tramites")), "the live tool PATCHed");
  assert.equal(shadowRows(h.writes)[0].body.modo, "vivo");

  const sombra = await h.tools.futurerp_bloqueo_open({ project_id: P1, categoria: "cfe_tramite", dependencia: "tercero", motivo: "CFE no contesta" });
  assert.match(txt(sombra), /^\(sombra\)/);
  assert.ok(!h.writes.some((w) => w.path.startsWith("/project_bloqueos")));
});

test("fix 7: unreadable or bad trami_tools_live = everything shadow", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }, { config_key: "trami_tools_live", config_value: "not json" }], "/project_tramites": [TRAMITE] });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { ultimo_estatus_cfe: "X" } })), /^\(sombra\)/);
});

test("fix 6: fueraDeHorario follows Monterrey 08:00-19:00", () => {
  assert.equal(fueraDeHorario(Date.parse("2026-11-20T18:00:00Z")), null); // 12:00
  assert.match(fueraDeHorario(Date.parse("2026-11-21T04:00:00Z")), /Fuera de horario \(22:00/);
  assert.match(fueraDeHorario(Date.parse("2026-11-20T13:59:00Z")), /07:00/);
  assert.equal(fueraDeHorario(Date.parse("2026-11-20T14:00:00Z")), null); // 08:00
});

test("fix 6: a shadow WhatsApp outside hours is refused, not logged as sombra", atUtc("2026-11-21T04:00:00Z", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }] });
  registerTramiteTools(h.server, h.deps);
  const r = await h.tools.futurerp_whatsapp_send({ chat_id: "5218100000000", text: "hola" });
  assert.equal(r.isError, true);
  assert.match(txt(r), /Fuera de horario/);
  assert.equal(shadowRows(h.writes).length, 0);
  assert.ok(h.writes.some((w) => w.path.startsWith("/bot_error_log")), "the refusal is logged as a tool error");
}));

test("fix 6: a shadow WhatsApp without own channel, or over 20/h, is refused; a valid one is shadowed", atUtc("2026-11-20T18:00:00Z", async () => {
  resetModeCache();
  let h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [] });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "5218100000000", text: "hola" })), /sesión de WhatsApp propia/);

  resetModeCache();
  h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1" }], "/clients": [], "/gestoras": [{ nombre: "Gestora A", activo: true, whatsapp_chat_ids: ["120363420531947860@g.us"] }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes("/whatsapp_messages") ? new Response("[]", { headers: { "content-range": "0-0/20" } }) : realFetch(url, init);
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "120363420531947860@g.us", text: "hola" })), /Tope alcanzado: 20/);

  resetModeCache();
  h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1" }], "/clients": [], "/gestoras": [{ nombre: "Gestora A", activo: true, whatsapp_chat_ids: ["120363420531947860@g.us"] }] });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "120363420531947860@g.us", text: "hola" })), /^\(sombra\)/);
  assert.equal(shadowRows(h.writes)[0].body.modo, undefined, "shadow row (default modo sombra)");
}));

test("fix 6: a shadow mail draft to a non-allowed address is refused", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/gestoras": [{ email: "gestora@example.com" }], "/project_tramites": [{ ...TRAMITE, enviado: true }] });
  registerMailTools(h.server, h.deps);
  const bad = await h.tools.futurerp_mail_draft({ to: "alguien@gmail.com", subject: "Trámite", text: "x" });
  assert.equal(bad.isError, true);
  assert.match(txt(bad), /Destinatario no permitido/);
  assert.equal(shadowRows(h.writes).length, 0);
  assert.match(txt(await h.tools.futurerp_mail_draft({ to: "gestora@example.com", subject: "Trámite", text: "x", tramite_id: T1 })), /^\(sombra\)/);
  assert.match(txt(await h.tools.futurerp_mail_draft({ to: "zona@cfe.mx", subject: "Trámite", text: "x", tramite_id: T1 })), /^\(sombra\)/);
});

test("fix 3: re-ingreso goes back with motivo and archives the previous SI; plain update still forward-only", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "live" }], "/project_tramites": [TRAMITE], "/projects": [{ id: P1, clients: { first_name: "Nombre", last_name: "Cliente" } }], ...gestoraDice("Reingresado Nombre Cliente, nuevo SI-NEW") });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado" } })), /nunca se mueve hacia atrás.*reingreso=true/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado" }, reingreso: true })), /necesita motivo/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "expediente_integracion" }, reingreso: true, motivo: "CFE canceló la orden" })), /no regresa a expediente_integracion/);

  const ok = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado", numero_si: "SI-NEW", fecha_ingreso: "2026-11-20" }, reingreso: true, motivo: "Iris: cancelaron la orden, reingresado", evidencia: { wa_message_id: "WA-G" } });
  assert.match(txt(ok), /actualizado/);
  const patch = h.writes.find((w) => w.method === "PATCH" && w.path.startsWith("/project_tramites")).body;
  assert.equal(patch.stage, "folio_ingresado");
  assert.equal(patch.numero_si, "SI-NEW");
  assert.deepEqual(patch.type_data.ingresos_anteriores.map((x) => [x.numero_si, x.fecha_ingreso, x.stage]), [["SI-OLD", "2026-10-01", "en_seguimiento_cfe"]]);
  const act = h.writes.find((w) => w.path.startsWith("/crm_activities")).body;
  assert.equal(act.metadata.reingreso, true);
  assert.ok("type_data" in shadowRows(h.writes)[0].body.antes, "undo restores type_data too");
});

test("fix 1 + 5: contexto lists unslotted files and Trami's last WhatsApp to the client", async () => {
  const h = harness({
    "/projects": [{ id: P1, efu: "EFU-1", name: "Proyecto", clients: { first_name: "Cliente", mobile_phone: "+52 1 81 1234 5678" } }],
    "/project_tramites": [{ id: T1, tipo: "cambio_nombre", stage: "solicitar_documentos" }],
    "/project_documents": [{ id: "d-recibo", name: "Recibo CFE", requerido: true }, { id: "d-fotos", name: "Fotos de instalación" }],
    "/project_files": [
      { id: "f-recibo", file_name: "recibo.pdf", document_id: "d-recibo", created_at: "2026-11-01" },
      { id: "f-escr", file_name: "escrituras casa.pdf", mime_type: "application/pdf", document_id: null, created_at: "2026-11-02" },
      { id: "f-foto", file_name: "foto.jpg", document_id: "d-fotos", created_at: "2026-11-03" },
      { id: "f-link", file_name: "ine.jpg", document_id: null, created_at: "2026-11-04" },
    ],
    "/tramite_file_links": [{ tramite_id: T1, doc_key: "INE nuevo titular", project_files: { id: "f-link", file_name: "ine.jpg" } }],
    "/whatsapp_channels": [{ id: "ch-trami" }],
    "/whatsapp_conversations": [{ id: "cv1", chat_id: "5218112345678@c.us", contact_phone: "5218112345678" }, { id: "cv2", chat_id: "5218199999999@c.us", contact_phone: "5218199999999" }],
    "/whatsapp_messages": (path) => (path.includes("in.(cv1)") ? [{ body: "Hola Cliente, buen día. Tu trámite ya fue ingresado", sent_at: "2026-11-18T17:00:00Z" }] : []),
  });
  registerContextoTool(h.server, h.deps);
  const out = txt(await h.tools.futurerp_tramite_contexto({ project_id: P1 }));
  assert.match(out, /WhatsApp de Trami al cliente: 1 mensaje\(s\); el último 2026-11-18 17:00 UTC: "Hola Cliente/);
  assert.match(out, /## Archivos SIN slot \(2\)/);
  assert.match(out, /escrituras casa\.pdf \[f-escr, application\/pdf, subido 2026-11-02\]/);
  assert.match(out, /foto\.jpg \[f-foto, subido 2026-11-03, slot "Fotos de instalación"\]/);
  assert.doesNotMatch(out.split("## Archivos SIN slot")[1], /ine\.jpg|recibo\.pdf/, "linked and slotted files are not loose");
});

test("fix 5: no channel conversation = 'nunca le ha escrito'", async () => {
  const h = harness({ "/projects": [{ id: P1, efu: "E", name: "P", clients: { mobile_phone: "8112345678" } }], "/whatsapp_channels": [{ id: "ch" }], "/whatsapp_conversations": [] });
  registerContextoTool(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_tramite_contexto({ project_id: P1 })), /WhatsApp de Trami al cliente: nunca le ha escrito/);
});

test("sinSlot keeps files with no slot or a non-expediente slot, drops linked ones", () => {
  const files = [{ id: "a", document_id: null }, { id: "b", document_id: "x" }, { id: "c", document_id: "y" }, { id: "d", document_id: null }];
  const slot = (d) => ({ x: "Recibo CFE", y: "Otra cosa" })[d];
  assert.deepEqual(sinSlot(files, slot, new Set(["d"])).map((f) => f.id), ["a", "c"]);
});

test("fix 2: historial reads a gestora group with the service key, dedups channels, logs a lectura", async () => {
  const h = harness({
    "/gestoras": [{ nombre: "Iris", whatsapp_chat_ids: ["120363420531947860@g.us"] }],
    "/whatsapp_conversations": [{ id: "g1", is_group: true }, { id: "g2", is_group: true }],
    "/whatsapp_messages": [
      { wa_message_id: "m1", direction: "inbound", body: "Desglose jueves: Cliente A  cambio de nombre  $650", sent_at: "2026-11-19T16:00:00Z", sender_name: "Iris" },
      { wa_message_id: "m1", direction: "inbound", body: "Desglose jueves: Cliente A  cambio de nombre  $650", sent_at: "2026-11-19T16:00:00Z", sender_name: "Iris" },
      { wa_message_id: "m2", direction: "outbound", body: "Gracias", sent_at: "2026-11-19T16:05:00Z", media_url: null },
    ],
  });
  registerHistorialTool(h.server, h.deps);
  const out = txt(await h.tools.futurerp_whatsapp_historial({ chat_id: "120363420531947860@g.us", desde: "2026-11-13", hasta: "2026-11-19" }));
  assert.match(out, /Leyó el chat de Iris \(grupo\): 2 mensaje\(s\) del 2026-11-13 al 2026-11-19/);
  assert.match(out, /19\/11 10:00 · Iris: Desglose jueves/);
  assert.match(out, /<untrusted source="whatsapp">/);
  assert.ok(h.reads.some((r) => r.startsWith("/whatsapp_messages?conversation_id=in.(g1,g2)") && r.includes("sent_at=gte.2026-11-13T06%3A00%3A00.000Z") && r.endsWith("[service]")));
  const row = shadowRows(h.writes)[0].body;
  assert.equal(row.modo, "lectura");
  assert.equal(row.tool_name, "futurerp_whatsapp_historial");
});

test("fix 2: a chat that is not a gestora's goes through the caller's RLS; none visible = error", async () => {
  const h = harness({ "/gestoras": [], "/whatsapp_conversations": [] });
  registerHistorialTool(h.server, h.deps);
  const r = await h.tools.futurerp_whatsapp_historial({ chat_id: "5218100000000@c.us" });
  assert.equal(r.isError, true);
  assert.ok(!h.reads.find((x) => x.startsWith("/whatsapp_conversations")).endsWith("[service]"));
  assert.equal(horaMty("2026-11-20T06:30:00Z"), "20/11 00:30");
});

// ── Gestoras are data: inactive gestora is never written to; routing by zona + tipo ──
const GESTORAS = [
  { nombre: "Gestora Vieja", activo: false, telefono: "5218112767099", whatsapp_chat_ids: ["5218112767099@c.us", "120363420531947860@g.us"] },
  { nombre: "Gestora Nueva", activo: true, telefono: "5218100000001", whatsapp_chat_ids: ["120363000000000001@g.us"] },
];
const sendHarness = () => harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1", chat_id: "120363420531947860@g.us" }], "/clients": [], "/gestoras": GESTORAS });

test("gestoras: an inactive gestora's group, 1:1 or phone is refused even in shadow; the active one's group is shadowed", atUtc("2026-11-20T18:00:00Z", async () => {
  for (const args of [{ chat_id: "120363420531947860@g.us" }, { chat_id: "5218112767099" }, { conversation_id: "33333333-3333-4333-8333-333333333333" }]) {
    resetModeCache();
    const h = sendHarness();
    registerTramiteTools(h.server, h.deps);
    const r = await h.tools.futurerp_whatsapp_send({ ...args, text: "hola" });
    assert.match(txt(r), /Gestora Vieja, que ya no es gestora activa/, JSON.stringify(args));
    assert.equal(shadowRows(h.writes).length, 0, "no shadow row for a refused send");
  }
  resetModeCache();
  const h = sendHarness();
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "120363000000000001@g.us", text: "hola" })), /^\(sombra\)/);
  resetModeCache();
  const h2 = sendHarness();
  registerTramiteTools(h2.server, h2.deps);
  assert.match(txt(await h2.tools.futurerp_whatsapp_send({ chat_id: "120363999999999999@g.us", text: "hola" })), /Solo escribes a grupos de una gestora activa/);
}));

test("gestoras: contexto names the gestora per zona + tipo with her notes, and says NINGUNA when nobody covers it", async () => {
  const rpc = (path) => {
    if (path.includes("p_tipo=cambio_nombre")) return { id: "g2", nombre: "Gestora Nueva", email: "nueva@example.com", whatsapp_chat_ids: ["120363000000000001@g.us"], notas_trami: "Escribe en mayúsculas\nPaga el jueves" };
    return { id: null, nombre: null }; // PostgREST shape of a NULL composite
  };
  const h = harness({
    "/projects": [{ id: P1, efu: "EFU-1", name: "Proyecto", zona_cfe: "DD10", clients: {} }],
    "/project_tramites": [{ id: T1, tipo: "cambio_nombre", stage: "deteccion" }, { id: "t2", tipo: "primary_dd10", stage: "expediente_integracion" }, { id: "t3", tipo: "cambio_tarifa", stage: "concluido" }],
    "/rpc/trami_gestora_para": rpc,
  });
  registerContextoTool(h.server, h.deps);
  const out = txt(await h.tools.futurerp_tramite_contexto({ project_id: P1 }));
  assert.match(out, /- DD10\/cambio_nombre: Gestora Nueva · correo nueva@example\.com · chats 120363000000000001@g\.us/);
  assert.match(out, /Notas de la gestora: Escribe en mayúsculas \/ Paga el jueves/);
  assert.match(out, /- DD10\/primary_dd10: NINGUNA gestora activa\. Pregunta a tramitología/);
  assert.doesNotMatch(out, /cambio_tarifa:/, "closed trámites are not routed");

  const h2 = harness({ "/projects": [{ id: P1, efu: "E", name: "P", zona_cfe: null, clients: {} }] });
  registerContextoTool(h2.server, h2.deps);
  assert.match(txt(await h2.tools.futurerp_tramite_contexto({ project_id: P1 })), /SIN ZONA CFE: no se puede saber la gestora/);
});

test("gestoras: pregunta_para_tramitologia notifies tramites.manage", async () => {
  for (const flag of ["pregunta_para_tramitologia"]) {
    resetModeCache();
    const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "live" }], "/user_crm_roles": [{ user_id: "u-a" }, { user_id: "u-b" }] });
    const rpcs = [];
    h.deps.sbRpc = async (name, args) => { rpcs.push({ name, args }); return {}; };
    registerTramiteTools(h.server, h.deps);
    const r = await h.tools.futurerp_activity_add({ subject: "¿A quién se manda?", [flag]: true });
    assert.match(txt(r), /Pregunta enviada a 2 persona/, flag);
    assert.deepEqual(rpcs.find((x) => x.name === "create_notification")?.args.p_user_ids, ["u-a", "u-b"]);
  }
});

// Gestoras are data and tramitología is a permission: no person's name in anything the model reads.
test("no Iris or Flor in the MCP sources (tool descriptions, replies, comments)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const hits = readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) =>
    readFileSync(new URL(f, dir), "utf8").split("\n").map((l, i) => [f, i + 1, l]).filter(([, , l]) => /\b(Iris|Flor)\b/.test(l)).map(([f, n]) => `${f}:${n}`));
  assert.deepEqual(hits, []);
});

// ── DD10/DD11: the expediente waits 7 days after the anticipo (tramites-reglas "Cuándo empezar") ──
import { esperaAnticipo, DIAS_ESPERA_ANTICIPO } from "../dist/espera.js";
const ANTICIPO = "2026-11-13T18:00:00Z"; // 12:00 Monterrey, Friday 13
const DIA = (n) => new Date(Date.parse(ANTICIPO) + n * 86_400_000 + 3600_000).toISOString(); // n days later, 13:00 Mty
const SUBJ = "Trámite nuevo – bidireccional – DD11 – Cliente Prueba";
function esperaHarness({ zona = "DD11", hist = [{ entered_at: ANTICIPO }], fac = null, mode = "shadow", tramite = {}, espera, extra = {} } = {}) {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: mode }],
    "/gestoras": [{ email: "gestora@example.com" }],
    "/projects": [{ id: P1, efu: "EFU-1", zona_cfe: zona, fecha_anticipo_completo: fac, clients: { first_name: "Nombre", last_name: "Cliente" } }],
    "/project_stage_history": hist,
    "/trami_reglas_zona": espera === undefined ? [] : [{ espera_dias: espera }],
    "/project_tramites": [{ ...TRAMITE, stage: "expediente_integracion", enviado: false, ...tramite }],
    ...extra,
  });
  registerMailTools(h.server, h.deps);
  registerTramiteTools(h.server, h.deps);
  return h;
}
const draft = (h, subject = SUBJ, project_id = P1, tramite_id = T1) => h.tools.futurerp_mail_draft({ to: "gestora@example.com", subject, text: "x", project_id, tramite_id });

test("espera: one constant, 7 days", () => assert.equal(DIAS_ESPERA_ANTICIPO, 7));

for (const [n, ok] of [[0, false], [6, false], [7, true]]) {
  test(`espera: expediente email on day ${n} after the anticipo is ${ok ? "allowed" : "refused"}`, atUtc(DIA(n), async () => {
    const r = await draft(esperaHarness());
    if (ok) assert.match(txt(r), /^\(sombra\)/);
    else { assert.equal(r.isError, true); assert.match(txt(r), /anticipo se pagó el 2026-11-13.*desde el 2026-11-20.*nota en el timeline/); }
  }));
  test(`espera: enviado=true / documentacion_con_gestor on day ${n} is ${ok ? "allowed" : "refused"}`, atUtc(DIA(n), async () => {
    const h = esperaHarness({ extra: gestoraDice("Ingresado Nombre Cliente SI261118DA76F1EE") });
    for (const patch of [{ enviado: true }, { stage: "documentacion_con_gestor" }, { stage: "folio_ingresado", numero_si: "SI261118DA76F1EE" }]) {
      const r = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch, evidencia: { wa_message_id: "WA-G" } });
      if (ok) assert.match(txt(r), /^\(sombra\)/, JSON.stringify(patch));
      else assert.match(txt(r), /desde el 2026-11-20/, JSON.stringify(patch));
    }
  }));
}

test("espera: live mode refuses too, and nothing is written", atUtc(DIA(0), async () => {
  const h = esperaHarness({ mode: "live" });
  const r = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { enviado: true } });
  assert.equal(r.isError, true);
  assert.ok(!h.writes.some((w) => w.method === "PATCH"));
}));

test("espera: no anticipo paid at all is refused; fecha_anticipo_completo is the fallback", atUtc(DIA(7), async () => {
  assert.match(txt(await draft(esperaHarness({ hist: [] }))), /no hay anticipo pagado/);
  assert.match(txt(await draft(esperaHarness({ hist: [], fac: "2026-11-13" }))), /^\(sombra\)/);
  assert.match(txt(await draft(esperaHarness({ hist: [], fac: "2026-11-15" }))), /desde el 2026-11-22/);
}));

test("espera: an expediente without tramite_id is refused; without project_id the trámite's project is used", atUtc(DIA(0), async () => {
  assert.match(txt(await draft(esperaHarness(), SUBJ, P1, "")), /lleva tramite_id/);
  assert.match(txt(await draft(esperaHarness(), SUBJ, "")), /desde el 2026-11-20/);
}));

test("espera: other zones, other tipos, other emails and other fields are unaffected on day 0", atUtc(DIA(0), async () => {
  for (const zona of ["DD12", "DD06", "foraneo"]) {
    const h = esperaHarness({ zona });
    assert.match(txt(await draft(h, `Trámite nuevo – bidireccional – ${zona} – Cliente`)), /^\(sombra\)/, zona);
    assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { enviado: true } })), /^\(sombra\)/, zona);
  }
  const h = esperaHarness();
  const cnMail = esperaHarness({ tramite: { tipo: "cambio_nombre" } });
  assert.match(txt(await draft(cnMail, "Trámite nuevo – cambio de nombre – DD11 – Cliente")), /^\(sombra\)/);
  assert.match(txt(await draft(cnMail, "Seguimiento SI-123")), /^\(sombra\)/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { ultimo_estatus_cfe: "en revisión" } })), /^\(sombra\)/);
  const cn = esperaHarness({ tramite: { tipo: "cambio_nombre", stage: "pendiente" } });
  assert.match(txt(await cn.tools.futurerp_tramite_update({ tramite_id: T1, patch: { enviado: true } })), /^\(sombra\)/);
}));

test("espera: the exemption comes from the trámite's tipo, never from the subject (QA 3a)", atUtc(DIA(0), async () => {
  // A bidireccional whose client is called Altamirano / Nombredios / ... still waits.
  for (const s of ["Trámite nuevo – bidireccional – DD11 – Juan Altamirano", "Trámite nuevo – bidireccional – DD11 – Nombredios", "Trámite nuevo – Bidireccional 220 – UVIE lista"]) {
    const r = await draft(esperaHarness(), s);
    assert.equal(r.isError, true, s);
    assert.match(txt(r), /desde el 2026-11-20/, s);
  }
  // A cambio de nombre goes on day 0 whatever the subject says.
  assert.match(txt(await draft(esperaHarness({ tramite: { tipo: "cambio_nombre" } }), SUBJ)), /^\(sombra\)/);
  // No tramite_id, or another project's trámite: refused, never waved through.
  assert.match(txt(await draft(esperaHarness(), SUBJ, P1, "")), /lleva tramite_id/);
  assert.match(txt(await draft(esperaHarness({ tramite: { project_id: "33333333-3333-4333-8333-333333333333" } }), SUBJ)), /no es del proyecto/);
}));

test("espera: every gestora/CFE email names its trámite and waits by its tipo, never by the subject (QA Pass B)", atUtc(DIA(0), async () => {
  const TC = "77777777-7777-4777-8777-777777777777"; // the project's cambio de nombre
  const F_BIDI = "66666666-6666-4666-8666-666666666661";   // linked to the bidireccional
  const F_INE = "66666666-6666-4666-8666-666666666662";    // unlinked, in the bidireccional's "INE del titular" slot
  const F_CN = "66666666-6666-4666-8666-666666666663";     // linked to the cambio de nombre
  const url = (id) => `https://firebasestorage.googleapis.com/v0/b/x/o/${id}.pdf`;
  const h = (bidi = {}) => esperaHarness({ tramite: bidi, extra: {
    "/project_tramites": (p) => {
      const rows = [{ ...TRAMITE, stage: "expediente_integracion", enviado: false, ...bidi }, { id: TC, project_id: P1, tipo: "cambio_nombre", enviado: false }];
      return p.includes("project_id=eq.") ? rows : rows.filter((r) => p.includes(`id=eq.${r.id}`));
    },
    "/project_files": (p) => [F_BIDI, F_INE, F_CN].filter((id) => p.includes(id) || p.includes(encodeURIComponent(url(id)))).map((id) => ({ id, project_id: P1, firebase_url: url(id), document_id: id === F_INE ? "doc-ine" : null })),
    "/tramite_file_links": (p) => p.includes(F_BIDI) ? [{ tramite_id: T1, doc_key: "Recibo CFE" }] : p.includes(F_CN) ? [{ tramite_id: TC, doc_key: "INE nuevo titular" }] : [],
    "/project_documents": [{ name: "INE del titular" }],
  } });
  const mail = (hh, a) => hh.tools.futurerp_mail_draft({ to: "gestora@example.com", subject: "Hola", text: "x", project_id: P1, ...a });
  // No trámite named: refused, to a gestora or to CFE, with or without files.
  assert.match(txt(await mail(h(), {})), /lleva tramite_id/);
  assert.match(txt(await mail(h(), { to: "zona@cfe.mx" })), /lleva tramite_id/);
  // The unsent bidireccional waits whatever the subject and whether or not it carries files or only links.
  for (const a of [{ subject: "Documentos de Cliente Prueba" }, { subject: "Pregunta" }, { text: `Liga: ${url(F_BIDI)}` }]) {
    assert.match(txt(await mail(h(), { tramite_id: T1, ...a })), /desde el 2026-11-20/, JSON.stringify(a));
  }
  // Naming the cambio de nombre while carrying the bidireccional's files (attached or linked) is refused.
  assert.match(txt(await mail(h(), { tramite_id: TC, attachment_file_ids: [F_BIDI] })), /vinculado a otro trámite/);
  assert.match(txt(await mail(h(), { tramite_id: TC, text: `Liga: ${url(F_BIDI)}` })), /vinculado a otro trámite/);
  assert.match(txt(await mail(h(), { tramite_id: TC, attachment_file_ids: [F_INE] })), /"INE del titular", que pide otro trámite/);
  // Not held: the cambio de nombre with its own files; the bidireccional once sent; the bidireccional on day 7.
  assert.match(txt(await mail(h(), { tramite_id: TC, attachment_file_ids: [F_CN] })), /^\(sombra\)/);
  assert.match(txt(await mail(h({ enviado: true }), { tramite_id: T1, attachment_file_ids: [F_BIDI] })), /^\(sombra\)/);
  await atUtc(DIA(7), async () => assert.match(txt(await mail(h(), { tramite_id: T1, attachment_file_ids: [F_BIDI, F_INE] })), /^\(sombra\)/))();
}));

test("espera: the anticipo day is the Monterrey day (21:00 Mty = 03:00 UTC next day)", async () => {
  const sb = async (path) => path.startsWith("/projects") ? [{ id: P1, efu: "E", zona_cfe: "DD10" }] : [{ entered_at: "2026-11-14T03:00:00Z" }];
  assert.match(await esperaAnticipo(sb, {}, P1, Date.parse("2026-11-19T18:00:00Z")), /pagó el 2026-11-13.*desde el 2026-11-20/);
  assert.equal(await esperaAnticipo(sb, {}, P1, Date.parse("2026-11-20T18:00:00Z")), null);
});

test("espera: Ajustes can raise the wait (10 waits 10) but not lower it (3 still waits 7)", async () => {
  for (const [espera, n, ok] of [[10, 7, false], [10, 9, false], [10, 10, true], [3, 3, false], [3, 6, false], [3, 7, true], [7, 7, true]]) {
    await atUtc(DIA(n), async () => {
      const r = await draft(esperaHarness({ espera }));
      if (ok) assert.match(txt(r), /^\(sombra\)/, `espera ${espera} day ${n}`);
      else assert.match(txt(r), new RegExp(`\\(${Math.max(7, espera)} días después`), `espera ${espera} day ${n}`);
    })();
  }
});

// ── Guards en vivo (QA eval part 2): client WhatsApp = allowed templates only; a stage moves only on a gestora event ──
import { plantillaDe } from "../dist/plantillas.js";
const GRUPO = "120363420531947860@g.us";
const CLIENTE = "528100000001"; // G18's chat, phone replaced
const INTRO = "Soy la asistente de tramitología de Future Energy, te estaré enviando actualizaciones de tus trámites con CFE.";
const INGRESO = (nombre, extra = "") => `Hola ${nombre}, buen día.${extra} Te informamos que tu trámite ya fue ingresado y está en proceso interno con CFE. *N° de Seguimiento*: SI2608060791002. *Fecha de ingreso*: 6 de agosto. Normalmente CFE tarda de 2 a 4 meses; te vamos avisando.`;
const CLIENTE_DB = { first_name: "Nombre", last_name: "Cliente", mobile_phone: CLIENTE, phone: null };
function waHarness() {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }],
    "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1" }], "/clients": [],
    "/gestoras": [{ nombre: "Gestora A", activo: true, telefono: GESTORA_TEL, whatsapp_chat_ids: [GRUPO] }],
    "/project_tramites": [{ ...TRAMITE, numero_si: "SI2608060791002" }],
    "/projects": [{ id: P1, razon_social: null, clients: CLIENTE_DB }],
  });
  registerTramiteTools(h.server, h.deps);
  return h;
}

test("plantillas: each template matches filled; extra text, free text in a hueco or a bad SI does not", () => {
  assert.equal(plantillaDe(INGRESO("Nombre Cliente")), "ingreso");
  assert.equal(plantillaDe(INGRESO("Nombre Cliente", ` ${INTRO}`)), "ingreso", "introduction after the greeting");
  assert.equal(plantillaDe(`  ${INGRESO("José Ñúñez").replace(/ /g, "  ")}\n`), "ingreso", "whitespace is not content");
  assert.equal(plantillaDe("Gracias Ana, lo recibimos."), "recibido");
  assert.equal(plantillaDe("Hola Ana, buen día. ¿Nos confirmas si CFE ya te cambió el medidor? Con eso seguimos con tu trámite."), "confirmar_medidor");
  assert.equal(plantillaDe(INGRESO("Nombre Cliente") + " Hoy CFE emitió el oficio."), null, "sentence added at the end");
  assert.equal(plantillaDe(INGRESO("Nombre Cliente", " Hoy CFE emitió el oficio.")), null, "sentence added after the greeting");
  assert.equal(plantillaDe("Gracias Ana, ya pagaste, lo recibimos."), null, "free text inside {nombre}");
  assert.equal(plantillaDe(INGRESO("Nombre Cliente").replace("SI2608060791002", "pendiente")), null, "{si} must be an SI");
  assert.equal(plantillaDe("hola"), null);
});

test("G18: the exact off-template client message is refused and points to tramitología; nothing is shadowed", atUtc("2026-11-20T18:00:00Z", async () => {
  const h = waHarness();
  // G18's text, client name replaced: introduction + template 2 + an invented sentence about the oficio.
  const g18 = "Hola Nombre Cliente, buen día. Soy la asistente de tramitología de Future Energy, te estaré enviando actualizaciones de tus trámites con CFE. Te informamos que tu trámite ya fue ingresado y está en proceso con CFE. *N° de Seguimiento*: SI2608060791002. *Fecha de ingreso*: 6 de agosto. Hoy CFE emitió el oficio de resolución y estamos atendiendo el siguiente paso (la inspección). Normalmente CFE tarda de 2 a 4 meses; te vamos avisando.";
  const r = await h.tools.futurerp_whatsapp_send({ chat_id: CLIENTE, text: g18, tramite_id: T1 });
  assert.equal(r.isError, true);
  assert.match(txt(r), /no es una de las plantillas.*pregúntale a tramitología.*pregunta_para_tramitologia=true/);
  assert.equal(shadowRows(h.writes).length, 0);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: CLIENTE, text: INGRESO("Nombre Cliente", ` ${INTRO}`), tramite_id: T1 })), /^\(sombra\)/, "the template itself goes");
}));

test("plantillas: {si} is this trámite's SI, {nombre} the client's, the chat the client's phone, and no files (QA)", atUtc("2026-11-20T18:00:00Z", async () => {
  const h = waHarness();
  const send = (a) => h.tools.futurerp_whatsapp_send({ chat_id: CLIENTE, tramite_id: T1, ...a });
  // An invented SI in the estatus template (the G23/G33 failure) and a valid-looking SI of another trámite.
  assert.match(txt(await send({ text: INGRESO("Nombre").replace("SI2608060791002", "SI261120EVAL09") })), /El SI SI261120EVAL09 no es el número de seguimiento guardado/);
  // Free words in {nombre}: "Cesar urge pagar hoy" is 4 words of letters, not the client's name.
  assert.match(txt(await send({ text: INGRESO("Cesar urge pagar hoy") })), /no es el nombre del cliente/);
  assert.match(txt(await send({ text: INGRESO("Nombre"), media_url: FB("algo.pdf") })), /no se le mandan archivos/);
  assert.match(txt(await send({ text: INGRESO("Nombre"), tramite_id: undefined })), /lleva el tramite_id/);
  assert.match(txt(await send({ text: INGRESO("Nombre"), chat_id: "5218100000002" })), /no es un teléfono del cliente de este trámite/);
  assert.equal(shadowRows(h.writes).length, 0);
  assert.match(txt(await send({ text: INGRESO("Nombre") })), /^\(sombra\)/, "first name + its own SI");
}));

test("allow-list: a gestora's group gets free text (G22's summary to the group still goes)", atUtc("2026-11-20T18:00:00Z", async () => {
  const h = waHarness();
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: GRUPO, text: "Hola, buen día. Resumen de ingresos de esta semana: 14 bidireccionales." })), /^\(sombra\)/);
}));

const T2 = "33333333-3333-4333-8333-333333333333";
const FB = (n) => `https://firebasestorage.googleapis.com/v0/b/x/o/${n}`;
const F = {
  gestora: "44444444-4444-4444-8444-444444444441",  // the PDF the gestora sent in her group
  cliente: "44444444-4444-4444-8444-444444444442",  // the photo the client sent
  persona: "44444444-4444-4444-8444-444444444443",  // a salesperson/installer upload
  anexo: "44444444-4444-4444-8444-444444444444",    // already in this trámite's Anexo 2 slot
  otro: "44444444-4444-4444-8444-444444444445",     // another project's file
  g22: "2304f7e0-9906-4229-a02b-19306f1f5b25",      // G22's file
  ajeno: "44444444-4444-4444-8444-444444444446",    // a photo that came from ANOTHER client's chat
  anexoScan: "44444444-4444-4444-8444-444444444447", // a scanned comprobante in Anexo 2 (no text layer)
  anexoOtro: "44444444-4444-4444-8444-444444444448", // a text comprobante in Anexo 2 that is ANOTHER client's
};
const FILES = [
  { id: F.gestora, project_id: P1, firebase_url: FB("comprobante.pdf"), uploaded_by: "trami-uid" },
  { id: F.cliente, project_id: P1, firebase_url: FB("medidor.jpg"), uploaded_by: "trami-uid" },
  { id: F.persona, project_id: P1, firebase_url: FB("recibo.pdf"), uploaded_by: "vendedor-uid" },
  { id: F.anexo, project_id: P1, firebase_url: FB("anexo.pdf"), uploaded_by: "trami-uid" },
  { id: F.otro, project_id: "otro-proyecto", firebase_url: FB("otro.pdf"), uploaded_by: "vendedor-uid" },
  { id: F.g22, project_id: P1, firebase_url: FB("g22.pdf"), uploaded_by: "trami-uid" },
  { id: F.ajeno, project_id: P1, firebase_url: FB("ajeno.jpg"), uploaded_by: "trami-uid" },
  { id: F.anexoScan, project_id: P1, firebase_url: FB("anexo-escaneado.pdf"), uploaded_by: "trami-uid" },
  { id: F.anexoOtro, project_id: P1, firebase_url: FB("anexo-otro.pdf"), uploaded_by: "trami-uid" },
];
const STAFF_TEL = "5218100000007";  // someone of ours in the gestora's group (G22's trigger was Ana Karen's question)
const MSGS = [
  { wa: "WA-GESTORA", cv: "cv-g", sender: GESTORA_TEL, media: FB("comprobante.pdf"), body: "Ingresado Nombre Cliente, SI261120AAAA0001" },
  { wa: "WA-GESTORA-OTRO", cv: "cv-g", sender: GESTORA_TEL, media: null, body: "Ingresado Pedro Otro Persona, SI261120ZZZZ0009" },
  { wa: "WA-STAFF", cv: "cv-g", sender: STAFF_TEL, media: FB("staff.pdf"), body: "¿Ya quedó ingresado Nombre Cliente? Su SI es SI261120AAAA0001" },
  { wa: "WA-CLIENTE", cv: "cv-c", sender: null, media: FB("medidor.jpg"), body: "" },
  { wa: "WA-AJENO", cv: "cv-x", sender: null, media: FB("ajeno.jpg"), body: "" },
  { wa: "WA-NORTE-MAL", cv: "cv-g", sender: GESTORA_TEL, media: null, body: "Ingresado Ferretería del Norte SA de CV" },
  { wa: "WA-NORTE-OK", cv: "cv-g", sender: GESTORA_TEL, media: null, body: "Ingresado ACEROS GARZA del norte" },
];
function etapaHarness(tramite = {}, proyecto = {}) {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }],
    "/project_tramites": [{ ...TRAMITE, id: T2, stage: "documentacion_con_gestor", numero_si: "SI261118DA76F1EE", fecha_ingreso: "2026-11-18", enviado: true, ...tramite }],
    "/gestoras": [{ nombre: "Gestora A", activo: true, telefono: GESTORA_TEL, whatsapp_chat_ids: [GRUPO] }],
    "/projects": [{ id: P1, razon_social: null, clients: CLIENTE_DB, ...proyecto }],
    "/whatsapp_messages": (p) => {
      if (!p.includes("direction=eq.inbound")) return [];
      return MSGS.filter((x) => p.includes(`wa_message_id=eq.${x.wa}&`) || (x.media && p.includes(`media_url=eq.${encodeURIComponent(x.media)}`)))
        .map((m) => ({ conversation_id: m.cv, media_url: m.media, body: m.body, sender_phone: m.sender }));
    },
    "/whatsapp_conversations": (p) => [{ chat_id: p.includes("cv-g") ? GRUPO : p.includes("cv-x") ? "5218100000002@c.us" : `${CLIENTE}@c.us` }],
    "/project_files": (p) => FILES.filter((f) => p.includes(f.id)),
    "/tramite_file_links": (p) => p.includes(F.anexo) || p.includes(F.anexoScan) || p.includes(F.anexoOtro) ? [{ tramite_id: T2, doc_key: "Anexo 2" }] : [],
  });
  h.deps.textoPdf = async (url) => PDF_TEXTO[url] ?? null;
  registerTramiteTools(h.server, h.deps);
  return h;
}
// The comprobante already in Anexo 2 has a text layer; the scanned one has none.
const PDF_TEXTO = {
  [FB("anexo.pdf")]: "ANEXO 2 Comprobante de ingreso. Solicitante: Nombre Cliente. Número de seguimiento SI261120CCCC0003.",
  [FB("anexo-otro.pdf")]: "ANEXO 2 Comprobante de ingreso. Solicitante: Pedro Otro Persona. Número de seguimiento SI261120DDDD0004.",
};

test("G22: the exact stage move without evidence is refused and becomes a question for tramitología", async () => {
  const h = etapaHarness();
  const r = await h.tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "en_seguimiento_cfe" }, motivo: "La gestora mandó el comprobante de ingreso con SI SI261118DA76F1EE (18/11); el trámite ya tenía SI y fecha de ingreso pero seguía en documentacion_con_gestor." });
  assert.equal(r.isError, true);
  assert.match(txt(r), /necesita evidencia: .*mandó la gestora \(desde su número.*pregúntale a tramitología/);
  assert.equal(shadowRows(h.writes).length, 0);
  // Re-sending the SI it already had is not a new SI.
  assert.equal((await h.tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "en_seguimiento_cfe", numero_si: "SI261118DA76F1EE" } })).isError, true);
});

test("evidencia: a new SI, the gestora's message or file, or the comprobante in Anexo 2 moves the stage; nothing else does", async () => {
  const mueve = (extra) => etapaHarness().tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "en_seguimiento_cfe", ...(extra.patch ?? {}) }, evidencia: extra.evidencia });
  for (const [why, extra, ok] of [
    ["a new SI written in her message", { patch: { numero_si: "SI261120AAAA0001" }, evidencia: { wa_message_id: "WA-GESTORA" } }, true],
    ["a new SI written in the message that carried her file", { patch: { numero_si: "SI261120AAAA0001" }, evidencia: { file_id: F.gestora } }, true],
    ["an invented SI, no evidence", { patch: { numero_si: "SI261120AAAA0001" } }, false],
    ["an SI that is not in her message", { patch: { numero_si: "SI261120BBBB0002" }, evidencia: { wa_message_id: "WA-GESTORA" } }, false],
    ["gestora's message naming this client", { evidencia: { wa_message_id: "WA-GESTORA" } }, true],
    ["gestora's message about another client", { evidencia: { wa_message_id: "WA-GESTORA-OTRO" } }, false],
    ["Ana Karen's question in the gestora's group (G22's trigger)", { evidencia: { wa_message_id: "WA-STAFF" } }, false],
    ["file the gestora sent", { evidencia: { file_id: F.gestora } }, true],
    ["file already in this trámite's Anexo 2", { evidencia: { file_id: F.anexo } }, true],
    ["our own (outbound) message", { evidencia: { wa_message_id: "WA-NUESTRO" } }, false],
    ["a client's message", { evidencia: { wa_message_id: "WA-CLIENTE" } }, false],
    ["the client's photo", { evidencia: { file_id: F.cliente } }, false],
    ["any other project file (a person's upload)", { evidencia: { file_id: F.persona } }, false],
    ["G22's file, not from the gestora nor in Anexo 2", { evidencia: { file_id: F.g22 } }, false],
    ["file of another project", { evidencia: { file_id: F.otro } }, false],
  ]) {
    const r = await mueve(extra);
    if (ok) assert.match(txt(r), /^\(sombra\)/, why);
    else assert.match(txt(r), /necesita evidencia/, why);
  }
  // Meter installed: the client's or installer's photo is the evidence; their word alone is a question.
  const medidor = (evidencia) => etapaHarness({ stage: "c0b_emitida" }).tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "medidor_instalado" }, evidencia });
  assert.match(txt(await medidor({ file_id: F.cliente })), /^\(sombra\)/, "client's WhatsApp photo");
  assert.match(txt(await medidor({ file_id: F.persona })), /^\(sombra\)/, "installer's upload");
  assert.match(txt(await medidor(undefined)), /necesita evidencia: evidencia.file_id de la foto/);
  assert.match(txt(await medidor({ wa_message_id: "WA-CLIENTE" })), /necesita evidencia/, "a client message without the photo as file");
  assert.match(txt(await medidor({ file_id: F.otro })), /necesita evidencia/);
  assert.match(txt(await medidor({ file_id: F.ajeno })), /necesita evidencia/, "a photo from another client's chat");
  // An SI alone (no stage) needs the same evidence; an SI not in it is refused by name.
  const si = (patch, evidencia) => etapaHarness().tools.futurerp_tramite_update({ tramite_id: T2, patch, evidencia });
  assert.match(txt(await si({ numero_si: "SI261120BBBB0002" })), /Poner el numero_si SI261120BBBB0002 necesita evidencia/);
  assert.match(txt(await si({ numero_si: "SI261120BBBB0002" }, { wa_message_id: "WA-GESTORA" })), /tiene que venir escrito, junto con el nombre del cliente, en el mensaje de la gestora/);
  assert.match(txt(await si({ numero_si: "SI261120AAAA0001" }, { wa_message_id: "WA-STAFF" })), /necesita evidencia/, "staff wrote the SI, not the gestora");
  assert.match(txt(await si({ numero_si: "SI261120AAAA0001" }, { wa_message_id: "WA-GESTORA" })), /^\(sombra\)/);
  // Not stage or SI changes: no evidence needed.
  const h = etapaHarness();
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T2, patch: { ultimo_estatus_cfe: "en revisión" } })), /^\(sombra\)/);
  const h2 = etapaHarness({ stage: "expediente_integracion", enviado: false, tipo: "cambio_nombre" });
  assert.doesNotMatch(txt(await h2.tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "documentacion_con_gestor" } })), /necesita evidencia/, "our own send");
});

test("link_file: G22's exact call is refused; only a file from the triggering message, or a person's upload into this trámite's own slots", async () => {
  const link = (a) => etapaHarness().tools.futurerp_tramite_link_file({ tramite_id: T2, ...a });
  const no = /Solo vinculas un archivo que llegó en el mensaje.*pregúntale a tramitología/;
  // G22: linked a file as Anexo 2 while answering a question, with nothing tying it to a message.
  const hg = etapaHarness();
  assert.match(txt(await hg.tools.futurerp_tramite_link_file({ tramite_id: T2, file_id: F.g22, doc_key: "Anexo 2" })), no);
  assert.equal(shadowRows(hg.writes).length, 0, "nothing shadowed");
  // The gestora's PDF with the message that carried it: yes. With a message that carried something else: no.
  assert.match(txt(await link({ file_id: F.gestora, doc_key: "Anexo 2", evidencia: { wa_message_id: "WA-GESTORA" } })), /^\(sombra\)/);
  assert.match(txt(await link({ file_id: F.g22, doc_key: "Anexo 2", evidencia: { wa_message_id: "WA-GESTORA" } })), no);
  // A client's attachment registered by url: needs its message.
  assert.match(txt(await link({ url: FB("medidor.jpg"), name: "medidor.jpg", doc_key: "Imagenes Instalacion", evidencia: { wa_message_id: "WA-CLIENTE" } })), /^\(sombra\)/);
  assert.match(txt(await link({ url: FB("medidor.jpg"), name: "medidor.jpg", doc_key: "Imagenes Instalacion" })), no);
  // Same, from another client's chat, or a staff member's PDF in her group: not this trámite's (QA (h)).
  assert.match(txt(await link({ url: FB("ajeno.jpg"), name: "ajeno.jpg", doc_key: "Imagenes Instalacion", evidencia: { wa_message_id: "WA-AJENO" } })), no);
  assert.match(txt(await link({ url: FB("staff.pdf"), name: "staff.pdf", doc_key: "Anexo 2", evidencia: { wa_message_id: "WA-STAFF" } })), no);
  // A salesperson's upload into the bidireccional's own document list (expediente flow): yes; into Anexo 2: no.
  assert.match(txt(await link({ file_id: F.persona, doc_key: "Recibo CFE" })), /^\(sombra\)/);
  assert.match(txt(await link({ file_id: F.persona, doc_key: "Anexo 2" })), no);
  // Another project's file: never.
  assert.match(txt(await link({ file_id: F.otro, doc_key: "Recibo CFE", evidencia: { wa_message_id: "WA-GESTORA" } })), /no es del proyecto de este trámite/);
});

test("QA probe (regression): another client's SI, a truncated SI, an invented SI on the comprobante, never stored", async () => {
  const up = (patch, evidencia) => etapaHarness().tools.futurerp_tramite_update({ tramite_id: T2, patch, evidencia });
  // Her message is about another person: its SI is that person's, alone or with a stage move.
  assert.equal((await up({ numero_si: "SI261120ZZZZ0009" }, { wa_message_id: "WA-GESTORA-OTRO" })).isError, true, "SI only, other client");
  assert.equal((await up({ stage: "en_seguimiento_cfe", numero_si: "SI261120ZZZZ0009" }, { wa_message_id: "WA-GESTORA-OTRO" })).isError, true, "stage + SI, other client");
  // Whole SI tokens: a truncated SI is not in her message.
  assert.equal((await up({ numero_si: "SI261120AAAA" }, { wa_message_id: "WA-GESTORA" })).isError, true, "truncated SI");
  // The comprobante gives an SI only from its readable text.
  assert.match(txt(await up({ numero_si: "SI999INVENTADO" }, { file_id: F.anexo })), /tiene que venir escrito/, "invented SI with the comprobante");
  assert.match(txt(await up({ numero_si: "SI261120CCCC0003" }, { file_id: F.anexo })), /^\(sombra\)/, "the SI the PDF shows");
  assert.match(txt(await up({ numero_si: "SI261120CCCC0003" }, { file_id: F.anexoScan })), /no tiene texto legible.*pregúntale a tramitología/, "scanned PDF: a question");
  assert.match(txt(await up({ stage: "en_seguimiento_cfe" }, { file_id: F.anexoScan })), /^\(sombra\)/, "the scanned comprobante still moves the stage without a new SI");
  // The CURRENT SI still names the trámite (a status message quoting it).
  assert.match(txt(await up({ stage: "en_seguimiento_cfe" }, { wa_message_id: "WA-GESTORA" })), /^\(sombra\)/);
});

test("name match ignores stopwords: 'del Norte SA de CV' is not a razón social's distinctive words", async () => {
  const mueve = (wa) => etapaHarness({}, { razon_social: "Aceros Garza del Norte SA de CV", clients: {} }).tools.futurerp_tramite_update({ tramite_id: T2, patch: { stage: "en_seguimiento_cfe" }, evidencia: { wa_message_id: wa } });
  assert.match(txt(await mueve("WA-NORTE-MAL")), /necesita evidencia/, "shares only del / norte / sa / de / cv");
  assert.match(txt(await mueve("WA-NORTE-OK")), /^\(sombra\)/, "aceros + garza");
});

test("a text comprobante in Anexo 2 gives its SI only when it also names this client", async () => {
  const up = (patch, evidencia) => etapaHarness().tools.futurerp_tramite_update({ tramite_id: T2, patch, evidencia });
  assert.match(txt(await up({ numero_si: "SI261120DDDD0004" }, { file_id: F.anexoOtro })), /junto con el nombre del cliente/, "another client's PDF");
  assert.match(txt(await up({ numero_si: "SI261120CCCC0003" }, { file_id: F.anexo })), /^\(sombra\)/, "this client's PDF");
});

test("fecha_ingreso and the subsanación fields need the same evidence as a stage move", async () => {
  const up = (patch, evidencia) => etapaHarness().tools.futurerp_tramite_update({ tramite_id: T2, patch, evidencia });
  assert.match(txt(await up({ fecha_ingreso: "2026-11-10" })), /^Cambiar fecha_ingreso necesita evidencia/);
  assert.match(txt(await up({ subsanacion_active: true, motivo_subsanacion: "adeudo", fecha_subsanacion: "2026-11-20" })), /^Cambiar subsanacion_active, motivo_subsanacion, fecha_subsanacion necesita evidencia/);
  assert.match(txt(await up({ fecha_ingreso: "2026-11-18" })), /^\(sombra\)/, "an unchanged date needs nothing");
  assert.match(txt(await up({ fecha_ingreso: "2026-11-10" }, { wa_message_id: "WA-GESTORA" })), /^\(sombra\)/, "her message naming the client");
  assert.match(txt(await up({ fecha_ingreso: "2026-11-10" }, { file_id: F.anexo })), /^\(sombra\)/, "the comprobante dates the ingreso");
  assert.match(txt(await up({ subsanacion_active: true, motivo_subsanacion: "adeudo" }, { file_id: F.anexo })), /necesita evidencia/, "an ingreso comprobante proves no subsanación");
  assert.match(txt(await up({ subsanacion_active: true, motivo_subsanacion: "adeudo" }, { wa_message_id: "WA-GESTORA" })), /^\(sombra\)/);
  // QA round 4: fecha_resolucion too.
  assert.match(txt(await up({ fecha_resolucion: "2026-11-20" })), /^Cambiar fecha_resolucion necesita evidencia/);
  assert.match(txt(await up({ fecha_resolucion: "2026-11-20" }, { file_id: F.anexo })), /necesita evidencia/, "an ingreso comprobante proves no resolution");
  assert.match(txt(await up({ fecha_resolucion: "2026-11-20" }, { wa_message_id: "WA-GESTORA" })), /^\(sombra\)/);
});
