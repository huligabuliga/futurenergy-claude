/**
 * Trami write-tool guard: shadow mode + error logging.
 *
 * system_config.trami_mode = 'shadow' (default) → every write tool records what
 * it WOULD do in agent_shadow_calls and returns a "(sombra)" result; nothing is
 * written, sent or mailed. 'live' → the tool runs. Flor grades the shadow rows
 * (trami_shadow_verdict) and trami_stats() reports the agreement per tool.
 * Either way a tool error lands in bot_error_log (fase 'trami').
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface GuardDeps {
  userId: string;
  restBase: string;
  uuidRx: RegExp;
  sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
  serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
}

/** Tools that change the world. Notes (activity_add) and reads are never shadowed. */
export const SHADOW_TOOLS = new Set([
  "futurerp_tramite_create", "futurerp_tramite_update", "futurerp_tramite_link_file",
  "futurerp_project_set_zona_cfe", "futurerp_project_tramites_requeridos_set",
  "futurerp_bloqueo_open", "futurerp_verification_tick",
  "futurerp_whatsapp_send", "futurerp_mail_send",
]);

let modeCache: { at: number; mode: "shadow" | "live" } = { at: 0, mode: "shadow" };
const MODE_TTL_MS = Number(process.env.TRAMI_MODE_CACHE_MS ?? 30_000);
export async function tramiMode(deps: GuardDeps): Promise<"shadow" | "live"> {
  if (Date.now() - modeCache.at < MODE_TTL_MS) return modeCache.mode;
  try {
    const rows: any[] = await deps.sbApi(`/system_config?config_key=eq.trami_mode&select=config_value`, deps.serviceHeaders());
    const mode = rows?.[0]?.config_value === "live" ? "live" : "shadow";
    modeCache = { at: Date.now(), mode };
  } catch {
    // ponytail: unreadable flag = shadow; never fail open into writing.
    modeCache = { at: Date.now(), mode: "shadow" };
  }
  return modeCache.mode;
}
export const resetModeCache = () => { modeCache = { at: 0, mode: "shadow" }; };

const short = (v: unknown, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };

/** One Spanish line per tool, for the shadow table and the Buzón. */
export function describeCall(name: string, a: Record<string, any>): string {
  switch (name) {
    case "futurerp_tramite_create": return `Crear trámite ${a.tipo} en ${a.project_id}`;
    case "futurerp_tramite_update": return `Actualizar trámite ${a.tramite_id}: ${Object.entries(a.patch ?? {}).map(([k, v]) => `${k}=${short(v, 40)}`).join(", ")}${a.motivo ? ` (${short(a.motivo, 80)})` : ""}`;
    case "futurerp_tramite_link_file": return `Adjuntar ${a.file_name ?? a.file_id ?? a.url} al trámite ${a.tramite_id} como ${a.doc_key}`;
    case "futurerp_project_set_zona_cfe": return `Fijar zona ${a.zona} en ${a.project_id}`;
    case "futurerp_project_tramites_requeridos_set": return `Requeridos de ${a.project_id}: +${(a.labels ?? []).join(", ")}${a.remove?.length ? ` −${a.remove.join(", ")}` : ""}${a.motivo ? ` (${short(a.motivo, 80)})` : ""}`;
    case "futurerp_bloqueo_open": return `Abrir bloqueo ${a.categoria ?? "cfe_tramite"} en ${a.project_id}: ${short(a.motivo, 100)}`;
    case "futurerp_verification_tick": return `Palomear ${a.item_key} en el checklist de ${a.project_id}`;
    case "futurerp_whatsapp_send": return `WhatsApp a ${a.chat_id ?? a.conversation_id}: "${short(a.text, 120)}"${a.media_url ? " + archivo" : ""}`;
    case "futurerp_mail_send": return `Correo a ${a.to}: "${short(a.subject, 100)}" (${(a.attachment_file_ids ?? []).length} adjuntos)`;
    default: return `${name} ${short(a, 200)}`;
  }
}

