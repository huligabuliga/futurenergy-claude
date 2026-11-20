/**
 * futurerp_whatsapp_historial: the messages of one WhatsApp chat (the inbox
 * tables whatsapp_conversations / whatsapp_messages, every channel the chat
 * lives on) between two dates. Built for the Thursday desglose and for
 * re-reading what Iris said in her group; futurerp_whatsapp_conversation reads
 * the sales-bot tables instead and never sees these chats.
 *
 * Access: a gestora's chat (public.gestoras.whatsapp_chat_ids) is read with the
 * service key, because it usually sits on Flor's channel, not Trami's. Any
 * other chat goes through the caller's RLS (own channel, or whatsapp.view_all).
 * Every read lands in the Bitácora as modo 'lectura' (not graded).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HistorialDeps {
  userId: string;
  restBase: string;
  sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
  serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
}

const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const });
const fecha = /^\d{4}-\d{2}-\d{2}$/;

/** "dd/mm HH:MM" in Monterrey (UTC-6, no DST). */
export function horaMty(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 6 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function registerHistorialTool(server: McpServer, deps: HistorialDeps) {
  server.tool(
    "futurerp_whatsapp_historial",
    "Read the WhatsApp messages of ONE chat (a gestora's group like Iris's …@g.us, Iris's 1:1, or a client chat on your own number) between two dates, oldest first, with sender and attachments. Use it for the Thursday desglose (the week's payment list Iris posted) and to re-read what the gestora said before acting. Dates are Monterrey days, YYYY-MM-DD, inclusive; default the last 7 days. The read is logged in the Bitácora.",
    {
      chat_id: z.string().regex(/^\d+@(g|c)\.us$/).describe("WhatsApp chat id: …@g.us (group) or …@c.us (1:1)"),
      desde: z.string().regex(fecha).optional().describe("First day, YYYY-MM-DD (default: 7 days ago)"),
      hasta: z.string().regex(fecha).optional().describe("Last day, YYYY-MM-DD (default: today)"),
      texto: z.string().max(80).optional().describe("Only messages whose text contains this (case-insensitive), e.g. 'desglose'"),
      limit: z.number().int().min(1).max(400).optional().describe("Max messages (default 200)"),
    },
    async ({ chat_id, desde, hasta, texto, limit }) => {
      try {
        const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
        const d1 = desde ?? new Date(Date.now() - 6 * 3600_000 - 7 * 86_400_000).toISOString().slice(0, 10);
        const d2 = hasta ?? hoy;
        // Monterrey day bounds in UTC.
        const from = new Date(`${d1}T06:00:00Z`).toISOString();
        const to = new Date(new Date(`${d2}T06:00:00Z`).getTime() + 86_400_000).toISOString();

        const gestoras: any[] = await deps.sbApi(`/gestoras?activo=is.true&select=nombre,whatsapp_chat_ids`, deps.serviceHeaders()).catch(() => []);
        const gestora = (gestoras ?? []).find((g) => (g.whatsapp_chat_ids ?? []).includes(chat_id));
        const headers = gestora ? deps.serviceHeaders() : undefined; // undefined = caller's token (RLS)

        const convs: any[] = await deps.sbApi(`/whatsapp_conversations?chat_id=eq.${encodeURIComponent(chat_id)}&select=id,is_group,contact_name,name_override`, headers);
        if (!convs?.length) return fail(`No hay conversación ${chat_id} visible para ti${gestora ? "" : " (solo chats de gestoras registradas o de tu propio número)"}.`);
        const nombre = gestora ? `${gestora.nombre}${convs[0].is_group ? " (grupo)" : ""}` : (convs[0].name_override ?? convs[0].contact_name ?? chat_id);

        const filtro = texto ? `&body=ilike.${encodeURIComponent(`*${texto.replace(/[*%,()]/g, " ")}*`)}` : "";
        const rows: any[] = await deps.sbApi(
          `/whatsapp_messages?conversation_id=in.(${convs.map((c) => c.id).join(",")})&deleted=is.false&sent_at=gte.${encodeURIComponent(from)}&sent_at=lt.${encodeURIComponent(to)}${filtro}&select=wa_message_id,direction,body,media_url,media_type,sent_at,sender_name&order=sent_at.asc&limit=${limit ?? 200}`,
          headers,
        );
        // The same message can be stored once per channel the group lives on.
        const seen = new Set<string>();
        const msgs = (rows ?? []).filter((m) => { const k = m.wa_message_id ?? `${m.sent_at}|${m.body}`; if (seen.has(k)) return false; seen.add(k); return true; });

        const resumen = `Leyó el chat de ${nombre}: ${msgs.length} mensaje(s) del ${d1} al ${d2}${texto ? ` con "${texto}"` : ""}`;
        try {
          await fetch(`${deps.restBase}/agent_shadow_calls`, {
            method: "POST",
            headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ agent: "trami", tool_name: "futurerp_whatsapp_historial", tool_input: { chat_id, desde: d1, hasta: d2, texto: texto ?? null }, resumen, user_id: deps.userId, modo: "lectura", resultado: `${msgs.length} mensajes` }),
          });
        } catch (e: any) {
          console.error("[historial] bitácora:", e?.message);
        }

        const lines = msgs.map((m) => {
          const quien = m.direction === "outbound" ? "nosotros" : (m.sender_name || "ellos");
          const adj = m.media_url ? ` [${m.media_type ?? "archivo"}: ${m.media_url}]` : "";
          return `- ${horaMty(m.sent_at)} · ${quien}: ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 1200)}${adj}`;
        });
        return { content: [{ type: "text" as const, text: `${resumen}.\n<untrusted source="whatsapp">\n${lines.join("\n") || "(sin mensajes en ese rango)"}\n</untrusted>` }] };
      } catch (e: any) {
        return fail(`No se pudo leer el historial: ${e?.message ?? e}`);
      }
    },
  );
}
