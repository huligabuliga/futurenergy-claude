// node scripts/trami-call.mjs <tool> '<json args>'   (needs trami-sandbox.mjs running)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const sb = JSON.parse(readFileSync(resolve(process.env.TRAMI_SANDBOX_DIR || resolve(here, "../.sandbox"), "sandbox.json"), "utf8"));
const [tool, argsJson] = process.argv.slice(2);
const args = argsJson ? JSON.parse(argsJson) : {};
async function mcp(method, params = {}, id = 1) {
  const r = await fetch(sb.mcp, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${sb.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop(); }
  return d;
}
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trami-call", version: "0" } });
if (tool === "list") { console.log((await mcp("tools/list", {}, 2)).result.tools.map((t) => t.name).join("\n")); process.exit(0); }
const r = await mcp("tools/call", { name: tool, arguments: args }, 3);
const c = r?.result?.content?.[0]?.text ?? JSON.stringify(r);
console.log((r?.result?.isError ? "ERROR " : "") + c);
