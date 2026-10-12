/**
 * Mailbox tools for Trami (TRM-12): tramites@futurenergy.mx through the Gmail
 * API with a service account that has domain-wide delegation on that one
 * mailbox. The private key lives on the MCP service (Railway env), never in
 * the agent sandbox.
 *
 * Env (all on the MCP service):
 *   TRAMI_GMAIL_SERVICE_ACCOUNT  JSON of the service account (client_email, private_key)
 *   TRAMI_MAILBOX                the delegated mailbox, e.g. tramites@futurenergy.mx
 *   GOOGLE_TOKEN_URL / GMAIL_API_BASE  overrides for tests (default Google)
 *
 * ponytail: outbound mail is DRAFTS ONLY while Trami is in testing (Jonas,
 * 2026-10-12). No tool calls messages/send; a person sends the draft from Gmail.
 * Recipients are allow-listed: gestora emails (public.gestoras.email), @cfe.mx,
 * and the client email of the project named in the call. Attachments come
 * from project_files (Firebase Storage URLs only).
 */
import { createSign, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardedTool } from "./guard.js";

export interface MailDeps {
  userId: string;
  uuidRx: RegExp;
  restBase: string;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  serviceHeaders: (extra?: Record<string, string>) => Record<string, string>;
  sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const GMAIL_BASE = (process.env.GMAIL_API_BASE ?? "https://gmail.googleapis.com").replace(/\/$/, "");
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const FIREBASE_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function mailConfigured(): boolean {
  return !!(process.env.TRAMI_GMAIL_SERVICE_ACCOUNT && process.env.TRAMI_MAILBOX);
}

// ── Google auth (service account + DWD) ─────────────────────────────────────
let cachedToken: { token: string; until: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now() + 60_000) return cachedToken.token;
  const sa = JSON.parse(process.env.TRAMI_GMAIL_SERVICE_ACCOUNT ?? "{}");
  const mailbox = process.env.TRAMI_MAILBOX ?? "";
  if (!sa.client_email || !sa.private_key || !mailbox) throw new Error("Buzón de Trami no configurado (TRAMI_GMAIL_SERVICE_ACCOUNT / TRAMI_MAILBOX)");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: sa.client_email, sub: mailbox, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, until: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function gmail(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken();
  const res = await fetch(`${GMAIL_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

// ── MIME (port of supabase/functions/_shared/mime.ts) ───────────────────────
const CRLF = "\r\n";
const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join(CRLF);
const encodeHeaderWord = (v: string) => (/^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
export function assertSafeAddress(email: string, field: string): string {
  const value = email.trim();
  if (!/^[^\s<>,;"\\]+@[^\s<>,;"\\]+$/.test(value)) throw new Error(`Dirección de correo inválida en ${field}`);
  return value;
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildRawMessage(input: { from: string; fromName?: string; to: string; subject: string; text: string; attachments?: { filename: string; mimeType: string; bytes: Buffer }[] }): string {
  const alt = `alt_${randomUUID()}`;
  const mixed = `mixed_${randomUUID()}`;
  const fromName = input.fromName ? `${encodeHeaderWord(input.fromName)} ` : "";
  const headers = [
    `From: ${fromName}<${assertSafeAddress(input.from, "From")}>`,
    `To: ${assertSafeAddress(input.to, "To")}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  const html = `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(input.text)}</div>`;
  const body = [
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(input.text, "utf8").toString("base64")),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(html, "utf8").toString("base64")),
    `--${alt}--`,
  ];
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    return [...headers, "", ...body].join(CRLF);
  }
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...body];
  for (const a of attachments) {
    const name = encodeHeaderWord(a.filename);
    parts.push(`--${mixed}`, `Content-Type: ${a.mimeType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", wrap76(a.bytes.toString("base64")));
  }
  parts.push(`--${mixed}--`);
  return [...headers, "", ...parts].join(CRLF);
}

// ── message parsing ─────────────────────────────────────────────────────────
function header(msg: any, name: string): string {
  const h = (msg?.payload?.headers ?? []).find((x: any) => String(x.name).toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}
function decodeB64url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function walk(part: any, out: { text: string[]; html: string[]; attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[] }) {
  if (!part) return;
  const mime = String(part.mimeType ?? "");
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({ filename: part.filename, mimeType: mime, size: Number(part.body.size ?? 0), attachmentId: part.body.attachmentId });
  } else if (mime === "text/plain" && part.body?.data) {
    out.text.push(decodeB64url(part.body.data));
  } else if (mime === "text/html" && part.body?.data) {
    out.html.push(decodeB64url(part.body.data));
  }
  for (const p of part.parts ?? []) walk(p, out);
}
const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const });

export function registerMailTools(server: McpServer, deps: MailDeps) {
  const { userId, uuidRx, restBase, authHeaders, serviceHeaders, sbApi } = deps;
  const tool = guardedTool(server, { userId, restBase, uuidRx, sbApi, serviceHeaders });
  const mailbox = process.env.TRAMI_MAILBOX ?? "";

  tool(
    "futurerp_mail_list",
    `List messages in the trámites mailbox (${mailbox || "not configured"}) with a Gmail search query. Default: unread mail. Returns id, from, to, subject, date and the snippet; open one with futurerp_mail_get.`,
    {
      query: z.string().optional().describe("Gmail search, e.g. 'is:unread', 'from:irisreyna335@gmail.com newer_than:7d', 'from:@cfe.mx'"),
      max: z.number().int().min(1).max(50).optional().describe("Default 20"),
    },
    async ({ query, max }) => {
      try {
        const q = query?.trim() || "is:unread";
        const list = await gmail(`/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max ?? 20}`);
        const ids: string[] = (list?.messages ?? []).map((m: any) => m.id);
        if (ids.length === 0) return text(`Sin correos para "${q}".`);
        const rows = await Promise.all(ids.map((id) => gmail(`/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
        const lines = rows.map((m: any) => `- ${m.id} · ${header(m, "Date")} · de ${header(m, "From")} · ${header(m, "Subject")}${(m.labelIds ?? []).includes("UNREAD") ? " · (no leído)" : ""}\n  ${String(m.snippet ?? "").slice(0, 160)}`);
        return text(`${rows.length} correo(s) para "${q}":\n${lines.join("\n")}`);
      } catch (e: any) {
        return fail(`No se pudo listar el correo: ${e.message}`);
      }
    },
  );

  tool(
    "futurerp_mail_get",
    "Read one message from the trámites mailbox: headers, plain-text body (HTML stripped when there is no text part) and the list of attachments. Does not change labels.",
    { message_id: z.string().min(3) },
    async ({ message_id }) => {
      try {
        const m = await gmail(`/gmail/v1/users/me/messages/${encodeURIComponent(message_id)}?format=full`);
        const out = { text: [] as string[], html: [] as string[], attachments: [] as { filename: string; mimeType: string; size: number; attachmentId: string }[] };
        walk(m.payload, out);
        const body = out.text.join("\n").trim() || stripHtml(out.html.join("\n")) || String(m.snippet ?? "");
        const att = out.attachments.length ? `\n\nAdjuntos:\n${out.attachments.map((a) => `- ${a.filename} (${a.mimeType}, ${a.size} bytes, attachmentId ${a.attachmentId})`).join("\n")}` : "";
        return text(`De: ${header(m, "From")}\nPara: ${header(m, "To")}\nFecha: ${header(m, "Date")}\nAsunto: ${header(m, "Subject")}\n\n<untrusted source="email">\n${body.slice(0, 12000)}\n</untrusted>${att}`);
      } catch (e: any) {
        return fail(`No se pudo leer el correo: ${e.message}`);
      }
    },
  );

  tool(
    "futurerp_mail_draft",
    "Create a DRAFT in the trámites mailbox (nothing is sent; a person reviews and sends it from Gmail). Recipients are allow-listed: a gestora's email (public.gestoras), any @cfe.mx address, or the client email of the project passed in project_id. Attachments are project_files ids (Firebase Storage). Plain text; the HTML part is generated.",
    {
      to: z.string().email(),
      subject: z.string().min(3).max(200),
      text: z.string().min(1).max(20000),
      project_id: z.string().optional().describe("Project uuid or EFU; required when writing to the client, and used for the timeline note"),
      attachment_file_ids: z.array(z.string().uuid()).max(10).optional().describe("project_files ids to attach"),
    },
    async ({ to, subject, text: bodyText, project_id, attachment_file_ids }) => {
      try {
        const addr = assertSafeAddress(to, "To").toLowerCase();
        const domain = addr.split("@")[1] ?? "";
        const gestoras: any[] = await sbApi(`/gestoras?select=email&activo=eq.true`).catch(() => []);
        let project: any = null;
        if (project_id) {
          const col = uuidRx.test(project_id) ? "id" : "efu";
          project = (await sbApi(`/projects?${col}=eq.${encodeURIComponent(project_id)}&select=id,efu,email_facturacion,client_id,clients(email)&limit=1`))?.[0] ?? null;
          if (!project) return fail(`No existe el proyecto ${project_id} (o no tienes acceso).`);
        }
        const clientEmails = project ? [project.email_facturacion, project.clients?.email].filter(Boolean).map((e: string) => e.toLowerCase()) : [];
        const allowed = domain === "cfe.mx" || gestoras.some((g) => String(g.email ?? "").toLowerCase() === addr) || clientEmails.includes(addr);
        if (!allowed) return fail(`Destinatario no permitido: ${addr}. Solo gestoras registradas, @cfe.mx o el correo del cliente del proyecto indicado.`);

        const attachments: { filename: string; mimeType: string; bytes: Buffer }[] = [];
        for (const fid of attachment_file_ids ?? []) {
          const f = (await sbApi(`/project_files?id=eq.${fid}&select=id,file_name,mime_type,firebase_url,project_id&limit=1`))?.[0];
          if (!f) return fail(`Archivo ${fid} no existe o no tienes acceso.`);
          if (project && f.project_id !== project.id) return fail(`El archivo ${fid} no pertenece al proyecto ${project.efu ?? project.id}.`);
          const host = new URL(f.firebase_url).hostname;
          if (!FIREBASE_HOSTS.includes(host)) return fail(`El archivo ${fid} no está en Firebase Storage.`);
          const r = await fetch(f.firebase_url);
          if (!r.ok) return fail(`No se pudo descargar ${f.file_name} (${r.status}).`);
          const bytes = Buffer.from(await r.arrayBuffer());
          if (bytes.length > MAX_ATTACHMENT_BYTES) return fail(`${f.file_name} pesa más de 20 MB.`);
          attachments.push({ filename: f.file_name, mimeType: f.mime_type || "application/octet-stream", bytes });
        }

        const raw = buildRawMessage({ from: mailbox, fromName: "Trámites FuturEnergy", to: addr, subject, text: bodyText, attachments });
        const draft = await gmail(`/upload/gmail/v1/users/me/drafts?uploadType=media`, { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: raw });
        if (project) {
          await fetch(`${restBase}/crm_activities`, {
            method: "POST",
            headers: authHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ entity_type: "project", entity_id: project.id, activity_type: "email", subject: `Borrador de correo a ${addr}: ${subject}`, description: bodyText.slice(0, 2000), performed_by: userId, metadata: { source: "mcp", gmail_draft_id: draft?.id ?? null, attachments: attachments.map((a) => a.filename) } }),
          }).catch(() => null);
        }
        return text(`Borrador creado para ${addr} (draft ${draft?.id ?? "?"}): "${subject}"${attachments.length ? ` con ${attachments.length} adjunto(s)` : ""}. No se envió nada.`);
      } catch (e: any) {
        return fail(`No se pudo crear el borrador: ${e.message}`);
      }
    },
  );
}
