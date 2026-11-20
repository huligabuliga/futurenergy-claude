import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * tramite_update is default-deny: a changed field needs evidence unless it is listed here as free.
 * Free = Trami's own bookkeeping about what IT did or will do; no outside fact is claimed.
 * A new column on the patch schema must land in one of the three lists (test: "every patch field").
 */
export declare const CAMPOS_LIBRES: string[];
/** type_data keys that are its own bookkeeping; every other key needs evidence. */
export declare const TYPE_DATA_LIBRES: string[];
/** Own rules in evidenciaCheck: a forward stage move / a new SI. */
export declare const CAMPOS_PROPIOS: string[];
/** Need evidence (listed so the schema test can tell a forgotten column from a decided one). */
export declare const CAMPOS_CON_EVIDENCIA: string[];
export interface TramiteDeps {
    /** PDF text reader (tests stub it). */
    textoPdf?: (href: string) => Promise<string | null>;
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
export declare const BASE_DOCS: Record<string, string[]>;
export declare const SHARED_OPTIONAL_DOCS: string[];
/** Refusal text when `ms` is outside the 08:00–19:00 Monterrey send window, else null. */
export declare function fueraDeHorario(ms: number): string | null;
export declare function registerTramiteTools(server: McpServer, deps: TramiteDeps): void;
