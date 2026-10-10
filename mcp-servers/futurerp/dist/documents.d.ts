import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface DocDeps {
    userId: string;
    uuidRx: RegExp;
    restBase: string;
    authHeaders: (extra?: Record<string, string>) => Record<string, string>;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
export declare function registerDocumentTools(server: McpServer, deps: DocDeps): void;
