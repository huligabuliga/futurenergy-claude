#!/usr/bin/env node
/**
 * FuturERP MCP Server v2 — remote Streamable HTTP + OAuth.
 *
 * Read-only MCP for Future Energy's internal ERP (pronto-resolver-61 on Supabase).
 * Data reads go through PostgREST with the secret key (bypass RLS — full org read,
 * unchanged from v1). Callers authenticate with a Supabase Auth OAuth 2.1 access token
 * (users log in with their FuturERP account); tool visibility is gated per user via the
 * app's RBAC (`has_crm_permission`): `mcp.access` (everything) + `mcp.whatsapp` (WhatsApp tools).
 *
 * Env vars:
 *   SUPABASE_URL                — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — sb_secret_* (preferred) OR legacy service_role JWT (data reads)
 *   SUPABASE_PUBLISHABLE_KEY    — sb_publishable_* / anon key (only used to validate user tokens)
 *   MCP_PUBLIC_URL              — public URL of this endpoint, e.g. https://mcp.futurenergy.mx/mcp
 *   PORT                        — listen port (default 3000)
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
// Load .env from server root (fallback if env vars not passed by MCP client)
try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(__dirname, "../.env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            if (!process.env[key])
                process.env[key] = val;
        }
    }
}
catch { }
import { PRONTO_TABLES, PRONTO_ENUMS, PRONTO_RPCS, LEAD_STATUS_VALUES, LEAD_STATUS_LABELS, LEAD_QUALIFICATION_VALUES, VENDOR_QUALIFICATION_VALUES, LEAD_PROGRAM_VALUES, CRM_ACTIVITY_TYPES, CRM_ACTIVITY_CATEGORIES, TICKET_PRIORITY_SLA_DAYS, PHOTO_TO_DOCUMENT_MAP, VT_TO_SF_FIELD_MAP, ACCOUNT_EMAIL_FIELDS, KEY_FIELDS, FILE_TABLES, FILE_ENTITY_TYPES, getRpcsByCategory, } from "./schema.js";
// ── Supabase connection ───────────────────────────────────
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const REST_BASE = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const MCP_PUBLIC_URL = new URL(process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}/mcp`);
const VERSION = "2.0.0";
// OpenAPI describe cache: schema doc TTL 2h (mirrors salesforce describe cache)
let openApiCache = null;
const OPENAPI_TTL = 2 * 60 * 60 * 1000;
function hasCredentials() {
    return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}
function requireCredentials() {
    if (!hasCredentials()) {
        throw new Error("No Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .mcp.json env or in ~/.claude/mcp-servers/futurerp/.env.");
    }
}
function authHeaders(extra = {}) {
    return {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...extra,
    };
}
/** GET to PostgREST `/rest/v1/<path>`. Returns parsed JSON. Throws on non-2xx. */
async function sbApi(path, headers = {}) {
    const url = `${REST_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, { headers: authHeaders(headers) });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${res.status}: ${text}`);
    }
    if (res.status === 204)
        return { success: true };
    return res.json();
}
/** HEAD/GET with `Prefer: count=exact` to read content-range total without fetching rows. */
async function sbCount(table, qs = "") {
    const url = `${REST_BASE}/${table}?select=*${qs ? `&${qs}` : ""}`;
    const res = await fetch(url, {
        method: "HEAD",
        headers: authHeaders({ Prefer: "count=exact" }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase count ${res.status}: ${text}`);
    }
    const range = res.headers.get("content-range") ?? "";
    const total = parseInt(range.split("/").pop() ?? "0", 10);
    return Number.isFinite(total) ? total : 0;
}
/** POST to `/rest/v1/rpc/<name>`. Returns the RPC's return value (rows or scalar). */
async function sbRpc(name, args = {}) {
    const url = `${REST_BASE}/rpc/${name}`;
    const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(args),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase RPC ${name} ${res.status}: ${text}`);
    }
    if (res.status === 204)
        return null;
    return res.json();
}
/** Fetch the PostgREST OpenAPI spec (cached 2h). */
async function sbOpenApi() {
    if (openApiCache && Date.now() - openApiCache.fetchedAt < OPENAPI_TTL) {
        return openApiCache.data;
    }
    // PostgREST root returns the OpenAPI spec with the apikey
    const res = await fetch(`${REST_BASE}/`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Accept: "application/openapi+json" },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAPI fetch failed ${res.status}: ${text}`);
    }
    const data = await res.json();
    openApiCache = { data, fetchedAt: Date.now() };
    return data;
}
/**
 * Shared filter zod schema. Defined ONCE and reused across every tool so tsc's type
 * inference doesn't blow up trying to widen the same complex union N times.
 */
const FilterOpEnum = z.enum([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "in",
    "is",
    "not.is",
]);
const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const FiltersSchema = z
    .array(z.object({ column: z.string(), op: FilterOpEnum, value: FilterValueSchema }))
    .optional();
function filtersToQs(filters) {
    if (!filters?.length)
        return "";
    return filters
        .map((f) => {
        const v = Array.isArray(f.value)
            ? `(${f.value.map((x) => String(x)).join(",")})`
            : String(f.value);
        return `${encodeURIComponent(f.column)}=${f.op}.${encodeURIComponent(v)}`;
    })
        .join("&");
}
/** Canonical uuid v4-ish shape — 8-4-4-4-12 hex with dashes. Rejects EFU folios. */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Batch-resolve a list of auth-user uuids to "First Last" display names.
 *
 * Pronto's `profiles` table has BOTH `id` (the profile row's own uuid) and `user_id`
 * (the auth.users uuid). Foreign-key columns across the app — `responsables_ids`,
 * `assigned_to`, `created_by`, `performed_by`, etc. — reference `auth.users.id`,
 * which corresponds to `profiles.user_id`. Joining via `profiles.id` returns nothing.
 *
 * Returns a Map<authUuid, displayName>. Best-effort — failures resolve to an empty map
 * so callers can fall back to the raw uuid.
 */
async function resolveProfiles(authUuids) {
    const out = new Map();
    const valid = [...new Set(authUuids)].filter((u) => u && UUID_RX.test(u));
    if (valid.length === 0)
        return out;
    try {
        const rows = await sbApi(`/profiles?user_id=in.(${valid.map((u) => encodeURIComponent(u)).join(",")})&select=user_id,first_name,last_name,email`);
        for (const p of Array.isArray(rows) ? rows : []) {
            const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email || p.user_id;
            out.set(p.user_id, name);
        }
    }
    catch {
        /* swallow — callers fall back to raw uuid */
    }
    return out;
}
/** Render an array of records as a markdown table when narrow enough, else as a JSON code block. */
function renderRecords(records, heading, maxCols = 8) {
    if (!records?.length)
        return `${heading ? heading + "\n\n" : ""}*No records.*`;
    const keys = Object.keys(records[0]);
    const head = heading ? `${heading}\n\n` : "";
    if (keys.length <= maxCols) {
        const header = `| ${keys.join(" | ")} |`;
        const sep = `| ${keys.map(() => "---").join(" | ")} |`;
        const rows = records.map((r) => `| ${keys
            .map((k) => {
            const v = r[k];
            if (v === null || v === undefined)
                return "";
            if (typeof v === "object")
                return JSON.stringify(v);
            return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
        })
            .join(" | ")} |`);
        return `${head}${header}\n${sep}\n${rows.join("\n")}`;
    }
    return `${head}\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\``;
}
/** Period filter helper — translates a named period to ISO date bounds. */
function periodToRange(period) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const iso = (d) => d.toISOString();
    switch (period) {
        case "this_month": {
            const start = new Date(Date.UTC(y, m, 1));
            const end = new Date(Date.UTC(y, m + 1, 1));
            return { gte: iso(start), lte: iso(end), label: "this month" };
        }
        case "last_month": {
            const start = new Date(Date.UTC(y, m - 1, 1));
            const end = new Date(Date.UTC(y, m, 1));
            return { gte: iso(start), lte: iso(end), label: "last month" };
        }
        case "this_quarter": {
            const qStart = m - (m % 3);
            const start = new Date(Date.UTC(y, qStart, 1));
            const end = new Date(Date.UTC(y, qStart + 3, 1));
            return { gte: iso(start), lte: iso(end), label: "this quarter" };
        }
        case "last_quarter": {
            const qStart = m - (m % 3) - 3;
            const start = new Date(Date.UTC(y, qStart, 1));
            const end = new Date(Date.UTC(y, qStart + 3, 1));
            return { gte: iso(start), lte: iso(end), label: "last quarter" };
        }
        case "this_year": {
            return { gte: iso(new Date(Date.UTC(y, 0, 1))), lte: iso(new Date(Date.UTC(y + 1, 0, 1))), label: "this year" };
        }
        case "last_year": {
            return { gte: iso(new Date(Date.UTC(y - 1, 0, 1))), lte: iso(new Date(Date.UTC(y, 0, 1))), label: "last year" };
        }
        case "all_time":
        default:
            return { label: "all time" };
    }
}
// ── Auth: Supabase user token → AuthInfo with MCP scopes ─────
//
// The bearer token is a Supabase Auth JWT (issued by the OAuth 2.1 server after the user
// logs in to FuturERP). We validate it by asking Supabase (`/auth/v1/user`) — works with
// HS256 today and asymmetric keys later — then map the user to MCP scopes via the app's
// `has_crm_permission` RPC. Cached 60 s per token.
const MCP_SCOPES = ["mcp.access", "mcp.whatsapp"];
const authCache = new Map();
async function hasCrmPermission(userId, key) {
    const res = await fetch(`${REST_BASE}/rpc/has_crm_permission`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ _user_id: userId, _permission: key }),
    });
    if (!res.ok)
        throw new Error(`has_crm_permission ${res.status}: ${await res.text()}`);
    return (await res.json()) === true;
}
async function resolveAuthInfo(token) {
    const now = Date.now();
    const hit = authCache.get(token);
    if (hit && hit.until > now)
        return hit.info;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok)
        throw new InvalidTokenError("Token inválido o expirado");
    const user = await res.json();
    let claims = {};
    try {
        claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    }
    catch { }
    const scopes = [];
    for (const key of MCP_SCOPES)
        if (await hasCrmPermission(user.id, key))
            scopes.push(key);
    const info = {
        token,
        clientId: claims.client_id ?? "session",
        scopes,
        expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
        extra: { userId: user.id, email: user.email ?? "" },
    };
    if (authCache.size > 500)
        authCache.clear();
    authCache.set(token, { info, until: now + 60_000 });
    return info;
}
const tokenVerifier = {
    async verifyAccessToken(token) {
        const info = await resolveAuthInfo(token);
        // Enforced here (not via requireBearerAuth.requiredScopes) so the 401/403 WWW-Authenticate
        // header never advertises a `scope=` that clients would forward to Supabase's authorize endpoint.
        if (!info.scopes.includes("mcp.access")) {
            throw new InsufficientScopeError("Sin acceso al MCP de FuturERP (falta el permiso mcp.access)");
        }
        return info;
    },
};
// ── Server factory ────────────────────────────────────────
//
// One McpServer per request (stateless Streamable HTTP). Tools are registered per caller:
// everything below requires `mcp.access` (already enforced by the middleware); the WhatsApp
// block is registered only when the caller also holds `mcp.whatsapp`.
// (Body intentionally not re-indented — it is the v1 tool code, moved inside the factory.)
export function buildServer(auth) {
    const can = (scope) => auth.scopes.includes(scope);
    const server = new McpServer({
        name: "futurerp",
        version: VERSION,
    });
    // ────────────────────────────────────────────────────────────
    // SCHEMA & METADATA TOOLS
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_describe_table", "Describe any table in the FuturERP (pronto-resolver) database. Returns columns with PostgreSQL types, nullability, defaults, and PG-enum references. Live data sourced from PostgREST's OpenAPI spec. Use this before querying an unfamiliar table.", {
        table: z.string().describe("Table name, e.g. tickets, leads, instalaciones, drones, notifications"),
        required_only: z.boolean().optional().describe("Only show NOT NULL columns"),
    }, async ({ table, required_only }) => {
        try {
            requireCredentials();
            const spec = await sbOpenApi();
            const def = spec?.definitions?.[table];
            if (!def) {
                const known = PRONTO_TABLES.find((t) => t.name === table);
                return {
                    content: [
                        {
                            type: "text",
                            text: known
                                ? `Table \`${table}\` exists in the static catalog (${known.category}: ${known.purpose}) but isn't exposed via PostgREST. It may be a view/private schema or RLS-hidden from the OpenAPI export.`
                                : `Table \`${table}\` not found. Try \`futurerp_list_tables\`.`,
                        },
                    ],
                    isError: true,
                };
            }
            const required = def.required ?? [];
            const props = def.properties ?? {};
            let cols = Object.entries(props);
            if (required_only)
                cols = cols.filter(([n]) => required.includes(n));
            const rows = cols.map(([name, info]) => {
                const isRequired = required.includes(name);
                const fmt = info.format ?? info.type ?? "?";
                const pgEnum = typeof info.description === "string"
                    ? (info.description.match(/PG enum:\s*([\w_]+)/i)?.[1] ?? "")
                    : "";
                const dflt = info.default !== undefined && info.default !== null ? String(info.default).slice(0, 40) : "";
                const desc = (info.description ?? "").toString().slice(0, 80);
                return `| \`${name}\` | ${fmt}${pgEnum ? ` (${pgEnum})` : ""} | ${isRequired ? "**Yes**" : "no"} | ${dflt} | ${desc} |`;
            });
            const known = PRONTO_TABLES.find((t) => t.name === table);
            const keyFieldNotes = KEY_FIELDS[table]
                ? `\n\n### Key fields\n\n${Object.entries(KEY_FIELDS[table])
                    .map(([k, v]) => `- **${k}** — ${v}`)
                    .join("\n")}`
                : "";
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `## Table \`${table}\``,
                            known ? `**Category:** ${known.category}  •  **Purpose:** ${known.purpose}` : "",
                            `**Total columns:** ${Object.keys(props).length}${required_only ? ` (${cols.length} required shown)` : ""}`,
                            "",
                            `| Column | Type | Required | Default | Description |`,
                            `|--------|------|----------|---------|-------------|`,
                            rows.join("\n"),
                            keyFieldNotes,
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Describe failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_list_tables", "List FuturERP tables, filter by keyword or category. Annotates each table with its domain category (lead, ticket, instalacion, drone, cantina, finance, report, user, notification, integration, system, junction) and one-line purpose.", {
        filter: z.string().optional().describe("Keyword to filter on name or purpose (e.g. 'lead', 'drone', 'pago')"),
        category: z
            .enum([
            "lead",
            "ticket",
            "project",
            "instalacion",
            "drone",
            "cantina",
            "report",
            "user",
            "finance",
            "catalog",
            "notification",
            "integration",
            "whatsapp",
            "system",
            "junction",
        ])
            .optional()
            .describe("Filter by domain category"),
    }, async ({ filter, category }) => {
        let rows = PRONTO_TABLES.slice();
        if (category)
            rows = rows.filter((t) => t.category === category);
        if (filter) {
            const kw = filter.toLowerCase();
            rows = rows.filter((t) => t.name.toLowerCase().includes(kw) || t.purpose.toLowerCase().includes(kw));
        }
        const byCat = {};
        for (const t of rows)
            (byCat[t.category] ??= []).push(t);
        const sections = Object.entries(byCat).map(([cat, list]) => `### ${cat} (${list.length})\n\n${list
            .map((t) => `- \`${t.name}\` — ${t.purpose}`)
            .join("\n")}`);
        // Live merge: any table in the DB but missing from the static catalog still shows up,
        // so this tool always covers the entire database even before the catalog is refreshed.
        let liveCount = 0;
        if (!category && hasCredentials()) {
            try {
                const spec = await sbOpenApi();
                const known = new Set(PRONTO_TABLES.map((t) => t.name));
                let extras = Object.keys(spec.definitions ?? {})
                    .filter((n) => !known.has(n))
                    .sort();
                if (filter)
                    extras = extras.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
                if (extras.length) {
                    liveCount = extras.length;
                    sections.push(`### (uncatalogued — live from DB) (${extras.length})\n\n${extras
                        .map((n) => `- \`${n}\` — use \`futurerp_describe_table\` for columns`)
                        .join("\n")}`);
                }
            }
            catch {
                /* offline / spec fetch failed — static catalog only */
            }
        }
        return {
            content: [
                {
                    type: "text",
                    text: `## FuturERP Tables (${rows.length + liveCount} shown, ${PRONTO_TABLES.length} catalogued)\n\n${sections.join("\n\n")}`,
                },
            ],
        };
    });
    server.tool("futurerp_list_enums", "List all PG enum types in FuturERP with their allowed values. Use this before constructing filters on status/priority/notification_type/etc. Also includes the TypeScript-level enums for lead (status, qualification, vendor qualification, program) and CRM activities.", {
        filter: z.string().optional().describe("Keyword to filter enum name or value"),
    }, async ({ filter }) => {
        const kw = filter?.toLowerCase();
        // PG enums
        const pgEnums = PRONTO_ENUMS.filter((e) => {
            if (!kw)
                return true;
            return (e.name.toLowerCase().includes(kw) ||
                e.values.some((v) => v.toLowerCase().includes(kw)));
        });
        const pgSection = pgEnums
            .map((e) => {
            const valLine = e.values
                .map((v) => `\`${v}\`${e.labels?.[v] ? ` (${e.labels[v]})` : ""}`)
                .join(", ");
            return `### \`${e.name}\`\n${e.description ?? ""}\nValues: ${valLine}`;
        })
            .join("\n\n");
        // TS-level enums (not PG, but vital for filters)
        const tsExtras = [
            {
                name: "lead.status (text-typed)",
                values: [...LEAD_STATUS_VALUES],
                labels: LEAD_STATUS_LABELS,
                description: "Lead pipeline stage (string column, not a PG enum).",
            },
            {
                name: "lead.lead_qualification",
                values: [...LEAD_QUALIFICATION_VALUES],
                description: "System-computed qualification tier.",
            },
            {
                name: "lead.vendor_qualification",
                values: [...VENDOR_QUALIFICATION_VALUES],
                description: "Manual vendor override tier.",
            },
            {
                name: "lead.program",
                values: [...LEAD_PROGRAM_VALUES],
                description: "Program tag (drives which detail subtable applies).",
            },
            {
                name: "crm_activities.activity_type",
                values: [...CRM_ACTIVITY_TYPES],
                description: "How the activity happened.",
            },
            {
                name: "crm_activities.category",
                values: [...CRM_ACTIVITY_CATEGORIES],
                description: "What the activity was about.",
            },
        ].filter((e) => !kw || e.name.toLowerCase().includes(kw) || e.values.some((v) => v.toLowerCase().includes(kw)));
        const tsSection = tsExtras
            .map((e) => {
            const valLine = e.values
                .map((v) => `\`${v}\`${e.labels?.[v] ? ` (${e.labels[v]})` : ""}`)
                .join(", ");
            return `### ${e.name}\n${e.description}\nValues: ${valLine}`;
        })
            .join("\n\n");
        return {
            content: [
                {
                    type: "text",
                    text: [
                        `## FuturERP Enums (${pgEnums.length} PG + ${tsExtras.length} TS-level)`,
                        "",
                        `## PostgreSQL enum types`,
                        pgSection || "*No matches.*",
                        tsSection ? `\n\n## String-typed columns acting as enums\n\n${tsSection}` : "",
                    ].join("\n"),
                },
            ],
        };
    });
    server.tool("futurerp_list_rpcs", "List RPC functions available in FuturERP, grouped by domain (kpi, lead, ticket, drone, cantina, report, permission, notification, finance, user, integration). Each entry notes whether it mutates state. Read-only RPCs are callable; mutating ones are listed for reference only — FuturERP does not invoke them.", {
        category: z
            .enum([
            "kpi",
            "lead",
            "ticket",
            "drone",
            "cantina",
            "report",
            "permission",
            "notification",
            "finance",
            "user",
            "integration",
            "internal",
        ])
            .optional()
            .describe("Filter to one category"),
        read_only: z.boolean().optional().describe("Hide mutating RPCs"),
    }, async ({ category, read_only }) => {
        let rpcs = PRONTO_RPCS.slice();
        if (category)
            rpcs = rpcs.filter((r) => r.category === category);
        if (read_only)
            rpcs = rpcs.filter((r) => !r.mutating);
        const grouped = rpcs.reduce((acc, r) => {
            (acc[r.category] ??= []).push(r);
            return acc;
        }, {});
        const sections = Object.entries(grouped).map(([cat, list]) => {
            const rows = list.map((r) => `- \`${r.name}\`${r.mutating ? " **(mutating)**" : ""} — ${r.purpose}`);
            return `### ${cat} (${list.length})\n\n${rows.join("\n")}`;
        });
        return {
            content: [
                {
                    type: "text",
                    text: `## FuturERP RPCs (${rpcs.length}/${PRONTO_RPCS.length})\n\n${sections.join("\n\n")}`,
                },
            ],
        };
    });
    // ────────────────────────────────────────────────────────────
    // DATA ACCESS TOOLS
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_query", "Run a PostgREST select query against any FuturERP table. Use structured `filters` (each is `{column, op, value}`) instead of raw SQL. Read-only.", {
        table: z.string().describe("Table name, e.g. tickets, leads, instalaciones"),
        select: z
            .string()
            .optional()
            .describe("Comma-separated columns. Default: *. Supports PostgREST embedding, e.g. 'id,folio,assigned_to:profiles(full_name)'"),
        filters: FiltersSchema.describe("Structured filter list. Example: [{column:'status', op:'eq', value:'abierto'}, {column:'fecha_creacion', op:'gte', value:'2026-05-01'}]"),
        order: z.string().optional().describe("PostgREST order, e.g. 'created_at.desc' or 'priority.asc,created_at.desc'"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50, max 200)"),
    }, async ({ table, select, filters, order, limit }) => {
        try {
            requireCredentials();
            const lim = Math.min(limit ?? 50, 200);
            const qsParts = [`select=${encodeURIComponent(select ?? "*")}`];
            const filterQs = filtersToQs(filters);
            if (filterQs)
                qsParts.push(filterQs);
            if (order)
                qsParts.push(`order=${encodeURIComponent(order)}`);
            qsParts.push(`limit=${lim}`);
            const data = await sbApi(`/${table}?${qsParts.join("&")}`);
            const rows = Array.isArray(data) ? data : [data];
            return {
                content: [
                    {
                        type: "text",
                        text: `**${rows.length} row(s)** from \`${table}\`${rows.length === lim ? ` (capped at limit ${lim})` : ""}.\n\n${renderRecords(rows)}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Query failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_count", "Count rows in any table with optional filters. Fast — uses HEAD + Prefer: count=exact.", {
        table: z.string().describe("Table name"),
        filters: FiltersSchema.describe("Filters (same shape as futurerp_query)"),
    }, async ({ table, filters }) => {
        try {
            requireCredentials();
            const total = await sbCount(table, filtersToQs(filters));
            const filterText = filters?.length
                ? ` where ${filters.map((f) => `${f.column} ${f.op} ${JSON.stringify(f.value)}`).join(" AND ")}`
                : "";
            return {
                content: [
                    { type: "text", text: `**${total.toLocaleString()}** rows in \`${table}\`${filterText}.` },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Count failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_get_record", "Fetch a single row from a table by id (or any unique column).", {
        table: z.string().describe("Table name"),
        id: z.string().describe("Primary key value (uuid or text)"),
        id_column: z.string().optional().describe("Column to filter on. Default: 'id'"),
        select: z.string().optional().describe("Columns. Default '*'."),
    }, async ({ table, id, id_column, select }) => {
        try {
            requireCredentials();
            const col = id_column ?? "id";
            const sel = select ?? "*";
            const data = await sbApi(`/${table}?${encodeURIComponent(col)}=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(sel)}&limit=1`);
            const rows = Array.isArray(data) ? data : [data];
            if (rows.length === 0) {
                return {
                    content: [{ type: "text", text: `No row in \`${table}\` where ${col} = '${id}'.` }],
                    isError: true,
                };
            }
            const row = rows[0];
            const composedName = row.first_name || row.last_name ? [row.first_name, row.last_name].filter(Boolean).join(" ") : null;
            const label = row.folio ??
                row.efu ??
                row.name ??
                row.nombre_cliente ??
                row.title ??
                composedName ??
                row.email ??
                id;
            return {
                content: [
                    {
                        type: "text",
                        text: `## ${table}: ${label}\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_get_related", "Fetch child/related rows by foreign key. Example: ticket_activities for a ticket, lead_stage_history for a lead, instalacion_fotos for an instalacion.", {
        child_table: z.string().describe("Table containing the child rows (e.g. ticket_activities)"),
        fk_column: z.string().describe("Foreign-key column on the child table (e.g. ticket_id, lead_id, instalacion_id)"),
        parent_id: z.string().describe("Parent record id (uuid)"),
        select: z.string().optional().describe("Columns. Default '*'."),
        order: z.string().optional().describe("Order, default 'created_at.desc'"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
    }, async ({ child_table, fk_column, parent_id, select, order, limit }) => {
        try {
            requireCredentials();
            const lim = Math.min(limit ?? 50, 200);
            const qs = [
                `${encodeURIComponent(fk_column)}=eq.${encodeURIComponent(parent_id)}`,
                `select=${encodeURIComponent(select ?? "*")}`,
                `order=${encodeURIComponent(order ?? "created_at.desc")}`,
                `limit=${lim}`,
            ].join("&");
            const data = await sbApi(`/${child_table}?${qs}`);
            const rows = Array.isArray(data) ? data : [data];
            if (rows.length === 0) {
                return {
                    content: [
                        { type: "text", text: `No \`${child_table}\` rows for ${fk_column} = '${parent_id}'.` },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `## ${child_table} for ${fk_column} = '${parent_id}' (${rows.length})\n\n${renderRecords(rows)}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_recent_records", "Get the most recent rows from any table. Default order is created_at.desc.", {
        table: z.string().describe("Table name"),
        select: z.string().optional().describe("Columns. Default '*'."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 10, max 100"),
        order: z.string().optional().describe("Order, default 'created_at.desc'"),
        filters: FiltersSchema,
    }, async ({ table, select, limit, order, filters }) => {
        try {
            requireCredentials();
            const lim = Math.min(limit ?? 10, 100);
            const qsParts = [`select=${encodeURIComponent(select ?? "*")}`];
            const filterQs = filtersToQs(filters);
            if (filterQs)
                qsParts.push(filterQs);
            qsParts.push(`order=${encodeURIComponent(order ?? "created_at.desc")}`);
            qsParts.push(`limit=${lim}`);
            const data = await sbApi(`/${table}?${qsParts.join("&")}`);
            const rows = Array.isArray(data) ? data : [data];
            if (rows.length === 0)
                return { content: [{ type: "text", text: `No \`${table}\` records.` }] };
            return {
                content: [
                    { type: "text", text: `## Recent ${table} (${rows.length})\n\n${renderRecords(rows)}` },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // SEARCH TOOL
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_search", "Fuzzy multi-table search across the main entities (tickets, leads, clients, instalaciones, projects). Uses ilike on the most-searched text fields (folio, asunto, name, email, phone, company).", {
        query: z.string().describe("Search term (e.g. 'EFU-00514', 'juan@', 'fachada', '+528112345678')"),
        tables: z
            .string()
            .optional()
            .describe("Comma-separated table list to search. Default: tickets,leads,clients,instalaciones,projects"),
        limit_per_table: z.number().int().min(1).max(20).optional().describe("Max results per table (default 5)"),
    }, async ({ query, tables, limit_per_table }) => {
        try {
            requireCredentials();
            const lim = Math.min(limit_per_table ?? 5, 20);
            const pattern = `*${query}*`; // PostgREST ilike uses * as wildcard
            const targets = (tables ?? "tickets,leads,clients,instalaciones,projects")
                .split(",")
                .map((s) => s.trim());
            const fieldMap = {
                tickets: {
                    cols: ["folio", "asunto", "descripcion", "cliente_nombre"],
                    select: "id,folio,asunto,estado,prioridad,fecha_creacion",
                },
                leads: {
                    cols: ["first_name", "last_name", "email", "phone", "mobile_phone", "company"],
                    select: "id,first_name,last_name,email,phone,status,created_at",
                },
                clients: {
                    cols: ["name", "first_name", "last_name", "email", "phone", "mobile_phone"],
                    select: "id,name,first_name,last_name,email,phone,created_at",
                },
                instalaciones: {
                    cols: ["efu", "nombre_cliente"],
                    select: "id,efu,status,fecha_instalacion,nombre_cliente,created_at",
                },
                projects: {
                    cols: ["description", "efu"],
                    select: "id,efu,description,etapa_tramite,created_at",
                },
            };
            // Run all per-table searches in parallel.
            const results = await Promise.all(targets.map(async (t) => {
                const cfg = fieldMap[t];
                if (!cfg)
                    return { t, section: `### ${t}\n*Unknown table, skipped.*`, count: 0 };
                // PostgREST OR clause: or=(col1.ilike.*kw*,col2.ilike.*kw*)
                const orClause = cfg.cols.map((c) => `${c}.ilike.${pattern}`).join(",");
                try {
                    const data = await sbApi(`/${t}?or=(${encodeURIComponent(orClause)})&select=${encodeURIComponent(cfg.select)}&limit=${lim}`);
                    const rows = Array.isArray(data) ? data : [data];
                    return {
                        t,
                        section: rows.length === 0
                            ? `### ${t}\n*No matches.*`
                            : `### ${t} (${rows.length})\n\n${renderRecords(rows)}`,
                        count: rows.length,
                    };
                }
                catch (err) {
                    return { t, section: `### ${t}\n*Error: ${err.message}*`, count: 0 };
                }
            }));
            const sections = results.map((r) => r.section);
            const total = results.reduce((s, r) => s + r.count, 0);
            return {
                content: [
                    {
                        type: "text",
                        text: `## Search: "${query}" — ${total} result(s) across ${targets.length} table(s)\n\n${sections.join("\n\n")}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // KPI & ANALYTICS TOOLS
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_lead_kpis", "Lead pipeline KPIs (org-wide). Returns total leads, closed amount, close rate, average ticket, projects sold, average sales cycle (days), open pipeline value, and breakdown by status. Mirrors the `useMyPipelineKPIs` widget on VentasHome but org-scoped (service role bypasses RLS).", {
        period: z
            .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
            .optional()
            .describe("Period filter on created_at. Default: this_month"),
        assigned_to: z.string().optional().describe("Restrict to a single owner uuid"),
    }, async ({ period, assigned_to }) => {
        try {
            requireCredentials();
            const range = periodToRange(period ?? "this_month");
            const filters = [];
            if (range.gte)
                filters.push({ column: "created_at", op: "gte", value: range.gte });
            if (range.lte)
                filters.push({ column: "created_at", op: "lt", value: range.lte });
            if (assigned_to)
                filters.push({ column: "assigned_to", op: "eq", value: assigned_to });
            const baseQs = filtersToQs(filters);
            const allLeads = await sbApi(`/leads?${baseQs ? baseQs + "&" : ""}select=id,status,project_amount,is_converted,converted_at,created_at,assigned_to&limit=5000`);
            const total = allLeads.length;
            const converted = allLeads.filter((l) => l.is_converted);
            const projectsSold = converted.length;
            const closeRate = total > 0 ? (projectsSold / total) * 100 : 0;
            const closedAmount = converted.reduce((s, l) => s + (Number(l.project_amount) || 0), 0);
            const totalAmount = allLeads.reduce((s, l) => s + (Number(l.project_amount) || 0), 0);
            const avgTicket = projectsSold > 0 ? closedAmount / projectsSold : 0;
            const pipelineValue = allLeads
                .filter((l) => !l.is_converted && l.status !== "descalificado")
                .reduce((s, l) => s + (Number(l.project_amount) || 0), 0);
            const cycleDays = converted.length > 0
                ? converted.reduce((s, l) => {
                    const c = new Date(l.created_at).getTime();
                    const co = l.converted_at ? new Date(l.converted_at).getTime() : c;
                    return s + (co - c) / (1000 * 60 * 60 * 24);
                }, 0) / converted.length
                : 0;
            // Group by status
            const byStatus = {};
            for (const l of allLeads)
                byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
            const fmt = (n) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
            const statusRows = LEAD_STATUS_VALUES.map((s) => `| ${LEAD_STATUS_LABELS[s] ?? s} | ${byStatus[s] ?? 0} | ${total > 0 ? (((byStatus[s] ?? 0) / total) * 100).toFixed(1) : "0.0"}% |`).join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Lead pipeline KPIs — ${range.label}${assigned_to ? ` (owner ${assigned_to})` : ""}`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Total leads | ${total.toLocaleString()} |`,
                            `| Projects sold (is_converted) | ${projectsSold.toLocaleString()} |`,
                            `| Close rate | ${closeRate.toFixed(1)}% |`,
                            `| Closed amount | ${fmt(closedAmount)} |`,
                            `| Avg ticket (per won deal) | ${fmt(avgTicket)} |`,
                            `| Total lead amount (all) | ${fmt(totalAmount)} |`,
                            `| Open pipeline value | ${fmt(pipelineValue)} |`,
                            `| Avg sales cycle (days) | ${cycleDays.toFixed(1)} |`,
                            "",
                            `## By status`,
                            "",
                            `| Status | Count | % |`,
                            `|--------|-------|---|`,
                            statusRows,
                            "",
                            total === 5000
                                ? "*Note: hit 5000-row sample cap. Narrow the period or filter by assigned_to for full accuracy.*"
                                : "",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Lead KPIs failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_ticket_kpis", "Ticket health KPIs: open vs resolved counts, SLA breaches (priority drives deadline: alta=1d, media=2d, baja=3d laborales), breakdown by area, by status, and by responsable.", {
        period: z
            .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
            .optional()
            .describe("Period filter on fecha_creacion. Default: this_month"),
    }, async ({ period }) => {
        try {
            requireCredentials();
            const range = periodToRange(period ?? "this_month");
            const filters = [];
            if (range.gte)
                filters.push({ column: "fecha_creacion", op: "gte", value: range.gte });
            if (range.lte)
                filters.push({ column: "fecha_creacion", op: "lt", value: range.lte });
            const baseQs = filtersToQs(filters);
            const tickets = await sbApi(`/tickets?${baseQs ? baseQs + "&" : ""}select=id,folio,estado,prioridad,canal,area,responsable,fecha_creacion,fecha_vencimiento&limit=5000`);
            const total = tickets.length;
            const now = Date.now();
            const open = tickets.filter((t) => t.estado !== "resuelto");
            const resolved = tickets.filter((t) => t.estado === "resuelto");
            const overdue = open.filter((t) => t.fecha_vencimiento && new Date(t.fecha_vencimiento).getTime() < now);
            // by estado
            const byStatus = {};
            const byPriority = {};
            const byArea = {};
            const byChannel = {};
            const byResp = {};
            for (const t of tickets) {
                byStatus[t.estado] = (byStatus[t.estado] ?? 0) + 1;
                byPriority[t.prioridad] = (byPriority[t.prioridad] ?? 0) + 1;
                byArea[t.area ?? "—"] = (byArea[t.area ?? "—"] ?? 0) + 1;
                byChannel[t.canal ?? "—"] = (byChannel[t.canal ?? "—"] ?? 0) + 1;
                byResp[t.responsable ?? "(sin asignar)"] = (byResp[t.responsable ?? "(sin asignar)"] ?? 0) + 1;
            }
            const slaTable = Object.entries(TICKET_PRIORITY_SLA_DAYS)
                .map(([p, d]) => `| ${p} | ${d} días laborales |`)
                .join("\n");
            const top = (m) => Object.entries(m)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([k, v]) => `| ${k} | ${v} | ${((v / total) * 100).toFixed(1)}% |`)
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Ticket KPIs — ${range.label}`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Total tickets | ${total.toLocaleString()} |`,
                            `| Open (no resueltos) | ${open.length} |`,
                            `| Resolved | ${resolved.length} |`,
                            `| SLA-overdue (open + past fecha_vencimiento) | **${overdue.length}** |`,
                            `| Overdue rate (vs open) | ${open.length > 0 ? ((overdue.length / open.length) * 100).toFixed(1) : "0.0"}% |`,
                            "",
                            `## SLA rules`,
                            "",
                            `| Priority | Deadline |`,
                            `|----------|----------|`,
                            slaTable,
                            "",
                            `## By status`,
                            "",
                            `| Status | Count | % |`,
                            `|--------|-------|---|`,
                            top(byStatus),
                            "",
                            `## By priority`,
                            "",
                            `| Priority | Count | % |`,
                            `|----------|-------|---|`,
                            top(byPriority),
                            "",
                            `## By area (top 10)`,
                            "",
                            `| Area | Count | % |`,
                            `|------|-------|---|`,
                            top(byArea),
                            "",
                            `## By channel`,
                            "",
                            `| Channel | Count | % |`,
                            `|---------|-------|---|`,
                            top(byChannel),
                            "",
                            `## By responsable (top 10)`,
                            "",
                            `| Responsable | Count | % |`,
                            `|-------------|-------|---|`,
                            top(byResp),
                            "",
                            total === 5000
                                ? "*Note: hit 5000-row sample cap. Narrow the period for full accuracy.*"
                                : "",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Ticket KPIs failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_instalacion_kpis", "Field installation KPIs: status breakdown (asignada/pendiente/en_proceso/completada/cancelada), completion rate, total jobs in period, panels installed, and per-cuadrilla counts.", {
        period: z
            .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
            .optional()
            .describe("Period filter on fecha_instalacion. Default: this_month"),
    }, async ({ period }) => {
        try {
            requireCredentials();
            const range = periodToRange(period ?? "this_month");
            const filters = [];
            if (range.gte)
                filters.push({ column: "fecha_instalacion", op: "gte", value: range.gte });
            if (range.lte)
                filters.push({ column: "fecha_instalacion", op: "lt", value: range.lte });
            const baseQs = filtersToQs(filters);
            const rows = await sbApi(`/instalaciones?${baseQs ? baseQs + "&" : ""}select=id,efu,status,cuadrilla_id,numero_paneles,fecha_instalacion&limit=5000`);
            const total = rows.length;
            const byEstado = {};
            const byCuadrilla = {};
            let totalPanels = 0;
            let completedPanels = 0;
            for (const r of rows) {
                const e = r.status ?? "—";
                byEstado[e] = (byEstado[e] ?? 0) + 1;
                const c = r.cuadrilla_id ?? "(sin cuadrilla)";
                const slot = (byCuadrilla[c] ??= { total: 0, completed: 0, panels: 0 });
                slot.total += 1;
                if (e === "completada")
                    slot.completed += 1;
                const p = Number(r.numero_paneles) || 0;
                slot.panels += p;
                totalPanels += p;
                if (e === "completada")
                    completedPanels += p;
            }
            const completed = byEstado["completada"] ?? 0;
            const completionRate = total > 0 ? (completed / total) * 100 : 0;
            const estadoRows = Object.entries(byEstado)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `| ${k} | ${v} | ${((v / total) * 100).toFixed(1)}% |`)
                .join("\n");
            const cuadrillaRows = Object.entries(byCuadrilla)
                .sort((a, b) => b[1].total - a[1].total)
                .slice(0, 15)
                .map(([k, s]) => `| ${k.slice(0, 8)} | ${s.total} | ${s.completed} | ${s.total > 0 ? ((s.completed / s.total) * 100).toFixed(1) : "0.0"}% | ${s.panels} |`)
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Instalacion KPIs — ${range.label}`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Total jobs scheduled | ${total.toLocaleString()} |`,
                            `| Completed | ${completed.toLocaleString()} |`,
                            `| Completion rate | ${completionRate.toFixed(1)}% |`,
                            `| Total panels (scheduled) | ${totalPanels.toLocaleString()} |`,
                            `| Panels installed (in completed jobs) | ${completedPanels.toLocaleString()} |`,
                            "",
                            `## By estado`,
                            "",
                            `| Estado | Count | % |`,
                            `|--------|-------|---|`,
                            estadoRows || "*No rows.*",
                            "",
                            `## By cuadrilla (top 15)`,
                            "",
                            `| Cuadrilla | Total | Completed | Rate | Panels |`,
                            `|-----------|-------|-----------|------|--------|`,
                            cuadrillaRows || "*No cuadrilla assignments.*",
                            "",
                            total === 5000
                                ? "*Note: hit 5000-row sample cap. Narrow the period for full accuracy.*"
                                : "",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Instalacion KPIs failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_drone_leaderboard", "Drone usage leaderboard. Calls the get_user_drone_rankings RPC for the user leaderboard, and optionally get_drone_kpis for a single drone.", {
        drone_id: z.string().optional().describe("If set, return per-drone metrics via get_drone_kpis"),
    }, async ({ drone_id }) => {
        try {
            requireCredentials();
            const sections = [];
            // User leaderboard
            try {
                const ranks = await sbRpc("get_user_drone_rankings");
                if (Array.isArray(ranks) && ranks.length > 0) {
                    sections.push(`## User leaderboard\n\n${renderRecords(ranks)}`);
                }
                else {
                    sections.push(`## User leaderboard\n\n*No data.*`);
                }
            }
            catch (err) {
                sections.push(`## User leaderboard\n\n*Error calling get_user_drone_rankings: ${err.message}*`);
            }
            // Per-drone if requested
            if (drone_id) {
                try {
                    const kpis = await sbRpc("get_drone_kpis", { p_drone_id: drone_id });
                    sections.push(`## Drone ${drone_id}\n\n\`\`\`json\n${JSON.stringify(kpis, null, 2)}\n\`\`\``);
                }
                catch (err) {
                    sections.push(`## Drone ${drone_id}\n\n*Error calling get_drone_kpis: ${err.message}*`);
                }
            }
            return {
                content: [
                    { type: "text", text: `# Drone KPIs\n\n${sections.join("\n\n")}` },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Drone leaderboard failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_aggregate", "Group-by aggregate over any table. Useful for status histograms, owner breakdowns, monthly trends. Implements GROUP BY client-side over a fetched sample (PostgREST has no native GROUP BY) — for large tables, narrow with `filters` first.", {
        table: z.string().describe("Table to aggregate over"),
        group_by: z.string().describe("Column to group by (e.g. status, prioridad, area, assigned_to)"),
        measure: z.enum(["count", "sum", "avg", "min", "max"]).optional().describe("Aggregate function. Default: count"),
        measure_column: z
            .string()
            .optional()
            .describe("Numeric column to measure (required for sum/avg/min/max, e.g. 'project_amount', 'paneles')"),
        filters: FiltersSchema.describe("Optional row filters applied before grouping"),
        sample_limit: z.number().int().min(100).max(10000).optional().describe("Row sample cap before grouping (default 5000, max 10000)"),
        top: z.number().int().min(1).max(50).optional().describe("Top-N groups to return (default 20)"),
    }, async ({ table, group_by, measure, measure_column, filters, sample_limit, top }) => {
        try {
            requireCredentials();
            const fn = measure ?? "count";
            if (fn !== "count" && !measure_column) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `\`measure_column\` is required for ${fn}. Provide a numeric column like 'project_amount' or 'paneles'.`,
                        },
                    ],
                    isError: true,
                };
            }
            const lim = Math.min(sample_limit ?? 5000, 10000);
            const topN = Math.min(top ?? 20, 50);
            const sel = fn === "count" ? group_by : `${group_by},${measure_column}`;
            const qsParts = [`select=${encodeURIComponent(sel)}`];
            const filterQs = filtersToQs(filters);
            if (filterQs)
                qsParts.push(filterQs);
            qsParts.push(`limit=${lim}`);
            const data = await sbApi(`/${table}?${qsParts.join("&")}`);
            const rows = Array.isArray(data) ? data : [data];
            const groups = {};
            for (const r of rows) {
                const key = r[group_by] === null || r[group_by] === undefined ? "(null)" : String(r[group_by]);
                const slot = (groups[key] ??= []);
                if (fn !== "count") {
                    const n = Number(r[measure_column]);
                    if (!Number.isNaN(n))
                        slot.push(n);
                }
                else {
                    slot.push(1);
                }
            }
            let out = Object.entries(groups).map(([k, arr]) => {
                let value;
                switch (fn) {
                    case "count":
                        value = arr.length;
                        break;
                    case "sum":
                        value = arr.reduce((s, x) => s + x, 0);
                        break;
                    case "avg":
                        value = arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
                        break;
                    case "min":
                        value = arr.length ? Math.min(...arr) : 0;
                        break;
                    case "max":
                        value = arr.length ? Math.max(...arr) : 0;
                        break;
                    default:
                        value = 0;
                }
                return { key: k, value };
            });
            out.sort((a, b) => b.value - a.value);
            out = out.slice(0, topN);
            const valLabel = fn === "count" ? "COUNT" : `${fn.toUpperCase()}(${measure_column})`;
            const tableRows = out
                .map((g) => `| ${g.key} | ${fn === "count" || fn === "min" || fn === "max"
                ? Math.round(g.value).toLocaleString()
                : g.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} |`)
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `## ${valLabel} on \`${table}\` grouped by \`${group_by}\``,
                            `*Sample: ${rows.length}${rows.length === lim ? ` (hit cap ${lim})` : ""} rows, ${Object.keys(groups).length} distinct groups, showing top ${out.length}.*`,
                            "",
                            `| ${group_by} | ${valLabel} |`,
                            `|---|---|`,
                            tableRows,
                        ].join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Aggregate failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // PROJECT / FULL-CONTEXT
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_get_lead", "Combined lead view: lead row + recent crm_activities + stage history + converted project (if any). One-call context dump for analyzing a single lead.", {
        lead_id: z.string().describe("Lead uuid"),
        activity_limit: z.number().int().min(1).max(50).optional().describe("Max crm_activities to include (default 20)"),
    }, async ({ lead_id, activity_limit }) => {
        try {
            requireCredentials();
            const aLim = Math.min(activity_limit ?? 20, 50);
            // 1. Lead
            const leadData = await sbApi(`/leads?id=eq.${encodeURIComponent(lead_id)}&select=*&limit=1`);
            const leadRows = Array.isArray(leadData) ? leadData : [leadData];
            if (leadRows.length === 0) {
                return {
                    content: [{ type: "text", text: `No lead with id ${lead_id}.` }],
                    isError: true,
                };
            }
            const lead = leadRows[0];
            // 2. Activities, history, project — fire in parallel
            const [activities, history, project] = await Promise.all([
                sbApi(`/crm_activities?entity_type=eq.lead&entity_id=eq.${encodeURIComponent(lead_id)}&select=id,activity_type,category,subject,description,performed_by,created_at&order=created_at.desc&limit=${aLim}`).catch(() => []),
                sbApi(`/lead_stage_history?lead_id=eq.${encodeURIComponent(lead_id)}&select=*&order=entered_at.desc&limit=20`).catch(() => []),
                lead.converted_project_id
                    ? sbApi(`/projects?id=eq.${encodeURIComponent(lead.converted_project_id)}&select=*&limit=1`).catch(() => [])
                    : Promise.resolve([]),
            ]);
            const projectRows = Array.isArray(project) ? project : [project];
            // Resolve all referenced user uuids to names in one batch.
            const userIds = new Set();
            if (lead.assigned_to)
                userIds.add(lead.assigned_to);
            if (lead.co_owner_id)
                userIds.add(lead.co_owner_id);
            if (lead.created_by)
                userIds.add(lead.created_by);
            for (const a of Array.isArray(activities) ? activities : [])
                if (a.performed_by)
                    userIds.add(a.performed_by);
            const profileMap = await resolveProfiles([...userIds]);
            const fmtUser = (u) => (u && profileMap.get(u)) || u || "—";
            const enrichedActivities = (Array.isArray(activities) ? activities : []).map((a) => ({
                ...a,
                performed_by: fmtUser(a.performed_by),
            }));
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Lead: ${lead.first_name ?? ""} ${lead.last_name ?? ""} (\`${lead.id}\`)`,
                            `**Status:** ${LEAD_STATUS_LABELS[lead.status] ?? lead.status}  •  **Owner:** ${fmtUser(lead.assigned_to) || "(unassigned)"}  •  **Co-owner:** ${fmtUser(lead.co_owner_id) || "—"}  •  **Source:** ${lead.lead_source ?? "—"}`,
                            `**Created:** ${lead.created_at}  •  **Converted:** ${lead.is_converted ? `yes (${lead.converted_at})` : "no"}`,
                            "",
                            `## Lead row`,
                            "",
                            "```json",
                            JSON.stringify(lead, null, 2),
                            "```",
                            "",
                            `## Stage history (${Array.isArray(history) ? history.length : 0})`,
                            "",
                            renderRecords(Array.isArray(history) ? history : []),
                            "",
                            `## Recent CRM activities (${enrichedActivities.length})`,
                            "",
                            renderRecords(enrichedActivities),
                            "",
                            projectRows.length > 0
                                ? `## Converted project\n\n\`\`\`json\n${JSON.stringify(projectRows[0], null, 2)}\n\`\`\``
                                : "",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Get lead failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // REFERENCE
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_field_mappings", "Reference dump of FuturERP's static knowledge: enum value cheatsheets, RPC catalog by category, SLA rules, key field semantics, Pronto↔Salesforce crosswalk (kept in sync with salesforce-futurenergy MCP).", {
        mapping: z
            .enum([
            "lead_enums",
            "ticket_enums",
            "notification_types",
            "rpc_catalog",
            "sla_rules",
            "key_fields",
            "salesforce_crosswalk",
            "all",
        ])
            .describe("Which reference section to dump"),
    }, async ({ mapping }) => {
        const sections = [];
        if (mapping === "lead_enums" || mapping === "all") {
            sections.push([
                "## Lead enums",
                "",
                `**status** (lead.status, text):  ${LEAD_STATUS_VALUES.map((s) => `\`${s}\``).join(", ")}`,
                "",
                `**lead_qualification** (system-computed):  ${LEAD_QUALIFICATION_VALUES.map((v) => `\`${v}\``).join(", ")}`,
                "",
                `**vendor_qualification** (manual override):  ${VENDOR_QUALIFICATION_VALUES.map((v) => `\`${v}\``).join(", ")}`,
                "",
                `**program**:  ${LEAD_PROGRAM_VALUES.map((v) => `\`${v}\``).join(", ")}`,
                "",
                `**crm_activities.activity_type**:  ${CRM_ACTIVITY_TYPES.map((v) => `\`${v}\``).join(", ")}`,
                "",
                `**crm_activities.category**:  ${CRM_ACTIVITY_CATEGORIES.map((v) => `\`${v}\``).join(", ")}`,
            ].join("\n"));
        }
        if (mapping === "ticket_enums" || mapping === "all") {
            const te = PRONTO_ENUMS.filter((e) => e.name.startsWith("ticket_") || e.name === "activity_type");
            const block = te
                .map((e) => `**${e.name}**: ${e.values.map((v) => `\`${v}\`${e.labels?.[v] ? ` (${e.labels[v]})` : ""}`).join(", ")}`)
                .join("\n\n");
            sections.push(`## Ticket enums\n\n${block}`);
        }
        if (mapping === "notification_types" || mapping === "all") {
            const nt = PRONTO_ENUMS.find((e) => e.name === "notification_type");
            sections.push(`## Notification types (${nt.values.length})\n\n${nt.values.map((v) => `- \`${v}\``).join("\n")}`);
        }
        if (mapping === "rpc_catalog" || mapping === "all") {
            const grouped = getRpcsByCategory();
            const block = Object.entries(grouped)
                .map(([cat, list]) => `### ${cat}\n${list
                .map((r) => `- \`${r.name}\`${r.mutating ? " (mutating)" : ""} — ${r.purpose}`)
                .join("\n")}`)
                .join("\n\n");
            sections.push(`## RPC catalog\n\n${block}`);
        }
        if (mapping === "sla_rules" || mapping === "all") {
            const block = Object.entries(TICKET_PRIORITY_SLA_DAYS)
                .map(([p, d]) => `- **${p}** — ${d} día(s) laboral(es) (${d * 8} horas)`)
                .join("\n");
            sections.push(`## Ticket SLA rules (priority → deadline)\n\n${block}`);
        }
        if (mapping === "key_fields" || mapping === "all") {
            const block = Object.entries(KEY_FIELDS)
                .map(([t, fields]) => {
                const rows = Object.entries(fields)
                    .map(([f, doc]) => `- **${f}** — ${doc}`)
                    .join("\n");
                return `### ${t}\n${rows}`;
            })
                .join("\n\n");
            sections.push(`## Key fields per entity\n\n${block}`);
        }
        if (mapping === "salesforce_crosswalk" || mapping === "all") {
            const vt = Object.entries(VT_TO_SF_FIELD_MAP)
                .map(([v, s]) => `| ${v} | \`${s}\` |`)
                .join("\n");
            const photo = Object.entries(PHOTO_TO_DOCUMENT_MAP)
                .map(([c, d]) => `| ${c} | ${d} |`)
                .join("\n");
            sections.push([
                "## Pronto ↔ Salesforce crosswalk",
                "",
                "*Kept in sync with the salesforce-futurenergy MCP. Update both schemas together.*",
                "",
                "### Visita Tecnica → Opportunity",
                "",
                `| Pronto VT field | Salesforce field |`,
                `|---|---|`,
                vt,
                "",
                "### Photo category → Documento__c name",
                "",
                `| Pronto category | Salesforce document |`,
                `|---|---|`,
                photo,
                "",
                "### Account email priority",
                "",
                ACCOUNT_EMAIL_FIELDS.map((f, i) => `${i + 1}. \`${f}\``).join("\n"),
            ].join("\n"));
        }
        return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
    });
    // ────────────────────────────────────────────────────────────
    // FILES & DOCUMENTS
    // ────────────────────────────────────────────────────────────
    const FileEntityEnum = z.enum(FILE_ENTITY_TYPES);
    server.tool("futurerp_list_files", "List files/photos attached to a parent record. Polymorphic across entity types: project, lead, instalacion, visita, inventory_movement, announcement, cantina. Returns metadata + the direct download URL (Firebase public URLs for most; Google Drive for announcements and cantina).", {
        entity_type: FileEntityEnum.describe("What the files are attached to. One of: project, lead, instalacion, visita, inventory_movement, announcement, cantina."),
        parent_id: z.string().describe("Parent record uuid"),
        limit: z.number().int().min(1).max(200).optional().describe("Max files (default 50, max 200)"),
    }, async ({ entity_type, parent_id, limit }) => {
        try {
            requireCredentials();
            const spec = FILE_TABLES[entity_type];
            if (!spec) {
                return {
                    content: [{ type: "text", text: `Unknown entity_type '${entity_type}'.` }],
                    isError: true,
                };
            }
            const lim = Math.min(limit ?? 50, 200);
            const createdCol = spec.created ?? "created_at";
            const cols = [
                "id",
                spec.fk,
                spec.url,
                spec.filename,
                spec.size,
                spec.mime,
                spec.extension,
                spec.uploader,
                spec.category,
                spec.subcategory,
                spec.thumbnail,
                createdCol,
            ]
                .filter(Boolean)
                .join(",");
            const data = await sbApi(`/${spec.table}?${encodeURIComponent(spec.fk)}=eq.${encodeURIComponent(parent_id)}&select=${encodeURIComponent(cols)}&order=${createdCol}.desc&limit=${lim}`);
            const rows = Array.isArray(data) ? data : [data];
            if (rows.length === 0) {
                return {
                    content: [
                        { type: "text", text: `No files in \`${spec.table}\` for ${spec.fk} = '${parent_id}'.` },
                    ],
                };
            }
            const lines = rows.map((r) => {
                const url = r[spec.url];
                const name = r[spec.filename] ?? "(unnamed)";
                const sizeKb = spec.size && r[spec.size] ? `${(r[spec.size] / 1024).toFixed(1)} KB` : "";
                const mime = spec.mime && r[spec.mime] ? r[spec.mime] : "";
                const cat = spec.category && r[spec.category] ? `[${r[spec.category]}${spec.subcategory && r[spec.subcategory] ? "/" + r[spec.subcategory] : ""}]` : "";
                const meta = [mime, sizeKb, cat].filter(Boolean).join(" • ");
                return `- ${cat ? cat + " " : ""}**${name}**${meta ? ` — ${meta}` : ""}\n  ${url ?? "*(no url)*"}`;
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `## Files for ${entity_type} \`${parent_id}\` (${rows.length})\n\n*Source table:* \`${spec.table}\`${spec.notes ? `  •  ${spec.notes}` : ""}\n\n${lines.join("\n")}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `List files failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_download_file", "Fetch a file by its public URL (Firebase Storage public URL or Google Drive web_content_link) and return its metadata (content type, size). For text-like files (text/*, JSON, XML) up to 200 KB the content is returned inline; for anything else use the returned URL directly (this server is remote and cannot write to your disk).", {
        url: z.string().url().describe("Direct download URL from futurerp_list_files (firebase_url / web_content_link / etc.)"),
    }, async ({ url }) => {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`Download ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const mime = res.headers.get("content-type") ?? "application/octet-stream";
            const textLike = /^(text\/|application\/(json|xml|x-yaml|yaml))/i.test(mime);
            const sizeKB = (buf.length / 1024).toFixed(1);
            const lines = [
                `## File`,
                ``,
                `- **URL:** ${url}`,
                `- **Size:** ${sizeKB} KB`,
                `- **MIME:** ${mime}`,
            ];
            if (textLike && buf.length <= 200 * 1024) {
                lines.push(``, "```", buf.toString("utf8"), "```");
            }
            else if (textLike) {
                lines.push(``, `_Text file larger than 200 KB — open the URL directly._`);
            }
            else {
                lines.push(``, `_Binary file — open the URL directly (Claude can't receive the bytes through this tool)._`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Download failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // CONTEXT DUMPS (ticket / project / instalacion)
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_get_ticket", "Combined ticket view: ticket row + ticket_activities (latest N) + linked project / lead / cliente. One-call context dump for analyzing a ticket.", {
        ticket_id: z.string().describe("Ticket id (uuid) or folio (e.g. EFU-00514-1)"),
        activity_limit: z.number().int().min(1).max(100).optional().describe("Max activities (default 30)"),
    }, async ({ ticket_id, activity_limit }) => {
        try {
            requireCredentials();
            const aLim = Math.min(activity_limit ?? 30, 100);
            // Accept either uuid or folio
            const idLooksLikeUuid = UUID_RX.test(ticket_id);
            const lookupCol = idLooksLikeUuid ? "id" : "folio";
            const ticketRows = await sbApi(`/tickets?${lookupCol}=eq.${encodeURIComponent(ticket_id)}&select=*&limit=1`);
            if (!Array.isArray(ticketRows) || ticketRows.length === 0) {
                return {
                    content: [{ type: "text", text: `No ticket where ${lookupCol} = '${ticket_id}'.` }],
                    isError: true,
                };
            }
            const t = ticketRows[0];
            // Parallel fan-out
            const [activities, project, lead, cliente] = await Promise.all([
                sbApi(`/ticket_activities?ticket_id=eq.${encodeURIComponent(t.id)}&select=*&order=created_at.desc&limit=${aLim}`).catch(() => []),
                t.project_id
                    ? sbApi(`/projects?id=eq.${encodeURIComponent(t.project_id)}&select=id,efu,description,etapa_tramite,client_id,amount&limit=1`).catch(() => [])
                    : Promise.resolve([]),
                t.lead_id
                    ? sbApi(`/leads?id=eq.${encodeURIComponent(t.lead_id)}&select=id,first_name,last_name,status,assigned_to,phone,email&limit=1`).catch(() => [])
                    : Promise.resolve([]),
                t.cliente_id
                    ? sbApi(`/clients?id=eq.${encodeURIComponent(t.cliente_id)}&select=*&limit=1`).catch(() => [])
                    : Promise.resolve([]),
            ]);
            const projectRow = Array.isArray(project) && project[0];
            const leadRow = Array.isArray(lead) && lead[0];
            const clienteRow = Array.isArray(cliente) && cliente[0];
            // Resolve all referenced user uuids to names.
            const userIds = new Set();
            if (t.created_by)
                userIds.add(t.created_by);
            for (const u of t.responsables_ids ?? [])
                if (u)
                    userIds.add(u);
            for (const a of Array.isArray(activities) ? activities : [])
                if (a.user_id)
                    userIds.add(a.user_id);
            const profileMap = await resolveProfiles([...userIds]);
            const fmtUser = (u) => (u && profileMap.get(u)) || u || "—";
            const responsablesDisplay = Array.isArray(t.responsables_ids) && t.responsables_ids.length > 0
                ? t.responsables_ids.map((u) => fmtUser(u)).join(", ")
                : (t.responsables ?? []).join(", ") || t.responsable || "(sin asignar)";
            const enrichedActivities = (Array.isArray(activities) ? activities : []).map((a) => ({
                ...a,
                user_id: fmtUser(a.user_id),
            }));
            // SLA status
            const overdue = t.fecha_vencimiento && new Date(t.fecha_vencimiento).getTime() < Date.now() && t.estado !== "resuelto";
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Ticket ${t.folio}  (\`${t.id}\`)`,
                            `**Estado:** ${t.estado}  •  **Prioridad:** ${t.prioridad}  •  **Canal:** ${t.canal}  •  **Área:** ${t.area}`,
                            `**Responsable(s):** ${responsablesDisplay}  •  **Creado por:** ${fmtUser(t.created_by)}`,
                            `**Creado:** ${t.fecha_creacion}  •  **Vence:** ${t.fecha_vencimiento}${overdue ? "  ⚠️ **OVERDUE**" : ""}`,
                            "",
                            `## Asunto`,
                            `${t.asunto}`,
                            "",
                            `## Descripción`,
                            `${t.descripcion ?? "*(none)*"}`,
                            t.notas_internas ? `\n## Notas internas\n${t.notas_internas}` : "",
                            "",
                            `## Activity (${enrichedActivities.length})`,
                            "",
                            renderRecords(enrichedActivities),
                            "",
                            projectRow
                                ? `## Linked project\n\n\`\`\`json\n${JSON.stringify(projectRow, null, 2)}\n\`\`\``
                                : "",
                            leadRow
                                ? `## Linked lead\n\n\`\`\`json\n${JSON.stringify(leadRow, null, 2)}\n\`\`\``
                                : "",
                            clienteRow
                                ? `## Linked cliente\n\n\`\`\`json\n${JSON.stringify(clienteRow, null, 2)}\n\`\`\``
                                : "",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Get ticket failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_get_project", "Combined project view: project row + project_files + project_tramites + project_scheduled_payments + related instalaciones + recent expenses. One-call deep dive on a project.", {
        project_id: z.string().describe("Project uuid or EFU code (e.g. EFU-00514-1)"),
    }, async ({ project_id }) => {
        try {
            requireCredentials();
            const idLooksLikeUuid = UUID_RX.test(project_id);
            const lookupCol = idLooksLikeUuid ? "id" : "efu";
            const projectRows = await sbApi(`/projects?${lookupCol}=eq.${encodeURIComponent(project_id)}&select=*&limit=1`);
            if (!Array.isArray(projectRows) || projectRows.length === 0) {
                return {
                    content: [{ type: "text", text: `No project where ${lookupCol} = '${project_id}'.` }],
                    isError: true,
                };
            }
            const p = projectRows[0];
            const [files, tramites, payments, instalaciones, expenses, client] = await Promise.all([
                sbApi(`/project_files?project_id=eq.${encodeURIComponent(p.id)}&select=id,file_name,mime_type,file_size,firebase_url,uploaded_by,created_at&order=created_at.desc&limit=50`).catch(() => []),
                sbApi(`/project_tramites?project_id=eq.${encodeURIComponent(p.id)}&select=*&order=created_at.desc&limit=50`).catch(() => []),
                sbApi(`/project_scheduled_payments?project_id=eq.${encodeURIComponent(p.id)}&select=*&order=fecha_comprometida.asc&limit=50`).catch(() => []),
                sbApi(`/instalaciones?project_id=eq.${encodeURIComponent(p.id)}&select=id,folio,estado,fecha_instalacion,cuadrilla_id,numero_paneles&order=fecha_instalacion.desc&limit=20`).catch(() => []),
                sbApi(`/project_expenses?project_id=eq.${encodeURIComponent(p.id)}&select=id,category,amount_total,status,approved_at,paid_at,created_at&order=created_at.desc&limit=50`).catch(() => []),
                p.client_id
                    ? sbApi(`/clients?id=eq.${encodeURIComponent(p.client_id)}&select=*&limit=1`).catch(() => [])
                    : Promise.resolve([]),
            ]);
            const clientRow = Array.isArray(client) && client[0];
            const fileRows = Array.isArray(files) ? files : [];
            const tramiteRows = Array.isArray(tramites) ? tramites : [];
            const paymentRows = Array.isArray(payments) ? payments : [];
            const instRows = Array.isArray(instalaciones) ? instalaciones : [];
            const expRows = Array.isArray(expenses) ? expenses : [];
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Project ${p.efu ?? p.id}  (\`${p.id}\`)`,
                            `**Stage:** ${p.etapa_tramite ?? "—"}  •  **Amount:** ${p.amount ?? 0}  •  **Commission total:** ${p.comision_total ?? 0}`,
                            `**Created:** ${p.created_at}  •  **Close date:** ${p.close_date ?? "—"}`,
                            "",
                            `## Project row`,
                            "",
                            "```json",
                            JSON.stringify(p, null, 2),
                            "```",
                            "",
                            clientRow
                                ? `## Client\n\n\`\`\`json\n${JSON.stringify(clientRow, null, 2)}\n\`\`\``
                                : "",
                            "",
                            `## Instalaciones (${instRows.length})`,
                            "",
                            renderRecords(instRows),
                            "",
                            `## Trámites (${tramiteRows.length})`,
                            "",
                            renderRecords(tramiteRows),
                            "",
                            `## Scheduled payments (${paymentRows.length})`,
                            "",
                            renderRecords(paymentRows),
                            "",
                            `## Recent expenses (${expRows.length})`,
                            "",
                            renderRecords(expRows),
                            "",
                            `## Files (${fileRows.length})`,
                            "",
                            fileRows.length === 0
                                ? "*No files.*"
                                : fileRows
                                    .map((f) => `- **${f.file_name}** — ${f.mime_type ?? "?"} • ${f.file_size ? (f.file_size / 1024).toFixed(1) + " KB" : "?"}\n  ${f.firebase_url ?? "*(no url)*"}`)
                                    .join("\n"),
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Get project failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_get_instalacion", "Combined instalacion view: instalacion row + photos (instalacion_fotos) + line items + installation_reports + visit log (check-in/out) + assigned cuadrilla profiles.", {
        instalacion_id: z.string().describe("Instalacion uuid or folio"),
    }, async ({ instalacion_id }) => {
        try {
            requireCredentials();
            const idLooksLikeUuid = UUID_RX.test(instalacion_id);
            // instalaciones has no `folio` column — the human-readable identifier is `efu`.
            const lookupCol = idLooksLikeUuid ? "id" : "efu";
            const rows = await sbApi(`/instalaciones?${lookupCol}=eq.${encodeURIComponent(instalacion_id)}&select=*&limit=1`);
            if (!Array.isArray(rows) || rows.length === 0) {
                return {
                    content: [{ type: "text", text: `No instalacion where ${lookupCol} = '${instalacion_id}'.` }],
                    isError: true,
                };
            }
            const inst = rows[0];
            const [fotos, lineItems, reports, visits, crew] = await Promise.all([
                sbApi(`/instalacion_fotos?instalacion_id=eq.${encodeURIComponent(inst.id)}&select=id,url,file_name,category,subcategory,ai_validation_status,created_at&order=created_at.desc&limit=100`).catch(() => []),
                sbApi(`/instalacion_line_items?instalacion_id=eq.${encodeURIComponent(inst.id)}&select=*&limit=100`).catch(() => []),
                sbApi(`/installation_reports?instalacion_id=eq.${encodeURIComponent(inst.id)}&select=*&order=created_at.desc&limit=20`).catch(() => []),
                sbApi(`/installation_visits?instalacion_id=eq.${encodeURIComponent(inst.id)}&select=*&order=check_in_time.asc&limit=20`).catch(() => []),
                Array.isArray(inst.assigned_to) && inst.assigned_to.length > 0
                    ? sbApi(`/profiles?user_id=in.(${inst.assigned_to.map((u) => encodeURIComponent(u)).join(",")})&select=user_id,first_name,last_name,email,department`).catch(() => [])
                    : Promise.resolve([]),
            ]);
            const crewRows = Array.isArray(crew) ? crew : [];
            const crewWithNames = crewRows.map((p) => ({
                ...p,
                name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || p.id,
            }));
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Instalacion ${inst.efu ?? inst.id}  (\`${inst.id}\`)`,
                            `**Status:** ${inst.status ?? "—"}  •  **Fecha:** ${inst.fecha_instalacion ?? "—"}  •  **Paneles:** ${inst.numero_paneles ?? "?"}  •  **Cuadrilla:** ${inst.cuadrilla_id ?? "(sin asignar)"}`,
                            `**Cliente:** ${inst.nombre_cliente ?? "—"}  •  **Check-in:** ${inst.check_in_time ?? "(no)"}  •  **Check-out:** ${inst.check_out_time ?? "(no)"}`,
                            "",
                            `## Cuadrilla / installers (${crewWithNames.length})`,
                            "",
                            renderRecords(crewWithNames),
                            "",
                            `## Visits (check-in/out) (${Array.isArray(visits) ? visits.length : 0})`,
                            "",
                            renderRecords(Array.isArray(visits) ? visits : []),
                            "",
                            `## Photos (${Array.isArray(fotos) ? fotos.length : 0})`,
                            "",
                            Array.isArray(fotos) && fotos.length > 0
                                ? fotos
                                    .map((f) => `- [${f.category}${f.subcategory ? "/" + f.subcategory : ""}] **${f.file_name ?? "(unnamed)"}** ${f.ai_validation_status ? `(AI: ${f.ai_validation_status})` : ""}\n  ${f.url}`)
                                    .join("\n")
                                : "*No photos.*",
                            "",
                            `## Line items / BOM (${Array.isArray(lineItems) ? lineItems.length : 0})`,
                            "",
                            renderRecords(Array.isArray(lineItems) ? lineItems : []),
                            "",
                            `## Installation reports (${Array.isArray(reports) ? reports.length : 0})`,
                            "",
                            renderRecords(Array.isArray(reports) ? reports : []),
                            "",
                            `## Instalacion row`,
                            "",
                            "```json",
                            JSON.stringify(inst, null, 2),
                            "```",
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Get instalacion failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // PROJECT FINANCIALS
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_get_project_financials", "Rolled-up project P&L: budget, total expenses (approved/paid/pending), scheduled vs received payments, overdue payments, gross margin. Numbers in MXN.", {
        project_id: z.string().describe("Project uuid or EFU code"),
    }, async ({ project_id }) => {
        try {
            requireCredentials();
            const idLooksLikeUuid = UUID_RX.test(project_id);
            const lookupCol = idLooksLikeUuid ? "id" : "efu";
            const projectRows = await sbApi(`/projects?${lookupCol}=eq.${encodeURIComponent(project_id)}&select=id,efu,amount,comision_total,egreso_total,ingreso_total&limit=1`);
            if (!Array.isArray(projectRows) || projectRows.length === 0) {
                return {
                    content: [{ type: "text", text: `No project where ${lookupCol} = '${project_id}'.` }],
                    isError: true,
                };
            }
            const p = projectRows[0];
            const [expenses, payments] = await Promise.all([
                sbApi(`/project_expenses?project_id=eq.${encodeURIComponent(p.id)}&select=category,amount_total,status,approved_at,paid_at&limit=500`).catch(() => []),
                sbApi(`/project_scheduled_payments?project_id=eq.${encodeURIComponent(p.id)}&select=monto,estado_pago,status,fecha_comprometida,fecha_pago_recibido&limit=500`).catch(() => []),
            ]);
            const expRows = Array.isArray(expenses) ? expenses : [];
            const payRows = Array.isArray(payments) ? payments : [];
            const expApproved = expRows.filter((e) => e.approved_at);
            const expPaid = expRows.filter((e) => e.paid_at);
            const expPending = expRows.filter((e) => !e.approved_at);
            const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
            const expensesApproved = sum(expApproved, "amount_total");
            const expensesPaid = sum(expPaid, "amount_total");
            const expensesPending = sum(expPending, "amount_total");
            const expensesTotal = sum(expRows, "amount_total");
            const byCategory = {};
            for (const e of expRows)
                byCategory[e.category ?? "—"] = (byCategory[e.category ?? "—"] ?? 0) + (Number(e.amount_total) || 0);
            const now = Date.now();
            const paymentsScheduled = sum(payRows, "monto");
            const paymentsReceived = sum(payRows.filter((p) => p.fecha_pago_recibido), "monto");
            const paymentsOverdue = payRows
                .filter((p) => !p.fecha_pago_recibido &&
                p.fecha_comprometida &&
                new Date(p.fecha_comprometida).getTime() < now)
                .reduce((s, r) => s + (Number(r.monto) || 0), 0);
            const revenue = Number(p.ingreso_total) || Number(p.amount) || 0;
            const grossMargin = revenue - expensesTotal;
            const marginPct = revenue > 0 ? (grossMargin / revenue) * 100 : 0;
            const status = grossMargin < 0 ? "negative" : marginPct < 10 ? "tight" : "healthy";
            const fmt = (n) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
            const catRows = Object.entries(byCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `| ${k} | ${fmt(v)} |`)
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `# Project Financials — ${p.efu ?? p.id}`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Project amount (budget) | ${fmt(Number(p.amount) || 0)} |`,
                            `| Commission total | ${fmt(Number(p.comision_total) || 0)} |`,
                            `| Revenue (ingreso_total or amount) | ${fmt(revenue)} |`,
                            `| Recorded egreso_total | ${fmt(Number(p.egreso_total) || 0)} |`,
                            "",
                            `## Expenses (${expRows.length} rows)`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Approved total | ${fmt(expensesApproved)} |`,
                            `| Paid total | ${fmt(expensesPaid)} |`,
                            `| Pending approval | ${fmt(expensesPending)} |`,
                            `| All expenses total | ${fmt(expensesTotal)} |`,
                            "",
                            `### By category`,
                            "",
                            `| Category | Total |`,
                            `|----------|-------|`,
                            catRows || "| — | — |",
                            "",
                            `## Payments (${payRows.length} rows)`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Scheduled total | ${fmt(paymentsScheduled)} |`,
                            `| Received total | ${fmt(paymentsReceived)} |`,
                            `| Overdue (committed date < now, not received) | **${fmt(paymentsOverdue)}** |`,
                            "",
                            `## Margin`,
                            "",
                            `| Metric | Value |`,
                            `|--------|-------|`,
                            `| Gross margin (revenue − expenses) | ${fmt(grossMargin)} |`,
                            `| Margin % | ${marginPct.toFixed(1)}% |`,
                            `| Status | **${status}** |`,
                        ].join("\n"),
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Financials failed: ${e.message}` }], isError: true };
        }
    });
    // ────────────────────────────────────────────────────────────
    // RPC WRAPPERS (named convenience tools)
    // ────────────────────────────────────────────────────────────
    server.tool("futurerp_sales_ranking", "Sales leaderboard via `get_sales_ranking` RPC. Returns ranked users by closed amount + project count over a period.", {
        period_start: z.string().optional().describe("ISO date start (e.g. 2026-05-01). Defaults: 90 days ago"),
        period_end: z.string().optional().describe("ISO date end. Defaults: now"),
    }, async ({ period_start, period_end }) => {
        try {
            requireCredentials();
            const start = period_start ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const end = period_end ?? new Date().toISOString().slice(0, 10);
            const rows = await sbRpc("get_sales_ranking", { p_period_start: start, p_period_end: end });
            if (!Array.isArray(rows) || rows.length === 0) {
                return { content: [{ type: "text", text: `No sales activity ${start} → ${end}.` }] };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `## Sales ranking ${start} → ${end} (${rows.length})\n\n${renderRecords(rows)}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Sales ranking failed: ${e.message}` }], isError: true };
        }
    });
    server.tool("futurerp_marketing_stats", "Marketing attribution via `get_marketing_lead_stats` RPC. Returns lead counts + conversion by source/program/status over a date range.", {
        range_start: z.string().optional().describe("ISO date start (defaults: 30 days ago)"),
        range_end: z.string().optional().describe("ISO date end (defaults: now)"),
    }, async ({ range_start, range_end }) => {
        try {
            requireCredentials();
            const args = {};
            if (range_start)
                args.range_start = range_start;
            if (range_end)
                args.range_end = range_end;
            const rows = await sbRpc("get_marketing_lead_stats", args);
            if (!Array.isArray(rows) || rows.length === 0) {
                return { content: [{ type: "text", text: `No marketing data for the range.` }] };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `## Marketing lead stats (${rows.length})\n\n${renderRecords(rows)}`,
                    },
                ],
            };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Marketing stats failed: ${e.message}` }], isError: true };
        }
    });
    const WA_CHANNEL_LABELS = {
        whatsapp: "WhatsApp",
        instagram: "Instagram",
        facebook: "Messenger",
        tiktok: "TikTok",
    };
    const WhatsAppChannelEnum = z.enum(["whatsapp", "instagram", "facebook", "tiktok"]);
    function pendingMsgCounts(messages) {
        const arr = Array.isArray(messages) ? messages : [];
        let inN = 0, outN = 0, last;
        for (const m of arr) {
            if (m?.dir === "in")
                inN++;
            else if (m?.dir === "out")
                outN++;
            if (m?.ts && (!last || m.ts > last))
                last = m.ts;
        }
        return { in: inN, out: outN, last };
    }
    const fmtTs = (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");
    const clip = (v, n = 60) => {
        const s = String(v ?? "").replace(/\s+/g, " ").trim();
        return s.length > n ? s.slice(0, n - 1) + "…" : s;
    };
    if (can("mcp.whatsapp")) {
        server.tool("futurerp_whatsapp_chats", "Overview of WhatsApp/Messenger/Instagram/TikTok bot conversations: pre-lead pending contacts (with in/out message counts, triage, lifecycle status) and leads with recent bot activity (last inbound/outbound, escalation, intent). Use futurerp_whatsapp_conversation to open a full thread.", {
            source: z.enum(["pending", "leads", "all"]).optional().describe("Which conversations to list. Default: all"),
            channel: WhatsAppChannelEnum.optional().describe("Filter by bot channel"),
            days: z.number().optional().describe("Only conversations with activity in the last N days. Default: 7"),
            limit: z.number().optional().describe("Max rows per section (default 30, max 100)"),
            only_escalated: z.boolean().optional().describe("Only leads the bot escalated to a human (bot_escalation_reason set)"),
            status: z
                .enum(["active", "lead", "discarded", "opted_out", "human_owned"])
                .optional()
                .describe("Filter pending contacts by lifecycle status"),
        }, async ({ source, channel, days, limit, only_escalated, status }) => {
            try {
                requireCredentials();
                const src = source ?? "all";
                const lim = Math.min(limit ?? 30, 100);
                const since = new Date(Date.now() - (days ?? 7) * 24 * 60 * 60 * 1000).toISOString();
                const sections = [];
                if (src !== "leads") {
                    let qs = `updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=${lim}`;
                    qs += `&select=respond_contact_id,channel,phone,contact_name,tipo_contacto,status,status_reason,lead_id,messages,nudges,last_inbound_at,updated_at,created_at`;
                    if (channel)
                        qs += `&channel=eq.${channel}`;
                    if (status)
                        qs += `&status=eq.${status}`;
                    const rows = await sbApi(`/whatsapp_pending_contacts?${qs}`);
                    const table = rows.map((r) => {
                        const c = pendingMsgCounts(r.messages);
                        return {
                            contacto: r.contact_name || r.phone || r.respond_contact_id,
                            canal: WA_CHANNEL_LABELS[r.channel] ?? r.channel,
                            in: c.in,
                            out: c.out,
                            tipo: r.tipo_contacto,
                            status: r.status + (r.status_reason ? ` (${r.status_reason})` : ""),
                            "última actividad": fmtTs(r.updated_at),
                            respond_contact_id: r.respond_contact_id,
                            lead_id: r.lead_id ?? "",
                        };
                    });
                    sections.push(renderRecords(table, `## Pending contacts (pre-lead) — ${rows.length}`, 9));
                }
                if (src !== "pending") {
                    let qs = `or=(whatsapp_last_inbound_at.gte.${since},whatsapp_last_outbound_at.gte.${since})`;
                    qs += `&order=whatsapp_last_inbound_at.desc.nullslast&limit=${lim}`;
                    qs += `&select=id,first_name,last_name,mobile_phone_e164,status,whatsapp_bot_active,whatsapp_last_inbound_at,whatsapp_last_outbound_at,bot_escalation_reason,intent_detected,interest_level`;
                    if (only_escalated)
                        qs += `&bot_escalation_reason=not.is.null`;
                    const rows = await sbApi(`/leads?${qs}`);
                    const table = rows.map((r) => ({
                        lead: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.id,
                        tel: r.mobile_phone_e164 ?? "",
                        etapa: r.status,
                        bot: r.whatsapp_bot_active === false ? "off" : "on",
                        "últ. inbound": fmtTs(r.whatsapp_last_inbound_at),
                        "últ. outbound": fmtTs(r.whatsapp_last_outbound_at),
                        escalación: r.bot_escalation_reason ?? "",
                        "intent/interés": [r.intent_detected, r.interest_level].filter(Boolean).join(" / "),
                        lead_id: r.id,
                    }));
                    sections.push(renderRecords(table, `## Leads con actividad de bot — ${rows.length}`, 9));
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `# WhatsApp chats (últimos ${days ?? 7} días${channel ? `, ${WA_CHANNEL_LABELS[channel]}` : ""})\n\n${sections.join("\n\n")}`,
                        },
                    ],
                };
            }
            catch (e) {
                return { content: [{ type: "text", text: `WhatsApp chats failed: ${e.message}` }], isError: true };
            }
        });
        server.tool("futurerp_whatsapp_conversation", "Full message thread for one WhatsApp bot contact — capture-phase messages (whatsapp_pending_contacts) plus lead-phase messages (crm_activities), rendered chronologically with direction and sender (bot / agente / cliente). Identify the contact by lead_id, respond_contact_id, or phone.", {
            lead_id: z.string().optional().describe("Lead uuid"),
            respond_contact_id: z.string().optional().describe("whatsapp_pending_contacts PK (Respond.io contact id or phone:<e164>)"),
            phone: z.string().optional().describe("Phone number (any format — matched against leads.mobile_phone_e164 and pending_contacts.phone)"),
            limit: z.number().optional().describe("Max lead-phase activity rows (default 100, max 300)"),
        }, async ({ lead_id, respond_contact_id, phone, limit }) => {
            try {
                requireCredentials();
                if (!lead_id && !respond_contact_id && !phone) {
                    throw new Error("Provide one of: lead_id, respond_contact_id, phone.");
                }
                const lim = Math.min(limit ?? 100, 300);
                // ── Resolve to a lead row and/or a pending row ──
                let lead = null;
                let pending = null;
                const pendingSelect = "select=respond_contact_id,channel,phone,contact_name,captured,tipo_contacto,status,status_reason,lead_id,messages,nudges,created_at,updated_at";
                if (phone && !lead_id && !respond_contact_id) {
                    const digits = phone.replace(/\D/g, "").slice(-10); // last 10 digits — MX local
                    const leads = await sbApi(`/leads?mobile_phone_e164=ilike.${encodeURIComponent(`*${digits}*`)}&select=*&limit=2`);
                    lead = leads[0] ?? null;
                    if (!lead) {
                        const pend = await sbApi(`/whatsapp_pending_contacts?phone=ilike.${encodeURIComponent(`*${digits}*`)}&${pendingSelect}&limit=2`);
                        pending = pend[0] ?? null;
                    }
                    if (!lead && !pending)
                        throw new Error(`No lead or pending contact matches phone ${phone}.`);
                }
                if (respond_contact_id) {
                    const pend = await sbApi(`/whatsapp_pending_contacts?respond_contact_id=eq.${encodeURIComponent(respond_contact_id)}&${pendingSelect}`);
                    pending = pend[0] ?? null;
                    if (!pending)
                        throw new Error(`No pending contact ${respond_contact_id}.`);
                    if (pending.lead_id)
                        lead_id = pending.lead_id;
                }
                if (lead_id && !lead) {
                    const rows = await sbApi(`/leads?id=eq.${encodeURIComponent(lead_id)}&select=*`);
                    lead = rows[0] ?? null;
                    if (!lead)
                        throw new Error(`No lead ${lead_id}.`);
                }
                // A promoted lead's capture conversation lives on its pending row — merge it in.
                if (lead && !pending) {
                    const pend = await sbApi(`/whatsapp_pending_contacts?lead_id=eq.${lead.id}&${pendingSelect}&limit=1`);
                    pending = pend[0] ?? null;
                }
                // ── Header ──
                const header = [];
                if (lead) {
                    header.push(`**Lead:** ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.id} (\`${lead.id}\`)`, `**Tel:** ${lead.mobile_phone_e164 ?? lead.phone ?? "—"} · **Etapa:** ${lead.status} · **Bot:** ${lead.whatsapp_bot_active === false ? "apagado" : "activo"}`);
                    if (lead.intent_detected || lead.interest_level)
                        header.push(`**Intent:** ${lead.intent_detected ?? "—"} · **Interés:** ${lead.interest_level ?? "—"}`);
                    if (lead.bot_escalation_reason)
                        header.push(`**Escalado:** ${lead.bot_escalation_reason}`);
                    if (lead.bot_conversation_summary)
                        header.push(`**Resumen del bot:** ${lead.bot_conversation_summary}`);
                }
                if (pending) {
                    header.push(`**Pending contact:** ${pending.contact_name ?? pending.phone ?? pending.respond_contact_id} (\`${pending.respond_contact_id}\`) · **Canal:** ${WA_CHANNEL_LABELS[pending.channel] ?? pending.channel} · **Triage:** ${pending.tipo_contacto} · **Status:** ${pending.status}${pending.status_reason ? ` (${pending.status_reason})` : ""}`);
                    const capturedKeys = Object.keys(pending.captured ?? {});
                    if (capturedKeys.length)
                        header.push(`**Capturado:** ${capturedKeys.join(", ")}`);
                }
                // ── Thread ──
                const lines = [];
                // At promotion the capture messages are replayed onto the lead's crm_activities,
                // so rendering both sections would duplicate the whole capture phase.
                const capturaReplayed = !!(lead && pending?.lead_id === lead.id);
                const pendMsgs = !capturaReplayed && Array.isArray(pending?.messages) ? pending.messages : [];
                if (pendMsgs.length) {
                    lines.push(`### Fase de captura (${pendMsgs.length} mensajes)`);
                    for (const m of pendMsgs) {
                        lines.push(`- ${fmtTs(m.ts)} ${m.dir === "in" ? "⬅️ **cliente**" : "➡️ bot"}: ${clip(m.text, 500)}`);
                    }
                }
                if (lead) {
                    const acts = await sbApi(`/crm_activities?entity_type=eq.lead&entity_id=eq.${lead.id}&activity_type=eq.whatsapp&order=created_at.asc&select=id,description,metadata,created_at&limit=${lim}`);
                    if (acts.length) {
                        lines.push("", `### Conversación como lead (${acts.length} actividades)`);
                        for (const a of acts) {
                            const meta = a.metadata ?? {};
                            const ts = fmtTs(a.created_at);
                            const emitted = !!(meta.mensaje_cliente || meta.mensaje_bot);
                            if (meta.mensaje_cliente)
                                lines.push(`- ${ts} ⬅️ **cliente**: ${clip(meta.mensaje_cliente, 500)}`);
                            if (meta.mensaje_bot) {
                                const sender = meta.status === "agente" ? "**agente**" : "bot";
                                lines.push(`- ${ts} ➡️ ${sender}: ${clip(meta.mensaje_bot, 500)}`);
                            }
                            if (!emitted) {
                                const dir = meta.direccion === "inbound" ? "⬅️" : "➡️";
                                lines.push(`- ${ts} ${dir} ${clip(a.description, 500)}`);
                            }
                        }
                        if (acts.length === lim)
                            lines.push("", `*Truncado a ${lim} actividades — sube \`limit\` para ver más.*`);
                    }
                }
                if (!lines.length)
                    lines.push("*Sin mensajes.*");
                return {
                    content: [{ type: "text", text: `# Conversación WhatsApp\n\n${header.join("\n")}\n\n${lines.join("\n")}` }],
                };
            }
            catch (e) {
                return { content: [{ type: "text", text: `WhatsApp conversation failed: ${e.message}` }], isError: true };
            }
        });
        server.tool("futurerp_whatsapp_stats", "Inbound vs outbound WhatsApp bot message stats for reporting: totals (in / out-bot / out-agente), breakdown by channel and by day/week, active conversations, new contacts, promotions to lead, triage mix, and escalations. Combines lead-phase crm_activities with capture-phase pending-contact messages.", {
            period: z
                .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
                .optional()
                .describe("Period. Default: this_month"),
            channel: WhatsAppChannelEnum.optional().describe("Filter by bot channel"),
            group_by: z.enum(["day", "week"]).optional().describe("Time bucket for the trend table. Default: day"),
        }, async ({ period, channel, group_by }) => {
            try {
                requireCredentials();
                const range = periodToRange(period ?? "this_month");
                const bucketOf = (ts) => {
                    const day = ts.slice(0, 10);
                    if ((group_by ?? "day") === "day")
                        return day;
                    const d = new Date(day + "T00:00:00Z");
                    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday of week
                    return `sem. ${d.toISOString().slice(0, 10)}`;
                };
                const inRange = (ts) => !!ts && (!range.gte || ts >= range.gte) && (!range.lte || ts < range.lte);
                // Tallies
                let inbound = 0, outBot = 0, outAgente = 0;
                const byChannel = {};
                const byBucket = {};
                const tally = (ch, dir, ts) => {
                    (byChannel[ch] ??= { in: 0, out: 0 })[dir]++;
                    (byBucket[bucketOf(ts)] ??= { in: 0, out: 0 })[dir]++;
                };
                // ── Lead phase (crm_activities) ──
                let qs = `activity_type=eq.whatsapp&entity_type=eq.lead&select=entity_id,created_at,metadata&order=created_at.asc&limit=10000`;
                if (range.gte)
                    qs += `&created_at=gte.${range.gte}`;
                if (range.lte)
                    qs += `&created_at=lt.${range.lte}`;
                if (channel)
                    qs += `&metadata->>canal=eq.${channel}`;
                const acts = await sbApi(`/crm_activities?${qs}`);
                const activeLeads = new Set();
                for (const a of acts) {
                    const meta = a.metadata ?? {};
                    const ch = meta.canal ?? "whatsapp";
                    activeLeads.add(a.entity_id);
                    if (meta.mensaje_cliente || meta.direccion === "inbound") {
                        inbound++;
                        tally(ch, "in", a.created_at);
                    }
                    if (meta.mensaje_bot || (meta.direccion === "outbound" && !meta.mensaje_cliente)) {
                        if (meta.status === "agente")
                            outAgente++;
                        else
                            outBot++;
                        tally(ch, "out", a.created_at);
                    }
                }
                // ── Capture phase (pending contacts) ──
                let pqs = `select=respond_contact_id,channel,tipo_contacto,status,status_changed_at,messages,created_at&limit=5000&order=updated_at.desc`;
                if (range.gte)
                    pqs += `&updated_at=gte.${range.gte}`;
                if (channel)
                    pqs += `&channel=eq.${channel}`;
                const pendings = await sbApi(`/whatsapp_pending_contacts?${pqs}`);
                const activePending = new Set();
                let newContacts = 0, promotions = 0;
                const byTriage = {};
                for (const p of pendings) {
                    const msgs = Array.isArray(p.messages) ? p.messages : [];
                    let touched = false;
                    for (const m of msgs) {
                        if (!m.ts || !inRange(m.ts))
                            continue;
                        touched = true;
                        if (m.dir === "in")
                            inbound++;
                        else
                            outBot++;
                        tally(p.channel ?? "whatsapp", m.dir === "in" ? "in" : "out", m.ts);
                    }
                    if (touched)
                        activePending.add(p.respond_contact_id);
                    if (inRange(p.created_at)) {
                        newContacts++;
                        byTriage[p.tipo_contacto ?? "—"] = (byTriage[p.tipo_contacto ?? "—"] ?? 0) + 1;
                    }
                    if (p.status === "lead" && inRange(p.status_changed_at))
                        promotions++;
                }
                // ── Escalations (leads the bot handed to a human, active in period) ──
                let escQs = `bot_escalation_reason=not.is.null`;
                if (range.gte)
                    escQs += `&whatsapp_last_inbound_at=gte.${range.gte}`;
                if (range.lte)
                    escQs += `&whatsapp_last_inbound_at=lt.${range.lte}`;
                const escalations = await sbCount("leads", escQs).catch(() => 0);
                const totalOut = outBot + outAgente;
                const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—");
                const dirTable = (m) => Object.entries(m)
                    .sort()
                    .map(([k, v]) => `| ${k} | ${v.in} | ${v.out} | ${v.in + v.out} |`)
                    .join("\n");
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `# WhatsApp bot — estadísticas ${range.label}${channel ? ` (${WA_CHANNEL_LABELS[channel]})` : ""}`,
                                "",
                                `| Métrica | Valor |`,
                                `|---------|-------|`,
                                `| Mensajes inbound (clientes) | **${inbound}** |`,
                                `| Mensajes outbound — bot | ${outBot} |`,
                                `| Mensajes outbound — agente humano | ${outAgente} |`,
                                `| Total outbound | ${totalOut} |`,
                                `| Ratio inbound : outbound | ${totalOut > 0 ? (inbound / totalOut).toFixed(2) : "—"} |`,
                                `| Conversaciones activas (leads) | ${activeLeads.size} |`,
                                `| Conversaciones activas (pre-lead) | ${activePending.size} |`,
                                "",
                                `## Embudo del período`,
                                "",
                                `| Métrica | Valor |`,
                                `|---------|-------|`,
                                `| Contactos nuevos (pending) | ${newContacts} |`,
                                `| Promovidos a lead | ${promotions} |`,
                                `| Escalados a humano | ${escalations} |`,
                                Object.keys(byTriage).length
                                    ? `\n### Triage de contactos nuevos\n\n| Tipo | Count | % |\n|------|-------|---|\n${Object.entries(byTriage)
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([k, v]) => `| ${k} | ${v} | ${pct(v, newContacts)} |`)
                                        .join("\n")}`
                                    : "",
                                "",
                                `## Por canal`,
                                "",
                                `| Canal | In | Out | Total |`,
                                `|-------|----|-----|-------|`,
                                dirTable(byChannel) || "| — | 0 | 0 | 0 |",
                                "",
                                `## Por ${(group_by ?? "day") === "day" ? "día" : "semana"}`,
                                "",
                                `| Fecha | In | Out | Total |`,
                                `|-------|----|-----|-------|`,
                                dirTable(byBucket) || "| — | 0 | 0 | 0 |",
                                "",
                                acts.length === 10000 || pendings.length === 5000
                                    ? "*Nota: se alcanzó el tope de muestreo (10k actividades / 5k contactos) — acota el período para cifras exactas.*"
                                    : "",
                            ]
                                .filter(Boolean)
                                .join("\n"),
                        },
                    ],
                };
            }
            catch (e) {
                return { content: [{ type: "text", text: `WhatsApp stats failed: ${e.message}` }], isError: true };
            }
        });
        server.tool("futurerp_whatsapp_health", "WhatsApp bot error & pipeline health report: bot_error_log grouped by fase × tipo with recent errors, webhook_outbox (target=whatsapp) status counts + recent failures with last_error, and stuck inbound-buffer rows (unprocessed >10 min).", {
            days: z.number().optional().describe("Lookback window in days. Default: 7"),
            limit: z.number().optional().describe("Max recent error rows to show (default 15, max 50)"),
        }, async ({ days, limit }) => {
            try {
                requireCredentials();
                const lim = Math.min(limit ?? 15, 50);
                const since = new Date(Date.now() - (days ?? 7) * 24 * 60 * 60 * 1000).toISOString();
                const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
                const [errors, outboxFailed, stuck] = await Promise.all([
                    sbApi(`/bot_error_log?created_at=gte.${since}&order=created_at.desc&select=created_at,contact_key,fase,tipo,detalle&limit=1000`),
                    sbApi(`/webhook_outbox?target=eq.whatsapp&status=eq.failed&created_at=gte.${since}&order=created_at.desc&select=created_at,event_type,attempts,last_error&limit=${lim}`),
                    sbApi(`/whatsapp_inbound_buffer?processed=eq.false&created_at=lt.${encodeURIComponent(stuckBefore)}&order=created_at.asc&select=contact_key,created_at&limit=50`),
                ]);
                const outboxCounts = {};
                await Promise.all(["pending", "sent", "failed", "skipped"].map(async (s) => {
                    outboxCounts[s] = await sbCount("webhook_outbox", `target=eq.whatsapp&status=eq.${s}&created_at=gte.${since}`).catch(() => 0);
                }));
                const byFaseTipo = {};
                for (const e of errors)
                    byFaseTipo[`${e.fase} / ${e.tipo}`] = (byFaseTipo[`${e.fase} / ${e.tipo}`] ?? 0) + 1;
                const verdict = (bad, warnAt = 1) => (bad === 0 ? "✅" : bad < warnAt ? "⚠️" : "🔴");
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `# WhatsApp bot — salud (últimos ${days ?? 7} días)`,
                                "",
                                `${errors.length === 0 ? "✅" : errors.length < 10 ? "⚠️" : "🔴"} **bot_error_log:** ${errors.length} errores`,
                                `${verdict(outboxCounts.failed, 3)} **webhook_outbox (whatsapp):** ${outboxCounts.failed} failed / ${outboxCounts.pending} pending / ${outboxCounts.sent} sent / ${outboxCounts.skipped} skipped`,
                                `${verdict(stuck.length)} **Buffer atorado:** ${stuck.length} mensajes sin procesar >10 min${stuck.length ? ` (el más viejo: ${fmtTs(stuck[0].created_at)})` : ""}`,
                                "",
                                Object.keys(byFaseTipo).length
                                    ? `## Errores por fase / tipo\n\n| Fase / Tipo | Count |\n|-------------|-------|\n${Object.entries(byFaseTipo)
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([k, v]) => `| ${k} | ${v} |`)
                                        .join("\n")}`
                                    : "",
                                errors.length
                                    ? `\n## Errores recientes (${Math.min(errors.length, lim)})\n\n| Fecha | Fase | Tipo | Contacto | Detalle |\n|-------|------|------|----------|---------|\n${errors
                                        .slice(0, lim)
                                        .map((e) => `| ${fmtTs(e.created_at)} | ${e.fase} | ${e.tipo} | ${clip(e.contact_key, 24)} | ${clip(e.detalle, 90)} |`)
                                        .join("\n")}`
                                    : "",
                                outboxFailed.length
                                    ? `\n## Outbox fallidos recientes\n\n| Fecha | Evento | Intentos | Error |\n|-------|--------|----------|-------|\n${outboxFailed
                                        .map((o) => `| ${fmtTs(o.created_at)} | ${o.event_type} | ${o.attempts} | ${clip(o.last_error, 90)} |`)
                                        .join("\n")}`
                                    : "",
                            ]
                                .filter(Boolean)
                                .join("\n"),
                        },
                    ],
                };
            }
            catch (e) {
                return { content: [{ type: "text", text: `WhatsApp health failed: ${e.message}` }], isError: true };
            }
        });
        // ────────────────────────────────────────────────────────────
        // SALES INBOX FOLLOW-UP AUDIT (OpenWA per-vendor inbox)
        //
        // Data model: whatsapp_channels (one linked phone → one vendor) →
        // whatsapp_conversations (1:1 chats, lead_id when linked) →
        // whatsapp_messages (direction inbound|outbound, sent_at).
        // Distinct from the Nancy bot tables above.
        // ────────────────────────────────────────────────────────────
        server.tool("futurerp_whatsapp_seguimientos", "Audit the SALES team's WhatsApp inbox (per-vendor OpenWA sessions, not the bot) for bad follow-ups: conversations where the client's last message is unanswered past a threshold, and lead-linked chats gone cold. Groups by vendedor with response stats. Pass conversation_id to fetch one full thread for qualitative chat analysis.", {
            days: z.number().optional().describe("Lookback window in days for message activity. Default: 7"),
            stale_hours: z.number().optional().describe("Hours an inbound client message may wait unanswered before flagging. Default: 12"),
            cold_days: z.number().optional().describe("Days of total silence on a lead-linked chat before flagging as cold. Default: 5"),
            vendedor: z.string().optional().describe("Filter channels by vendor name / label / session name (substring, case-insensitive)"),
            limit: z.number().optional().describe("Max flagged conversations per section (default 30, max 100)"),
            conversation_id: z.string().optional().describe("whatsapp_conversations uuid — render that full thread instead of the audit"),
            thread_limit: z.number().optional().describe("Max messages when rendering a thread (default 200, max 500)"),
        }, async ({ days, stale_hours, cold_days, vendedor, limit, conversation_id, thread_limit }) => {
            try {
                requireCredentials();
                // ── Thread mode ──
                if (conversation_id) {
                    const convos = await sbApi(`/whatsapp_conversations?id=eq.${encodeURIComponent(conversation_id)}&select=*,whatsapp_channels(label,session_name,phone,vendor_user_id)`);
                    const c = convos[0];
                    if (!c)
                        throw new Error(`No conversation ${conversation_id}.`);
                    const ch = c.whatsapp_channels ?? {};
                    const names = await resolveProfiles([ch.vendor_user_id].filter(Boolean));
                    const vendorName = names.get(ch.vendor_user_id) ?? ch.label ?? ch.session_name ?? "—";
                    const lim = Math.min(thread_limit ?? 200, 500);
                    const msgs = await sbApi(`/whatsapp_messages?conversation_id=eq.${encodeURIComponent(conversation_id)}&order=sent_at.desc&select=direction,body,media_type,status,sent_at&limit=${lim}`);
                    msgs.reverse();
                    const header = [
                        `**Contacto:** ${c.name_override ?? c.contact_name ?? c.contact_phone ?? c.chat_id}`,
                        `**Vendedor:** ${vendorName} · **Tel contacto:** ${c.contact_phone ?? "—"} · **Lead:** ${c.lead_id ? `\`${c.lead_id}\`` : "sin vincular"}`,
                        `**Último mensaje:** ${fmtTs(c.last_message_at)}`,
                    ];
                    const lines = msgs.map((m) => `- ${fmtTs(m.sent_at)} ${m.direction === "inbound" ? "⬅️ **cliente**" : "➡️ vendedor"}: ${m.body ? clip(m.body, 500) : `[${m.media_type ?? "media"}]`}`);
                    if (msgs.length === lim)
                        lines.push("", `*Truncado a ${lim} mensajes — sube \`thread_limit\`.*`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `# Conversación de ventas\n\n${header.join("\n")}\n\n${lines.length ? lines.join("\n") : "*Sin mensajes.*"}`,
                            },
                        ],
                    };
                }
                // ── Audit mode ──
                const lim = Math.min(limit ?? 30, 100);
                const staleMs = (stale_hours ?? 12) * 3600_000;
                const coldMs = (cold_days ?? 5) * 86400_000;
                const now = Date.now();
                const since = new Date(now - (days ?? 7) * 86400_000).toISOString();
                const channels = await sbApi(`/whatsapp_channels?active=eq.true&select=id,label,session_name,phone,vendor_user_id,connection_status`);
                const names = await resolveProfiles(channels.map((c) => c.vendor_user_id).filter(Boolean));
                const chanName = (c) => names.get(c.vendor_user_id) ?? c.label ?? c.session_name;
                const filtered = vendedor
                    ? channels.filter((c) => [chanName(c), c.label, c.session_name].some((s) => s?.toLowerCase().includes(vendedor.toLowerCase())))
                    : channels;
                if (!filtered.length)
                    throw new Error(`No active sales channels${vendedor ? ` matching "${vendedor}"` : ""}.`);
                const chanById = new Map(filtered.map((c) => [c.id, c]));
                const chanIds = filtered.map((c) => c.id).join(",");
                const [convos, msgs] = await Promise.all([
                    sbApi(`/whatsapp_conversations?channel_id=in.(${chanIds})&is_group=eq.false&select=id,channel_id,contact_phone,contact_name,name_override,lead_id,last_message_at,last_message_preview&order=last_message_at.desc.nullslast&limit=2000`),
                    sbApi(
                    // ponytail: one bulk fetch reduced in JS beats N+1 last-message queries; 10k cap matches the stats tool
                    `/whatsapp_messages?sent_at=gte.${encodeURIComponent(since)}&select=conversation_id,direction,sent_at&order=sent_at.desc&limit=10000`),
                ]);
                const agg = new Map();
                for (const m of msgs) {
                    let a = agg.get(m.conversation_id);
                    if (!a)
                        agg.set(m.conversation_id, (a = { in: 0, out: 0 }));
                    if (m.direction === "inbound") {
                        a.in++;
                        if (!a.lastIn || m.sent_at > a.lastIn)
                            a.lastIn = m.sent_at;
                    }
                    else {
                        a.out++;
                        if (!a.lastOut || m.sent_at > a.lastOut)
                            a.lastOut = m.sent_at;
                    }
                }
                const hrs = (iso) => (now - new Date(iso).getTime()) / 3600_000;
                const label = (c) => c.name_override ?? c.contact_name ?? c.contact_phone ?? "—";
                const unanswered = [];
                const cold = [];
                const perVendor = new Map();
                const bump = (chId) => {
                    const v = chanName(chanById.get(chId));
                    let s = perVendor.get(v);
                    if (!s)
                        perVendor.set(v, (s = { convos: 0, in: 0, out: 0, sinResp: 0, frías: 0 }));
                    return s;
                };
                for (const c of convos) {
                    if (!chanById.has(c.channel_id))
                        continue;
                    const a = agg.get(c.id);
                    const active = a && (a.in || a.out);
                    const s = bump(c.channel_id);
                    if (active) {
                        s.convos++;
                        s.in += a.in;
                        s.out += a.out;
                    }
                    // Unanswered: client spoke last and has waited past the threshold.
                    if (a?.lastIn && (!a.lastOut || a.lastIn > a.lastOut) && now - new Date(a.lastIn).getTime() > staleMs) {
                        s.sinResp++;
                        unanswered.push({
                            vendedor: chanName(chanById.get(c.channel_id)),
                            contacto: label(c),
                            "esperando (h)": Math.round(hrs(a.lastIn)),
                            "último mensaje": clip(c.last_message_preview, 60),
                            lead_id: c.lead_id ?? "",
                            conversation_id: c.id,
                        });
                    }
                    // Cold: linked to a lead but nobody has said anything in cold_days.
                    else if (c.lead_id && c.last_message_at && now - new Date(c.last_message_at).getTime() > coldMs) {
                        s.frías++;
                        cold.push({
                            vendedor: chanName(chanById.get(c.channel_id)),
                            contacto: label(c),
                            "días en silencio": Math.round(hrs(c.last_message_at) / 24),
                            "último mensaje": clip(c.last_message_preview, 60),
                            lead_id: c.lead_id,
                            conversation_id: c.id,
                        });
                    }
                }
                unanswered.sort((x, y) => y["esperando (h)"] - x["esperando (h)"]);
                cold.sort((x, y) => y["días en silencio"] - x["días en silencio"]);
                const vendorTable = [...perVendor.entries()].map(([v, s]) => ({
                    vendedor: v,
                    "convos activas": s.convos,
                    recibidos: s.in,
                    enviados: s.out,
                    "sin responder": s.sinResp,
                    "leads fríos": s.frías,
                }));
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `# Seguimientos de ventas — WhatsApp (últimos ${days ?? 7} días)`,
                                "",
                                `${unanswered.length ? "🔴" : "✅"} **${unanswered.length} conversaciones con cliente esperando >${stale_hours ?? 12}h** · ${cold.length ? "⚠️" : "✅"} **${cold.length} leads fríos >${cold_days ?? 5} días**`,
                                "",
                                renderRecords(vendorTable, "## Por vendedor", 7),
                                "",
                                renderRecords(unanswered.slice(0, lim), `## 🔴 Cliente sin respuesta — ${unanswered.length}`, 7),
                                "",
                                renderRecords(cold.slice(0, lim), `## ⚠️ Leads fríos (sin actividad) — ${cold.length}`, 7),
                                "",
                                "*Para analizar la calidad de un chat, vuelve a llamar esta tool con su `conversation_id`.*",
                            ].join("\n"),
                        },
                    ],
                };
            }
            catch (e) {
                return { content: [{ type: "text", text: `WhatsApp seguimientos failed: ${e.message}` }], isError: true };
            }
        });
    } // end if can("mcp.whatsapp")
    // ────────────────────────────────────────────────────────────
    // MCP PROMPTS
    // ────────────────────────────────────────────────────────────
    server.prompt("futurerp_context", "Essential context about FuturERP (pronto-resolver). Use this as a session primer to learn the data model, key tables, enum vocabulary, and when to prefer FuturERP vs the generic Supabase MCP.", () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `You are a FuturERP expert for Future Energy. FuturERP is the company's internal operations platform (pronto-resolver-61, React + Supabase) — distinct from Salesforce (sales CRM).

## When to use which MCP
- **futurerp_***  — anything about tickets, internal leads (pronto-side, not Salesforce leads), instalaciones, drones, cantina, dashboards, reports, financial milestones, notifications. Use this MCP first.
- **supabase_***  — generic SQL, migrations, advisors, branch management.
- **salesforce_***  — sales pipeline, Opportunities, Accounts, customer-facing CRM data.

## Core domains
- **Leads** (CRM): pipeline funnel (nuevo→asignado→primer_contacto→seguimiento→visita_en_sitio→negociacion→calificado/descalificado). Has system-computed lead_qualification (Good/Warm/Cold/HOT/Bad Lead) and manual vendor_qualification. Synced to Salesforce via salesforce_lead_id.
- **Tickets**: internal support/incidencia. Folio'd (EFU-XXXXX-X). SLA-driven: priority alta=1d, media=2d, baja=3d laborales. Status: abierto, en_progreso, resuelto, escalado. Multiple responsables (responsables_ids: uuid[]).
- **Instalaciones**: field installation work orders. Cuadrilla-assigned, scheduled, GPS-tracked (checkin/checkout). estado: asignada, pendiente, en_proceso, completada, cancelada.
- **Drones**: inventory + sessions (checkout, checkin, charging). PG enum drone_status.
- **Cantina**: break-room resource queue (water/ice/milk/coffee).
- **Projects**: post-conversion customer projects. Stage history audited.
- **Reports & dashboards**: user-defined custom queries with sharing/folders.
- **WhatsApp bot ("Nancy")**: inbound sales bot on WhatsApp/Instagram/Messenger/TikTok. Pre-lead capture lives in whatsapp_pending_contacts (messages jsonb, triage, lifecycle status); lead-phase conversations are crm_activities rows (activity_type='whatsapp', metadata.direccion/canal/mensaje_cliente/mensaje_bot; metadata.status='agente' = human-sent). Errors land in bot_error_log.
- **Sales WhatsApp inbox** (separate from the bot): each vendor links their own phone via OpenWA — whatsapp_channels (session → vendor) → whatsapp_conversations (lead_id when linked) → whatsapp_messages (direction inbound/outbound).

## Key tools for common questions
- "How are we doing this month?" → \`futurerp_lead_kpis\` then \`futurerp_ticket_kpis\`
- "What's stuck?" → \`futurerp_ticket_kpis\` (SLA-overdue) and \`futurerp_aggregate\` on \`tickets\` grouped by \`status\` or \`responsable\`.
- "Show me lead X" → \`futurerp_get_lead\` for full context (row + stage history + activities + converted project).
- "Who's busiest with drones?" → \`futurerp_drone_leaderboard\`.
- "How is the WhatsApp bot doing?" → \`futurerp_whatsapp_stats\` (inbound/outbound report), \`futurerp_whatsapp_health\` (errors).
- "Show me the chats / this conversation" → \`futurerp_whatsapp_chats\` then \`futurerp_whatsapp_conversation\`.
- "¿Cómo van los seguimientos de ventas?" / bad follow-ups / chat quality of the SALES team → \`futurerp_whatsapp_seguimientos\` (audit, then pass conversation_id for the thread).
- "What's available?" → \`futurerp_list_tables\`, \`futurerp_list_enums\`, \`futurerp_list_rpcs\`.
- Field semantics → \`futurerp_field_mappings\` mapping=key_fields.

## Constraints
- Read-only. No INSERT/UPDATE/DELETE. Mutating RPCs are catalogued but not invoked.
- Spanish UI (Mexico market) — labels in es-MX, dates dd/mm/yyyy when rendered for humans.
- Service role key bypasses RLS, so results are org-wide. Filter by \`assigned_to\`/\`responsable\` if you want a single-user view.

## Tip
Before guessing column names, call \`futurerp_describe_table\`. Before guessing enum values, call \`futurerp_list_enums\`. The schema is large — don't memorize it.`,
                },
            },
        ],
    }));
    server.prompt("lead_funnel_analysis", "Analyze the lead funnel: stage breakdown, conversion, owner performance.", { period: z.string().optional().describe("this_month, last_month, this_quarter, this_year, etc.") }, ({ period }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Analyze the FuturERP lead funnel for ${period ?? "this_month"}.

1. Call \`futurerp_lead_kpis\` period=${period ?? "this_month"} to get the headline numbers (total, close rate, avg ticket, pipeline value, sales cycle).
2. Call \`futurerp_aggregate\` table=leads group_by=status to see the stage distribution.
3. Call \`futurerp_aggregate\` table=leads group_by=assigned_to measure=count and again with measure=sum measure_column=project_amount to compare owners.
4. Call \`futurerp_aggregate\` table=leads group_by=lead_qualification to see quality mix.
5. Identify bottlenecks: which stages have the most stuck leads? Compare to the canonical pipeline order from \`futurerp_field_mappings mapping=lead_enums\`.
6. Summarize with 3 actionable insights.`,
                },
            },
        ],
    }));
    if (can("mcp.whatsapp"))
        server.prompt("sales_followup_review", "Review the sales team's WhatsApp follow-ups: find unanswered clients and cold leads, then rate the worst conversations.", { vendedor: z.string().optional().describe("Limit the review to one vendor (name substring)") }, ({ vendedor }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Review the sales team's WhatsApp follow-ups${vendedor ? ` for ${vendedor}` : ""}.

1. Call \`futurerp_whatsapp_seguimientos\`${vendedor ? ` vendedor=${vendedor}` : ""} to get the per-vendor audit (unanswered clients, cold leads).
2. For the 3–5 worst flagged conversations (longest wait / most days silent), call the same tool with each \`conversation_id\` to read the full thread.
3. Rate each thread 1–5 on: response speed, whether questions were answered, whether the vendor pushed toward a next step (cita, cotización, cierre), and tone.
4. Summarize per vendedor: what they do well, the specific bad habits found (with quoted examples), and the top 3 conversations that need a follow-up TODAY (contacto, tel/lead_id, suggested message in Spanish).`,
                    },
                },
            ],
        }));
    server.prompt("ticket_health_check", "Quick ticket-health dashboard: open count, SLA breaches, top responsables, top areas.", () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Give me a ticket health check for this month.

1. Call \`futurerp_ticket_kpis\` period=this_month.
2. Call \`futurerp_recent_records\` table=tickets filters=[{column:'status', op:'neq', value:'resuelto'}] order=fecha_vencimiento.asc limit=10 — these are the most urgent open tickets.
3. Highlight any SLA-overdue tickets and group them by responsable.
4. Summarize: total open, overdue rate, top 3 responsables by load, top 3 areas by ticket volume.`,
                },
            },
        ],
    }));
    return server;
} // end buildServer
// ── HTTP entrypoint ───────────────────────────────────────
async function main() {
    requireCredentials();
    if (!SUPABASE_PUBLISHABLE_KEY) {
        throw new Error("Set SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) — needed to validate user tokens.");
    }
    const app = express();
    app.use(express.json({ limit: "4mb" }));
    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, version: VERSION });
    });
    // RFC 9728 protected-resource metadata → points clients at Supabase Auth (the OAuth 2.1 AS).
    if (process.env.MCP_SKIP_AS_METADATA === "1") {
        console.error("WARNING: MCP_SKIP_AS_METADATA=1 — OAuth discovery metadata not served (smoke-test only)");
    }
    else {
        const metaUrl = `${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`;
        const r = await fetch(metaUrl).catch((e) => ({ ok: false, status: String(e) }));
        if (!r.ok) {
            console.error(`Cannot load OAuth metadata from ${metaUrl} (${r.status}). Supabase OAuth server disabled? Enable it under Authentication → OAuth Server.`);
            process.exit(1);
        }
        const oauthMetadata = await r.json();
        app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: MCP_PUBLIC_URL, resourceName: "FuturERP" }));
    }
    const bearer = requireBearerAuth({
        verifier: tokenVerifier,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_PUBLIC_URL),
    });
    app.post("/mcp", bearer, async (req, res) => {
        const auth = req.auth;
        if (req.body?.method === "tools/call") {
            // Audit line (Railway logs): who called what.
            console.log(JSON.stringify({ t: new Date().toISOString(), email: auth.extra?.email, tool: req.body.params?.name }));
        }
        const server = buildServer(auth);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (e) {
            console.error("MCP request error:", e);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
            }
        }
    });
    const notAllowed = (_req, res) => {
        res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    };
    app.get("/mcp", notAllowed);
    app.delete("/mcp", notAllowed);
    app.listen(PORT, () => {
        console.error(`FuturERP MCP v${VERSION} listening on :${PORT} — public ${MCP_PUBLIC_URL.href}`);
    });
}
main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
