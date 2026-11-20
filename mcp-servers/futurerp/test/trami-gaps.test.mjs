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

const TRAMITE = { id: T1, project_id: P1, tipo: "primary_bidireccional_dd11", stage: "en_seguimiento_cfe", numero_si: "SI-OLD", fecha_ingreso: "2026-10-01", type_data: {} };

test("fix 7: a tool in trami_tools_live runs while the global mode is shadow; the rest stays shadow", async () => {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }, { config_key: "trami_tools_live", config_value: '["futurerp_tramite_update"]' }],
    "/project_tramites": [TRAMITE],
    "/projects": [{ id: P1, efu: "EFU-1", owner_id: null }],
  });
  registerTramiteTools(h.server, h.deps);
  const live = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { numero_si: "SI-NEW" } });
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
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { numero_si: "X" } })), /^\(sombra\)/);
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
  h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1" }], "/clients": [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes("/whatsapp_messages") ? new Response("[]", { headers: { "content-range": "0-0/20" } }) : realFetch(url, init);
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "5218100000000", text: "hola" })), /Tope alcanzado: 20/);

  resetModeCache();
  h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/whatsapp_channels": [{ id: "ch1" }], "/whatsapp_conversations": [{ id: "c1" }], "/clients": [], "/gestoras": [{ nombre: "Gestora A", activo: true, whatsapp_chat_ids: ["120363420531947860@g.us"] }] });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_whatsapp_send({ chat_id: "120363420531947860@g.us", text: "hola" })), /^\(sombra\)/);
  assert.equal(shadowRows(h.writes)[0].body.modo, undefined, "shadow row (default modo sombra)");
}));

test("fix 6: a shadow mail draft to a non-allowed address is refused", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "shadow" }], "/gestoras": [{ email: "gestora@example.com" }] });
  registerMailTools(h.server, h.deps);
  const bad = await h.tools.futurerp_mail_draft({ to: "alguien@gmail.com", subject: "Trámite", text: "x" });
  assert.equal(bad.isError, true);
  assert.match(txt(bad), /Destinatario no permitido/);
  assert.equal(shadowRows(h.writes).length, 0);
  assert.match(txt(await h.tools.futurerp_mail_draft({ to: "gestora@example.com", subject: "Trámite", text: "x" })), /^\(sombra\)/);
  assert.match(txt(await h.tools.futurerp_mail_draft({ to: "zona@cfe.mx", subject: "Trámite", text: "x" })), /^\(sombra\)/);
});

test("fix 3: re-ingreso goes back with motivo and archives the previous SI; plain update still forward-only", async () => {
  resetModeCache();
  const h = harness({ "/system_config": [{ config_key: "trami_mode", config_value: "live" }], "/project_tramites": [TRAMITE] });
  registerTramiteTools(h.server, h.deps);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado" } })), /nunca se mueve hacia atrás.*reingreso=true/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado" }, reingreso: true })), /necesita motivo/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "expediente_integracion" }, reingreso: true, motivo: "CFE canceló la orden" })), /no regresa a expediente_integracion/);

  const ok = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { stage: "folio_ingresado", numero_si: "SI-NEW", fecha_ingreso: "2026-11-20" }, reingreso: true, motivo: "Iris: cancelaron la orden, reingresado" });
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
function esperaHarness({ zona = "DD11", hist = [{ entered_at: ANTICIPO }], fac = null, mode = "shadow", tramite = {} } = {}) {
  resetModeCache();
  const h = harness({
    "/system_config": [{ config_key: "trami_mode", config_value: mode }],
    "/gestoras": [{ email: "gestora@example.com" }],
    "/projects": [{ id: P1, efu: "EFU-1", zona_cfe: zona, fecha_anticipo_completo: fac, clients: {} }],
    "/project_stage_history": hist,
    "/project_tramites": [{ ...TRAMITE, stage: "expediente_integracion", enviado: false, ...tramite }],
  });
  registerMailTools(h.server, h.deps);
  registerTramiteTools(h.server, h.deps);
  return h;
}
const draft = (h, subject = SUBJ, project_id = P1) => h.tools.futurerp_mail_draft({ to: "gestora@example.com", subject, text: "x", project_id });

test("espera: one constant, 7 days", () => assert.equal(DIAS_ESPERA_ANTICIPO, 7));

for (const [n, ok] of [[0, false], [6, false], [7, true]]) {
  test(`espera: expediente email on day ${n} after the anticipo is ${ok ? "allowed" : "refused"}`, atUtc(DIA(n), async () => {
    const r = await draft(esperaHarness());
    if (ok) assert.match(txt(r), /^\(sombra\)/);
    else { assert.equal(r.isError, true); assert.match(txt(r), /anticipo se pagó el 2026-11-13.*desde el 2026-11-20.*nota en el timeline/); }
  }));
  test(`espera: enviado=true / documentacion_con_gestor on day ${n} is ${ok ? "allowed" : "refused"}`, atUtc(DIA(n), async () => {
    const h = esperaHarness();
    for (const patch of [{ enviado: true }, { stage: "documentacion_con_gestor" }, { stage: "folio_ingresado" }]) {
      const r = await h.tools.futurerp_tramite_update({ tramite_id: T1, patch });
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

test("espera: an expediente email without project_id is refused", atUtc(DIA(7), async () => {
  assert.match(txt(await draft(esperaHarness(), SUBJ, "")), /lleva project_id/);
}));

test("espera: other zones, other tipos, other emails and other fields are unaffected on day 0", atUtc(DIA(0), async () => {
  for (const zona of ["DD12", "DD06", "foraneo"]) {
    const h = esperaHarness({ zona });
    assert.match(txt(await draft(h, `Trámite nuevo – bidireccional – ${zona} – Cliente`)), /^\(sombra\)/, zona);
    assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { enviado: true } })), /^\(sombra\)/, zona);
  }
  const h = esperaHarness();
  assert.match(txt(await draft(h, "Trámite nuevo – cambio de nombre – DD11 – Cliente")), /^\(sombra\)/);
  assert.match(txt(await draft(h, "Seguimiento SI-123")), /^\(sombra\)/);
  assert.match(txt(await h.tools.futurerp_tramite_update({ tramite_id: T1, patch: { numero_si: "SI-1" } })), /^\(sombra\)/);
  const cn = esperaHarness({ tramite: { tipo: "cambio_nombre", stage: "pendiente" } });
  assert.match(txt(await cn.tools.futurerp_tramite_update({ tramite_id: T1, patch: { enviado: true } })), /^\(sombra\)/);
}));

test("espera: the anticipo day is the Monterrey day (21:00 Mty = 03:00 UTC next day)", async () => {
  const sb = async (path) => path.startsWith("/projects") ? [{ id: P1, efu: "E", zona_cfe: "DD10" }] : [{ entered_at: "2026-11-14T03:00:00Z" }];
  assert.match(await esperaAnticipo(sb, {}, P1, Date.parse("2026-11-19T18:00:00Z")), /pagó el 2026-11-13.*desde el 2026-11-20/);
  assert.equal(await esperaAnticipo(sb, {}, P1, Date.parse("2026-11-20T18:00:00Z")), null);
});
