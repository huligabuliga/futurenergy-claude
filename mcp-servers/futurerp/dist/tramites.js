/**
 * Trámite write tools (Trami, Sprint 1 — TRM-10/11).
 *
 * Every tool runs under the caller's token: RLS decides what the user may
 * touch, `created_by` / `updated_by` are stamped by the audit trigger, and
 * the guards here only add what the UI enforces client-side (forward-only
 * stages, no-op on unchanged values, catalog enums). Registered only for
 * users with `tramites.manage` (Trami's ERP user, Flor).
 *
 * Stage lists, labels and document catalog mirror pronto-resolver-61:
 * src/types/tramite.ts and src/config/tramiteRequirements.ts. Keep in sync.
 */
import { z } from "zod";
// ── catalog (mirror of the app) ─────────────────────────────────────────────
const PRIMARY_STAGES = ["expediente_integracion", "documentacion_con_gestor", "folio_ingresado", "en_seguimiento_cfe", "c0b_emitida", "medidor_instalado", "sistema_activado"];
const CAMBIO_NOMBRE_STAGES = ["deteccion", "solicitar_documentos", "documentos_recibidos", "enviado_a_gestor", "ingresado_cfe", "en_seguimiento", "concluido"];
const CAMBIO_TARIFA_STAGES = ["deteccion", "enviado_a_gestor", "ingresado", "en_seguimiento", "concluido"];
const FACTIBILIDAD_STAGES = ["solicitud", "en_estudio_cfe", "dictamen_emitido", "concluido"];
const CAMBIO_220V_STAGES = ["deteccion", "evaluacion_tecnica", "enviado_a_gestor", "ingresado", "ejecutado", "concluido"];
const SERVICIO_STAGES = ["deteccion", "enviado_a_gestor", "ingresado", "ejecutado", "concluido"];
const UVIE_UIIE_STAGES = ["contratacion_uvie", "inspeccion", "dictamen_uvie", "dictamen_uiie", "concluido"];
export const TRAMITE_STAGES = {
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
const TIPOS = Object.keys(TRAMITE_STAGES);
const PRIMARY_TIPOS = new Set(["primary_bidireccional_dd11", "primary_dd10", "primary_dd12", "primary_dd06", "primary_foraneo"]);
const ZONAS = ["DD10", "DD11", "DD12", "DD06", "foraneo"];
const REQUERIDO_LABELS = ["Trámite de medidor bidireccional", "Cambio de nombre", "aumento de voltaje", "Alta de servicio", "Baja de servicio", "UVIE", "UIIE", "Otro"];
const BLOQUEO_CATEGORIAS = ["documentacion_cliente", "pago_financiamiento", "cfe_tramite", "material_proveedor", "interno_capacidad", "clima_sitio", "otro"];
const BLOQUEO_DEPENDENCIAS = ["nosotros", "cliente", "tercero"];
const ACTIVITY_TYPES = ["note", "status_change", "call", "email", "meeting", "assignment", "field_update", "conversion", "system"];
/** Base (non-conditional) document slots the app seeds on create, per tipo. */
const BIDIRECCIONAL_DOCS = ["Recibo CFE", "INE del titular"];
const FACTIBILIDAD_DOCS = ["Recibo CFE", "INE del titular", "Predial o escrituras", "Foto medidor con lecturas", "Foto preparación nuevo servicio"];
const BASE_DOCS = {
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
const SHARED_OPTIONAL_DOCS = ["Imagenes Instalacion", "Comprobante de ingreso"];
/** Columns the agent may patch. Everything else on the row is owned by triggers or people. */
const UPDATABLE = [
    "stage", "numero_si", "fecha_ingreso", "fecha_resolucion", "gestor_cfe", "comentarios",
    "enviado", "subsanacion_active", "fecha_subsanacion", "motivo_subsanacion",
    "c0b_rechazada", "fecha_c0b_rechazada", "pagado", "costo",
    "ultimo_seguimiento_at", "siguiente_revision_at", "docs_solicitados_at", "docs_recordatorio_at",
    "ultimo_estatus_cfe", "ultimo_estatus_cfe_at", "ultimo_estatus_cfe_avisado_at",
];
const FIREBASE_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];
const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
export function registerTramiteTools(server, deps) {
    const { userId, restBase, uuidRx, authHeaders, sbApi, sbRpc } = deps;
    async function sbWrite(method, path, body, prefer = "return=representation") {
        const res = await fetch(`${restBase}${path}`, { method, headers: authHeaders({ Prefer: prefer }), body: JSON.stringify(body) });
        const txt = await res.text();
        if (!res.ok)
            throw new Error(`Supabase ${res.status}: ${txt.slice(0, 400)}`);
        if (!txt)
            return null;
        try {
            return JSON.parse(txt);
        }
        catch {
            return txt;
        }
    }
    async function projectRow(idOrEfu, select = "id,efu,name,zona_cfe,stage,tramites_requeridos_otro") {
        const col = uuidRx.test(idOrEfu) ? "id" : "efu";
        const rows = await sbApi(`/projects?${col}=eq.${encodeURIComponent(idOrEfu)}&select=${select}&limit=1`);
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    async function logActivity(entityId, activityType, subject, description, extra = {}) {
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
    server.tool("futurerp_tramite_create", "Create a trámite (CFE procedure) on a project in its first stage and seed its document slots, exactly like the app's 'Nuevo trámite'. Refuses if the project already has a trámite of that tipo; a project has at most ONE primary (bidireccional) trámite, whatever the zona. Logs a note on the project timeline.", {
        project_id: z.string().describe("Project uuid or EFU code"),
        tipo: z.enum(TIPOS).describe("Trámite tipo. Primary tipos follow the project's zona_cfe: DD11→primary_bidireccional_dd11, DD10→primary_dd10, DD12→primary_dd12, DD06→primary_dd06, foraneo→primary_foraneo"),
        comentarios: z.string().optional().describe("Why it is being created (shown on the trámite and in the timeline)"),
    }, async ({ project_id, tipo, comentarios }) => {
        try {
            const p = await projectRow(project_id);
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            const existing = await sbApi(`/project_tramites?project_id=eq.${p.id}&select=id,tipo,stage`);
            const clash = existing.find((t) => t.tipo === tipo || (PRIMARY_TIPOS.has(tipo) && PRIMARY_TIPOS.has(t.tipo)));
            if (clash)
                return fail(`El proyecto ${p.efu ?? p.id} ya tiene un trámite ${clash.tipo} (${clash.id}, etapa ${clash.stage}). No se crea otro.`);
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
            }
            catch (e) {
                console.warn("[tramites] seed project_documents:", e.message);
            }
            await logActivity(p.id, "note", `Trámite creado: ${tipo}`, comentarios ?? null, { metadata: { tramite_id: row.id, tipo, source: "mcp" } });
            return text(`Trámite ${tipo} creado en ${p.efu ?? p.id}: id ${row.id}, etapa ${row.stage}. Slots de documentos sembrados: ${docs.map((d) => d.name).join(", ")}.`);
        }
        catch (e) {
            return fail(`No se pudo crear el trámite: ${e.message}`);
        }
    });
    // ── futurerp_tramite_update ───────────────────────────────────────────────
    server.tool("futurerp_tramite_update", "Update fields of a trámite the way the trámite card does: stage moves only FORWARD along the tipo's stage list, unchanged values are dropped, and every changed field is logged on the project timeline (field_update, old → new). enviado=true also stamps enviado_at/enviado_by. type_data keys are merged, never replaced. Returns what changed; a no-op if nothing differs.", {
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
    }, async ({ tramite_id, patch, motivo }) => {
        try {
            const rows = await sbApi(`/project_tramites?id=eq.${tramite_id}&select=*&limit=1`);
            const cur = rows[0];
            if (!cur)
                return fail(`No existe el trámite ${tramite_id} (o no tienes acceso).`);
            const stages = TRAMITE_STAGES[cur.tipo] ?? [];
            if (patch.stage !== undefined && patch.stage !== cur.stage) {
                const from = stages.indexOf(cur.stage);
                const to = stages.indexOf(patch.stage);
                if (to < 0)
                    return fail(`Etapa inválida para ${cur.tipo}: ${patch.stage}. Válidas: ${stages.join(" → ")}.`);
                if (from >= 0 && to < from)
                    return fail(`Un trámite nunca se mueve hacia atrás (${cur.stage} → ${patch.stage}).`);
            }
            const update = {};
            const changes = [];
            for (const key of UPDATABLE) {
                const v = patch[key];
                if (v === undefined)
                    continue;
                const before = cur[key];
                const same = typeof v === "number" ? Number(before) === v : String(before ?? "") === String(v ?? "");
                if (same)
                    continue;
                update[key] = v;
                changes.push({ field: key, from: before, to: v });
            }
            if (patch.type_data && Object.keys(patch.type_data).length) {
                const merged = { ...(cur.type_data ?? {}), ...patch.type_data };
                if (JSON.stringify(merged) !== JSON.stringify(cur.type_data ?? {})) {
                    update.type_data = merged;
                    for (const [k, v] of Object.entries(patch.type_data)) {
                        if (String((cur.type_data ?? {})[k] ?? "") !== String(v ?? ""))
                            changes.push({ field: `type_data.${k}`, from: (cur.type_data ?? {})[k], to: v });
                    }
                }
            }
            if (update.enviado === true && !cur.enviado) {
                update.enviado_at = new Date().toISOString();
                update.enviado_by = userId;
            }
            if (changes.length === 0)
                return text(`Sin cambios: el trámite ${tramite_id} ya tiene esos valores.`);
            const [after] = await sbWrite("PATCH", `/project_tramites?id=eq.${tramite_id}`, update);
            // The activity trigger (activity_log_triggers) already logs every other
            // column; it skips `stage` on purpose, so the card — and this tool — log
            // the stage move themselves.
            const stageChange = changes.find((c) => c.field === "stage");
            if (stageChange) {
                await logActivity(cur.project_id, "field_update", `Etapa de trámite: ${cur.tipo}`, motivo ?? null, {
                    old_value: String(stageChange.from ?? ""),
                    new_value: String(stageChange.to),
                    metadata: { tramite_id, tipo: cur.tipo, from_stage: stageChange.from, to_stage: stageChange.to, source: "mcp" },
                });
            }
            else if (motivo) {
                await logActivity(cur.project_id, "note", `Trámite ${cur.tipo}: ${changes.map((c) => c.field).join(", ")}`, motivo, { metadata: { tramite_id, source: "mcp" } });
            }
            return text(`Trámite ${tramite_id} actualizado (${changes.map((c) => `${c.field}: ${c.from ?? "—"} → ${c.to}`).join("; ")}). Etapa actual: ${after?.stage ?? cur.stage}.`);
        }
        catch (e) {
            return fail(`No se pudo actualizar el trámite: ${e.message}`);
        }
    });
    // ── futurerp_project_set_zona_cfe ─────────────────────────────────────────
    server.tool("futurerp_project_set_zona_cfe", "Set the project's CFE zone (DD10, DD11, DD12, DD06, foraneo) through the app's RPC. The zone decides which primary trámite tipo applies and when it is eligible.", {
        project_id: z.string().describe("Project uuid or EFU code"),
        zona: z.enum(ZONAS),
        motivo: z.string().optional().describe("How it was determined (recibo, dirección…)"),
    }, async ({ project_id, zona, motivo }) => {
        try {
            const p = await projectRow(project_id);
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            if (p.zona_cfe === zona)
                return text(`Sin cambios: ${p.efu ?? p.id} ya está en zona ${zona}.`);
            await sbRpc("set_project_zona_cfe", { p_project_id: p.id, p_zona: zona });
            if (motivo)
                await logActivity(p.id, "note", `Zona CFE ${zona}`, motivo, { metadata: { source: "mcp" } });
            return text(`Zona CFE de ${p.efu ?? p.id}: ${p.zona_cfe ?? "—"} → ${zona}.`);
        }
        catch (e) {
            return fail(`No se pudo fijar la zona: ${e.message}`);
        }
    });
    // ── futurerp_project_tramites_requeridos_set ──────────────────────────────
    server.tool("futurerp_project_tramites_requeridos_set", "Add (and optionally remove) required trámite labels on a project through the app's RPC (set_project_tramites_requeridos). The effective list is the manual list plus what the Visita Técnica marked; this tool is ADDITIVE: it keeps everything already there and adds `labels`. Pass `remove` to untick explicitly (the RPC records an untick as a veto, so only do it when a person asked). Labels in projects.tramites_requeridos_vetados are never re-added; they are dropped and reported. Omit `otro` to keep the current 'Otro' text; pass '' to clear it.", {
        project_id: z.string().describe("Project uuid or EFU code"),
        labels: z.array(z.enum(REQUERIDO_LABELS)).describe("Labels that must be present"),
        remove: z.array(z.enum(REQUERIDO_LABELS)).optional().describe("Labels to untick (recorded as vetoes)"),
        otro: z.string().optional().describe("Free text for the 'Otro' label; omit to keep, '' to clear"),
        motivo: z.string().optional(),
    }, async ({ project_id, labels, remove, otro, motivo }) => {
        try {
            const p = await projectRow(project_id, "id,efu,tramites_requeridos_manual,tramites_requeridos_vtecnica,tramites_requeridos_vetados,tramites_requeridos_otro");
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            const vetados = p.tramites_requeridos_vetados ?? [];
            const current = [...new Set([...(p.tramites_requeridos_manual ?? []), ...(p.tramites_requeridos_vtecnica ?? [])])];
            const blocked = labels.filter((l) => vetados.includes(l));
            const drop = new Set(remove ?? []);
            const send = [...new Set([...current, ...labels])].filter((l) => !vetados.includes(l) && !drop.has(l)).sort();
            const sameList = send.length === current.length && send.every((l) => current.includes(l));
            const otroSame = otro === undefined || (otro || null) === (p.tramites_requeridos_otro ?? null);
            const vetNote = blocked.length ? ` Vetados por una persona (no se agregan): ${blocked.join(", ")}.` : "";
            if (sameList && otroSame)
                return text(`Sin cambios en ${p.efu ?? p.id}: ${current.join(", ") || "sin trámites requeridos"}.${vetNote}`);
            const args = { p_project_id: p.id, p_labels: send };
            if (otro !== undefined)
                args.p_otro = otro;
            await sbRpc("set_project_tramites_requeridos", args);
            if (motivo)
                await logActivity(p.id, "note", "Trámites requeridos", motivo, { metadata: { source: "mcp", labels: send, removed: [...drop], vetados_omitidos: blocked } });
            return text(`Trámites requeridos de ${p.efu ?? p.id}: ${send.join(", ") || "ninguno"} (antes: ${current.join(", ") || "ninguno"}).${vetNote}`);
        }
        catch (e) {
            return fail(`No se pudo fijar la lista: ${e.message}`);
        }
    });
    // ── futurerp_activity_add ─────────────────────────────────────────────────
    server.tool("futurerp_activity_add", "Write a note on a project's timeline (crm_activities, performed_by = you). Use it to explain decisions, record what the gestora said (quoted), or leave a question for Flor.", {
        project_id: z.string().describe("Project uuid or EFU code"),
        activity_type: z.enum(ACTIVITY_TYPES).default("note"),
        subject: z.string().max(200),
        description: z.string().max(4000).optional(),
    }, async ({ project_id, activity_type, subject, description }) => {
        try {
            const p = await projectRow(project_id, "id,efu");
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            await logActivity(p.id, activity_type, subject, description ?? null, { metadata: { source: "mcp" } });
            return text(`Nota registrada en ${p.efu ?? p.id}: ${subject}`);
        }
        catch (e) {
            return fail(`No se pudo registrar la nota: ${e.message}`);
        }
    });
    // ── futurerp_tramite_link_file ────────────────────────────────────────────
    server.tool("futurerp_tramite_link_file", "Attach a file to a trámite under a document slot (doc_key), like the trámite card's 'Vincular'. Either an existing project_files id, or a Firebase Storage URL + name to register first. Idempotent on (tramite, file). Use doc_key 'Comprobante de ingreso' for the gestora's ingreso PDF.", {
        tramite_id: z.string().uuid(),
        file_id: z.string().uuid().optional().describe("Existing project_files.id"),
        url: z.string().url().optional().describe("Firebase Storage URL of a file not yet registered"),
        name: z.string().optional().describe("File name when registering by url"),
        doc_key: z.string().describe("Document slot, e.g. 'Comprobante de ingreso', 'Recibo CFE', 'Imagenes Instalacion'"),
    }, async ({ tramite_id, file_id, url, name, doc_key }) => {
        try {
            const [t] = await sbApi(`/project_tramites?id=eq.${tramite_id}&select=id,project_id,tipo&limit=1`);
            if (!t)
                return fail(`No existe el trámite ${tramite_id} (o no tienes acceso).`);
            let fileId = file_id;
            if (!fileId) {
                if (!url || !name)
                    return fail("Indica file_id, o url + name.");
                const host = new URL(url).hostname;
                if (!FIREBASE_HOSTS.includes(host))
                    return fail(`Solo se vinculan archivos del Storage de Firebase (host recibido: ${host}).`);
                const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : null;
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
        }
        catch (e) {
            return fail(`No se pudo vincular el archivo: ${e.message}`);
        }
    });
    // ── futurerp_bloqueo_open ─────────────────────────────────────────────────
    server.tool("futurerp_bloqueo_open", "Open a bloqueo (blocker) on a project at its current stage, like the project's 'Bloqueo' button. Use categoria cfe_tramite for a trámite stuck at CFE. Refuses if an active bloqueo of the same categoria already exists.", {
        project_id: z.string().describe("Project uuid or EFU code"),
        categoria: z.enum(BLOQUEO_CATEGORIAS),
        dependencia: z.enum(BLOQUEO_DEPENDENCIAS).describe("Who the resolution depends on"),
        motivo: z.string().min(5).max(2000),
    }, async ({ project_id, categoria, dependencia, motivo }) => {
        try {
            const p = await projectRow(project_id, "id,efu,stage");
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            const open = await sbApi(`/project_bloqueos?project_id=eq.${p.id}&estado=eq.activo&categoria=eq.${categoria}&select=id,motivo`);
            if (open.length)
                return fail(`Ya hay un bloqueo ${categoria} activo en ${p.efu ?? p.id} (${open[0].id}): ${open[0].motivo}`);
            const [b] = await sbWrite("POST", "/project_bloqueos", { project_id: p.id, stage: p.stage, categoria, dependencia, motivo, created_by: userId });
            return text(`Bloqueo ${categoria} abierto en ${p.efu ?? p.id} (id ${b.id}, etapa ${p.stage}, depende de ${dependencia}).`);
        }
        catch (e) {
            return fail(`No se pudo abrir el bloqueo: ${e.message}`);
        }
    });
}
