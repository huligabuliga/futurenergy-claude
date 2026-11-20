/**
 * Trámite write tools (Trami, Sprint 1 — TRM-10/11).
 *
 * Every tool runs under the caller's token: RLS decides what the user may
 * touch, `created_by` / `updated_by` are stamped by the audit trigger, and
 * the guards here only add what the UI enforces client-side (forward-only
 * stages, no-op on unchanged values, catalog enums). Registered only for
 * users with `tramites.manage` (Trami's ERP user and the tramitología team).
 *
 * Stage lists, labels and document catalog mirror pronto-resolver-61:
 * src/types/tramite.ts and src/config/tramiteRequirements.ts. Keep in sync.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardedTool, setShadowCheck } from "./guard.js";
import { esperaAnticipo } from "./espera.js";
import { leerPlantilla, listaPlantillas } from "./plantillas.js";
import { textoPdf } from "./documents.js";

export interface TramiteDeps {
  /** PDF text reader (tests stub it). */
  textoPdf?: (href: string) => Promise<string | null>;
  userId: string;
  restBase: string;
  uuidRx: RegExp;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  /** Service-role headers: only for the WhatsApp tables, which have no user INSERT policy. */
  serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
  sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
  sbRpc: (name: string, args?: Record<string, any>) => Promise<any>;
}

const OPENWA_API_URL = (process.env.OPENWA_API_URL ?? "").replace(/\/$/, "");
const OPENWA_API_KEY = process.env.OPENWA_API_KEY ?? "";
const WA_SENDS_PER_HOUR = 20;
const WA_HOUR_FROM = 8;   // Monterrey, UTC-6 (no DST since 2022)
const WA_HOUR_TO = 19;
const CIERRE_ITEMS = ["medidor_instalado", "sistema_inyectando", "cliente_entiende", "acta_conformidad"] as const;

// ── catalog (mirror of the app) ─────────────────────────────────────────────
const PRIMARY_STAGES = ["expediente_integracion", "documentacion_con_gestor", "folio_ingresado", "en_seguimiento_cfe", "c0b_emitida", "medidor_instalado", "sistema_activado"];
const CAMBIO_NOMBRE_STAGES = ["deteccion", "solicitar_documentos", "documentos_recibidos", "enviado_a_gestor", "ingresado_cfe", "en_seguimiento", "concluido"];
const CAMBIO_TARIFA_STAGES = ["deteccion", "enviado_a_gestor", "ingresado", "en_seguimiento", "concluido"];
const FACTIBILIDAD_STAGES = ["solicitud", "en_estudio_cfe", "dictamen_emitido", "concluido"];
const CAMBIO_220V_STAGES = ["deteccion", "evaluacion_tecnica", "enviado_a_gestor", "ingresado", "ejecutado", "concluido"];
const SERVICIO_STAGES = ["deteccion", "enviado_a_gestor", "ingresado", "ejecutado", "concluido"];
const UVIE_UIIE_STAGES = ["contratacion_uvie", "inspeccion", "dictamen_uvie", "dictamen_uiie", "concluido"];

export const TRAMITE_STAGES: Record<string, string[]> = {
  primary_bidireccional_dd11: PRIMARY_STAGES,
  primary_dd10: PRIMARY_STAGES,
  primary_dd12: PRIMARY_STAGES,
  primary_dd06: PRIMARY_STAGES,
  primary_foraneo: PRIMARY_STAGES,
  cambio_nombre: CAMBIO_NOMBRE_STAGES,
  cambio_tarifa: CAMBIO_TARIFA_STAGES,
  factibilidad: FACTIBILIDAD_STAGES,
  cambio_220v: CAMBIO_220V_STAGES,
  uvie_uiie: UVIE_UIIE_STAGES,
  unificacion_cargas: CAMBIO_220V_STAGES,
  alta_servicio: SERVICIO_STAGES,
  baja_servicio: SERVICIO_STAGES,
};
const TIPOS = Object.keys(TRAMITE_STAGES) as [string, ...string[]];
const PRIMARY_TIPOS = new Set(["primary_bidireccional_dd11", "primary_dd10", "primary_dd12", "primary_dd06", "primary_foraneo"]);
const ZONAS = ["DD10", "DD11", "DD12", "DD06", "foraneo"] as const;
const REQUERIDO_LABELS = ["Trámite de medidor bidireccional", "Cambio de nombre", "aumento de voltaje", "Alta de servicio", "Baja de servicio", "UVIE", "UIIE", "Otro"] as const;
const BLOQUEO_CATEGORIAS = ["documentacion_cliente", "pago_financiamiento", "cfe_tramite", "material_proveedor", "interno_capacidad", "clima_sitio", "otro"] as const;
const BLOQUEO_DEPENDENCIAS = ["nosotros", "cliente", "tercero"] as const;
const ACTIVITY_TYPES = ["note", "status_change", "call", "email", "meeting", "assignment", "field_update", "conversion", "system"] as const;

/** Base (non-conditional) document slots the app seeds on create, per tipo. */
const BIDIRECCIONAL_DOCS = ["Recibo CFE", "INE del titular"];
const FACTIBILIDAD_DOCS = ["Recibo CFE", "INE del titular", "Predial o escrituras", "Foto medidor con lecturas", "Foto preparación nuevo servicio"];
export const BASE_DOCS: Record<string, string[]> = {
  primary_bidireccional_dd11: BIDIRECCIONAL_DOCS,
  primary_dd10: BIDIRECCIONAL_DOCS,
  primary_dd12: BIDIRECCIONAL_DOCS,
  primary_dd06: BIDIRECCIONAL_DOCS,
  primary_foraneo: BIDIRECCIONAL_DOCS,
  cambio_nombre: ["Recibo CFE", "INE nuevo titular", "Predial o escrituras"],
  cambio_tarifa: ["Recibo CFE", "INE del titular"],
  factibilidad: FACTIBILIDAD_DOCS,
  cambio_220v: FACTIBILIDAD_DOCS,
  unificacion_cargas: FACTIBILIDAD_DOCS,
  alta_servicio: ["INE del titular", "Predial o escrituras", "Foto preparación nuevo servicio"],
  baja_servicio: ["Recibo CFE", "INE del titular"],
  uvie_uiie: ["Recibo CFE", "INE del titular"],
};
export const SHARED_OPTIONAL_DOCS = ["Imagenes Instalacion", "Comprobante de ingreso"];

/** Columns the agent may patch. Everything else on the row is owned by triggers or people. */
const UPDATABLE = [
  "stage", "numero_si", "fecha_ingreso", "fecha_resolucion", "gestor_cfe", "comentarios",
  "enviado", "subsanacion_active", "fecha_subsanacion", "motivo_subsanacion",
  "c0b_rechazada", "fecha_c0b_rechazada", "pagado", "costo",
  "ultimo_seguimiento_at", "siguiente_revision_at", "docs_solicitados_at", "docs_recordatorio_at",
  "ultimo_estatus_cfe", "ultimo_estatus_cfe_at", "ultimo_estatus_cfe_avisado_at",
] as const;

const FIREBASE_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];

/** Refusal text when `ms` is outside the 08:00–19:00 Monterrey send window, else null. */
export function fueraDeHorario(ms: number): string | null {
  const hour = Math.floor(((ms - 6 * 3600_000) % 86_400_000) / 3_600_000);
  return hour < WA_HOUR_FROM || hour >= WA_HOUR_TO ? `Fuera de horario (${String(hour).padStart(2, "0")}:00 Monterrey). Solo se envía de ${WA_HOUR_FROM}:00 a ${WA_HOUR_TO}:00.` : null;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const });

