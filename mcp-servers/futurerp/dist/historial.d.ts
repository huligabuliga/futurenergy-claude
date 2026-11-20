import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface HistorialDeps {
    userId: string;
    restBase: string;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
    serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
}
/** "dd/mm HH:MM" in Monterrey (UTC-6, no DST). */
export declare function horaMty(iso: string): string;
export declare function registerHistorialTool(server: McpServer, deps: HistorialDeps): void;