async function resolveIds(deps: GuardDeps, a: Record<string, any>): Promise<{ project_id: string | null; tramite_id: string | null }> {
  let project_id: string | null = null, tramite_id: string | null = null;
  try {
    if (a.tramite_id && deps.uuidRx.test(a.tramite_id)) {
      tramite_id = a.tramite_id;
      const t: any[] = await deps.sbApi(`/project_tramites?id=eq.${a.tramite_id}&select=project_id`, deps.serviceHeaders());
      project_id = t?.[0]?.project_id ?? null;
    } else if (a.project_id) {
      const q = deps.uuidRx.test(a.project_id) ? `id=eq.${a.project_id}` : `efu=eq.${encodeURIComponent(a.project_id)}`;
      const p: any[] = await deps.sbApi(`/projects?${q}&select=id`, deps.serviceHeaders());
      project_id = p?.[0]?.id ?? null;
    } else if (typeof a.chat_id === "string" && !/@g\.us$/.test(a.chat_id)) {
      // A WhatsApp to a client: find the client by phone, then their newest project.
      const digits = a.chat_id.replace(/\D/g, "");
      const local = digits.length >= 10 ? digits.slice(-10) : digits;
      if (local.length === 10) {
        // Stored phones carry spaces and prefixes ("+52 1 81 8366 7268"): match on the last 4
        // digits in SQL, then on the full 10 digits here.
        const tail = local.slice(-4);
        const cands: any[] = await deps.sbApi(`/clients?or=(mobile_phone.ilike.*${tail}*,phone.ilike.*${tail}*)&select=id,mobile_phone,phone&limit=50`, deps.serviceHeaders());
        const d10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
        const c = (cands ?? []).filter((x) => d10(x.mobile_phone) === local || d10(x.phone) === local);
        if (c?.[0]?.id) {
          const p: any[] = await deps.sbApi(`/projects?client_id=eq.${c[0].id}&select=id&order=created_at.desc&limit=1`, deps.serviceHeaders());
          project_id = p?.[0]?.id ?? null;
        }
      }
    }
  } catch { /* labels only */ }
  return { project_id, tramite_id };
}

export async function logToolError(deps: GuardDeps, name: string, args: unknown, detalle: string) {
  try {
    await fetch(`${deps.restBase}/bot_error_log`, {
      method: "POST",
      headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ contact_key: "trami", fase: "trami", tipo: `mcp:${name.replace(/^futurerp_/, "")}`, detalle: `${detalle}\n\nuser ${deps.userId}\nargs ${short(args, 1500)}` }),
    });
  } catch (e: any) {
    console.error("[trami guard] bot_error_log:", e?.message);
  }
}

type Handler = (args: any, extra: any) => Promise<any>;

/**
 * server.tool() with the guard: shadow for SHADOW_TOOLS, error logging for
 * every tool it wraps. Typed as McpServer['tool'] so the handlers keep the
 * argument types inferred from their zod schema.
 */
export function guardedTool(server: McpServer, deps: GuardDeps): McpServer["tool"] {
  const wrapped = (name: string, description: string, schema: any, handler: Handler) =>
    server.tool(name, description, schema, async (args: any, extra: any) => {
      try {
        if (SHADOW_TOOLS.has(name) && (await tramiMode(deps)) === "shadow") {
          const resumen = describeCall(name, args ?? {});
          const ids = await resolveIds(deps, args ?? {});
          await fetch(`${deps.restBase}/agent_shadow_calls`, {
            method: "POST",
            headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ agent: "trami", tool_name: name, tool_input: args ?? {}, resumen, user_id: deps.userId, ...ids }),
          });
          return { content: [{ type: "text" as const, text: `(sombra) ${resumen}. Trami está en modo sombra: la acción quedó registrada para que Flor la califique y NO se ejecutó. Sigue con el resto del trabajo como si se hubiera hecho; no la repitas.` }] };
        }
        const res = await handler(args, extra);
        if (res?.isError) await logToolError(deps, name, args, String(res?.content?.[0]?.text ?? "error"));
        return res;
      } catch (e: any) {
        await logToolError(deps, name, args, `throw: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `Error en ${name}: ${e?.message ?? e}. Quedó registrado; no lo reintentes más de una vez, anótalo en el timeline y sigue.` }], isError: true as const };
      }
    });
  return wrapped as unknown as McpServer["tool"];
}
