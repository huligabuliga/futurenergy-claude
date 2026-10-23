/**
 * futurerp_upload_file: put a file in FuturERP's Firebase Storage bucket and attach it to a record.
 *
 * Registered only for users with the `mcp.upload` permission (assigned in the ERP at
 * /admin/permisos). The upload runs as the caller: their Supabase token mints the same Firebase
 * session the web app uses (firebase-token edge function → storage rules), and the attachment row
 * is inserted through PostgREST with their token, so RLS decides where they may attach, exactly as
 * in the app. Works on any table that stores files: columns are read from the live schema.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertWritable, ledger, rest, text, type WriteDeps } from "./writes.js";

export interface UploadDeps extends Pick<WriteDeps, "userId" | "restBase" | "authHeaders" | "serviceHeaders"> {
  supabaseUrl: string;
  publishableKey: string;
  userToken: () => string | undefined;
  tableColumns: (table: string) => Promise<string[] | null>;
}

export const MAX_URL_BYTES = 50 * 1024 * 1024; // the app's MAX_FILE_SIZE
export const MAX_B64_BYTES = 10 * 1024 * 1024; // base64 travels inside the JSON-RPC body
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET ?? "tickets-futurenergy.firebasestorage.app";
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY ?? "";
// Standard Firebase emulator env vars (local tests only); unset in Railway → real endpoints.
const STORAGE_BASE = process.env.FIREBASE_STORAGE_EMULATOR_HOST ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}` : "https://firebasestorage.googleapis.com";
const IDT_BASE = process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";

const URL_COLS = ["firebase_url", "url", "file_url", "attachment_url"];
const PATH_COLS = ["storage_path", "file_path"];

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", xml: "application/xml", txt: "text/plain",
  csv: "text/csv", doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  dwg: "application/acad", zip: "application/zip",
};

// ── SSRF guard: public https hosts only, re-checked on every redirect ────────────
const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) blocked.addSubnet(a, p, "ipv4");
// IPv4-mapped v6 (::ffff:a.b.c.d) is matched against the v4 rules by BlockList itself.
for (const [a, p] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(a, p, "ipv6");

export async function assertPublicHttps(u: URL): Promise<void> {
  if (u.protocol !== "https:") throw new Error("Only https:// URLs can be uploaded.");
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
    throw new Error(`Host ${u.hostname} is not a public address.`);
  }
  // ponytail: DNS is resolved again by fetch (rebinding window); pin the IP with an undici dispatcher if this ever matters.
}

/** Google Drive "share" links → direct download. */
export function directUrl(raw: string): string {
  const m = raw.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : raw;
}

async function fetchCapped(raw: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  let u = new URL(directUrl(raw));
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHttps(u);
    const res = await fetch(u, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location")!, u);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_URL_BYTES) throw new Error("File is larger than 50 MB.");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > MAX_URL_BYTES) throw new Error("File is larger than 50 MB.");
      chunks.push(Buffer.from(c));
    }
    return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type")?.split(";")[0].trim() || null };
  }
  throw new Error("Too many redirects.");
}

