/** futurerp_trami_stats: the numbers behind the daily report (trami_stats + trami_health RPCs, caller's RLS). */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerOpsTools(server: McpServer, deps: { sbRpc: (name: string, args?: Record<string, any>) => Promise<any> }) {
  server.tool(
    "futurerp_trami_stats",
    "Trami's own numbers for a period: sessions per trigger/status and per day, gated calls per tool and outcome, shadow-mode rows with Flor's agreement per tool, expedientes sent, median hours from anticipo to send, documents requested, questions to Flor, gestora messages, errors by type; plus current health (stuck outbox rows, long-open sessions, failed sessions, pending Buzón, ungraded shadow rows, last errors). Needs tramites.access.",
    { days: z.number().int().min(1).max(365).default(1).describe("Window in days (1 = today's report)") },
    async ({ days }) => {
      try {
        const [stats, health] = await Promise.all([deps.sbRpc("trami_stats", { p_days: days }), deps.sbRpc("trami_health")]);
        return { content: [{ type: "text" as const, text: `## trami_stats(${days})\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\n## trami_health()\n\`\`\`json\n${JSON.stringify(health, null, 2)}\n\`\`\`` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `No se pudieron leer las estadísticas: ${e?.message ?? e}` }], isError: true as const };
      }
    },
  );
}
