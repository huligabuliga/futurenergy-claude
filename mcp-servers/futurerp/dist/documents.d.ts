import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/** The text layer of a Firebase-stored PDF, or null when it can't be downloaded or has none (scanned). */
export declare function textoPdf(href: string): Promise<string | null>;
export interface DocDeps {
    userId: string;
    uuidRx: RegExp;
    restBase: string;
    authHeaders: (extra?: Record<string, string>) => Record<string, string>;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
export declare function registerDocumentTools(server: McpServer, deps: DocDeps): void;
