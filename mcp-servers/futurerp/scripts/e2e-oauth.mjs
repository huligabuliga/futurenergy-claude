// End-to-end against a Supabase project with the OAuth 2.1 server enabled: DCR → authorize → consent API
// → PKCE token exchange → futurerp MCP tools/list per role. Creates + deletes throwaway users (needs the
// secret key → LOCAL Supabase only). Start the server first (PORT=3210 MCP_PUBLIC_URL=http://localhost:3210/mcp).
// Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, MCP_URL
import { createHash, randomBytes } from "node:crypto";

const SB = process.env.SUPABASE_URL.replace(/\/+$/, "");
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MCP = process.env.MCP_URL;
const REDIRECT = "http://localhost:9999/cb";
const PASS = "E2e-Test-" + randomBytes(6).toString("hex");
const svcHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
let failures = 0;
const ok = (cond, msg, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}${extra ? " — " + extra : ""}`); if (!cond) failures++; };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function j(url, init = {}) { const r = await fetch(url, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, headers: r.headers, body: b }; }

async function createUser(email, roleName) {
  const u = await j(`${SB}/auth/v1/admin/users`, { method: "POST", headers: svcHeaders, body: JSON.stringify({ email, password: PASS, email_confirm: true, user_metadata: { first_name: "E2E", last_name: "MCP", department: "Sistemas" } }) });
  if (u.status >= 300) throw new Error("createUser " + JSON.stringify(u.body));
  const id = u.body.id;
  // Local prod-dump DB has no handle_new_user trigger (prod does) → create the profile row explicitly.
  const prof = await j(`${SB}/rest/v1/profiles?on_conflict=user_id`, { method: "POST", headers: { ...svcHeaders, Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify({ user_id: id, email, first_name: "E2E", last_name: "MCP", is_active: true, is_admin: false }) });
  if (prof.status >= 300) throw new Error("profile " + JSON.stringify(prof.body));
  if (roleName) {
    const r = await j(`${SB}/rest/v1/crm_roles?name=eq.${encodeURIComponent(roleName)}&select=id`, { headers: svcHeaders });
    const roleId = r.body[0]?.id; if (!roleId) throw new Error("role missing " + roleName);
    const ins = await j(`${SB}/rest/v1/user_crm_roles`, { method: "POST", headers: { ...svcHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ user_id: id, role_id: roleId }) });
    if (ins.status >= 300) throw new Error("assign role " + JSON.stringify(ins.body));
  }
  return id;
}
const deleteUser = async (id) => { await j(`${SB}/rest/v1/user_crm_roles?user_id=eq.${id}`, { method: "DELETE", headers: svcHeaders }); await j(`${SB}/rest/v1/profiles?user_id=eq.${id}`, { method: "DELETE", headers: svcHeaders }); return j(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svcHeaders }); };

async function signIn(email) {
  const r = await j(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) });
  if (r.status >= 300) throw new Error("signIn " + JSON.stringify(r.body));
  return r.body.access_token;
}

async function oauthFlow(meta, clientId, userToken, approve = true) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(8));
  const authz = new URL(meta.authorization_endpoint);
  authz.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  const r1 = await fetch(authz, { redirect: "manual" });
  const loc = r1.headers.get("location") || "";
  ok(r1.status === 302 || r1.status === 303, "authorize → redirect to consent page", `${r1.status} ${loc}`);
  const authorizationId = new URL(loc, SB).searchParams.get("authorization_id");
  ok(!!authorizationId, "consent URL carries authorization_id", authorizationId ?? "");
  const userHeaders = { apikey: PUB, Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
  const det = await j(`${SB}/auth/v1/oauth/authorizations/${authorizationId}`, { headers: userHeaders });
  ok(det.status === 200 && (det.body.client || det.body.redirect_url), "GET authorization details", JSON.stringify(det.body).slice(0, 160));
  let redirectUrl = det.body.redirect_url;
  if (!redirectUrl) {
    const dec = await j(`${SB}/auth/v1/oauth/authorizations/${authorizationId}/consent`, { method: "POST", headers: userHeaders, body: JSON.stringify({ action: approve ? "approve" : "deny" }) });
    ok(dec.status === 200 && dec.body.redirect_url, `POST consent ${approve ? "approve" : "deny"}`, JSON.stringify(dec.body).slice(0, 160));
    redirectUrl = dec.body.redirect_url;
  }
  const cb = new URL(redirectUrl);
  ok(cb.origin + cb.pathname === REDIRECT && cb.searchParams.get("state") === state, "redirect back to client with state", redirectUrl);
  if (!approve) { ok(!!cb.searchParams.get("error"), "deny → error param", cb.searchParams.get("error") ?? ""); return null; }
  const code = cb.searchParams.get("code");
  const tok = await j(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }) });
  ok(tok.status === 200 && tok.body.access_token, "token exchange (PKCE, public client)", JSON.stringify(tok.body).slice(0, 120));
  const claims = JSON.parse(Buffer.from(tok.body.access_token.split(".")[1], "base64url").toString());
  ok(claims.client_id === clientId, "access token carries client_id claim", `client_id=${claims.client_id} sub=${claims.sub}`);
  return tok.body.access_token;
}

async function mcp(token, method, params = {}, id = 1) {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await r.text();
  // stateless streamable http may answer as SSE
  const data = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop() : (text ? JSON.parse(text) : null);
  return { status: r.status, headers: r.headers, data };
}
async function listTools(token) {
  await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  const r = await mcp(token, "tools/list", {}, 2);
  return r.data?.result?.tools?.map((t) => t.name) ?? [];
}

// ── run ─────────────────────────────────────────────────────
const created = [];
try {
  let meta = (await j(`${SB}/.well-known/oauth-authorization-server/auth/v1`)).body; if (!meta?.authorization_endpoint) meta = (await j(`${SB}/auth/v1/.well-known/oauth-authorization-server`)).body;
  ok(!!meta.registration_endpoint, "AS discovery has registration_endpoint (DCR)", meta.registration_endpoint);

  const prm = await j(`${new URL(MCP).origin}/.well-known/oauth-protected-resource${new URL(MCP).pathname}`);
  ok(prm.status === 200 && (prm.body.authorization_servers || []).some((a) => a.startsWith(SB)), "MCP protected-resource metadata points at Supabase", JSON.stringify(prm.body));

  const noTok = await mcp(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  ok(noTok.status === 401 && /resource_metadata=/.test(noTok.headers.get("www-authenticate") || ""), "no token → 401 + WWW-Authenticate resource_metadata", noTok.headers.get("www-authenticate") ?? "");

  const reg = await j(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "e2e Claude-like client", redirect_uris: [REDIRECT, "https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  ok(reg.status === 201 || reg.status === 200, "DCR registers public client with localhost + claude.ai redirect URIs", JSON.stringify(reg.body).slice(0, 200));
  const clientId = reg.body.client_id;

  const stamp = randomBytes(3).toString("hex");
  const users = { wa: `e2e-mcp-wa-${stamp}@futurenergy.mx`, basic: `e2e-mcp-basic-${stamp}@futurenergy.mx`, none: `e2e-mcp-none-${stamp}@futurenergy.mx` };
  created.push(await createUser(users.wa, "MCP WhatsApp"), await createUser(users.basic, "MCP Básico"), await createUser(users.none, null));

  console.log("\n# user with role MCP WhatsApp");
  const tWa = await oauthFlow(meta, clientId, await signIn(users.wa));
  const toolsWa = await listTools(tWa);
  ok(toolsWa.length >= 30 && toolsWa.includes("futurerp_whatsapp_chats"), "MCP WhatsApp user sees whatsapp tools", `${toolsWa.length} tools`);

  console.log("\n# deny path");
  await oauthFlow(meta, clientId, await signIn(users.basic), false);

  console.log("\n# user with role MCP Básico");
  const tBasic = await oauthFlow(meta, clientId, await signIn(users.basic));
  const toolsBasic = await listTools(tBasic);
  ok(toolsBasic.length > 0 && !toolsBasic.some((n) => n.startsWith("futurerp_whatsapp")), "MCP Básico user gets tools but NO whatsapp tools", `${toolsBasic.length} tools`);
  const call = await mcp(tBasic, "tools/call", { name: "futurerp_count", arguments: { table: "profiles" } }, 3);
  ok(call.status === 200 && call.data && !call.data.error && !call.data.result?.isError, "MCP Básico can call futurerp_count", JSON.stringify(call.data).slice(0, 160));

  console.log("\n# user with no MCP role");
  const tNone = await oauthFlow(meta, clientId, await signIn(users.none));
  const r403 = await mcp(tNone, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  ok(r403.status === 403, "no role → 403 insufficient_scope", `${r403.status} ${JSON.stringify(r403.data).slice(0, 120)}`);

  console.log("\n# re-consent (already approved) short-circuits");
  const t2 = await oauthFlow(meta, clientId, await signIn(users.basic));
  ok(!!t2, "second authorize for same client returns token without new consent");
} catch (e) {
  console.error("ERROR", e); failures++;
} finally {
  for (const id of created) { try { await deleteUser(id); } catch (e) { console.error("cleanup failed for", id, e); } }
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures ? 1 : 0);
}
