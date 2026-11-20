import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface CtxDeps {
    userId: string;
    uuidRx: RegExp;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
/** Files outside every slot and not linked to a trámite: the expediente may be hiding in them. */
export declare function sinSlot(files: any[], slotOf: (documentId: string | null) => string | null | undefined, linked: Set<string>): any[];
export declare function registerContextoTool(server: McpServer, deps: CtxDeps): void;
