import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface TramiteDeps {
    userId: string;
    restBase: string;
    uuidRx: RegExp;
    authHeaders: (extra?: Record<string, string>) => Record<string, string>;
    /** Service-role headers: only for the WhatsApp tables, which have no user INSERT policy. */
    serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
    sbRpc: (name: string, args?: Record<string, any>) => Promise<any>;
}
export declare const TRAMITE_STAGES: Record<string, string[]>;
export declare function registerTramiteTools(server: McpServer, deps: TramiteDeps): void;
