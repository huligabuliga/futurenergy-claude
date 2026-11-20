/**
 * Trami write-tool guard: shadow mode + live ledger + error logging.
 *
 * system_config.trami_mode = 'shadow' (default) → every write tool records what
 * it WOULD do in agent_shadow_calls (modo 'sombra') and returns a "(sombra)"
 * result; nothing is written, sent or mailed. 'live' → the tool runs and the
 * same table gets a modo 'vivo' row with the previous values (antes) and the
 * tool's reply, so the panel shows what was done and can undo it. Tramitología grades
 * both (trami_shadow_verdict); trami_stats() reports the agreement per tool.
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
/**
 * 'live' when the global trami_mode is live, or when `tool` was released on its
 * own (system_config.trami_tools_live, set from the panel's Results tab).
 */
export declare function tramiMode(deps: GuardDeps, tool?: string): Promise<"shadow" | "live">;
export declare const resetModeCache: () => void;
/**
 * Checks a tool must pass even in shadow (send window, rate limit, own channel,
 * mail allowlist): a shadow call that live would refuse is refused the same way,
 * so tramitología never grades an action that could not have happened.
 * Return a reason to refuse, or null. Per server: each session's checks read
 * through that session's token.
 */
type ShadowCheck = (args: any) => Promise<string | null>;
export declare function setShadowCheck(server: McpServer, tool: string, check: ShadowCheck): void;
/** One Spanish line per tool, for the shadow table and the Buzón. */
export declare function describeCall(name: string, a: Record<string, any>): string;
export declare function logToolError(deps: GuardDeps, name: string, args: unknown, detalle: string): Promise<void>;
/**
 * Deterministic rule (was a skill line the model sometimes missed): never write
 * to the same client twice within 24 h unless the client answered in between.
 * Counts real sends (whatsapp_messages outbound) AND shadow rows, so the rule
 * holds in evals too. Groups (@g.us) are not covered: the gestora's group has its own cadence.
 * Returns the refusal text, or null when the send may go.
 */
export declare function repeatedClientMessage(deps: GuardDeps, a: Record<string, any>, nowMs?: number): Promise<string | null>;
/**
 * server.tool() with the guard: shadow for SHADOW_TOOLS, error logging for
 * every tool it wraps. Typed as McpServer['tool'] so the handlers keep the
 * argument types inferred from their zod schema.
 */
export declare function guardedTool(server: McpServer, deps: GuardDeps): McpServer["tool"];
export {};
