/**
 * futurerp_tramite_contexto: everything a trámite session needs about one
 * project in ONE call and a few thousand tokens, instead of get_project's
 * full row dump plus five follow-up queries. Reads go through the user's RLS.
 */
import { z } from "zod";
const EXPEDIENTE_SLOTS = new Set([
    "Recibo CFE", "Recibo de luz", "INE del titular", "INE Para Cambio De Medidor", "INE del Firmante", "INE nuevo titular",
    "Predial", "Escrituras", "Predial o escrituras", "Acta Constitutiva", "Documentos Adicionales",
    "Foto de Medidor", "Foto medidor con lecturas", "Foto preparación nuevo servicio", "Imagenes Instalacion", "Comprobante de ingreso",
    "Contrato Firmado (incluye Anexo A)", "Dictamen De UVIE", "Dictamen de UIIE",
]);
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
const tel = (s) => (s ? s.replace(/[^\d+]/g, "") : null);
export function registerContextoTool(server, deps) {
    server.tool("futurerp_tramite_contexto", "Start here for any trámite work on a project: one call returns the project (zona, tarifa, stage, required labels, vetoes, RFC, address, Maps link), the client (name, phones, email), every trámite with its fields, the expediente slots with their files (ids for futurerp_read_document / mail attachments; files attached from the trámite card included), the BOM (panels, micros, kW), active bloqueos and the last timeline notes. Accepts an EFU or a uuid.", { project_id: z.string().describe("Project uuid or EFU code") }, async ({ project_id }) => {
        try {
            const q = deps.uuidRx.test(project_id) ? `id=eq.${project_id}` : `efu=eq.${encodeURIComponent(project_id)}`;
            const [p] = await deps.sbApi(`/projects?${q}&select=id,efu,name,stage,zona_cfe,tarifa_cfe,tipo_proyecto,rfc,razon_social,email_facturacion,tramites_requeridos_manual,tramites_requeridos_vtecnica,tramites_requeridos_vetados,tramites_requeridos_otro,paneles_solicitados,potencia_total,proyecto_street,proyecto_city,proyecto_state_code,proyecto_postal_code,instalacion_street,instalacion_city,proyecto_latitude,proyecto_longitude,instalacion_latitude,instalacion_longitude,fecha_anticipo_completo,client_id,clients(first_name,last_name,name,phone,mobile_phone,email)&limit=1`) ?? [];
            if (!p)
                return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
            const id = p.id;
            const [tramites, docs, files, links, bom, bloqueos, notas] = await Promise.all([
                deps.sbApi(`/project_tramites?project_id=eq.${id}&select=id,tipo,stage,enviado,enviado_at,numero_si,fecha_ingreso,gestor_cfe,fecha_resolucion,subsanacion_active,motivo_subsanacion,pagado,costo,docs_solicitados_at,docs_recordatorio_at,siguiente_revision_at,ultimo_estatus_cfe,ultimo_estatus_cfe_at,ultimo_estatus_cfe_avisado_at,comentarios,created_at&order=created_at`),
                deps.sbApi(`/project_documents?project_id=eq.${id}&select=id,name,requerido`),
                deps.sbApi(`/project_files?project_id=eq.${id}&select=id,file_name,mime_type,file_size,document_id,created_at&order=created_at.desc&limit=200`),
                deps.sbApi(`/tramite_file_links?select=tramite_id,doc_key,project_files(id,file_name,mime_type,file_size)&tramite_id=in.(${"00000000-0000-0000-0000-000000000000"})`).catch(() => []),
                deps.sbApi(`/project_products?project_id=eq.${id}&select=quantity,catalog_items(name,category,watts_per_unit)`),
                deps.sbApi(`/project_bloqueos?project_id=eq.${id}&estado=eq.activo&select=id,categoria,dependencia,motivo,created_at`),
                deps.sbApi(`/crm_activities?entity_type=eq.project&entity_id=eq.${id}&select=created_at,activity_type,subject&order=created_at.desc&limit=8`),
            ]);
            const tramIds = (tramites ?? []).map((t) => t.id);
            const linkRows = tramIds.length ? await deps.sbApi(`/tramite_file_links?select=tramite_id,doc_key,project_files(id,file_name,mime_type,file_size)&tramite_id=in.(${tramIds.join(",")})`) : links;
            const c = p.clients ?? {};
            const cliente = { nombre: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.name || null, celular: tel(c.mobile_phone), telefono: tel(c.phone), email: c.email ?? p.email_facturacion ?? null };
            const requeridos = [...new Set([...(p.tramites_requeridos_manual ?? []), ...(p.tramites_requeridos_vtecnica ?? [])])];
            const lat = p.proyecto_latitude ?? p.instalacion_latitude, lng = p.proyecto_longitude ?? p.instalacion_longitude;
            const direccion = [p.proyecto_street ?? p.instalacion_street, p.proyecto_city ?? p.instalacion_city, p.proyecto_state_code, p.proyecto_postal_code].filter(Boolean).join(", ");
            // Expediente: slot → files (project slots + files attached from the trámite card).
            const porSlot = new Map();
            for (const d of docs ?? [])
                if (EXPEDIENTE_SLOTS.has(d.name))
                    porSlot.set(d.name, { requerido: !!d.requerido, archivos: [] });
            const nameOf = new Map((docs ?? []).map((d) => [d.id, d.name]));
            for (const f of files ?? []) {
                const slot = f.document_id ? nameOf.get(f.document_id) : null;
                if (slot && porSlot.has(slot))
                    porSlot.get(slot).archivos.push({ id: f.id, nombre: f.file_name, tipo: f.mime_type ?? null, kb: Math.round((f.file_size ?? 0) / 1024) });
            }
            for (const l of linkRows ?? []) {
                if (!l.doc_key || !l.project_files)
                    continue;
                if (!porSlot.has(l.doc_key))
                    porSlot.set(l.doc_key, { requerido: false, archivos: [] });
                const arr = porSlot.get(l.doc_key).archivos;
                if (!arr.some((a) => a.id === l.project_files.id))
                    arr.push({ id: l.project_files.id, nombre: l.project_files.file_name, tipo: l.project_files.mime_type ?? null, kb: Math.round((l.project_files.file_size ?? 0) / 1024) });
            }
            const otros = (files ?? []).filter((f) => !f.document_id || !EXPEDIENTE_SLOTS.has(nameOf.get(f.document_id))).slice(0, 15).map((f) => `${f.file_name} (${f.id})`);
            const paneles = (bom ?? []).filter((b) => b.catalog_items?.category === "Paneles");
            const micros = (bom ?? []).filter((b) => ["Microinversores", "Inversores"].includes(b.catalog_items?.category));
            const kw = paneles.reduce((s, b) => s + Number(b.quantity) * Number(b.catalog_items?.watts_per_unit ?? 0), 0) / 1000;
            const md = [
                `# ${p.efu ?? "(sin EFU)"} · ${p.name}  (uuid ${id})`,
                `Etapa: ${p.stage ?? "—"} · Zona CFE: ${p.zona_cfe ?? "SIN ZONA"} · Tarifa: ${p.tarifa_cfe ?? "—"} · Tipo: ${p.tipo_proyecto ?? "—"}${p.rfc ? ` · RFC ${p.rfc}${String(p.rfc).length === 12 ? " (persona moral)" : ""}` : ""}${p.razon_social ? ` · ${p.razon_social}` : ""}`,
                `Anticipo completo: ${p.fecha_anticipo_completo ?? "—"} · Dirección: ${direccion || "—"}${lat && lng ? ` · Maps: https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : ""}`,
                `Cliente: ${cliente.nombre ?? "—"} · cel ${cliente.celular ?? "—"} · tel ${cliente.telefono ?? "—"} · ${cliente.email ?? "sin email"}`,
                `Requeridos (VT + manual): ${requeridos.join(", ") || "ninguno"}${p.tramites_requeridos_vetados?.length ? ` · VETADOS (no volver a poner): ${p.tramites_requeridos_vetados.join(", ")}` : ""}${p.tramites_requeridos_otro ? ` · Otro: "${p.tramites_requeridos_otro}"` : ""}`,
                "",
                `## Trámites (${(tramites ?? []).length})`,
                ...((tramites ?? []).length ? tramites.map((t) => `- ${t.tipo} · etapa ${t.stage} · id ${t.id}${t.enviado ? ` · enviado ${String(t.enviado_at).slice(0, 10)}` : ""}${t.numero_si ? ` · SI ${t.numero_si}` : ""}${t.fecha_ingreso ? ` · ingreso ${t.fecha_ingreso}` : ""}${t.gestor_cfe ? ` · gestor ${t.gestor_cfe}` : ""}${t.subsanacion_active ? ` · EN SUBSANACIÓN: ${t.motivo_subsanacion ?? ""}` : ""}${t.docs_solicitados_at ? ` · docs pedidos ${String(t.docs_solicitados_at).slice(0, 10)}` : ""}${t.siguiente_revision_at ? ` · revisar ${t.siguiente_revision_at}` : ""}${t.ultimo_estatus_cfe ? ` · CFE: ${t.ultimo_estatus_cfe}` : ""}${t.pagado ? ` · pagado $${t.costo ?? "?"}` : ""}`) : ["- ninguno"]),
                "",
                "## Expediente (slot → archivos; usa el id con futurerp_read_document o como adjunto)",
                ...[...porSlot.entries()].map(([slot, v]) => `- ${slot}${v.requerido ? " (requerido)" : ""}: ${v.archivos.length ? v.archivos.map((a) => `${a.nombre} [${a.id}${a.tipo ? `, ${a.tipo}` : ""}${a.kb ? `, ${a.kb} KB` : ""}]`).join("; ") : "VACÍO"}`),
                otros.length ? `- Otros archivos del proyecto: ${otros.join(", ")}` : "",
                "",
                `## Equipo (BOM): ${paneles.length ? paneles.map((b) => `${b.quantity} × ${b.catalog_items.name}`).join(", ") : "sin paneles en el BOM"}; ${micros.length ? micros.map((b) => `${b.quantity} × ${b.catalog_items.name}`).join(", ") : "sin microinversores en el BOM"}; ${kw ? `${kw.toFixed(2)} kW, ~${(kw * 5.1).toFixed(1)} kWh/día` : p.potencia_total ? `${(Number(p.potencia_total) / 1000).toFixed(2)} kW (columna del proyecto)` : "potencia desconocida"}${p.paneles_solicitados ? ` · paneles solicitados: ${p.paneles_solicitados}` : ""}`,
                "",
                `## Bloqueos activos: ${(bloqueos ?? []).length ? bloqueos.map((b) => `${b.categoria} (${b.dependencia}): ${b.motivo}`).join(" | ") : "ninguno"}`,
                "",
                "## Últimas notas del timeline",
                ...((notas ?? []).length ? notas.map((n) => `- ${String(n.created_at).slice(0, 16)} ${n.activity_type}: ${n.subject}`) : ["- ninguna"]),
            ].filter((l) => l !== "").join("\n");
            return { content: [{ type: "text", text: md }] };
        }
        catch (e) {
            return fail(`No se pudo armar el contexto: ${e?.message ?? e}`);
        }
    });
}
