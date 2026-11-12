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
export declare function registerCatalogTools(server: McpServer, deps: CatalogDeps): void;
export {};
