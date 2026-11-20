import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface CtxDeps {
    userId: string;
    uuidRx: RegExp;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
/** Primary trámite tipo of a CFE zona (the tipo the Bandeja routes with when a project has no trámite yet). */
export declare const PRIMARIO_DE_ZONA: Record<string, string>;
/**
 * "## Gestora" lines for each (zona, tipo): resolved by trami_gestora_para(), the
 * server twin of the Bandeja's matchGestora (active only, first by nombre). No
 * gestora = say so; Trami asks tramitología and writes to nobody.
 */
export declare function gestoraLines(sbApi: CtxDeps["sbApi"], zona: string | null, tipos: string[]): Promise<string[]>;
/** Files outside every slot and not linked to a trámite: the expediente may be hiding in them. */
export declare function sinSlot(files: any[], slotOf: (documentId: string | null) => string | null | undefined, linked: Set<string>): any[];
export declare function registerContextoTool(server: McpServer, deps: CtxDeps): void;
