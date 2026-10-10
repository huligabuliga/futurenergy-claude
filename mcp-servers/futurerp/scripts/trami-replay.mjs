// Replay eval: real gestora messages from the LOCAL inbox, one shadow session
// each with the real model, scored against what Flor actually did in the ERP
// around the same date (crm_activities field_update on project_tramites).
//
//   ANTHROPIC_API_KEY=… node scripts/trami-replay.mjs --days 90 --limit 20 [--model claude-opus-5-5] [--dry]
//
// Needs trami-sandbox.mjs running in SHADOW mode. Output: a table per message
// (project Trami chose vs project Flor touched, fields proposed vs fields Flor
// changed within ±3 days) and totals; JSON in <sandbox>/runs/replay-*.json.
//
// Limitation: the DB is today's state, not the state of the day the message
// arrived, so a trámite Flor already moved reads as "already done" to Trami.
// The score therefore measures project matching and field coverage, not
// exact equality; "sin cambios" on an already-updated trámite counts as hit.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]); return acc; }, []));
const SANDBOX = process.env.TRAMI_SANDBOX_DIR || resolve(here, "../.sandbox");
const DB = process.env.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DAYS = Number(args.days || 90), LIMIT = Number(args.limit || 20);
const sql = (q) => JSON.parse(execFileSync("psql", ["-X", "-Atc", `SELECT COALESCE(json_agg(r), '[]') FROM (${q}) r`, DB], { encoding: "utf8" }));

// 1. Gestora messages (her 1:1 chat and the group), oldest first, text only, not ours.
const msgs = sql(`
  SELECT m.id, m.body, m.media_url, m.media_type, m.sender_name, m.sender_phone, m.sent_at, c.chat_id
  FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversation_id
  WHERE m.direction = 'inbound' AND m.body IS NOT NULL AND length(m.body) > 15
    AND EXISTS (SELECT 1 FROM gestoras g WHERE c.chat_id = ANY (g.whatsapp_chat_ids))
    AND NOT EXISTS (SELECT 1 FROM whatsapp_channels ch WHERE ch.phone IS NOT NULL AND right(regexp_replace(ch.phone,'\\D','','g'),10) = right(regexp_replace(COALESCE(m.sender_phone,''),'\\D','','g'),10))
    AND m.sent_at >= now() - interval '${DAYS} days'
  ORDER BY m.sent_at DESC LIMIT ${LIMIT}`);
console.log(`${msgs.length} mensajes de la gestora en ${DAYS} días (máx ${LIMIT})`);

// 2. What Flor did: trámite field updates per project, with dates.
const flor = sql(`
  SELECT a.entity_id AS project_id, p.efu, a.created_at, a.subject, a.description
  FROM crm_activities a JOIN projects p ON p.id = a.entity_id
  WHERE a.activity_type = 'field_update' AND (a.subject ILIKE '%trámite%' OR a.subject ILIKE '%tramite%')
    AND a.created_at >= now() - interval '${DAYS + 7} days'`);
const florByProject = new Map();
for (const f of flor) { if (!florByProject.has(f.project_id)) florByProject.set(f.project_id, []); florByProject.get(f.project_id).push(f); }
const campoDe = (subject) => (subject.match(/·\s*([a-z_]+)$/i)?.[1] ?? subject.replace(/^Trámite\s*·\s*/i, "").replace(/^Etapa de trámite.*/i, "stage")).toLowerCase();

const results = [];
for (const m of msgs) {
  const t0 = new Date().toISOString();
  const text = m.body + (m.media_url ? `\n[adjunto ${m.media_type ?? "archivo"}: ${m.media_url}]` : "");
  console.log(`\n═══ ${m.sent_at.slice(0, 16)} ${m.sender_name ?? m.sender_phone ?? "?"}: ${m.body.replace(/\s+/g, " ").slice(0, 120)}`);
  if (args.dry === "true") continue;
  const run = spawnSync(process.execPath, [join(here, "trami-local-agent.mjs"), "--scenario", "whatsapp", "--text", text, "--from", m.sender_name ?? "Iris", "--chat", m.chat_id, ...(args.model ? ["--model", args.model] : [])], { encoding: "utf8", env: { ...process.env, TRAMI_SANDBOX_DIR: SANDBOX }, maxBuffer: 50 * 1024 * 1024 });
  const out = (run.stdout || "") + (run.stderr || "");
  const shadow = sql(`SELECT tool_name, tool_input, project_id, resumen FROM agent_shadow_calls WHERE created_at >= '${t0}'`);
  const notas = sql(`SELECT entity_id AS project_id, subject FROM crm_activities WHERE created_at >= '${t0}' AND performed_by = (SELECT user_id FROM profiles WHERE email='trami-sandbox@futurenergy.mx')`);
  const trProjects = [...new Set([...shadow.map((s) => s.project_id), ...notas.map((n) => n.project_id)].filter(Boolean))];
  // Flor's updates within ±3 days of the message
  const t = new Date(m.sent_at).getTime();
  const florNear = flor.filter((f) => Math.abs(new Date(f.created_at).getTime() - t) <= 3 * 86_400_000);
  const florProjects = [...new Set(florNear.map((f) => f.project_id))];
  const proyectoOk = trProjects.length === 0 ? (florProjects.length === 0 ? "ninguno (ok)" : "Trami no tocó nada") : trProjects.some((p) => florProjects.includes(p)) ? "coincide" : florProjects.length === 0 ? "Trami actuó, Flor no" : "proyecto distinto";
  const florCampos = [...new Set(florNear.filter((f) => trProjects.includes(f.project_id)).map((f) => campoDe(f.subject)))];
  const trCampos = [...new Set(shadow.filter((s) => s.tool_name === "futurerp_tramite_update").flatMap((s) => Object.keys(s.tool_input?.patch ?? {})))];
  const cubiertos = florCampos.filter((c) => trCampos.includes(c));
  const pregunto = notas.some((n) => /pregunta/i.test(n.subject));
  const r = { message_id: m.id, sent_at: m.sent_at, texto: m.body.slice(0, 200), trami_proyectos: trProjects, flor_proyectos: florProjects, proyecto: proyectoOk, flor_campos: florCampos, trami_campos: trCampos, cubiertos, pregunto, herramientas: [...new Set(shadow.map((s) => s.tool_name))], ok: run.status === 0 };
  results.push(r);
  console.log(`   proyecto: ${proyectoOk} · Flor cambió [${florCampos.join(", ")}] · Trami propuso [${trCampos.join(", ")}] · cubiertos ${cubiertos.length}/${florCampos.length}${pregunto ? " · preguntó a Flor" : ""}${run.status ? " · RUN FAILED" : ""}`);
  if (run.status) console.log(out.slice(-600));
}
if (args.dry !== "true") {
  const n = results.length, coincide = results.filter((r) => r.proyecto === "coincide" || r.proyecto === "ninguno (ok)").length;
  const camposTot = results.reduce((a, r) => a + r.flor_campos.length, 0), camposOk = results.reduce((a, r) => a + r.cubiertos.length, 0);
  console.log(`\n══ ${n} mensajes · proyecto correcto o nada que hacer: ${coincide}/${n} · campos de Flor cubiertos: ${camposOk}/${camposTot} · preguntó a Flor en ${results.filter((r) => r.pregunto).length}`);
  mkdirSync(join(SANDBOX, "runs"), { recursive: true });
  const out = join(SANDBOX, "runs", `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ days: DAYS, limit: LIMIT, model: args.model ?? null, results }, null, 2));
  console.log(`json ${out}`);
}
