import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type WriteDeps } from "./writes.js";
type Deps = Pick<WriteDeps, "userId" | "restBase" | "authHeaders" | "serviceHeaders"> & {
    supabaseUrl: string;
};
/** "YYYY-MM-DDTHH:MM" without offset = Monterrey wall clock (UTC-6, no DST since 2022). Exported for the check script. */
export declare function parseWhen(v: string): Date | null;
export declare function registerLeadActionTools(server: McpServer, deps: Deps): void;
export {};
