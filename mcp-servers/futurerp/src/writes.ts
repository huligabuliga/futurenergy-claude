/**
 * Generic ERP write tools: futurerp_update_record / futurerp_insert_record.
 *
 * Registered only for users with the `mcp.write` permission (assigned in the
 * ERP at /admin/permisos). Every write goes to PostgREST with the CALLER's
 * token, so RLS write policies, triggers and the audit columns decide exactly
 * as they do in the web app: nobody can do here what they can't do there, and
 * any new table or column with RLS is covered the day it ships. The only
 * per-schema upkeep is the small denylist below.
 *
 * Every executed write is recorded in public.mcp_write_log (service role) with
 * the previous values, so a change is undone by writing `antes` back.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface WriteDeps {
  userId: string;
  restBase: string;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
  filtersSchema: z.ZodTypeAny;
  filtersToQs: (filters?: any[]) => string;
}

export const MAX_ROWS = 20;

// Role/permission plumbing, agent ledgers and config: change those in the app, not from a chat.
const DENY_TABLES = new Set([
  "user_crm_roles", "crm_roles", "crm_role_stage_moves", "system_config",
  "mcp_write_log", "agent_shadow_calls", "webhook_outbox",
]);
// Audit columns are the trigger's job; is_admin and secrets never come from a chat.
const DENY_COLUMN = /^(is_admin|created_by|updated_by|created_at|updated_at)$|password|secret|token|api_key/i;
const TABLE_RX = /^[a-z_][a-z0-9_]*$/;

/** Throws a readable reason when the target or a column is off-limits. Exported for the check script. */
export function assertWritable(table: string, columns: string[]): void {
  if (!TABLE_RX.test(table)) throw new Error(`Invalid table name "${table}".`);
  if (DENY_TABLES.has(table)) throw new Error(`Table "${table}" can't be written from the MCP; change it in the FuturERP app.`);
  const bad = columns.filter((c) => DENY_COLUMN.test(c));
  if (bad.length) throw new Error(`Column(s) ${bad.join(", ")} can't be written from the MCP.`);
  if (!columns.length) throw new Error("Nothing to write: give at least one column.");
}

export const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true as const } : {}) });

export async function rest(deps: Pick<WriteDeps, "restBase" | "authHeaders">, method: string, path: string, body?: unknown, prefer?: string) {
  const res = await fetch(`${deps.restBase}${path}`, {
    method,
    headers: deps.authHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try { const j = JSON.parse(raw); msg = [j.message, j.details, j.hint].filter(Boolean).join(" · "); } catch {}
    const hint = res.status === 403 || /row-level security|permission denied/i.test(msg)
      ? " (your FuturERP permissions don't allow this write)" : "";
    throw new Error(`Supabase ${res.status}: ${msg}${hint}`);
  }
  return raw ? JSON.parse(raw) : [];
}

export async function ledger(deps: Pick<WriteDeps, "userId" | "restBase" | "serviceHeaders">, row: Record<string, unknown>) {
  try {
    const res = await fetch(`${deps.restBase}/mcp_write_log`, {
      method: "POST",
      headers: deps.serviceHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: deps.userId, ...row }),
    });
    if (!res.ok) console.error("[mcp write] ledger:", res.status, await res.text());
  } catch (e: any) {
    console.error("[mcp write] ledger:", e?.message ?? e);
  }
}

const pick = (r: Record<string, any>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));

export function registerWriteTools(server: McpServer, deps: WriteDeps) {
  server.tool(
    "futurerp_update_record",
    `Update existing FuturERP rows, with the signed-in user's own permissions (only rows and columns they can edit in the app; the same triggers and validations run). Works on any table: use futurerp_describe_table to see the columns. \`filters\` is required (usually [{column:'id', op:'eq', value:'<uuid>'}]); at most ${MAX_ROWS} rows per call. Use dry_run first when the filter is not by id. To undo a change, write the 'before' values back.`,
    {
      table: z.string().describe("Table name, e.g. tickets, leads, projects"),
      filters: deps.filtersSchema.describe("Which rows: [{column, op, value}]. Required."),
      patch: z.record(z.string(), z.any()).describe("Columns to set, e.g. {status: 'cerrado'}"),
      dry_run: z.boolean().optional().describe("Show the rows that would change and their current values; write nothing"),
    },
    async ({ table, filters, patch, dry_run }) => {
      try {
        const cols = Object.keys(patch ?? {});
        assertWritable(table, cols);
        const qs = deps.filtersToQs(filters as any[] | undefined);
        if (!qs) throw new Error("filters is required: an update without a filter would touch the whole table.");

        // Current values, read with the caller's token: also the row-count guard and the undo material.
        const current: any[] = await rest(deps, "GET", `/${table}?${qs}&select=*&limit=${MAX_ROWS + 1}`);
        if (current.length === 0) return text(`No changes: no ${table} row matches that filter, or you don't have access to it.`);
        if (current.length > MAX_ROWS) throw new Error(`The filter matches more than ${MAX_ROWS} rows; narrow it.`);
        const keyCols = ["id", ...cols];
        const antes = current.map((r) => pick(r, keyCols));
        if (dry_run) {
          return text(`Dry run: ${current.length} ${table} row(s) would change.\n\nPatch:\n\`\`\`json\n${JSON.stringify(patch, null, 2)}\n\`\`\`\nCurrent values:\n\`\`\`json\n${JSON.stringify(antes, null, 2)}\n\`\`\``);
        }

        // ponytail: the GET above is the row cap; a row that starts matching between GET and PATCH slips past it (rare, ≤ RLS scope).
        const after: any[] = await rest(deps, "PATCH", `/${table}?${qs}`, patch, "return=representation");
        if (after.length === 0) return text(`No changes: the ${table} row(s) are visible to you but your permissions don't allow editing them.`);
        const despues = after.map((r) => pick(r, keyCols));
        await ledger(deps, { op: "update", table_name: table, match: filters, payload: patch, antes, despues, row_count: after.length });
        return text(`Updated ${after.length} ${table} row(s).\n\nBefore:\n\`\`\`json\n${JSON.stringify(antes, null, 2)}\n\`\`\`\nAfter:\n\`\`\`json\n${JSON.stringify(despues, null, 2)}\n\`\`\``);
      } catch (e: any) {
        return text(`Update failed: ${e?.message ?? e}`, true);
      }
    },
  );

  server.tool(
    "futurerp_insert_record",
    "Create one FuturERP row, with the signed-in user's own permissions (same RLS, defaults and triggers as the app). Works on any table: use futurerp_describe_table for required columns. Returns the created row.",
    {
      table: z.string().describe("Table name, e.g. ticket_activities, reminders"),
      row: z.record(z.string(), z.any()).describe("Column values for the new row"),
    },
    async ({ table, row }) => {
      try {
        assertWritable(table, Object.keys(row ?? {}));
        const created: any[] = await rest(deps, "POST", `/${table}`, row, "return=representation");
        const r = created[0] ?? {};
        await ledger(deps, { op: "insert", table_name: table, payload: row, despues: r, row_count: created.length });
        return text(`Created ${table} row${r.id ? ` ${r.id}` : ""}.\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
      } catch (e: any) {
        return text(`Insert failed: ${e?.message ?? e}`, true);
      }
    },
  );
}