export function fileMeta(fileName: string, mime?: string | null) {
  const ext = (fileName.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const m = (mime && mime !== "application/octet-stream" ? mime : EXT_MIME[ext]) ?? "application/octet-stream";
  if (/^image\/hei[cf]$/i.test(m) || ext === "heic" || ext === "heif") {
    throw new Error("HEIC/HEIF photos aren't supported here (the app converts them in the browser). Send a JPEG or PNG.");
  }
  const fileType = m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : m === "application/pdf" ? "pdf" : "document";
  return { ext, mime: m, fileType, isImage: m.startsWith("image/") };
}

/** Builds the attachment row for `table` from its live columns. Pure; exported for the check script. */
export function buildRow(
  table: string, cols: string[], values: Record<string, any>,
  f: { url: string; path: string; name: string; size: number; mime: string; ext: string; fileType: string; isImage: boolean },
  userId: string,
): Record<string, any> {
  const has = (c: string) => cols.includes(c);
  const urlCol = URL_COLS.find(has);
  if (!urlCol && has("metadata")) {
    // Activity feeds (ticket_activities, incidencia_activities): a comment carrying metadata.attachments.
    const attachment = { id: randomUUID(), file_name: f.name, file_size: f.size, mime_type: f.mime, is_image: f.isImage,
      firebase_url: f.url, storage_path: f.path, uploaded_at: new Date().toISOString() };
    return {
      ...(has("activity_type") ? { activity_type: "comment" } : {}),
      ...(has("user_id") ? { user_id: userId } : {}),
      ...(has("content") ? { content: `Archivo adjunto: ${f.name}` } : {}),
      ...values,
      metadata: { ...(values.metadata ?? {}), attachments: [attachment] },
    };
  }
  const pathCol = PATH_COLS.find(has);
  if (!urlCol && !pathCol) throw new Error(`Table "${table}" has no file column (${[...URL_COLS, ...PATH_COLS].join("/")}); pick a *_files / *_attachments table.`);
  const derived: Record<string, any> = {};
  if (urlCol) derived[urlCol] = f.url;
  if (pathCol) derived[pathCol] = f.path;
  const put = (c: string, v: any) => { if (has(c)) derived[c] = v; };
  put("title", f.name); put("file_name", f.name); put("file_size", f.size); put("mime_type", f.mime); put("content_type", f.mime);
  put("file_type", f.fileType); put("file_extension", f.ext); put("is_image", f.isImage);
  put("uploaded_by", userId); put("uploaded_by_user_id", userId);
  return { ...derived, ...values };
}

async function firebaseIdToken(deps: UploadDeps): Promise<string> {
  const tok = deps.userToken();
  if (!tok) throw new Error("No user session.");
  if (!FIREBASE_API_KEY) throw new Error("FIREBASE_API_KEY is not set on the MCP server.");
  const r1 = await fetch(`${deps.supabaseUrl}/functions/v1/firebase-token`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, apikey: deps.publishableKey },
  });
  if (!r1.ok) throw new Error(`firebase-token ${r1.status}: ${await r1.text()}`);
  const { token } = await r1.json();
  const r2 = await fetch(`${IDT_BASE}/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, returnSecureToken: true }),
  });
  if (!r2.ok) throw new Error(`Firebase sign-in ${r2.status}: ${await r2.text()}`);
  return (await r2.json()).idToken;
}

const objUrl = (path: string) => `${STORAGE_BASE}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`;

export function registerUploadTools(server: McpServer, deps: UploadDeps) {
  server.tool(
    "futurerp_upload_file",
    "Upload a file to FuturERP and attach it to a record, with the signed-in user's own permissions (only where they could attach it in the app). Give the file as a public https URL (Google Drive share links work) or base64 (≤10 MB), and the attachment table plus its link columns: e.g. table 'lead_files' {lead_id}, 'project_files' {project_id, document_id?}, 'ticket_activities' {ticket_id, content?} (adds a comment with the file), 'requisicion_attachments' {requisicion_id}. File columns (url, name, size, type, uploader) are filled automatically. Use futurerp_list_files afterwards to see it.",
    {
      table: z.string().describe("Table that stores the attachment, e.g. lead_files, project_files, ticket_activities"),
      values: z.record(z.string(), z.any()).describe("Link columns for the new row, e.g. {lead_id: '<uuid>', document_type: 'recibo_cfe'}"),
      file_name: z.string().min(1).describe("File name with extension, e.g. recibo.pdf"),
      url: z.string().optional().describe("Public https URL to download the file from"),
      base64: z.string().optional().describe("File contents in base64 (instead of url), ≤10 MB"),
      mime_type: z.string().optional().describe("MIME type; guessed from the download or the extension when omitted"),
    },
    async ({ table, values, file_name, url, base64, mime_type }) => {
      let uploaded: { path: string; idToken: string } | null = null;
      try {
        if (!url === !base64) throw new Error("Give exactly one of url or base64.");
        const cols = await deps.tableColumns(table);
        if (!cols) throw new Error(`Unknown table "${table}".`);

        let bytes: Buffer, mime = mime_type ?? null;
        if (base64) {
          bytes = Buffer.from(base64.replace(/^data:[^,]*,/, ""), "base64");
          if (bytes.length > MAX_B64_BYTES) throw new Error("base64 files are limited to 10 MB; pass a URL instead.");
        } else {
          const got = await fetchCapped(url!);
          bytes = got.bytes;
          mime ??= got.contentType;
        }
        if (!bytes.length) throw new Error("The file is empty.");
        const meta = fileMeta(file_name, mime);

        const safe = file_name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const parent = String(Object.entries(values ?? {}).find(([k]) => k.endsWith("_id"))?.[1] ?? "misc").replace(/[^\w-]/g, "");
        const path = `${table}/${parent}/${Date.now()}_${randomUUID().slice(0, 8)}_${safe}`;
        const fileUrl = `${objUrl(path)}?alt=media`;
        const row = buildRow(table, cols, values ?? {}, { url: fileUrl, path, name: file_name, size: bytes.length, ...meta }, deps.userId);
        assertWritable(table, Object.keys(row));

        const idToken = await firebaseIdToken(deps);
        const up = await fetch(`${STORAGE_BASE}/v0/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, {
          method: "POST", headers: { Authorization: `Firebase ${idToken}`, "Content-Type": meta.mime }, body: new Uint8Array(bytes),
        });
        if (!up.ok) throw new Error(`Storage upload ${up.status}: ${await up.text()}`);
        uploaded = { path, idToken };

        const created: any[] = await rest(deps, "POST", `/${table}`, row, "return=representation");
        const r = created[0] ?? {};
        await ledger(deps, { op: "insert", table_name: table, payload: { ...row, file_size: bytes.length }, despues: r, row_count: created.length });
        return text(`Uploaded ${file_name} (${bytes.length < 1024 ? `${bytes.length} bytes` : `${Math.round(bytes.length / 1024)} KB`}) and attached it in ${table}${r.id ? ` (row ${r.id})` : ""}.\n\nStorage path: ${path}`);
      } catch (e: any) {
        let note = "";
        if (uploaded) {
          // The row was refused: don't leave an orphan blob behind.
          const r = await fetch(objUrl(uploaded.path), { method: "DELETE", headers: { Authorization: `Firebase ${uploaded.idToken}` } }).catch(() => null);
          note = r?.ok ? " (the uploaded file was removed again)" : ` (orphan file left at ${uploaded.path})`;
          if (!r?.ok) console.error("[mcp upload] cleanup failed", r?.status, uploaded.path);
        }
        return text(`Upload failed: ${e?.message ?? e}${note}`, true);
      }
    },
  );
}
