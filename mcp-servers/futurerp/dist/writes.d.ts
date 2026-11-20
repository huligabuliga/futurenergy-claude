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
export declare const MAX_ROWS = 20;
/** Throws a readable reason when the target or a column is off-limits. Exported for the check script. */
export declare function assertWritable(table: string, columns: string[]): void;
export declare const text: (t: string, isError?: boolean) => {
    isError?: true | undefined;
    content: {
        type: "text";
        text: string;
    }[];
};
export declare function rest(deps: Pick<WriteDeps, "restBase" | "authHeaders">, method: string, path: string, body?: unknown, prefer?: string): Promise<any>;
export declare function ledger(deps: Pick<WriteDeps, "userId" | "restBase" | "serviceHeaders">, row: Record<string, unknown>): Promise<void>;
export declare function registerWriteTools(server: McpServer, deps: WriteDeps): void;
