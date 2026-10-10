/** futurerp_trami_stats: the numbers behind the daily report (trami_stats + trami_health RPCs, caller's RLS). */
import { z } from "zod";
export function registerOpsTools(server, deps) {
    server.tool("futurerp_trami_barrido", "The morning sweep list in one call: every open project with required trámites or a trámite still in progress (created after the configured cutoff), with zona, stage, required labels and vetoes, each trámite's stage/SI/dates/next review, active bloqueo, and whether recibo and INE are on file. Sorted by priority: 1 subsanación, 2 review date due, 3 assembling expediente, 4 no trámite yet, 5 with the gestora > 2 days without news, 6 the rest. Open futurerp_tramite_contexto only for the projects you will act on.", {}, async () => {
        try {
            const rows = (await deps.sbRpc("trami_barrido")) ?? [];
            const P = { 1: "en subsanación", 2: "revisión vencida", 3: "armando expediente", 4: "sin trámite", 5: "con la gestora sin noticias", 6: "en curso" };
            const lines = rows.map((r) => {
                const tr = (r.tramites ?? []).map((t) => `${t.tipo}:${t.etapa}${t.enviado ? "/enviado" : ""}${t.si ? `/SI ${t.si}` : ""}${t.subsanacion ? "/SUBSANACIÓN" : ""}${t.revisar ? `/revisar ${t.revisar}` : ""}${t.docs_pedidos ? `/docs pedidos ${t.docs_pedidos}` : ""} (${t.dias_en_etapa}d, id ${t.id})`).join("; ");
                return `- [${r.prioridad} ${P[r.prioridad]}] ${r.efu} ${r.name} · ${r.stage} · zona ${r.zona_cfe ?? "SIN ZONA"} · requeridos: ${(r.requeridos ?? []).join(", ") || "—"}${r.vetados?.length ? ` · vetados: ${r.vetados.join(", ")}` : ""}${r.bloqueado ? " · BLOQUEADO" : ""} · recibo ${r.tiene_recibo ? "sí" : "no"}, INE ${r.tiene_ine ? "sí" : "no"} · trámites: ${tr || "ninguno"}`;
            });
            return { content: [{ type: "text", text: `## Barrido (${rows.length} proyectos)\n${lines.join("\n") || "- nada"}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudo leer el barrido: ${e?.message ?? e}` }], isError: true };
        }
    });
    server.tool("futurerp_trami_lecciones", "Flor's corrections of your past actions (shadow mode grades): what you proposed, whether she would have done the same (correcto / parcial / incorrecto) and what she would have done instead. Read them at the start of every session; they override your own judgement and your memory.", { limit: z.number().int().min(1).max(200).default(40) }, async ({ limit }) => {
        try {
            const rows = (await deps.sbRpc("trami_lecciones", { p_limit: limit })) ?? [];
            if (!rows.length)
                return { content: [{ type: "text", text: "Sin lecciones todavía: Flor no ha corregido ninguna acción." }] };
            const lines = rows.map((r) => `- [${r.verdict}] ${r.proyecto ? `${r.proyecto} (${r.efu}) · ` : ""}${r.resumen}\n  Flor: ${r.verdict_nota ?? "(sin nota)"}`);
            return { content: [{ type: "text", text: `## Lecciones de Flor (${rows.length}, correcciones primero)\n${lines.join("\n")}` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudieron leer las lecciones: ${e?.message ?? e}` }], isError: true };
        }
    });
    server.tool("futurerp_trami_stats", "Trami's own numbers for a period: sessions per trigger/status and per day, gated calls per tool and outcome, shadow-mode rows with Flor's agreement per tool, expedientes sent, median hours from anticipo to send, documents requested, questions to Flor, gestora messages, errors by type; plus current health (stuck outbox rows, long-open sessions, failed sessions, pending Buzón, ungraded shadow rows, last errors). Needs tramites.access.", { days: z.number().int().min(1).max(365).default(1).describe("Window in days (1 = today's report)") }, async ({ days }) => {
        try {
            const [stats, health] = await Promise.all([deps.sbRpc("trami_stats", { p_days: days }), deps.sbRpc("trami_health")]);
            return { content: [{ type: "text", text: `## trami_stats(${days})\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\n## trami_health()\n\`\`\`json\n${JSON.stringify(health, null, 2)}\n\`\`\`` }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `No se pudieron leer las estadísticas: ${e?.message ?? e}` }], isError: true };
        }
    });
}
