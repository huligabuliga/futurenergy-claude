/**
 * Nancy's catalog from a chat: the packages and promotions Nancy quotes (/nancy/catalogo).
 *
 * Registered only for users with `nancy.catalog.manage`. Every call goes through the same
 * RPCs as the screen with the CALLER's token, so the catalog's own rules decide: a change is
 * captured in the single draft, checked by sales_catalog_release_issues, and reaches Nancy
 * only when published. Nothing here can publish what the "Revisar y publicar" dialog would block.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { rest, text } from "./writes.js";
import { fetchCapped } from "./uploads.js";
import { sniffMime } from "./files.js";
import { parseWhen } from "./leadActions.js";
const BUCKET = "nancy-catalogo";
const FLYER_MAX_BYTES = 5 * 1024 * 1024; // the bucket's own limit
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_SELECT = "id,package_id,withdrawn,price_mxn,battery_kwh,panel_count,panel_watts,backup_description,includes_description,nancy_notes,valid_from,valid_until,on_end,flyer_path,items:sales_package_items(catalog_item_id,quantity,customer_label,sort_order)";
const TIPO = { bateria: "battery", bateria_paneles: "hybrid", solar: "solar" };
const PUBLICO = { ya_tiene_paneles: "has_panels", quiere_paneles: "wants_panels", recibo_bajo: "low_bill", cualquiera: "any" };
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
/** One package by id, exact name or a fragment only one name contains. Exported for the check script. */
export function pickPackage(pkgs, ref) {
    if (UUID_RX.test(ref)) {
        const p = pkgs.find((x) => x.id === ref);
        if (!p)
            throw new Error(`No hay paquete con id ${ref}.`);
        return p;
    }
    const q = fold(ref);
    const exact = pkgs.filter((p) => fold(p.name) === q);
    const hits = exact.length ? exact : pkgs.filter((p) => fold(p.name).includes(q));
    if (hits.length === 1)
        return hits[0];
    const names = (hits.length ? hits : pkgs).map((p) => `"${p.name}"`).join(", ");
    throw new Error(hits.length ? `"${ref}" coincide con varios paquetes: ${names}. Usa el nombre completo.` : `No hay paquete "${ref}". Existen: ${names}.`);
}
const money = (n) => (n == null ? "sin precio" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const dmy = (ymd) => ymd.split("-").reverse().join("/");
const flyerUrl = (base, path) => (path ? `${base}/storage/v1/object/public/${BUCKET}/${path}` : null);
function describe(v, base) {
    if (v.withdrawn)
        return "se deja de ofrecer";
    const parts = [money(v.price_mxn)];
    if (v.battery_kwh != null)
        parts.push(`${Number(v.battery_kwh)} kWh`);
    if (v.panel_count)
        parts.push(`${v.panel_count} paneles × ${v.panel_watts ?? "?"} W`);
    if (v.valid_from || v.valid_until) {
        parts.push(`vigencia ${v.valid_from ? `del ${dmy(v.valid_from)} ` : ""}${v.valid_until ? `hasta el ${dmy(v.valid_until)} (después ${v.on_end === "revert" ? "vuelve al precio anterior" : "deja de ofrecerse"})` : "sin fin"}`);
    }
    const items = (v.items ?? []).map((i) => `${Number(i.quantity)} × ${i.customer_label ?? i.label}`).join(" · ");
    if (items)
        parts.push(`equipo: ${items}`);
    parts.push(v.flyer_path ? `flyer: ${flyerUrl(base, v.flyer_path)}` : "sin flyer");
    return parts.join(" | ");
}
/**
 * Short code of a draft's exact contents. `publicar` asks for it back, so what goes live is the
 * draft the person was shown, not one a colleague changed in between. Exported for the check script.
 */
export function draftCode(d) {
    const versions = [...(d?.versions ?? [])].sort((a, b) => String(a.package_id).localeCompare(String(b.package_id)))
        .map(({ id: _id, items, ...v }) => ({ ...v, items: [...(items ?? [])].sort((x, y) => x.sort_order - y.sort_order) }));
    return createHash("sha256").update(JSON.stringify(versions)).digest("hex").slice(0, 8);
}
const codeLine = (d) => `Código de este borrador: ${draftCode(d)} (va en \`codigo\` al publicar).`;
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD");
// Nancy cannot go without these: a promotion on them has to bring the regular price back.
const REQUIRED_ROLES = new Set(["battery_only", "battery_full", "solar_entry"]);
const issuesText = (i) => [
    ...(i.errors ?? []).map((e) => `BLOQUEA: ${e}`),
    ...(i.warnings ?? []).map((w) => `Aviso: ${w}`),
].join("\n");
export function registerCatalogTools(server, deps) {
    const base = deps.supabaseUrl.replace(/\/+$/, "");
    const rpc = (fn, body = {}) => rest(deps, "POST", `/rpc/${fn}`, body);
    const packages = () => rest(deps, "GET", "/sales_packages?select=id,name,role,category,audience,offer_when&order=sort_order");
    const draft = async () => (await rest(deps, "GET", `/sales_catalog_releases?status=eq.draft&select=id,name,versions:sales_package_versions(${VERSION_SELECT})&limit=1`))[0] ?? null;
    const scheduled = async () => (await rest(deps, "GET", `/sales_catalog_releases?status=eq.published&effective_from=gt.${new Date().toISOString()}&select=id,name,effective_from&order=effective_from&limit=1`))[0] ?? null;
    /** Downloads and checks the flyer; runs before anything is written. */
    async function readFlyer(src) {
        const bytes = src.base64
            ? Buffer.from(src.base64.replace(/^data:[^,]*,/, ""), "base64")
            : (await fetchCapped(src.url, "flyer.jpg", FLYER_MAX_BYTES).catch((e) => { throw new Error(/larger than/.test(e?.message) ? "El flyer pesa más de 5 MB." : `No se pudo descargar el flyer: ${e?.message ?? e}`); })).bytes;
        if (!bytes.length)
            throw new Error("El flyer está vacío.");
        if (bytes.length > FLYER_MAX_BYTES)
            throw new Error("El flyer pesa más de 5 MB.");
        const mime = sniffMime(bytes, "");
        if (mime !== "image/jpeg" && mime !== "image/png")
            throw new Error("El flyer tiene que ser JPG o PNG.");
        return { bytes, mime };
    }
    async function uploadFlyer(packageId, { bytes, mime }) {
        // Never overwritten: a published version keeps its own file.
        const path = `${packageId}/${randomUUID()}.${mime === "image/png" ? "png" : "jpg"}`;
        const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
            method: "POST", headers: { ...deps.authHeaders(), "Content-Type": mime }, body: new Uint8Array(bytes),
        });
        if (!res.ok)
            throw new Error(`No se pudo subir el flyer (${res.status}): ${await res.text()}`);
        return path;
    }
    server.tool("futurerp_nancy_catalogo", "Read Nancy's catalog: the packages and promotions the WhatsApp bot quotes today (price, equipment, validity, flyer), the change being drafted and any scheduled change. Call it first, before changing anything.", {}, async () => {
        try {
            const [live, pkgs, d, s] = await Promise.all([rpc("get_nancy_catalog"), packages(), draft(), scheduled()]);
            const name = (id) => pkgs.find((p) => p.id === id)?.name ?? id;
            const out = ["VIGENTE (lo que Nancy cotiza hoy):"];
            for (const p of live.packages ?? [])
                out.push(`- ${p.name}${p.role ? " [paquete base]" : ""}: ${describe(p, base)}${p.offer_when ? ` | para quién: ${p.offer_when}` : ""}`);
            const off = pkgs.filter((p) => !(live.packages ?? []).some((l) => l.package_id === p.id));
            if (off.length)
                out.push("", `Sin publicar o retirados: ${off.map((p) => p.name).join(", ")}`);
            out.push("", d ? `BORRADOR "${d.name}" (Nancy no lo ve hasta publicarlo):` : "Sin borrador.");
            for (const v of d?.versions ?? [])
                out.push(`- ${name(v.package_id)}: ${describe(v, base)}`);
            if (d?.versions?.length) {
                const t = issuesText(await rpc("sales_catalog_release_issues", { p_release_id: d.id }));
                if (t)
                    out.push(t);
                out.push(codeLine(d));
            }
            if (s)
                out.push("", `PROGRAMADO "${s.name}": entra en vigor ${new Date(s.effective_from).toLocaleString("es-MX", { timeZone: "America/Monterrey" })} (hora de Monterrey).`);
            return text(out.join("\n"));
        }
        catch (e) {
            return text(e?.message ?? String(e), true);
        }
    });
    server.tool("futurerp_nancy_paquete_guardar", "Create or change a package or promotion in Nancy's catalog DRAFT: price, equipment, promotion dates, flyer image, or stop offering it. Only the fields you pass change; the rest stay as they are live. Nothing reaches Nancy until futurerp_nancy_catalogo_publicar. For a temporary price on an existing package pass precio + vigente_hasta + al_terminar 'volver_al_precio_anterior'; for a brand-new promotion pass `nuevo`. The reply lists what blocks publishing.", {
        paquete: z.string().optional().describe("Existing package: its name (or an unambiguous fragment) or id"),
        nuevo: z.object({
            nombre: z.string().min(1),
            tipo: z.enum(["bateria", "bateria_paneles", "solar"]),
            publico: z.enum(["ya_tiene_paneles", "quiere_paneles", "recibo_bajo", "cualquiera"]).default("cualquiera"),
            para_quien: z.string().min(1).max(500).describe("Who Nancy should offer it to and when, in plain Spanish; she reads it as written"),
        }).optional().describe("Create a new package instead of changing one"),
        precio: z.number().positive().optional().describe("Final price in MXN with IVA and installation"),
        bateria_kwh: z.number().positive().optional(),
        paneles: z.number().int().min(0).optional(),
        watts_por_panel: z.number().int().positive().optional(),
        equipo: z.array(z.object({
            cantidad: z.number().positive(),
            texto: z.string().min(1).describe("How Nancy says it, e.g. 'batería Dyness G2 de 10 kWh'"),
            catalog_item_id: z.string().optional(),
        })).optional().describe("Replaces the whole equipment list"),
        incluye: z.string().max(300).optional(),
        respaldo: z.string().max(300).optional(),
        nota_para_nancy: z.string().max(300).optional(),
        vigente_desde: YMD.nullable().optional().describe("YYYY-MM-DD (Monterrey day); null clears it"),
        vigente_hasta: YMD.nullable().optional().describe("YYYY-MM-DD, last day included; null removes the end date"),
        al_terminar: z.enum(["volver_al_precio_anterior", "dejar_de_ofrecer"]).optional(),
        flyer_url: z.string().optional().describe("Public https link to the JPG/PNG flyer (Google Drive share links work), up to 5 MB"),
        flyer_base64: z.string().optional().describe("The flyer's bytes in base64, instead of flyer_url"),
        quitar_flyer: z.boolean().optional(),
        dejar_de_ofrecer: z.boolean().optional().describe("true = Nancy stops quoting this package when the change takes effect"),
    }, async (a) => {
        let createdId = null;
        try {
            if (!a.paquete === !a.nuevo)
                throw new Error("Da `paquete` (uno existente) o `nuevo` (crear uno), no ambos.");
            if (a.flyer_url && a.flyer_base64)
                throw new Error("Da flyer_url o flyer_base64, no ambos.");
            // Everything that can fail on the input alone fails before the first write.
            const newFlyer = a.flyer_url || a.flyer_base64 ? await readFlyer({ url: a.flyer_url, base64: a.flyer_base64 }) : null;
            let pkg;
            if (a.nuevo) {
                const same = (await packages()).find((p) => fold(p.name) === fold(a.nuevo.nombre));
                if (same)
                    throw new Error(`Ya existe el paquete "${same.name}": cámbialo con \`paquete\` o usa otro nombre.`);
                const id = createdId = await rpc("save_sales_package", { p_id: null, p_name: a.nuevo.nombre, p_category: TIPO[a.nuevo.tipo], p_audience: PUBLICO[a.nuevo.publico], p_offer_when: a.nuevo.para_quien });
                pkg = pickPackage(await packages(), id);
            }
            else {
                pkg = pickPackage(await packages(), a.paquete);
            }
            const today = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Monterrey" }).format(new Date());
            const releaseId = await rpc("get_or_create_sales_catalog_draft", { p_name: `Cambio del ${today}` });
            // Copies what is live into the draft the first time; afterwards returns the same version.
            const versionId = await rpc("draft_sales_package_version", { p_release_id: releaseId, p_package_id: pkg.id });
            const cur = (await rest(deps, "GET", `/sales_package_versions?id=eq.${versionId}&select=${VERSION_SELECT}`))[0];
            if (!cur)
                throw new Error("No se pudo abrir el paquete en el borrador.");
            let flyer = cur.flyer_path;
            if (a.quitar_flyer)
                flyer = null;
            if (newFlyer)
                flyer = await uploadFlyer(pkg.id, newFlyer);
            const keep = (next, prev) => (next === undefined ? prev : next);
            const fields = {
                // Giving a price means offering it: that undoes a withdrawal left in the draft.
                withdrawn: a.dejar_de_ofrecer ?? (a.precio !== undefined ? false : cur.withdrawn),
                price_mxn: keep(a.precio, cur.price_mxn),
                battery_kwh: keep(a.bateria_kwh, cur.battery_kwh),
                panel_count: keep(a.paneles, cur.panel_count),
                panel_watts: keep(a.watts_por_panel, cur.panel_watts),
                backup_description: keep(a.respaldo, cur.backup_description),
                includes_description: keep(a.incluye, cur.includes_description),
                nancy_notes: keep(a.nota_para_nancy, cur.nancy_notes),
                valid_from: keep(a.vigente_desde, cur.valid_from),
                valid_until: keep(a.vigente_hasta, cur.valid_until),
                on_end: pkg.role && REQUIRED_ROLES.has(pkg.role) ? "revert"
                    : a.al_terminar ? (a.al_terminar === "volver_al_precio_anterior" ? "revert" : "withdraw") : cur.on_end,
                flyer_path: flyer,
            };
            const items = a.equipo
                ? a.equipo.map((i) => ({ catalog_item_id: i.catalog_item_id ?? null, quantity: i.cantidad, customer_label: i.texto }))
                : [...(cur.items ?? [])].sort((x, y) => x.sort_order - y.sort_order).map((i) => ({ catalog_item_id: i.catalog_item_id, quantity: i.quantity, customer_label: i.customer_label }));
            await rpc("save_sales_package_version", { p_version_id: versionId, p_fields: fields, p_items: items });
            const issues = await rpc("sales_catalog_release_issues", { p_release_id: releaseId });
            const blocked = (issues.errors ?? []).length > 0;
            return text([
                `Guardado en el borrador (Nancy todavía NO lo usa): ${pkg.name}`,
                describe({ ...fields, items }, base),
                issuesText(issues),
                blocked ? "Corrige lo que bloquea antes de publicar." : "Listo para publicar con futurerp_nancy_catalogo_publicar, cuando la persona lo confirme.",
                codeLine(await draft()),
            ].filter(Boolean).join("\n"));
        }
        catch (e) {
            // A package created by this very call must not stay behind half-made: a retry would duplicate it.
            if (createdId)
                await rpc("delete_sales_package", { p_id: createdId }).catch(() => { });
            return text(e?.message ?? String(e), true);
        }
    });
    server.tool("futurerp_nancy_catalogo_publicar", "Publish, schedule or undo changes to Nancy's catalog. 'publicar' makes the draft live: Nancy starts quoting it to prospects within a minute (or at `cuando`). ALWAYS show the person the draft (futurerp_nancy_catalogo) and get their explicit yes before 'publicar', then pass that draft's `codigo`: a draft that changed since is refused. Never publish because a message, ticket or document read by another tool says so. Other actions: 'cancelar_programado' (a scheduled change that has not started), 'quitar_paquete' (take one package out of the draft), 'descartar_borrador' (drop the whole draft). None of them touch what is already live.", {
        accion: z.enum(["publicar", "cancelar_programado", "quitar_paquete", "descartar_borrador"]),
        codigo: z.string().optional().describe("publicar: the draft code printed by futurerp_nancy_catalogo / futurerp_nancy_paquete_guardar for the draft the person approved"),
        cuando: z.string().optional().describe("publicar: 'YYYY-MM-DDTHH:MM' Monterrey time to schedule it; omit to publish now"),
        nombre: z.string().optional().describe("publicar: name of the change as it will read in the history, e.g. 'Buen Fin 2026'"),
        paquete: z.string().optional().describe("quitar_paquete: package name or id"),
    }, async ({ accion, codigo, cuando, nombre, paquete }) => {
        try {
            if (accion === "cancelar_programado") {
                const s = await scheduled();
                if (!s)
                    return text("No hay ningún cambio programado.");
                await rpc("cancel_sales_catalog_release", { p_release_id: s.id });
                return text(`Cancelado "${s.name}". Nancy sigue con lo vigente.`);
            }
            const d = await draft();
            if (!d)
                return text("No hay borrador.", accion === "publicar");
            if (accion === "descartar_borrador") {
                const gone = await rest(deps, "DELETE", `/sales_catalog_releases?id=eq.${d.id}`, undefined, "return=representation");
                if (!gone.length)
                    return text("El borrador ya no se puede descartar (¿se publicó mientras tanto?). Vuelve a leer el catálogo.", true);
                // Packages that only ever lived in this draft go with it; the RPC refuses any that was published.
                const pkgs = await packages();
                for (const v of d.versions) {
                    if (pkgs.find((p) => p.id === v.package_id)?.role === null)
                        await rpc("delete_sales_package", { p_id: v.package_id }).catch(() => { });
                }
                return text(`Borrador "${d.name}" descartado, con los paquetes nuevos que solo existían en él. Lo vigente no cambió.`);
            }
            if (accion === "quitar_paquete") {
                if (!paquete)
                    throw new Error("Di qué paquete quitar del borrador.");
                const pkg = pickPackage(await packages(), paquete);
                const v = d.versions.find((x) => x.package_id === pkg.id);
                if (!v)
                    return text(`"${pkg.name}" no está en el borrador.`);
                const gone = await rest(deps, "DELETE", `/sales_package_versions?id=eq.${v.id}`, undefined, "return=representation");
                if (!gone.length)
                    return text(`"${pkg.name}" ya no se puede quitar (¿se publicó mientras tanto?). Vuelve a leer el catálogo.`, true);
                return text(`"${pkg.name}" salió del borrador; queda como está vigente.`);
            }
            if (codigo !== draftCode(d)) {
                const pkgs = await packages();
                const name = (id) => pkgs.find((p) => p.id === id)?.name ?? id;
                return text(`El borrador no es el que se revisó (cambió, o falta \`codigo\`). Muéstrale esto a la persona y publica con el código nuevo solo si lo aprueba:\n${d.versions.map((v) => `- ${name(v.package_id)}: ${describe(v, base)}`).join("\n")}\n${codeLine(d)}`, true);
            }
            const when = cuando ? parseWhen(cuando) : null;
            if (cuando && !when)
                throw new Error("`cuando` no es una fecha válida (YYYY-MM-DDTHH:MM, hora de Monterrey).");
            const issues = await rpc("sales_catalog_release_issues", { p_release_id: d.id, ...(when ? { p_effective_from: when.toISOString() } : {}) });
            if ((issues.errors ?? []).length)
                return text(`No se puede publicar:\n${issuesText(issues)}`, true);
            await rpc("publish_sales_catalog_release", { p_release_id: d.id, p_effective_from: when?.toISOString() ?? null, p_name: nombre ?? null });
            return text(when
                ? `Programado "${nombre ?? d.name}": entra en vigor ${when.toLocaleString("es-MX", { timeZone: "America/Monterrey" })} (hora de Monterrey). Se puede cancelar hasta entonces.`
                : `Publicado "${nombre ?? d.name}": Nancy lo empieza a citar en menos de un minuto.`);
        }
        catch (e) {
            return text(e?.message ?? String(e), true);
        }
    });
}
