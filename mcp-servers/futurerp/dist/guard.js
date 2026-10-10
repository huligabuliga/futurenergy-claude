/** Tools that change the world. Notes (activity_add) and reads are never shadowed. */
export const SHADOW_TOOLS = new Set([
    "futurerp_tramite_create", "futurerp_tramite_update", "futurerp_tramite_link_file",
    "futurerp_project_set_zona_cfe", "futurerp_project_tramites_requeridos_set",
    "futurerp_bloqueo_open", "futurerp_verification_tick",
    "futurerp_whatsapp_send", "futurerp_mail_send",
]);
let modeCache = { at: 0, mode: "shadow" };
const MODE_TTL_MS = Number(process.env.TRAMI_MODE_CACHE_MS ?? 30_000);
export async function tramiMode(deps) {
    if (Date.now() - modeCache.at < MODE_TTL_MS)
        return modeCache.mode;
    try {
        const rows = await deps.sbApi(`/system_config?config_key=eq.trami_mode&select=config_value`, deps.serviceHeaders());
        const mode = rows?.[0]?.config_value === "live" ? "live" : "shadow";
        modeCache = { at: Date.now(), mode };
    }
    catch {
        // ponytail: unreadable flag = shadow; never fail open into writing.
        modeCache = { at: Date.now(), mode: "shadow" };
    }
    return modeCache.mode;
}
export const resetModeCache = () => { modeCache = { at: 0, mode: "shadow" }; };
const short = (v, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
/** One Spanish line per tool, for the shadow table and the Buzón. */
export function describeCall(name, a) {
    switch (name) {
        case "futurerp_tramite_create": return `Crear trámite ${a.tipo} en ${a.project_id}`;
        case "futurerp_tramite_update": return `Actualizar trámite ${a.tramite_id}: ${Object.entries(a.patch ?? {}).map(([k, v]) => `${k}=${short(v, 40)}`).join(", ")}${a.motivo ? ` (${short(a.motivo, 80)})` : ""}`;
        case "futurerp_tramite_link_file": return `Adjuntar ${a.file_name ?? a.file_id ?? a.url} al trámite ${a.tramite_id} como ${a.doc_key}`;
        case "futurerp_project_set_zona_cfe": return `Fijar zona ${a.zona} en ${a.project_id}`;
        case "futurerp_project_tramites_requeridos_set": return `Requeridos de ${a.project_id}: +${(a.add ?? []).join(", ")}${a.remove?.length ? ` −${a.remove.join(", ")}` : ""}`;
        case "futurerp_bloqueo_open": return `Abrir bloqueo ${a.categoria ?? "cfe_tramite"} en ${a.project_id}: ${short(a.motivo, 100)}`;
        case "futurerp_verification_tick": return `Palomear ${a.item_key} en el checklist de ${a.project_id}`;
        case "futurerp_whatsapp_send": return `WhatsApp a ${a.chat_id ?? a.conversation_id}: "${short(a.text, 120)}"${a.media_url ? " + archivo" : ""}`;
        case "futurerp_mail_send": return `Correo a ${a.to}: "${short(a.subject, 100)}" (${(a.attachment_file_ids ?? []).length} adjuntos)`;
        default: return `${name} ${short(a, 200)}`;
    }
}
async function resolveIds(deps, a) {
    let project_id = null, tramite_id = null;
    try {
        if (a.tramite_id && deps.uuidRx.test(a.tramite_id)) {
            tramite_id = a.tramite_id;
            const t = await deps.sbApi(`/project_tramites?id=eq.${a.tramite_id}&select=project_id`, deps.serviceHeaders());
            project_id = t?.[0]?.project_id ?? null;
        }
        else if (a.project_id) {
            const q = deps.uuidRx.test(a.project_id) ? `id=eq.${a.project_id}` : `efu=eq.${encodeURIComponent(a.project_id)}`;
            const p = await deps.sbApi(`/projects?${q}&select=id`, deps.serviceHeaders());
            project_id = p?.[0]?.id ?? null;
        }
    }
    catch { /* labels only */ }
    return { project_id, tramite_id };
}
export async function logToolError(deps, name, args, detalle) {
    try {
        await fetch(`${deps.restBase}/bot_error_log`, {
            method: "POST",
            headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ contact_key: "trami", fase: "trami", tipo: `mcp:${name.replace(/^futurerp_/, "")}`, detalle: `${detalle}\n\nuser ${deps.userId}\nargs ${short(args, 1500)}` }),
        });
    }
    catch (e) {
        console.error("[trami guard] bot_error_log:", e?.message);
    }
}
/**
 * server.tool() with the guard: shadow for SHADOW_TOOLS, error logging for
 * every tool it wraps. Typed as McpServer['tool'] so the handlers keep the
 * argument types inferred from their zod schema.
 */
export function guardedTool(server, deps) {
    const wrapped = (name, description, schema, handler) => server.tool(name, description, schema, async (args, extra) => {
        try {
            if (SHADOW_TOOLS.has(name) && (await tramiMode(deps)) === "shadow") {
                const resumen = describeCall(name, args ?? {});
                const ids = await resolveIds(deps, args ?? {});
                await fetch(`${deps.restBase}/agent_shadow_calls`, {
                    method: "POST",
                    headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
                    body: JSON.stringify({ agent: "trami", tool_name: name, tool_input: args ?? {}, resumen, user_id: deps.userId, ...ids }),
                });
                return { content: [{ type: "text", text: `(sombra) ${resumen}. Trami está en modo sombra: la acción quedó registrada para que Flor la califique y NO se ejecutó. Sigue con el resto del trabajo como si se hubiera hecho; no la repitas.` }] };
            }
            const res = await handler(args, extra);
            if (res?.isError)
                await logToolError(deps, name, args, String(res?.content?.[0]?.text ?? "error"));
            return res;
        }
        catch (e) {
            await logToolError(deps, name, args, `throw: ${e?.message ?? e}`);
            return { content: [{ type: "text", text: `Error en ${name}: ${e?.message ?? e}. Quedó registrado; no lo reintentes más de una vez, anótalo en el timeline y sigue.` }], isError: true };
        }
    });
    return wrapped;
}
