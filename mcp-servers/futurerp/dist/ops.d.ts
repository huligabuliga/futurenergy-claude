import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function registerOpsTools(server: McpServer, deps: {
    sbRpc: (name: string, args?: Record<string, any>) => Promise<any>;
}): void;
