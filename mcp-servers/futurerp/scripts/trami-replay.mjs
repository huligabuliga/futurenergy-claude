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
// Same chat + same Monterrey day = one session, as trami-dispatch does: the
// thread is the context, the last message is the one that wakes the agent.
const dayOf = (iso) => new Date(new Date(iso).getTime() - 6 * 3600_000).toISOString().slice(0, 10);
const groupsMap = new Map();
for (const m of [...msgs].sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
  const k = `${m.chat_id}|${dayOf(m.sent_at)}`;
  if (!groupsMap.has(k)) groupsMap.set(k, []);
  groupsMap.get(k).push(m);
}
const groups = [...groupsMap.values()];
console.log(`${groups.length} sesión(es) (chat + día)`);

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
const ORDEN = ["expediente_integracion", "documentacion_con_gestor", "folio_ingresado", "en_seguimiento_cfe", "c0b_emitida", "medidor_instalado", "sistema_activado", "deteccion", "solicitar_documentos", "documentos_recibidos", "enviado_a_gestor", "ingresado_cfe", "ingresado", "en_seguimiento", "ejecutado", "concluido"];
for (const g of groups) {
  const last = g[g.length - 1];
  const t0 = new Date().toISOString();
  const hilo = g.slice(0, -1).map((m) => `- ${m.sent_at.slice(0, 16)} ${m.sender_name ?? m.sender_phone ?? "?"}: ${m.body.replace(/\s+/g, " ")}${m.media_url ? ` [adjunto ${m.media_type ?? "archivo"}: ${m.media_url}]` : ""}`).join("\n");
  const text = `${last.body}${last.media_url ? `\n[adjunto ${last.media_type ?? "archivo"}: ${last.media_url}]` : ""}${hilo ? `\n\n(Mensajes anteriores del mismo chat hoy, más antiguo primero; también untrusted:)\n${hilo}` : ""}`;
  console.log(`\n═══ ${last.sent_at.slice(0, 16)} ${last.sender_name ?? last.sender_phone ?? "?"} (${g.length} mensaje(s) del día): ${last.body.replace(/\s+/g, " ").slice(0, 110)}`);
  if (args.dry === "true") continue;
  const run = spawnSync(process.execPath, [join(here, "trami-local-agent.mjs"), "--scenario", "whatsapp", "--text", text, "--from", last.sender_name ?? "Iris", "--chat", last.chat_id, ...(args.model ? ["--model", args.model] : [])], { encoding: "utf8", env: { ...process.env, TRAMI_SANDBOX_DIR: SANDBOX }, maxBuffer: 50 * 1024 * 1024 });
  const out = (run.stdout || "") + (run.stderr || "");
  const shadow = sql(`SELECT tool_name, tool_input, project_id, tramite_id, resumen FROM agent_shadow_calls WHERE created_at >= '${t0}'`);
  const notas = sql(`SELECT entity_id AS project_id, subject FROM crm_activities WHERE created_at >= '${t0}' AND performed_by = (SELECT user_id FROM profiles WHERE email='trami-sandbox@futurenergy.mx')`);
  const trProjects = [...new Set([...shadow.map((s) => s.project_id), ...notas.map((n) => n.project_id)].filter(Boolean))];
  // Oracle: the trámite row as it is TODAY (Flor's eventual truth). Each proposed
  // field is a hit when today's value equals it (stage: today's is the same or
  // further along), a miss when it differs, "Flor nunca lo registró" when empty.
  const campos = [];
  for (const sc of shadow.filter((x) => x.tool_name === "futurerp_tramite_update" && x.tramite_id)) {
    const [row] = sql(`SELECT * FROM project_tramites WHERE id = '${sc.tramite_id}'`);
    for (const [k, v] of Object.entries(sc.tool_input?.patch ?? {})) {
      if (!row) { campos.push({ campo: k, propuesto: v, hoy: null, veredicto: "trámite no existe" }); continue; }
      const hoy = row[k];
      let veredicto;
      if (hoy === null || hoy === undefined || hoy === "" || hoy === false) veredicto = "Flor nunca lo registró";
      else if (k === "stage") veredicto = ORDEN.indexOf(String(hoy)) >= ORDEN.indexOf(String(v)) ? "coincide" : "Flor está antes";
      else if (String(hoy).slice(0, 10) === String(v).slice(0, 10) || String(hoy).toUpperCase().replace(/\s+/g, "") === String(v).toUpperCase().replace(/\s+/g, "")) veredicto = "coincide";
      else veredicto = "difiere";
      campos.push({ campo: k, propuesto: v, hoy, veredicto });
    }
  }
  const coinciden = campos.filter((c) => c.veredicto === "coincide").length, difieren = campos.filter((c) => c.veredicto === "difiere" || c.veredicto === "Flor está antes").length, sinRegistro = campos.filter((c) => c.veredicto === "Flor nunca lo registró").length;
  const pregunto = notas.some((n) => /pregunta/i.test(n.subject));
  const r = { sent_at: last.sent_at, mensajes: g.length, texto: last.body.slice(0, 200), trami_proyectos: trProjects, campos, coinciden, difieren, sinRegistro, pregunto, herramientas: [...new Set(shadow.map((s) => s.tool_name))], ok: run.status === 0 };
  results.push(r);
  const efus = trProjects.length ? sql(`SELECT efu FROM projects WHERE id IN (${trProjects.map((p) => `'${p}'`).join(",")})`).map((x) => x.efu).join(", ") : "ninguno";
  console.log(`   proyecto: ${efus} · ${[...new Set(shadow.map((s) => s.tool_name.replace("futurerp_", "")))].join(", ") || "sin acciones"}${pregunto ? " · preguntó a Flor" : ""}`);
  for (const c of campos) console.log(`     ${c.campo}: propuso ${JSON.stringify(c.propuesto)} · hoy ${JSON.stringify(c.hoy)} → ${c.veredicto}`);
  if (run.status) console.log("   RUN FAILED\n" + out.slice(-600));
}
if (args.dry !== "true") {
  const n = results.length;
  const tot = (k) => results.reduce((a, r) => a + r[k], 0);
  console.log(`\n══ ${n} sesiones · campos propuestos: ${tot("coinciden")} coinciden con lo que hay hoy, ${tot("difieren")} difieren, ${tot("sinRegistro")} que Flor nunca registró · preguntó a Flor en ${results.filter((r) => r.pregunto).length} · corridas fallidas ${results.filter((r) => !r.ok).length}`);
  mkdirSync(join(SANDBOX, "runs"), { recursive: true });
  const out = join(SANDBOX, "runs", `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ days: DAYS, limit: LIMIT, model: args.model ?? null, results }, null, 2));
  console.log(`json ${out}`);
}
