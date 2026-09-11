#!/usr/bin/env node
/**
 * FuturERP MCP Server v2 — remote Streamable HTTP + OAuth.
 *
 * Read-only MCP for Future Energy's internal ERP (pronto-resolver-61 on Supabase).
 * Data reads forward the CALLER's token (their JWT + publishable key), so PostgREST/RLS returns
 * unchanged from v1). Callers authenticate with a Supabase Auth OAuth 2.1 access token
 * (users log in with their FuturERP account); tool visibility is gated per user via the
 * app's RBAC via RLS: every data read forwards the caller's token, so Postgres row-level security
 * returns exactly what the person can see in FuturERP. Org-wide SECURITY DEFINER tools and bot-only
 * tables are gated by permission (see buildServer).
 *
 * Env vars:
 *   SUPABASE_URL                — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — sb_secret_* (preferred) OR legacy service_role JWT (data reads)
 *   SUPABASE_PUBLISHABLE_KEY    — sb_publishable_* / anon key (only used to validate user tokens)
 *   MCP_PUBLIC_URL              — public URL of this endpoint, e.g. https://mcp.futurenergy.mx/mcp
 *   PORT                        — listen port (default 3000)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
export declare function buildServer(auth: AuthInfo): McpServer;
