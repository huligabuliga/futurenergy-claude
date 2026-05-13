#!/usr/bin/env node
/**
 * FuturERP MCP Server v1.1
 *
 * Read-only MCP for Future Energy's internal ERP (pronto-resolver-61 on Supabase).
 * Connects directly via PostgREST + Supabase RPCs using either a new-style secret key
 * (sb_secret_*) or a legacy service_role JWT. Both bypass RLS — full org read.
 *
 * Env vars:
 *   SUPABASE_URL                — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — sb_secret_* (preferred) OR legacy service_role JWT
 */
export {};