export function registerTramiteTools(server: McpServer, deps: TramiteDeps) {
  const { userId, restBase, uuidRx, authHeaders, serviceHeaders, sbApi, sbRpc } = deps;
  const leerPdf = deps.textoPdf ?? textoPdf;
  const tool = guardedTool(server, { userId, restBase, uuidRx, sbApi, serviceHeaders });

  async function sbWrite(method: "POST" | "PATCH", path: string, body: unknown, prefer = "return=representation"): Promise<any> {
    const res = await fetch(`${restBase}${path}`, { method, headers: authHeaders({ Prefer: prefer }), body: JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt.slice(0, 400)}`);
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return txt; }
  }

  async function projectRow(idOrEfu: string, select = "id,efu,name,zona_cfe,stage,tramites_requeridos_otro") {
    const col = uuidRx.test(idOrEfu) ? "id" : "efu";
    const rows = await sbApi(`/projects?${col}=eq.${encodeURIComponent(idOrEfu)}&select=${select}&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function logActivity(entityId: string, activityType: string, subject: string, description: string | null, extra: Record<string, unknown> = {}) {
    await sbWrite("POST", "/crm_activities", {
      entity_type: "project",
      entity_id: entityId,
      activity_type: activityType,
      subject,
      description,
      performed_by: userId,
      ...extra,
    }, "return=minimal");
  }

  // ── futurerp_tramite_create ───────────────────────────────────────────────
  tool(
    "futurerp_tramite_create",
    "Create a trámite (CFE procedure) on a project in its first stage and seed its document slots, exactly like the app's 'Nuevo trámite'. Refuses if the project already has a trámite of that tipo; a project has at most ONE primary (bidireccional) trámite, whatever the zona. Logs a note on the project timeline.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      tipo: z.enum(TIPOS).describe("Trámite tipo. Primary tipos follow the project's zona_cfe: DD11→primary_bidireccional_dd11, DD10→primary_dd10, DD12→primary_dd12, DD06→primary_dd06, foraneo→primary_foraneo"),
      comentarios: z.string().optional().describe("Why it is being created (shown on the trámite and in the timeline)"),
    },
    async ({ project_id, tipo, comentarios }) => {
      try {
        const p = await projectRow(project_id);
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        const existing: any[] = await sbApi(`/project_tramites?project_id=eq.${p.id}&select=id,tipo,stage`);
        const clash = existing.find((t) => t.tipo === tipo || (PRIMARY_TIPOS.has(tipo) && PRIMARY_TIPOS.has(t.tipo)));
        if (clash) return fail(`El proyecto ${p.efu ?? p.id} ya tiene un trámite ${clash.tipo} (${clash.id}, etapa ${clash.stage}). No se crea otro.`);
        if (PRIMARY_TIPOS.has(tipo) && p.zona_cfe && !tipo.endsWith(String(p.zona_cfe).toLowerCase()) && !(p.zona_cfe === "DD11" && tipo === "primary_bidireccional_dd11")) {
          return fail(`La zona del proyecto es ${p.zona_cfe}; el tipo primario debe corresponder (recibido ${tipo}).`);
        }
        const [row] = await sbWrite("POST", "/project_tramites", {
          project_id: p.id,
          tipo,
          stage: TRAMITE_STAGES[tipo][0],
          comentarios: comentarios ?? null,
          type_data: {},
          created_by: userId,
        });
        // Document slots: idempotent upsert, never resets an uploaded document.
        const docs = [
          ...(BASE_DOCS[tipo] ?? []).map((name) => ({ project_id: p.id, name, requerido: true })),
          ...SHARED_OPTIONAL_DOCS.map((name) => ({ project_id: p.id, name, requerido: false })),
        ];
        try {
          await sbWrite("POST", "/project_documents?on_conflict=project_id,name", docs, "return=minimal,resolution=ignore-duplicates");
        } catch (e: any) {
          console.warn("[tramites] seed project_documents:", e.message);
        }
        await logActivity(p.id, "note", `Trámite creado: ${tipo}`, comentarios ?? null, { metadata: { tramite_id: row.id, tipo, source: "mcp" } });
        return text(`Trámite ${tipo} creado en ${p.efu ?? p.id}: id ${row.id}, etapa ${row.stage}. Slots de documentos sembrados: ${docs.map((d) => d.name).join(", ")}.`);
      } catch (e: any) {
        return fail(`No se pudo crear el trámite: ${e.message}`);
      }
    },
  );

  /**
   * Marking a primary trámite as sent (enviado=true, or a stage at/after documentacion_con_gestor)
   * waits for the DD10/DD11 week after the anticipo, like the expediente email. Also run in shadow.
   */
  async function envioCheck(cur: any, patch: { stage?: string; enviado?: boolean }, reingreso?: boolean): Promise<string | null> {
    if (reingreso || !String(cur.tipo ?? "").startsWith("primary")) return null;
    const stages = TRAMITE_STAGES[cur.tipo] ?? [];
    const envio = stages.indexOf("documentacion_con_gestor");
    const marca = (patch.enviado === true && !cur.enviado) || (envio >= 0 && patch.stage !== undefined && stages.indexOf(patch.stage) >= envio && stages.indexOf(cur.stage) < envio);
    return marca ? esperaAnticipo(sbApi, serviceHeaders(), cur.project_id) : null;
  }
  // ── Provenance: a file "came" in a WhatsApp message when its firebase_url is that inbound message's media_url ──
  const d10 = (x: unknown) => String(x ?? "").replace(/\D/g, "").slice(-10);
  const plano = (s: unknown) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  /**
   * Who sent an inbound message, by phone: sender_phone (groups), or the chat itself for a 1:1.
   * A group message with no sender_phone has no known sender, so it is nobody's evidence.
   */
  async function leerMensajes(filtro: string): Promise<{ media_url: string | null; body: string; sender: string; deGestora: boolean }[]> {
    const rows: any[] = (await sbApi(`/whatsapp_messages?${filtro}&direction=eq.inbound&select=conversation_id,media_url,body,sender_phone&limit=20`, serviceHeaders())) ?? [];
    if (!rows.length) return [];
    const tels = new Set(((await sbApi(`/gestoras?activo=is.true&select=telefono,activo`, serviceHeaders())) ?? []).filter((g: any) => g.activo).map((g: any) => d10(g.telefono)).filter((t: string) => t.length === 10));
    const out = [];
    for (const m of rows) {
      let sender = d10(m.sender_phone);
      if (!sender) {
        const c = (await sbApi(`/whatsapp_conversations?id=eq.${m.conversation_id}&select=chat_id&limit=1`, serviceHeaders()))?.[0];
        sender = String(c?.chat_id ?? "").endsWith("@c.us") ? d10(c.chat_id) : "";
      }
      out.push({ media_url: m.media_url ?? null, body: String(m.body ?? ""), sender, deGestora: sender.length === 10 && tels.has(sender) });
    }
    return out;
  }
  const mensaje = async (waId: string) => (await leerMensajes(`wa_message_id=eq.${encodeURIComponent(waId)}`))[0] ?? null;
  /** A project file plus the inbound messages that carried it. */
  async function archivo(fileId: string): Promise<any | null> {
    if (!uuidRx.test(fileId)) return null;
    const f = (await sbApi(`/project_files?id=eq.${fileId}&select=id,project_id,firebase_url,uploaded_by&limit=1`, serviceHeaders()))?.[0];
    if (!f) return null;
    const msgs = f.firebase_url ? await leerMensajes(`media_url=eq.${encodeURIComponent(f.firebase_url)}`) : [];
    return { ...f, msgs, dePersona: !!f.uploaded_by && f.uploaded_by !== userId };
  }
  /** The project's client: the names a gestora may write (client, razón social) and the client's phones. */
  async function clienteDe(projectId: string): Promise<{ nombres: string[]; tels: string[] }> {
    const p = (await sbApi(`/projects?id=eq.${projectId}&select=razon_social,clients(first_name,last_name,name,phone,mobile_phone)&limit=1`, serviceHeaders()))?.[0];
    const c = p?.clients ?? {};
    return {
      nombres: [[c.first_name, c.last_name].filter(Boolean).join(" "), c.name, p?.razon_social].filter(Boolean),
      tels: [c.mobile_phone, c.phone].map(d10).filter((t) => t.length === 10),
    };
  }
  const sinEspacios = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toUpperCase();
  /** The SI appears as a whole token (a truncated or longer SI is another SI). */
  const traeSi = (texto: string, si: string | null | undefined) => !!si && String(texto ?? "").toUpperCase().split(/[^A-Z0-9-]+/).includes(sinEspacios(si));
  // Words that say nothing about who the client is ("Comercializadora del Norte SA de CV").
  const VACIAS = new Set(["del", "las", "los", "por", "para", "con", "san", "santa", "grupo", "comercializadora", "servicios", "norte", "sur", "mexico", "sapi", "constructora", "inmobiliaria"]);
  /**
   * A text names this client by two words of the client's name or razón social (the whole name if it
   * has one word; gestoras write the name as on the recibo, one word may differ), or by the trámite's
   * CURRENT SI. A new SI never names the trámite by itself: it could be another client's.
   */
  function nombraTramite(texto: string, nombres: string[], siActual: string | null | undefined): boolean {
    if (traeSi(texto, siActual)) return true;
    return nombraCliente(texto, nombres);
  }
  function nombraCliente(texto: string, nombres: string[]): boolean {
    const palabras = new Set(plano(texto).split(/[^a-zñ]+/));
    return nombres.some((n) => {
      const w = plano(n).split(/[^a-zñ]+/).filter((x) => x.length >= 3 && !VACIAS.has(x));
      return w.length > 0 && w.filter((x) => palabras.has(x)).length >= Math.min(2, w.length);
    });
  }

  /**
   * A stage only moves on evidence: a NEW numero_si in the same patch; an inbound message or a file
   * from an active gestora; a file this trámite already holds in that stage's slot (the comprobante);
   * for the client-side stages (meter, documents received), a photo/document the client or installer
   * sent. Our own steps (sending the expediente, asking for documents) need none.
   */
  const ETAPAS_PROPIAS = new Set(["documentacion_con_gestor", "enviado_a_gestor", "solicitar_documentos"]);
  const ETAPAS_DEL_CLIENTE = new Set(["medidor_instalado", "sistema_activado", "documentos_recibidos"]);
  const SLOTS_INGRESO = ["Anexo 2", "Comprobante de ingreso"];
  const SLOTS_DE_ETAPA: Record<string, string[]> = { folio_ingresado: SLOTS_INGRESO, en_seguimiento_cfe: SLOTS_INGRESO, ingresado_cfe: SLOTS_INGRESO, ingresado: SLOTS_INGRESO };
  async function evidenciaCheck(cur: any, patch: { stage?: string; numero_si?: string }, ev?: { wa_message_id?: string; file_id?: string }): Promise<string | null> {
    const etapa = patch.stage;
    const mueve = etapa !== undefined && etapa !== cur.stage && !ETAPAS_PROPIAS.has(etapa);
    const siNuevo = patch.numero_si && patch.numero_si !== cur.numero_si ? patch.numero_si : null;
    if (!mueve && !siNuevo) return null;
    const cli = await clienteDe(cur.project_id);
    // A message storing a NEW SI must name the client: the SI alone could belong to anyone.
    const nombra = (t: string) => siNuevo ? nombraCliente(t, cli.nombres) : nombraTramite(t, cli.nombres, cur.numero_si);
    // valida: the evidence is from the right person AND about this trámite. conSi: the new SI is written in it.
    let valida = false, conSi = false, pdfIlegible = false;
    if (ev?.wa_message_id) {
      const m = await mensaje(ev.wa_message_id);
      if (m?.deGestora && nombra(m.body)) { valida = true; conSi = traeSi(m.body, siNuevo); }
    }
    if (!valida && ev?.file_id) {
      const f = await archivo(ev.file_id);
      if (f && f.project_id === cur.project_id) {
        const links: any[] = (await sbApi(`/tramite_file_links?tramite_id=eq.${cur.id}&file_id=eq.${f.id}&select=doc_key`, serviceHeaders())) ?? [];
        const deElla = f.msgs.filter((m: any) => m.deGestora);
        if (links.some((l) => SLOTS_INGRESO.includes(l.doc_key)) && (!mueve || SLOTS_DE_ETAPA[etapa!])) {
          // The comprobante was linked from her message; a new SI is taken only from its readable text.
          valida = true;
          if (siNuevo) { const t = f.firebase_url ? await leerPdf(f.firebase_url) : null; conSi = !!t && traeSi(t, siNuevo); pdfIlegible = !t; }
        } else if (deElla.length && (links.length > 0 || deElla.some((m: any) => nombra(m.body)))) {
          valida = true; conSi = deElla.some((m: any) => traeSi(m.body, siNuevo) && nombraCliente(m.body, cli.nombres));
        } else if (mueve && ETAPAS_DEL_CLIENTE.has(etapa!) && (f.msgs.some((m: any) => cli.tels.includes(m.sender)) || f.dePersona)) {
          // ponytail: an installer's upload counts by uploaded_by alone; tie it to a meter slot if that proves too loose.
          valida = true;
        }
      }
    }
    if (valida && (!siNuevo || conSi)) return null;
    const que = mueve ? `Cambiar la etapa a ${etapa}` : `Poner el numero_si ${siNuevo}`;
    const cual = valida && pdfIlegible
      ? `el comprobante vinculado no tiene texto legible (escaneado), así que el numero_si ${siNuevo} no se puede comprobar; no lo guardes por tu cuenta`
      : valida
      ? `el numero_si ${siNuevo} tiene que venir escrito en el mensaje de la gestora que pasas como evidencia (o en el comprobante ya vinculado en Anexo 2); un SI que no está en la evidencia no se guarda`
      : mueve && ETAPAS_DEL_CLIENTE.has(etapa!)
        ? "evidencia.file_id de la foto o documento que mandó el cliente desde su teléfono, o que subió el instalador al proyecto"
        : `evidencia.wa_message_id de un mensaje que mandó la gestora (desde su número, no otra persona del grupo) y que nombra a este cliente o su SI, o evidencia.file_id de un archivo que ella mandó para este trámite${SLOTS_DE_ETAPA[etapa ?? ""] || !mueve ? " o del comprobante ya vinculado en Anexo 2 / Comprobante de ingreso" : ""}; un numero_si nuevo tiene que venir escrito en esa evidencia`;
    return `${que} necesita evidencia: ${cual}. Sin eso no se cambia: pregúntale a tramitología con futurerp_activity_add (pregunta_para_tramitologia=true), citando por qué crees que ya cambió.`;
  }

  /**
   * A file is linked to a trámite only when it arrived in the triggering message (evidencia.wa_message_id
   * whose media is that file), or when a person uploaded it to the project and it goes into one of
   * this trámite's own document slots (the expediente list tramitología asks for).
   */
  async function vinculoCheck(t: any, a: { file_id?: string; url?: string; doc_key?: string; evidencia?: { wa_message_id?: string } }): Promise<string | null> {
    let f: any = null;
    if (a.file_id) {
      f = await archivo(a.file_id);
      if (!f || f.project_id !== t.project_id) return `El archivo ${a.file_id} no existe o no es del proyecto de este trámite.`;
    }
    const u = f?.firebase_url ?? a.url;
    if (a.evidencia?.wa_message_id && u) {
      const m = await mensaje(a.evidencia.wa_message_id);
      // The message carried this very file, and came from an active gestora or this trámite's client.
      if (m?.media_url && m.media_url === u && (m.deGestora || (await clienteDe(t.project_id)).tels.includes(m.sender))) return null;
    }
    if (f?.dePersona && (BASE_DOCS[t.tipo] ?? []).includes(String(a.doc_key ?? ""))) return null;
    return `Solo vinculas un archivo que llegó en el mensaje que estás atendiendo (evidencia.wa_message_id de ese mensaje, cuyo adjunto es este archivo y que mandó la gestora o el cliente de este trámite desde su teléfono) o uno que una persona subió al proyecto para un documento del expediente de este trámite (${(BASE_DOCS[t.tipo] ?? []).join(", ") || "sin lista"}). Si no, no lo vincules: pregúntale a tramitología con futurerp_activity_add (pregunta_para_tramitologia=true).`;
  }
  setShadowCheck(server, "futurerp_tramite_link_file", async (a) => {
    const t = a.tramite_id && uuidRx.test(a.tramite_id) ? (await sbApi(`/project_tramites?id=eq.${a.tramite_id}&select=id,project_id,tipo&limit=1`))?.[0] : null;
    return t ? vinculoCheck(t, a) : null;
  });
  setShadowCheck(server, "futurerp_tramite_update", async (a) => {
    const cur = a.tramite_id && uuidRx.test(a.tramite_id) ? (await sbApi(`/project_tramites?id=eq.${a.tramite_id}&select=*&limit=1`))?.[0] : null;
    return cur ? (await envioCheck(cur, a.patch ?? {}, a.reingreso)) ?? evidenciaCheck(cur, a.patch ?? {}, a.evidencia) : null;
  });

  // ── futurerp_tramite_update ───────────────────────────────────────────────
  tool(
    "futurerp_tramite_update",
    "Update fields of a trámite the way the trámite card does: stage moves only FORWARD along the tipo's stage list (except a re-ingreso: reingreso=true + motivo lets the stage go back, never to the first stage, and keeps the previous numero_si / fecha_ingreso in type_data.ingresos_anteriores), unchanged values are dropped, and every changed field is logged on the project timeline (field_update, old → new). enviado=true also stamps enviado_at/enviado_by; on a DD10/DD11 primary it (and any stage from documentacion_con_gestor on) is refused until 7 days after the anticipo. Any other stage change needs evidence: a new numero_si in the patch, or the gestora's message / file (evidencia.wa_message_id / evidencia.file_id), or the comprobante already in this trámite's Anexo 2 slot; meter installed / documents received take the client's or installer's photo as evidencia.file_id. Without it, ask tramitología instead. type_data keys are merged, never replaced. Returns what changed; a no-op if nothing differs.",
    {
      tramite_id: z.string().uuid(),
      patch: z.object({
        stage: z.string().optional(),
        numero_si: z.string().optional(),
        fecha_ingreso: z.string().optional().describe("YYYY-MM-DD"),
        fecha_resolucion: z.string().optional().describe("YYYY-MM-DD"),
        gestor_cfe: z.string().optional(),
        comentarios: z.string().optional(),
        enviado: z.boolean().optional(),
        subsanacion_active: z.boolean().optional(),
        fecha_subsanacion: z.string().optional(),
        motivo_subsanacion: z.string().optional(),
        c0b_rechazada: z.boolean().optional(),
        fecha_c0b_rechazada: z.string().optional(),
        pagado: z.boolean().optional(),
        costo: z.number().optional(),
        ultimo_seguimiento_at: z.string().optional().describe("ISO timestamp"),
        siguiente_revision_at: z.string().optional().describe("YYYY-MM-DD"),
        docs_solicitados_at: z.string().optional().describe("ISO timestamp"),
        docs_recordatorio_at: z.string().optional().describe("ISO timestamp"),
        ultimo_estatus_cfe: z.string().optional(),
        ultimo_estatus_cfe_at: z.string().optional().describe("ISO timestamp"),
        ultimo_estatus_cfe_avisado_at: z.string().optional().describe("ISO timestamp"),
        type_data: z.record(z.string(), z.any()).optional().describe("Keys merged into type_data (e.g. fecha_medidor_instalado, fecha_envio_gestor)"),
      }).describe("Only the fields to change"),
      motivo: z.string().optional().describe("Why (goes into the timeline entries)"),
      reingreso: z.boolean().optional().describe("true = CFE cancelled or returned the ingreso and it is filed again: allows a backward stage move (needs motivo) and archives the previous SI and date"),
      evidencia: z.object({
        wa_message_id: z.string().optional().describe("wa_message_id of the gestora's inbound message that reports the change"),
        file_id: z.string().uuid().optional().describe("project_files.id of the file that proves it (e.g. the comprobante de ingreso)"),
      }).optional().describe("Required for any stage change except documentacion_con_gestor, unless the patch sets a new numero_si"),
    },
    async ({ tramite_id, patch, motivo, reingreso, evidencia }) => {
      try {
        const rows: any[] = await sbApi(`/project_tramites?id=eq.${tramite_id}&select=*&limit=1`);
        const cur = rows[0];
        if (!cur) return fail(`No existe el trámite ${tramite_id} (o no tienes acceso).`);

        const stages = TRAMITE_STAGES[cur.tipo] ?? [];
        if (patch.stage !== undefined && patch.stage !== cur.stage) {
          const from = stages.indexOf(cur.stage);
          const to = stages.indexOf(patch.stage);
          if (to < 0) return fail(`Etapa inválida para ${cur.tipo}: ${patch.stage}. Válidas: ${stages.join(" → ")}.`);
          if (from >= 0 && to < from && !reingreso) return fail(`Un trámite nunca se mueve hacia atrás (${cur.stage} → ${patch.stage}). Si CFE canceló o regresó el ingreso, es un re-ingreso: reingreso=true con motivo.`);
          if (from >= 0 && to < from && to === 0) return fail(`Un re-ingreso no regresa a ${stages[0]}: el expediente ya se envió una vez.`);
        }
        const espera = await envioCheck(cur, patch, reingreso);
        if (espera) return fail(espera);
        if (reingreso) {
          if (!motivo || motivo.trim().length < 5) return fail("Un re-ingreso necesita motivo (qué dijo la gestora o CFE).");
          // The previous filing is history, not garbage: keep it next to the row.
          const prev = { numero_si: cur.numero_si ?? null, fecha_ingreso: cur.fecha_ingreso ?? null, stage: cur.stage, motivo, at: new Date().toISOString() };
          const hist = Array.isArray(cur.type_data?.ingresos_anteriores) ? cur.type_data.ingresos_anteriores : [];
          patch.type_data = { ...(patch.type_data ?? {}), ingresos_anteriores: [...hist, prev] };
        }
        const sinEvidencia = await evidenciaCheck(cur, patch, evidencia);
        if (sinEvidencia) return fail(sinEvidencia);

        const update: Record<string, unknown> = {};
        const changes: { field: string; from: unknown; to: unknown }[] = [];
        for (const key of UPDATABLE) {
          const v = (patch as Record<string, unknown>)[key];
          if (v === undefined) continue;
          const before = cur[key];
          const same = typeof v === "number" ? Number(before) === v : String(before ?? "") === String(v ?? "");
          if (same) continue;
          update[key] = v;
          changes.push({ field: key, from: before, to: v });
        }
        if (patch.type_data && Object.keys(patch.type_data).length) {
          const merged = { ...(cur.type_data ?? {}), ...patch.type_data };
          if (JSON.stringify(merged) !== JSON.stringify(cur.type_data ?? {})) {
            update.type_data = merged;
            for (const [k, v] of Object.entries(patch.type_data)) {
              if (String((cur.type_data ?? {})[k] ?? "") !== String(v ?? "")) changes.push({ field: `type_data.${k}`, from: (cur.type_data ?? {})[k], to: v });
            }
          }
        }
        if (update.enviado === true && !cur.enviado) {
          update.enviado_at = new Date().toISOString();
          update.enviado_by = userId;
        }
        if (changes.length === 0) return text(`Sin cambios: el trámite ${tramite_id} ya tiene esos valores.`);

        const [after] = await sbWrite("PATCH", `/project_tramites?id=eq.${tramite_id}`, update);
        // The activity trigger (activity_log_triggers) already logs every other
        // column; it skips `stage` on purpose, so the card — and this tool — log
        // the stage move themselves.
        const stageChange = changes.find((c) => c.field === "stage");
        if (stageChange) {
          await logActivity(cur.project_id, "field_update", `Etapa de trámite: ${cur.tipo}`, motivo ?? null, {
            old_value: String(stageChange.from ?? ""),
            new_value: String(stageChange.to),
            metadata: { tramite_id, tipo: cur.tipo, from_stage: stageChange.from, to_stage: stageChange.to, source: "mcp", ...(reingreso ? { reingreso: true } : {}) },
          });
        } else if (motivo) {
          await logActivity(cur.project_id, "note", `${reingreso ? "Re-ingreso " : ""}Trámite ${cur.tipo}: ${changes.map((c) => c.field).join(", ")}`, motivo, { metadata: { tramite_id, source: "mcp" } });
        }
        return text(`Trámite ${tramite_id} actualizado (${changes.map((c) => `${c.field}: ${c.from ?? "—"} → ${c.to}`).join("; ")}). Etapa actual: ${after?.stage ?? cur.stage}.`);
      } catch (e: any) {
        return fail(`No se pudo actualizar el trámite: ${e.message}`);
      }
    },
  );

  // ── futurerp_project_set_zona_cfe ─────────────────────────────────────────
  tool(
    "futurerp_project_set_zona_cfe",
    "Set the project's CFE zone (DD10, DD11, DD12, DD06, foraneo) through the app's RPC. The zone decides which primary trámite tipo applies and when it is eligible.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      zona: z.enum(ZONAS),
      motivo: z.string().optional().describe("How it was determined (recibo, dirección…)"),
    },
    async ({ project_id, zona, motivo }) => {
      try {
        const p = await projectRow(project_id);
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        if (p.zona_cfe === zona) return text(`Sin cambios: ${p.efu ?? p.id} ya está en zona ${zona}.`);
        await sbRpc("set_project_zona_cfe", { p_project_id: p.id, p_zona: zona });
        if (motivo) await logActivity(p.id, "note", `Zona CFE ${zona}`, motivo, { metadata: { source: "mcp" } });
        return text(`Zona CFE de ${p.efu ?? p.id}: ${p.zona_cfe ?? "—"} → ${zona}.`);
      } catch (e: any) {
        return fail(`No se pudo fijar la zona: ${e.message}`);
      }
    },
  );

  // ── futurerp_project_tramites_requeridos_set ──────────────────────────────
  tool(
    "futurerp_project_tramites_requeridos_set",
    "Add (and optionally remove) required trámite labels on a project through the app's RPC (set_project_tramites_requeridos). The effective list is the manual list plus what the Visita Técnica marked; this tool is ADDITIVE: it keeps everything already there and adds `labels`. Pass `remove` to untick explicitly (the RPC records an untick as a veto, so only do it when a person asked). Labels in projects.tramites_requeridos_vetados are never re-added; they are dropped and reported. Omit `otro` to keep the current 'Otro' text; pass '' to clear it.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      labels: z.array(z.enum(REQUERIDO_LABELS)).describe("Labels that must be present"),
      remove: z.array(z.enum(REQUERIDO_LABELS)).optional().describe("Labels to untick (recorded as vetoes)"),
      otro: z.string().optional().describe("Free text for the 'Otro' label; omit to keep, '' to clear"),
      motivo: z.string().optional(),
    },
    async ({ project_id, labels, remove, otro, motivo }) => {
      try {
        const p = await projectRow(project_id, "id,efu,tramites_requeridos_manual,tramites_requeridos_vtecnica,tramites_requeridos_vetados,tramites_requeridos_otro");
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        const vetados: string[] = p.tramites_requeridos_vetados ?? [];
        const current: string[] = [...new Set([...(p.tramites_requeridos_manual ?? []), ...(p.tramites_requeridos_vtecnica ?? [])])];
        const blocked = labels.filter((l) => vetados.includes(l));
        const drop = new Set<string>(remove ?? []);
        const send = [...new Set([...current, ...labels])].filter((l) => !vetados.includes(l) && !drop.has(l)).sort();
        const sameList = send.length === current.length && send.every((l) => current.includes(l));
        const otroSame = otro === undefined || (otro || null) === (p.tramites_requeridos_otro ?? null);
        const vetNote = blocked.length ? ` Vetados por una persona (no se agregan): ${blocked.join(", ")}.` : "";
        if (sameList && otroSame) return text(`Sin cambios en ${p.efu ?? p.id}: ${current.join(", ") || "sin trámites requeridos"}.${vetNote}`);
        const args: Record<string, unknown> = { p_project_id: p.id, p_labels: send };
        if (otro !== undefined) args.p_otro = otro;
        await sbRpc("set_project_tramites_requeridos", args);
        if (motivo) await logActivity(p.id, "note", "Trámites requeridos", motivo, { metadata: { source: "mcp", labels: send, removed: [...drop], vetados_omitidos: blocked } });
        return text(`Trámites requeridos de ${p.efu ?? p.id}: ${send.join(", ") || "ninguno"} (antes: ${current.join(", ") || "ninguno"}).${vetNote}`);
      } catch (e: any) {
        return fail(`No se pudo fijar la lista: ${e.message}`);
      }
    },
  );

  // ── futurerp_activity_add ─────────────────────────────────────────────────
  tool(
    "futurerp_activity_add",
    "Write a note on a project's timeline (crm_activities, performed_by = you). Use it to explain decisions, record what the gestora said (quoted), or leave a question for tramitología (the tramites.manage team, never one person). A question goes with pregunta_para_tramitologia=true: every tramites.manage holder gets a notification pointing at the project, so the question is not just a silent note. Without a project (e.g. a gestora message that matches nothing) pass pregunta_para_tramitologia=true and omit project_id: only the notification is sent.",
    {
      project_id: z.string().optional().describe("Project uuid or EFU code; optional only when pregunta_para_tramitologia is true"),
      activity_type: z.enum(ACTIVITY_TYPES).default("note"),
      subject: z.string().max(200),
      description: z.string().max(4000).optional(),
      pregunta_para_tramitologia: z.boolean().optional().describe("true = also notify everyone with tramites.manage"),
    },
    async ({ project_id, activity_type, subject, description, pregunta_para_tramitologia }) => {
      const pregunta = !!pregunta_para_tramitologia;
      try {
        let p: { id: string; efu: string | null } | null = null;
        if (project_id) {
          p = await projectRow(project_id, "id,efu");
          if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
          await logActivity(p.id, activity_type, subject, description ?? null, { metadata: { source: "mcp", pregunta_para_tramitologia: pregunta } });
        } else if (!pregunta) {
          return fail("Falta project_id (solo puede omitirse con pregunta_para_tramitologia=true).");
        }
        let avisados = 0;
        if (pregunta) {
          const rows: any[] = await sbApi(`/user_crm_roles?select=user_id,crm_roles!inner(id)&crm_roles.permissions=cs.${encodeURIComponent(JSON.stringify({ "tramites.manage": true }))}`, serviceHeaders());
          const ids = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
          if (ids.length) {
            await sbRpc("create_notification", {
              p_user_ids: ids,
              p_type: "system",
              p_title: `Trami pregunta: ${subject}`.slice(0, 120),
              p_body: (description ?? subject).slice(0, 500),
              p_resource_type: p ? "project" : "system",
              p_resource_id: p?.id ?? null,
              p_metadata: { agent: "trami", ruta: p ? `/proyectos/${p.id}` : "/tramites/trami/buzon" },
            });
            avisados = ids.length;
          }
        }
        return text(p ? `Nota registrada en ${p.efu ?? p.id}: ${subject}${avisados ? ` · pregunta enviada a ${avisados} persona(s) con tramites.manage` : ""}` : `Pregunta enviada a ${avisados} persona(s) con tramites.manage: ${subject}`);
      } catch (e: any) {
        return fail(`No se pudo registrar la nota: ${e.message}`);
      }
    },
  );

  // ── futurerp_ticket_create ────────────────────────────────────────────────
  tool(
    "futurerp_ticket_create",
    "Open a ticket to the project's vendor (projects.owner_id), like the app's 'Nuevo ticket': area = the vendor's department, SLA 2 business days, the vendor gets a 'ticket_assigned' notification. Use it for documents the expediente is missing (tramitología's rule: the vendor first, the client only if the vendor is slow). Logs a note on the project timeline.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      asunto: z.string().max(200),
      descripcion: z.string().max(4000).describe("What is missing and for which trámite; plain text"),
      prioridad: z.enum(["alta", "media", "baja"]).default("media"),
    },
    async ({ project_id, asunto, descripcion, prioridad }) => {
      try {
        const p = await projectRow(project_id, "id,efu,name,owner_id");
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        if (!p.owner_id) return fail(`El proyecto ${p.efu ?? p.id} no tiene vendedor asignado: pregunta a tramitología a quién pedirle.`);
        const [v]: any[] = await sbApi(`/profiles?user_id=eq.${p.owner_id}&select=user_id,first_name,last_name,department&limit=1`, serviceHeaders());
        const nombre = [v?.first_name, v?.last_name].filter(Boolean).join(" ") || "Vendedor";
        const area = v?.department || "Ventas";
        const sla = { alta: 510, media: 1020, baja: 1530 }[prioridad]; // minutes, same ladder as the app
        const [t] = await sbWrite("POST", "/tickets", {
          area, prioridad, sla_minutos: sla, fecha_vencimiento: new Date(Date.now() + sla * 60_000).toISOString(),
          canal: "reporte", asunto, descripcion: `<p>${descripcion.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`,
          responsable: `${nombre} (${area})`, responsables: [`${nombre} (${area})`], responsables_ids: [p.owner_id],
          project_id: p.id, cliente_nombre: p.name ?? null, created_by: userId,
        });
        await sbRpc("create_notification", {
          p_user_ids: [p.owner_id], p_type: "ticket_assigned", p_title: "Ticket asignado",
          p_body: `Te han asignado el ticket #${t.folio}: ${asunto}`.slice(0, 500),
          p_resource_type: "ticket", p_resource_id: t.folio,
          p_metadata: { folio: t.folio, asunto, assignedBy: "Trami", agent: "trami" }, p_actor_id: userId,
        });
        await logActivity(p.id, "note", `Ticket ${t.folio} a ${nombre}: ${asunto}`, descripcion, { metadata: { source: "mcp", ticket_folio: t.folio, ticket_id: t.id } });
        return text(`Ticket ${t.folio} abierto a ${nombre} (${area}) en ${p.efu ?? p.id}: ${asunto}. id ${t.id}.`);
      } catch (e: any) {
        return fail(`No se pudo abrir el ticket: ${e.message}`);
      }
    },
  );

  // ── futurerp_tramite_link_file ────────────────────────────────────────────
  tool(
    "futurerp_tramite_link_file",
    "Attach a file to a trámite under a document slot (doc_key), like the trámite card's 'Vincular'. Either an existing project_files id, or a Firebase Storage URL + name to register first. Idempotent on (tramite, file). Only a file that arrived in the message you are handling (evidencia.wa_message_id; its attachment must be this file), or one a person uploaded to the project going into one of this trámite's own document slots; otherwise ask tramitología. Use doc_key 'Anexo 2' for the gestora's ingreso PDF (the Anexo 2 is the comprobante de ingreso).",
    {
      tramite_id: z.string().uuid(),
      file_id: z.string().uuid().optional().describe("Existing project_files.id"),
      url: z.string().url().optional().describe("Firebase Storage URL of a file not yet registered"),
      name: z.string().optional().describe("File name when registering by url"),
      doc_key: z.string().describe("Document slot, e.g. 'Anexo 2' (comprobante de ingreso), 'Recibo CFE', 'Imagenes Instalacion'"),
      evidencia: z.object({
        wa_message_id: z.string().optional().describe("wa_message_id of the inbound message whose attachment is this file"),
      }).optional().describe("Required unless a person uploaded the file to the project and doc_key is one of this trámite's own document slots"),
    },
    async ({ tramite_id, file_id, url, name, doc_key, evidencia }) => {
      try {
        const [t] = await sbApi(`/project_tramites?id=eq.${tramite_id}&select=id,project_id,tipo&limit=1`);
        if (!t) return fail(`No existe el trámite ${tramite_id} (o no tienes acceso).`);
        const sinOrigen = await vinculoCheck(t, { file_id, url, doc_key, evidencia });
        if (sinOrigen) return fail(sinOrigen);
        let fileId = file_id;
        if (!fileId) {
          if (!url || !name) return fail("Indica file_id, o url + name.");
          const host = new URL(url).hostname;
          if (!FIREBASE_HOSTS.includes(host)) return fail(`Solo se vinculan archivos del Storage de Firebase (host recibido: ${host}).`);
          const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : null;
          const kind = ext === "pdf" ? "pdf" : ["jpg", "jpeg", "png", "webp", "heic"].includes(ext ?? "") ? "image" : "document";
          const [f] = await sbWrite("POST", "/project_files", {
            project_id: t.project_id,
            document_id: null,
            title: name,
            file_name: name,
            file_type: kind,
            file_extension: ext,
            mime_type: kind === "pdf" ? "application/pdf" : kind === "image" ? `image/${ext === "jpg" ? "jpeg" : ext}` : "application/octet-stream",
            source: "firebase",
            firebase_url: url,
            uploaded_by: userId,
          });
          fileId = f.id;
        }
        await sbWrite("POST", "/tramite_file_links?on_conflict=tramite_id,file_id", { tramite_id, file_id: fileId, doc_key, created_by: userId }, "return=minimal,resolution=ignore-duplicates");
        // The slot row makes the file count for the expediente in the card.
        await sbWrite("POST", "/project_documents?on_conflict=project_id,name", [{ project_id: t.project_id, name: doc_key, requerido: false }], "return=minimal,resolution=ignore-duplicates").catch(() => null);
        return text(`Archivo ${fileId} vinculado al trámite ${tramite_id} como "${doc_key}".`);
      } catch (e: any) {
        return fail(`No se pudo vincular el archivo: ${e.message}`);
      }
    },
  );

  // ── futurerp_bloqueo_open ─────────────────────────────────────────────────
  tool(
    "futurerp_bloqueo_open",
    "Open a bloqueo (blocker) on a project at its current stage, like the project's 'Bloqueo' button. Use categoria cfe_tramite for a trámite stuck at CFE. Refuses if an active bloqueo of the same categoria already exists.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      categoria: z.enum(BLOQUEO_CATEGORIAS),
      dependencia: z.enum(BLOQUEO_DEPENDENCIAS).describe("Who the resolution depends on"),
      motivo: z.string().min(5).max(2000),
    },
    async ({ project_id, categoria, dependencia, motivo }) => {
      try {
        const p = await projectRow(project_id, "id,efu,stage");
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        const open: any[] = await sbApi(`/project_bloqueos?project_id=eq.${p.id}&estado=eq.activo&categoria=eq.${categoria}&select=id,motivo`);
        if (open.length) return fail(`Ya hay un bloqueo ${categoria} activo en ${p.efu ?? p.id} (${open[0].id}): ${open[0].motivo}`);
        const [b] = await sbWrite("POST", "/project_bloqueos", { project_id: p.id, stage: p.stage, categoria, dependencia, motivo, created_by: userId });
        return text(`Bloqueo ${categoria} abierto en ${p.efu ?? p.id} (id ${b.id}, etapa ${p.stage}, depende de ${dependencia}).`);
      } catch (e: any) {
        return fail(`No se pudo abrir el bloqueo: ${e.message}`);
      }
    },
  );

  /**
   * Everything whatsapp_send refuses before touching the gateway: send window,
   * Firebase-only media, own channel, 20/hour, the conversation is ours, chat id
   * format. Also run in shadow (guard.setShadowCheck), so a shadow send that live
   * would refuse is refused too.
   */
  /**
   * Gestoras are data (public.gestoras): a gestora who is no longer active is
   * never written to, and the only groups Trami writes to are active gestoras'.
   */
  /** The active gestoras a chat belongs to (group id in whatsapp_chat_ids, or her phone for a 1:1). */
  async function gestorasDe(chat: string): Promise<any[]> {
    const gs: any[] = (await sbApi(`/gestoras?select=nombre,activo,telefono,whatsapp_chat_ids`, serviceHeaders()).catch(() => null)) ?? [];
    const d10 = (x: string | null | undefined) => String(x ?? "").replace(/\D/g, "").slice(-10);
    return gs.filter((g) => (g.whatsapp_chat_ids ?? []).includes(chat) || (chat.endsWith("@c.us") && g.telefono && d10(g.telefono) === d10(chat)));
  }
  async function gestoraTargetCheck(chat: string): Promise<{ error: string | null; gestora: boolean }> {
    const de = await gestorasDe(chat);
    const gestora = de.some((g) => g.activo);
    if (de.length && !gestora) return { gestora, error: `Ese chat es de ${de[0].nombre}, que ya no es gestora activa: no se le escribe. Pregunta a tramitología quién lleva ahora ese trámite.` };
    if (chat.endsWith("@g.us") && !gestora) return { gestora, error: "Solo escribes a grupos de una gestora activa (public.gestoras.whatsapp_chat_ids)." };
    return { gestora, error: null };
  }
  async function waCheck({ conversation_id, chat_id, media_url, text: body, tramite_id }: { conversation_id?: string; chat_id?: string; media_url?: string; text?: string; tramite_id?: string }): Promise<{ error: string } | { ch: any; sentLastHour: number }> {
    const hora = fueraDeHorario(Date.now());
    if (hora) return { error: hora };
    if (media_url && !FIREBASE_HOSTS.includes(new URL(media_url).hostname)) return { error: "Solo se adjuntan archivos del Storage de Firebase." };
    const ch = (await sbApi(`/whatsapp_channels?vendor_user_id=eq.${userId}&active=is.true&select=id,session_id,connection_status,label&limit=1`))?.[0];
    if (!ch) return { error: "No tienes una sesión de WhatsApp propia (whatsapp_channels.vendor_user_id). Trami solo escribe desde su número." };
    let target: string;
    if (conversation_id) {
      const convo = (await sbApi(`/whatsapp_conversations?id=eq.${conversation_id}&channel_id=eq.${ch.id}&select=id,chat_id&limit=1`))?.[0];
      if (!convo) return { error: "Esa conversación no es de tu número." };
      target = String(convo.chat_id ?? "");
    } else if (chat_id) {
      const cid = chat_id.includes("@") ? chat_id : `${chat_id.replace(/\D/g, "")}@c.us`;
      if (!/^\d{10,15}@c\.us$|^\d+@g\.us$/.test(cid)) return { error: `chat_id inválido: ${chat_id}` };
      target = cid;
    } else {
      return { error: "Indica conversation_id o chat_id." };
    }
    const dest = await gestoraTargetCheck(target);
    if (dest.error) return { error: dest.error };
    // A client only ever gets one of the allowed templates (plantillas_cliente.json), filled with THIS
    // trámite's data, and no files; gestoras are not restricted.
    if (!dest.gestora) {
      const pregunta = "Si el caso pide decirle otra cosa, no le escribas: pregúntale a tramitología con futurerp_activity_add (pregunta_para_tramitologia=true) y deja el texto propuesto en la nota.";
      const p = leerPlantilla(body ?? "");
      if (!p) return { error: `Ese mensaje no es una de las plantillas para clientes, así que no se manda. A un cliente sólo van las plantillas de la descripción de futurerp_whatsapp_send, con cada hueco lleno y sin agregar nada. ${pregunta}` };
      if (media_url) return { error: `A un cliente no se le mandan archivos: sólo el texto de la plantilla. ${pregunta}` };
      const t = tramite_id && uuidRx.test(tramite_id) ? (await sbApi(`/project_tramites?id=eq.${tramite_id}&select=id,project_id,numero_si&limit=1`, serviceHeaders()))?.[0] : null;
      if (!t) return { error: "Todo mensaje a un cliente lleva el tramite_id del trámite del que le hablas: con él se revisan el nombre y el SI de la plantilla." };
      const cli = await clienteDe(t.project_id);
      if (!target.endsWith("@c.us") || !cli.tels.includes(d10(target))) return { error: `Ese chat no es un teléfono del cliente de este trámite (el del proyecto). ${pregunta}` };
      const malSi = (p.huecos.si ?? []).find((si) => !t.numero_si || sinEspacios(si) !== sinEspacios(t.numero_si));
      if (malSi) return { error: `El SI ${malSi} no es el número de seguimiento guardado en este trámite (${t.numero_si ?? "sin SI todavía"}): no se manda.` };
      const delCliente = new Set(cli.nombres.flatMap((n) => plano(n).split(/[^a-zñ]+/)));
      const malNombre = (p.huecos.nombre ?? []).find((n) => !plano(n).split(/[^a-zñ]+/).filter(Boolean).every((w) => delCliente.has(w)));
      if (malNombre) return { error: `"${malNombre}" no es el nombre del cliente de este proyecto: en {nombre} va su nombre como está en el ERP. ${pregunta}` };
    }
    // Rate limit: outbound rows on this channel in the last hour.
    const since = new Date(Date.now() - 3600_000).toISOString();
    const convIds: string[] = ((await sbApi(`/whatsapp_conversations?channel_id=eq.${ch.id}&select=id`, serviceHeaders())) ?? []).map((c: any) => c.id);
    let sentLastHour = 0;
    if (convIds.length) {
      const cnt = await fetch(`${restBase}/whatsapp_messages?select=id&conversation_id=in.(${convIds.join(",")})&direction=eq.outbound&sent_at=gte.${encodeURIComponent(since)}&limit=1`, { headers: serviceHeaders({ Prefer: "count=exact" }) });
      sentLastHour = parseInt((cnt.headers.get("content-range") ?? "*/0").split("/").pop() ?? "0", 10) || 0;
    }
    if (sentLastHour >= WA_SENDS_PER_HOUR) return { error: `Tope alcanzado: ${sentLastHour} envíos en la última hora (máximo ${WA_SENDS_PER_HOUR}).` };
    return { ch, sentLastHour };
  }
  setShadowCheck(server, "futurerp_whatsapp_send", async (a) => { const r = await waCheck(a); return "error" in r ? r.error : null; });

  // ── futurerp_whatsapp_send ────────────────────────────────────────────────
  tool(
    "futurerp_whatsapp_send",
    `Send a WhatsApp text (optionally with a Firebase Storage file) from YOUR OWN number — the OpenWA session whose vendor_user_id is you (Trami's). To an existing conversation (conversation_id) or a phone/chat (chat_id: digits like 5218112345678, or a @g.us group id). Guards: 08:00–19:00 Monterrey, 20 sends per hour, Firebase-only media, never to an inactive gestora, groups only if they belong to an active gestora. To a CLIENT (any chat that is not an active gestora's): pass tramite_id; the chat must be a phone of that project's client, no media, and the text exactly one of these templates with {si} = that trámite's numero_si and {nombre} = the client's name in the ERP, nothing added; anything else is refused: ${listaPlantillas()} Messages to gestoras are free text. The message is recorded in the inbox like any outbound.`,
    {
      conversation_id: z.string().uuid().optional(),
      chat_id: z.string().optional().describe("Phone digits (E.164 without +) or a WhatsApp chat id (…@c.us / …@g.us)"),
      text: z.string().min(1).max(4096),
      media_url: z.string().url().optional().describe("Firebase Storage URL (PDF or image)"),
      media_name: z.string().optional().describe("File name shown to the recipient"),
      tramite_id: z.string().uuid().optional().describe("Required for a client: the trámite you are telling them about ({si} and {nombre} are checked against it)"),
    },
    async ({ conversation_id, chat_id, text: body, media_url, media_name, tramite_id }) => {
      try {
        if (!OPENWA_API_URL || !OPENWA_API_KEY) return fail("El gateway de WhatsApp no está configurado en el MCP (OPENWA_API_URL / OPENWA_API_KEY).");
        const chk = await waCheck({ conversation_id, chat_id, media_url, text: body, tramite_id });
        if ("error" in chk) return fail(chk.error);
        const { ch, sentLastHour } = chk;

        // Conversation under this channel (create for a new chat).
        let convo: any = null;
        if (conversation_id) {
          convo = (await sbApi(`/whatsapp_conversations?id=eq.${conversation_id}&channel_id=eq.${ch.id}&select=id,chat_id&limit=1`))?.[0];
        } else {
          const cid = chat_id!.includes("@") ? chat_id! : `${chat_id!.replace(/\D/g, "")}@c.us`;
          const up = await fetch(`${restBase}/whatsapp_conversations?on_conflict=channel_id,chat_id`, { method: "POST", headers: serviceHeaders({ Prefer: "return=representation,resolution=merge-duplicates" }), body: JSON.stringify({ channel_id: ch.id, chat_id: cid, is_group: cid.endsWith("@g.us"), contact_phone: cid.endsWith("@c.us") ? cid.split("@")[0] : null }) });
          if (!up.ok) return fail(`No se pudo abrir la conversación: ${(await up.text()).slice(0, 200)}`);
          convo = (await up.json())[0];
        }

        // Gateway call (same routes openwa-send uses).
        const ext = (media_name ?? media_url ?? "").split(".").pop()?.toLowerCase() ?? "";
        const route = media_url ? (["jpg", "jpeg", "png", "webp"].includes(ext) ? "send-image" : "send-document") : "send-text";
        const payload = media_url ? { chatId: convo.chat_id, url: media_url, fileName: media_name ?? "archivo", caption: body } : { chatId: convo.chat_id, text: body };
        const r = await fetch(`${OPENWA_API_URL}/sessions/${ch.session_id}/messages/${route}`, { method: "POST", headers: { "X-API-Key": OPENWA_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
        if (!r.ok) return fail(`OpenWA rechazó el envío (${r.status}): ${(await r.text()).slice(0, 200)}`);
        const out = await r.json().catch(() => ({}));
        const waId = out?.messageId ? String(out.messageId) : null;
        const now = new Date().toISOString();
        if (waId) {
          await fetch(`${restBase}/whatsapp_messages?on_conflict=conversation_id,wa_message_id`, { method: "POST", headers: serviceHeaders({ Prefer: "return=minimal,resolution=ignore-duplicates" }), body: JSON.stringify({ conversation_id: convo.id, wa_message_id: waId, direction: "outbound", body, media_url: media_url ?? null, media_type: media_url ? (route === "send-image" ? "image" : "document") : null, status: "sent", sent_at: now, metadata: { source: "mcp", agent: "trami" } }) });
        }
        await fetch(`${restBase}/whatsapp_conversations?id=eq.${convo.id}`, { method: "PATCH", headers: serviceHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ last_message_at: now, last_message_preview: body.slice(0, 120), unread_count: 0 }) });
        return text(`WhatsApp enviado a ${convo.chat_id} desde ${ch.label ?? ch.session_id}${waId ? ` (id ${waId})` : ""}. Envíos en la última hora: ${sentLastHour + 1}/${WA_SENDS_PER_HOUR}.`);
      } catch (e: any) {
        return fail(`No se pudo enviar el WhatsApp: ${e.message}`);
      }
    },
  );

  // ── futurerp_verification_tick ────────────────────────────────────────────
  tool(
    "futurerp_verification_tick",
    "Tick one item of the project's closing checklist (verificacion_cierre, stage Instalación Pagada → Funcionando) through the app's RPC: medidor_instalado when CFE changed the meter, sistema_inyectando when it is confirmed generating. The RPC refuses unless you are in that checklist's approver group.",
    {
      project_id: z.string().describe("Project uuid or EFU code"),
      item_key: z.enum(CIERRE_ITEMS),
      checked: z.boolean().optional().describe("Default true"),
    },
    async ({ project_id, item_key, checked }) => {
      try {
        const p = await projectRow(project_id, "id,efu,stage");
        if (!p) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        const v = (await sbApi(`/project_stage_verifications?project_id=eq.${p.id}&verification_key=eq.verificacion_cierre&select=id,status&order=created_at.desc&limit=1`))?.[0];
        if (!v) return fail(`${p.efu ?? p.id} no tiene todavía el checklist de cierre (se solicita desde el proyecto en Instalación Pagada; etapa actual: ${p.stage}).`);
        const row = await sbRpc("set_stage_verification_item", { p_verification_id: v.id, p_item_key: item_key, p_checked: checked ?? true });
        return text(`Checklist de cierre de ${p.efu ?? p.id}: ${item_key} = ${row?.checked ?? (checked ?? true)}.`);
      } catch (e: any) {
        return fail(`No se pudo palomear el checklist: ${e.message}`);
      }
    },
  );
}
