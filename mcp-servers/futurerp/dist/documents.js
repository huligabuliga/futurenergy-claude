/**
 * futurerp_read_document: the content of a project file for the model.
 * PDF → text layer (+ parsed CFE bill fields); image → downscaled JPEG as an
 * image block; anything else → metadata only. Reads go through the user's RLS.
 */
import { z } from "zod";
import { createRequire } from "node:module";
import sharp from "sharp";
import { esRecibo, parseRecibo } from "./recibo.js";
const require = createRequire(import.meta.url);
// pdf-parse is CommonJS; its index.js runs a debug self-test on import, so load lib/ directly.
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const MAX_BYTES = 25 * 1024 * 1024;
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
export function registerDocumentTools(server, deps) {
    server.tool("futurerp_read_document", "Read a project file so you can use its contents: a PDF returns its text (and, for a CFE bill, the parsed fields: titular, número de servicio, cuenta, zona from the account number, tarifa, periodo, total, límite de pago, adeudo signals); an image (INE, predial photo, meter) returns a downscaled picture you can look at. Pass the project_files id from futurerp_list_files, or a Firebase URL.", {
        file_id: z.string().uuid().optional().describe("project_files.id"),
        url: z.string().url().optional().describe("Firebase Storage URL (when there is no project_files row)"),
        max_chars: z.number().int().min(500).max(60000).optional().describe("Cap for the PDF text (default 12000)"),
    }, async ({ file_id, url, max_chars }) => {
        try {
            let name = "(archivo)", mime = null, href = url ?? null;
            if (file_id) {
                const rows = await deps.sbApi(`/project_files?id=eq.${file_id}&select=id,file_name,mime_type,firebase_url`);
                const f = rows?.[0];
                if (!f)
                    return fail(`No existe el archivo ${file_id} (o no tienes acceso).`);
                name = f.file_name ?? name;
                mime = f.mime_type ?? null;
                href = f.firebase_url ?? null;
            }
            if (!href)
                return fail("Pasa file_id o url.");
            if (!/^https:\/\/firebasestorage\.googleapis\.com\//.test(href))
                return fail("Solo leo archivos de Firebase Storage del ERP.");
            const r = await fetch(href);
            if (!r.ok)
                return fail(`No se pudo descargar ${name}: HTTP ${r.status}`);
            const len = Number(r.headers.get("content-length") ?? 0);
            if (len > MAX_BYTES)
                return fail(`${name} pesa ${(len / 1048576).toFixed(1)} MB; el máximo es 25 MB.`);
            const bytes = Buffer.from(await r.arrayBuffer());
            if (bytes.length > MAX_BYTES)
                return fail(`${name} pesa más de 25 MB.`);
            const kind = (mime ?? r.headers.get("content-type") ?? "").toLowerCase();
            const isPdf = kind.includes("pdf") || bytes.subarray(0, 4).toString() === "%PDF";
            const isImg = /^image\/(jpeg|jpg|png|webp|heic|heif|tiff)/.test(kind) || /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
            if (isPdf) {
                const parsed = await pdfParse(bytes, { max: 10 });
                const text = parsed.text.replace(/[ \t]+\n/g, "\n").trim();
                const cap = max_chars ?? 12000;
                const head = `## ${name} — PDF, ${parsed.numpages} página(s), ${(bytes.length / 1024).toFixed(0)} KB`;
                if (text.length < 40) {
                    return { content: [{ type: "text", text: `${head}\n\nEl PDF no tiene capa de texto (escaneado). Descárgalo en tu sandbox y conviértelo a imagen para leerlo, o pide el documento en foto.` }] };
                }
                const recibo = esRecibo(text) ? parseRecibo(text) : null;
                const fields = recibo ? `\n\n### Recibo CFE (campos leídos)\n\`\`\`json\n${JSON.stringify(recibo, null, 2)}\n\`\`\`` : "";
                return { content: [{ type: "text", text: `${head}${fields}\n\n### Texto\n${text.slice(0, cap)}${text.length > cap ? "\n…(recortado)" : ""}` }] };
            }
            if (isImg) {
                const out = await sharp(bytes).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
                return {
                    content: [
                        { type: "text", text: `## ${name} — imagen, ${(bytes.length / 1024).toFixed(0)} KB original. Léela: nombre completo, CURP/clave si es INE, domicilio; compara con el recibo y el proyecto.` },
                        { type: "image", data: out.toString("base64"), mimeType: "image/jpeg" },
                    ],
                };
            }
            return { content: [{ type: "text", text: `## ${name} — ${kind || "tipo desconocido"}, ${(bytes.length / 1024).toFixed(0)} KB. No sé leer este formato; usa la URL en tu sandbox: ${href}` }] };
        }
        catch (e) {
            return fail(`No se pudo leer el documento: ${e?.message ?? e}`);
        }
    });
}
