/**
 * Trami write-tool guard: shadow mode + error logging.
 *
 * system_config.trami_mode = 'shadow' (default) → every write tool records what
 * it WOULD do in agent_shadow_calls and returns a "(sombra)" result; nothing is
 * written, sent or mailed. 'live' → the tool runs. Flor grades the shadow rows
 * (trami_shadow_verdict) and trami_stats() reports the agreement per tool.
 * Either way a tool error lands in bot_error_log (fase 'trami').
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface GuardDeps {
    userId: string;
    restBase: string;
    uuidRx: RegExp;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
    serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
}
/** Tools that change the world. Notes (activity_add) and reads are never shadowed. */
export declare const SHADOW_TOOLS: Set<string>;
export declare function tramiMode(deps: GuardDeps): Promise<"shadow" | "live">;
export declare const resetModeCache: () => void;
/** One Spanish line per tool, for the shadow table and the Buzón. */
export declare function describeCall(name: string, a: Record<string, any>): string;
export declare function logToolError(deps: GuardDeps, name: string, args: unknown, detalle: string): Promise<void>;
/**
 * server.tool() with the guard: shadow for SHADOW_TOOLS, error logging for
 * every tool it wraps. Typed as McpServer['tool'] so the handlers keep the
 * argument types inferred from their zod schema.
 */
export declare function guardedTool(server: McpServer, deps: GuardDeps): McpServer["tool"];
