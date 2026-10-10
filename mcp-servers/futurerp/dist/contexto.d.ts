import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface CtxDeps {
    uuidRx: RegExp;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
export declare function registerContextoTool(server: McpServer, deps: CtxDeps): void;
