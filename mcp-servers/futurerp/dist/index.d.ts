#!/usr/bin/env node
/**
 * FuturERP MCP Server v1.0
 *
 * Read-only MCP for Future Energy's internal ERP (pronto-resolver-61 on Supabase).
 * Connects directly via PostgREST + Supabase RPCs using the service role key
 * (bypasses RLS — full org read). Mirrors the Salesforce MCP's tool shape.
 *
 * Env vars:
 *   SUPABASE_URL                — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role key from Supabase Dashboard → Project Settings → API
 */
export {};
