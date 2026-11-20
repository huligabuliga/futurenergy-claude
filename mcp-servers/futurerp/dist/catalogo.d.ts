import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type WriteDeps } from "./writes.js";
export type CatalogDeps = Pick<WriteDeps, "restBase" | "authHeaders"> & {
    supabaseUrl: string;
};
interface Pkg {
    id: string;
    name: string;
    role: string | null;
    category: string;
    audience: string;
    offer_when: string | null;
}
/** One package by id, exact name or a fragment only one name contains. Exported for the check script. */
export declare function pickPackage(pkgs: Pkg[], ref: string): Pkg;
/**
 * Short code of a draft's exact contents. `publicar` asks for it back, so what goes live is the
 * draft the person was shown, not one a colleague changed in between. Exported for the check script.
 */
export declare function draftCode(d: {
    versions?: any[];
} | null): string;
export declare function registerCatalogTools(server: McpServer, deps: CatalogDeps): void;
export {};
