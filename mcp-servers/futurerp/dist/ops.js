/** futurerp_trami_stats: the numbers behind the daily report (trami_stats + trami_health RPCs, caller's RLS). */
import { z } from "zod";
export function registerOpsTools(server, deps) {
    server.tool("futurerp_trami_barrido", "The morning sweep list in one call. By default only the projects that need your judgement today: changed by someone else since the last sweep, in subsanación, review date due, DD10/DD11 that just became eligible (7 days after the anticipo), or > 60 days with CFE and not chased in 7 days. Each row says why (motivo). The quiet ones are only counted, for the summary: do not look them up. todos=true returns every open project (Friday audit). Open futurerp_tramite_contexto only for the projects you will act on.", {
        todos: z.boolean().optional().describe("true = every open project (audit), default = only what changed or is due"),
        desde: z.string().datetime({ offset: true }).optional().describe("Override the cutoff (ISO timestamp); only for evals and replays"),
    }, async ({ todos, desde }) => {
        try {
            const P = { 1: "en subsanación", 2: "revisión vencida", 3: "armando expediente", 4: "sin trámite", 5: "con la gestora sin noticias", 6: "en curso" };
            const line = (r) => {
                const tr = (r.tramites ?? []).map((t) => `${t.tipo}:${t.etapa}${t.enviado ? "/enviado" : ""}${t.si ? `/SI ${t.si}` : ""}${t.subsanacion ? "/SUBSANACIÓN" : ""}${t.revisar ? `/revisar ${t.revisar}` : ""}${t.docs_pedidos ? `/docs pedidos ${t.docs_pedidos}` : ""}${t.ingreso ? `/ingreso ${t.ingreso}` : ""} (${t.dias_en_etapa}d, id ${t.id})`).join("; ");
                return `- [${r.prioridad} ${P[r.prioridad]}]${r.motivo ? ` (${r.motivo})` : ""} ${r.efu} ${r.name} · ${r.stage} · zona ${r.zona_cfe ?? "SIN ZONA"} · requeridos: ${(r.requeridos ?? []).join(", ") || "—"}${r.vetados?.length ? ` · vetados: ${r.vetados.join(", ")}` : ""}${r.bloqueado ? " · BLOQUEADO" : ""} · recibo ${r.tiene_recibo ? "sí" : "no"}, INE ${r.tiene_ine ? "sí" : "no"} · trámites: ${tr || "ninguno"}`;
            };
            if (todos) {
                const rows = (await deps.sbRpc("trami_barrido")) ?? [];
                return { content: [{ type: "text", text: `## Barrido completo (${rows.length} proyectos)\n${rows.map(line).join("\n") || "- nada"}` }] };
            }
            const d = (await deps.sbRpc("trami_barrido_delta", desde ? { p_desde: desde } : {})) ?? {};
            const rows = d.proyectos ?? [];
            const quietos = Object.entries(d.quietos_por_prioridad ?? {}).map(([k, n]) => `${n} ${P[Number(k)] ?? k}`).join(", ");
            return { content: [{ type: "text", text: `## Barrido: ${rows.length} de ${d.total ?? "?"} proyectos necesitan tu juicio hoy (cambios desde ${String(d.desde ?? "").slice(0, 16).replace("T", " ")} UTC)\nSin cambios, no los revises: ${quietos || "ninguno"}${d.en_espera_dd10_dd11 ? ` (incluye ${d.en_espera_dd10_dd11} DD10/DD11 en su semana de espera)` : ""}.\n${rows.map(line).join("\n") || "- nada que hacer hoy"}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudo leer el barrido: ${e?.message ?? e}` }], isError: true };
        }
    });
    server.tool("futurerp_trami_acuses", "Monday acuses list: expedientes sent to the gestora that still have no SI and were not chased in the last 7 days, grouped (más de un mes / 2 a 4 semanas / esta semana), longest wait first. Already filtered: send ONE grouped reminder with exactly these, then mark ultimo_seguimiento_at on each. Empty = send nothing.", {}, async () => {
        try {
            const rows = (await deps.sbRpc("trami_acuses_pendientes")) ?? [];
            if (!rows.length)
                return { content: [{ type: "text", text: "Sin acuses pendientes esta semana: no mandes nada." }] };
            const groups = ["más de un mes", "2 a 4 semanas", "esta semana"].map((g) => [g, rows.filter((r) => r.grupo === g)]).filter(([, v]) => v.length);
            return { content: [{ type: "text", text: `## Acuses pendientes (${rows.length})\n${groups.map(([g, v]) => `### ${g}\n${v.map((r) => `- ${r.cliente ?? r.name} · ${r.efu} · ${r.tipo} · ${r.dias} días (trámite ${r.tramite_id})`).join("\n")}`).join("\n")}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudieron leer los acuses: ${e?.message ?? e}` }], isError: true };
        }
    });
    server.tool("futurerp_trami_lecciones", "Tramitología's corrections of your past actions (shadow mode grades, from tramites.manage holders): what you proposed, whether they would have done the same (correcto / parcial / incorrecto) and what they would have done instead. Read them at the start of every session; they override your own judgement and your memory.", { limit: z.number().int().min(1).max(200).default(40) }, async ({ limit }) => {
        try {
            const rows = (await deps.sbRpc("trami_lecciones", { p_limit: limit })) ?? [];
            if (!rows.length)
                return { content: [{ type: "text", text: "Sin lecciones todavía: tramitología no ha corregido ninguna acción." }] };
            const lines = rows.map((r) => `- [${r.verdict}] ${r.proyecto ? `${r.proyecto} (${r.efu}) · ` : ""}${r.resumen}\n  Tramitología: ${r.verdict_nota ?? "(sin nota)"}`);
            return { content: [{ type: "text", text: `## Lecciones de tramitología (${rows.length}, correcciones primero)\n${lines.join("\n")}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudieron leer las lecciones: ${e?.message ?? e}` }], isError: true };
        }
    });
    server.tool("futurerp_trami_stats", "Trami's own numbers for a period: sessions per trigger/status and per day, gated calls per tool and outcome, shadow-mode rows with tramitología's agreement per tool, expedientes sent, median hours from anticipo to send, documents requested, questions to tramitología, gestora messages, errors by type; plus current health (stuck outbox rows, long-open sessions, failed sessions, pending Buzón, ungraded shadow rows, last errors). Needs tramites.access.", { days: z.number().int().min(1).max(365).default(1).describe("Window in days (1 = today's report)") }, async ({ days }) => {
        try {
            const [stats, health] = await Promise.all([deps.sbRpc("trami_stats", { p_days: days }), deps.sbRpc("trami_health")]);
            return { content: [{ type: "text", text: `## trami_stats(${days})\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\n## trami_health()\n\`\`\`json\n${JSON.stringify(health, null, 2)}\n\`\`\`` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudieron leer las estadísticas: ${e?.message ?? e}` }], isError: true };
        }
    });
}
