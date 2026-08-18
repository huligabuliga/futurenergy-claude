#!/usr/bin/env node
// Smoke test for the remote FuturERP MCP: auth gating + tool visibility.
//
// Creates two throwaway Supabase users, obtains password-grant tokens, and asserts:
//   1. no token            → 401 + WWW-Authenticate resource_metadata
//   2. user w/o any role   → 403 insufficient_scope
//   3. admin (is_admin)    → 30 tools incl. futurerp_whatsapp_chats
//   4. role {mcp.access}   → 25 tools, no whatsapp
// Cleans up users + test role. Requires an admin (secret) key — LOCAL Supabase only.
//
// Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      MCP_URL (optional; default: spawn dist/index.js on :3210 with MCP_SKIP_AS_METADATA=1)

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "http://127.0.0.1:54321").replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!PUB || !SECRET) {
  console.error("Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const PORT = 3210;
let MCP_URL = process.env.MCP_URL ?? "";
let child = null;

const admin = (extra = {}) => ({ apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...extra });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function createUser(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin(),
    body: JSON.stringify({
      email,
      password: "Smoke-test-1234!",
      email_confirm: true,
      user_metadata: { first_name: "MCP", last_name: "Smoke", department: "Sistemas" },
    }),
  });
  if (!r.ok) throw new Error(`createUser ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}
const deleteUser = (id) => fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin() });

async function token(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUB, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Smoke-test-1234!" }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function rest(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers: admin({ Prefer: "return=representation", ...(init.headers ?? {}) }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`REST ${path} ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

async function mcp(tok, body) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    if (line) json = JSON.parse(line.slice(6));
  } else if (text) {
    try { json = JSON.parse(text); } catch {}
  }
  return { status: r.status, headers: r.headers, json, text };
}
const listTools = async (tok) => {
  const res = await mcp(tok, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return { ...res, tools: res.json?.result?.tools?.map((t) => t.name) ?? [] };
};

async function startServer() {
  const here = dirname(fileURLToPath(import.meta.url));
  child = spawn(process.execPath, [resolve(here, "../dist/index.js")], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: PUB,
      SUPABASE_SERVICE_ROLE_KEY: SECRET,
      PORT: String(PORT),
      MCP_PUBLIC_URL: `http://localhost:${PORT}/mcp`,
      MCP_SKIP_AS_METADATA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  MCP_URL = `http://localhost:${PORT}/mcp`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("server did not start");
}

const stamp = Date.now();
const adminEmail = `mcp-admin-test-${stamp}@futurenergy.mx`;
const basicEmail = `mcp-basic-test-${stamp}@futurenergy.mx`;
let adminId, basicId, roleId;

try {
  if (!MCP_URL) await startServer();

  adminId = await createUser(adminEmail);
  basicId = await createUser(basicEmail);
  // Local DB (prod dump) has no handle_new_user trigger on auth.users → create profiles explicitly.
  await rest(`/profiles?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([
      { user_id: adminId, email: adminEmail, first_name: "MCP", last_name: "Admin", department: "Sistemas", is_admin: true, is_active: true },
      { user_id: basicId, email: basicEmail, first_name: "MCP", last_name: "Basic", department: "Sistemas", is_admin: false, is_active: true },
    ]),
  });
  const adminTok = await token(adminEmail);
  const basicTok = await token(basicEmail);

  // 1. no token
  {
    const r = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const www = r.headers.get("www-authenticate") ?? "";
    check("no token → 401", r.status === 401, `status=${r.status}`);
    check("401 carries resource_metadata", www.includes("resource_metadata="), www);
    check("401 does not advertise scope=", !www.includes("scope="), www);
  }
  // 2. user without any role
  {
    const r = await mcp(basicTok, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    check("no-role user → 403 insufficient_scope", r.status === 403 && (r.json?.error === "insufficient_scope"), `status=${r.status} body=${r.text.slice(0, 120)}`);
  }
  // 3. admin → all tools
  {
    const r = await listTools(adminTok);
    check("admin → 200", r.status === 200, `status=${r.status}`);
    check("admin sees 30 tools", r.tools.length === 30, `count=${r.tools.length}`);
    check("admin sees futurerp_whatsapp_chats", r.tools.includes("futurerp_whatsapp_chats"));
    const call = await mcp(adminTok, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "futurerp_count", arguments: { table: "profiles" } } });
    check("admin tools/call futurerp_count works", call.status === 200 && call.json !== null && !call.json?.error && !call.json?.result?.isError, call.json?.result?.content?.[0]?.text?.slice(0, 80) ?? call.text.slice(0, 120));
  }
  // 4. role with only mcp.access
  {
    const [role] = await rest(`/crm_roles`, {
      method: "POST",
      body: JSON.stringify({ name: `__mcp_smoke_${stamp}`, description: "smoke", permissions: { "mcp.access": true }, is_system: false }),
    });
    roleId = role.id;
    await rest(`/user_crm_roles`, { method: "POST", body: JSON.stringify({ user_id: basicId, role_id: roleId }) });
    // token cache is 60 s per token — get a fresh token to bypass it
    const basicTok2 = await token(basicEmail);
    const r = await listTools(basicTok2);
    check("mcp.access-only user → 200", r.status === 200, `status=${r.status}`);
    check("mcp.access-only user sees 25 tools", r.tools.length === 25, `count=${r.tools.length}`);
    check("mcp.access-only user has NO whatsapp tools", !r.tools.some((t) => t.startsWith("futurerp_whatsapp")));
    const p = await mcp(basicTok2, { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
    const prompts = p.json?.result?.prompts?.map((x) => x.name) ?? [];
    check("mcp.access-only user has NO sales_followup_review prompt", !prompts.includes("sales_followup_review"), prompts.join(","));
  }
} catch (e) {
  check("script error", false, e.message);
} finally {
  try {
    if (roleId) await rest(`/user_crm_roles?role_id=eq.${roleId}`, { method: "DELETE" });
    if (roleId) await rest(`/crm_roles?id=eq.${roleId}`, { method: "DELETE" });
    for (const id of [adminId, basicId].filter(Boolean)) {
      await rest(`/profiles?user_id=eq.${id}`, { method: "DELETE" });
      await deleteUser(id);
    }
  } catch (e) {
    console.error("cleanup error:", e.message);
  }
  if (child) child.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
