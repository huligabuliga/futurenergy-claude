#!/usr/bin/env node

/**
 * FuturERP MCP Server v1.0
 *
 * Read-only MCP for Future Energy's internal ERP (pronto-resolver-61 on Supabase).
 * Connects directly via PostgREST + Supabase RPCs using the service role key
 * (bypasses RLS — full org read). Mirrors the Salesforce MCP's tool shape.
 *
 * Env vars:
 *   SUPABASE_URL                — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role key from Supabase Dashboard → Project Settings → API
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Load .env from server root (fallback if env vars not passed by MCP client)
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dirname, "../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

import {
  PRONTO_TABLES,
  PRONTO_ENUMS,
  PRONTO_RPCS,
  LEAD_STATUS_VALUES,
  LEAD_STATUS_LABELS,
  LEAD_QUALIFICATION_VALUES,
  VENDOR_QUALIFICATION_VALUES,
  LEAD_PROGRAM_VALUES,
  CRM_ACTIVITY_TYPES,
  CRM_ACTIVITY_CATEGORIES,
  TICKET_PRIORITY_SLA_DAYS,
  PHOTO_TO_DOCUMENT_MAP,
  VT_TO_SF_FIELD_MAP,
  ACCOUNT_EMAIL_FIELDS,
  KEY_FIELDS,
  getRpcsByCategory,
  type ProntoTable,
  type ProntoRpc,
} from "./schema.js";

// ── Supabase connection ───────────────────────────────────

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const REST_BASE = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";

// OpenAPI describe cache: schema doc TTL 2h (mirrors salesforce describe cache)
let openApiCache: { data: any; fetchedAt: number } | null = null;
const OPENAPI_TTL = 2 * 60 * 60 * 1000;

function hasCredentials(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function requireCredentials() {
  if (!hasCredentials()) {
    throw new Error(
      "No Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .mcp.json env or in ~/.claude/mcp-servers/futurerp/.env."
    );
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

/** GET to PostgREST `/rest/v1/<path>`. Returns parsed JSON. Throws on non-2xx. */
async function sbApi(path: string, headers: Record<string, string> = {}): Promise<any> {
  const url = `${REST_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { headers: authHeaders(headers) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

/** HEAD/GET with `Prefer: count=exact` to read content-range total without fetching rows. */
async function sbCount(table: string, qs = ""): Promise<number> {
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
async function sbRpc(name: string, args: Record<string, any> = {}): Promise<any> {
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
  if (res.status === 204) return null;
  return res.json();
}

/** Fetch the PostgREST OpenAPI spec (cached 2h). */
async function sbOpenApi(): Promise<any> {
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

/** Build PostgREST filter querystring fragments from a structured filter array. */
interface RawFilter {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is" | "not.is";
  value: string | number | boolean | (string | number)[];
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

function filtersToQs(filters?: RawFilter[]): string {
  if (!filters?.length) return "";
  return filters
    .map((f) => {
      const v = Array.isArray(f.value)
        ? `(${f.value.map((x) => String(x)).join(",")})`
        : String(f.value);
      return `${encodeURIComponent(f.column)}=${f.op}.${encodeURIComponent(v)}`;
    })
    .join("&");
}

/** Render an array of records as a markdown table when narrow enough, else as a JSON code block. */
function renderRecords(records: any[], heading?: string, maxCols = 8): string {
  if (!records?.length) return `${heading ? heading + "\n\n" : ""}*No records.*`;
  const keys = Object.keys(records[0]);
  const head = heading ? `${heading}\n\n` : "";
  if (keys.length <= maxCols) {
    const header = `| ${keys.join(" | ")} |`;
    const sep = `| ${keys.map(() => "---").join(" | ")} |`;
    const rows = records.map(
      (r) =>
        `| ${keys
          .map((k) => {
            const v = r[k];
            if (v === null || v === undefined) return "";
            if (typeof v === "object") return JSON.stringify(v);
            return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
          })
          .join(" | ")} |`
    );
    return `${head}${header}\n${sep}\n${rows.join("\n")}`;
  }
  return `${head}\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\``;
}

/** Period filter helper — translates a named period to ISO date bounds. */
function periodToRange(period: string): { gte?: string; lte?: string; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString();

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

// ── Server ────────────────────────────────────────────────

const server = new McpServer({
  name: "futurerp",
  version: "1.0.0",
});

// ────────────────────────────────────────────────────────────
// SCHEMA & METADATA TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_describe_table",
  "Describe any table in the FuturERP (pronto-resolver) database. Returns columns with PostgreSQL types, nullability, defaults, and PG-enum references. Live data sourced from PostgREST's OpenAPI spec. Use this before querying an unfamiliar table.",
  {
    table: z.string().describe("Table name, e.g. tickets, leads, instalaciones, drones, notifications"),
    required_only: z.boolean().optional().describe("Only show NOT NULL columns"),
  },
  async ({ table, required_only }) => {
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
      const required: string[] = def.required ?? [];
      const props: Record<string, any> = def.properties ?? {};
      let cols = Object.entries(props);
      if (required_only) cols = cols.filter(([n]) => required.includes(n));

      const rows = cols.map(([name, info]) => {
        const isRequired = required.includes(name);
        const fmt = info.format ?? info.type ?? "?";
        const pgEnum =
          typeof info.description === "string"
            ? (info.description.match(/PG enum:\s*([\w_]+)/i)?.[1] ?? "")
            : "";
        const dflt =
          info.default !== undefined && info.default !== null ? String(info.default).slice(0, 40) : "";
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Describe failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_list_tables",
  "List FuturERP tables, filter by keyword or category. Annotates each table with its domain category (lead, ticket, instalacion, drone, cantina, finance, report, user, notification, integration, system, junction) and one-line purpose.",
  {
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
        "system",
        "junction",
      ])
      .optional()
      .describe("Filter by domain category"),
  },
  async ({ filter, category }) => {
    let rows = PRONTO_TABLES.slice();
    if (category) rows = rows.filter((t) => t.category === category);
    if (filter) {
      const kw = filter.toLowerCase();
      rows = rows.filter(
        (t) => t.name.toLowerCase().includes(kw) || t.purpose.toLowerCase().includes(kw)
      );
    }
    const byCat: Record<string, ProntoTable[]> = {};
    for (const t of rows) (byCat[t.category] ??= []).push(t);

    const sections = Object.entries(byCat).map(
      ([cat, list]) =>
        `### ${cat} (${list.length})\n\n${list
          .map((t) => `- \`${t.name}\` — ${t.purpose}`)
          .join("\n")}`
    );

    return {
      content: [
        {
          type: "text",
          text: `## FuturERP Tables (${rows.length}/${PRONTO_TABLES.length})\n\n${sections.join("\n\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "futurerp_list_enums",
  "List all PG enum types in FuturERP with their allowed values. Use this before constructing filters on status/priority/notification_type/etc. Also includes the TypeScript-level enums for lead (status, qualification, vendor qualification, program) and CRM activities.",
  {
    filter: z.string().optional().describe("Keyword to filter enum name or value"),
  },
  async ({ filter }) => {
    const kw = filter?.toLowerCase();

    // PG enums
    const pgEnums = PRONTO_ENUMS.filter((e) => {
      if (!kw) return true;
      return (
        e.name.toLowerCase().includes(kw) ||
        e.values.some((v) => v.toLowerCase().includes(kw))
      );
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
          .map((v) => `\`${v}\`${(e as any).labels?.[v] ? ` (${(e as any).labels[v]})` : ""}`)
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
  }
);

server.tool(
  "futurerp_list_rpcs",
  "List RPC functions available in FuturERP, grouped by domain (kpi, lead, ticket, drone, cantina, report, permission, notification, finance, user, integration). Each entry notes whether it mutates state. Read-only RPCs are callable; mutating ones are listed for reference only — FuturERP does not invoke them.",
  {
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
  },
  async ({ category, read_only }) => {
    let rpcs = PRONTO_RPCS.slice();
    if (category) rpcs = rpcs.filter((r) => r.category === category);
    if (read_only) rpcs = rpcs.filter((r) => !r.mutating);

    const grouped = rpcs.reduce<Record<string, ProntoRpc[]>>((acc, r) => {
      (acc[r.category] ??= []).push(r);
      return acc;
    }, {});

    const sections = Object.entries(grouped).map(([cat, list]) => {
      const rows = list.map(
        (r) => `- \`${r.name}\`${r.mutating ? " **(mutating)**" : ""} — ${r.purpose}`
      );
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
  }
);

// ────────────────────────────────────────────────────────────
// DATA ACCESS TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_query",
  "Run a PostgREST select query against any FuturERP table. Use structured `filters` (each is `{column, op, value}`) instead of raw SQL. Read-only.",
  {
    table: z.string().describe("Table name, e.g. tickets, leads, instalaciones"),
    select: z
      .string()
      .optional()
      .describe("Comma-separated columns. Default: *. Supports PostgREST embedding, e.g. 'id,folio,assigned_to:profiles(full_name)'"),
    filters: FiltersSchema.describe(
      "Structured filter list. Example: [{column:'status', op:'eq', value:'abierto'}, {column:'fecha_creacion', op:'gte', value:'2026-05-01'}]"
    ),
    order: z.string().optional().describe("PostgREST order, e.g. 'created_at.desc' or 'priority.asc,created_at.desc'"),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50, max 200)"),
  },
  async ({ table, select, filters, order, limit }) => {
    try {
      requireCredentials();
      const lim = Math.min(limit ?? 50, 200);
      const qsParts: string[] = [`select=${encodeURIComponent(select ?? "*")}`];
      const filterQs = filtersToQs(filters as RawFilter[] | undefined);
      if (filterQs) qsParts.push(filterQs);
      if (order) qsParts.push(`order=${encodeURIComponent(order)}`);
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Query failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_count",
  "Count rows in any table with optional filters. Fast — uses HEAD + Prefer: count=exact.",
  {
    table: z.string().describe("Table name"),
    filters: FiltersSchema.describe("Filters (same shape as futurerp_query)"),
  },
  async ({ table, filters }) => {
    try {
      requireCredentials();
      const total = await sbCount(table, filtersToQs(filters as RawFilter[] | undefined));
      const filterText = filters?.length
        ? ` where ${filters.map((f) => `${f.column} ${f.op} ${JSON.stringify(f.value)}`).join(" AND ")}`
        : "";
      return {
        content: [
          { type: "text", text: `**${total.toLocaleString()}** rows in \`${table}\`${filterText}.` },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Count failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_get_record",
  "Fetch a single row from a table by id (or any unique column).",
  {
    table: z.string().describe("Table name"),
    id: z.string().describe("Primary key value (uuid or text)"),
    id_column: z.string().optional().describe("Column to filter on. Default: 'id'"),
    select: z.string().optional().describe("Columns. Default '*'."),
  },
  async ({ table, id, id_column, select }) => {
    try {
      requireCredentials();
      const col = id_column ?? "id";
      const sel = select ?? "*";
      const data = await sbApi(
        `/${table}?${encodeURIComponent(col)}=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(sel)}&limit=1`
      );
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No row in \`${table}\` where ${col} = '${id}'.` }],
          isError: true,
        };
      }
      const row = rows[0];
      const label = row.folio ?? row.name ?? row.title ?? row.full_name ?? id;
      return {
        content: [
          {
            type: "text",
            text: `## ${table}: ${label}\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_get_related",
  "Fetch child/related rows by foreign key. Example: ticket_activities for a ticket, lead_stage_history for a lead, instalacion_fotos for an instalacion.",
  {
    child_table: z.string().describe("Table containing the child rows (e.g. ticket_activities)"),
    fk_column: z.string().describe("Foreign-key column on the child table (e.g. ticket_id, lead_id, instalacion_id)"),
    parent_id: z.string().describe("Parent record id (uuid)"),
    select: z.string().optional().describe("Columns. Default '*'."),
    order: z.string().optional().describe("Order, default 'created_at.desc'"),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
  },
  async ({ child_table, fk_column, parent_id, select, order, limit }) => {
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_recent_records",
  "Get the most recent rows from any table. Default order is created_at.desc.",
  {
    table: z.string().describe("Table name"),
    select: z.string().optional().describe("Columns. Default '*'."),
    limit: z.number().int().min(1).max(100).optional().describe("Default 10, max 100"),
    order: z.string().optional().describe("Order, default 'created_at.desc'"),
    filters: FiltersSchema,
  },
  async ({ table, select, limit, order, filters }) => {
    try {
      requireCredentials();
      const lim = Math.min(limit ?? 10, 100);
      const qsParts = [`select=${encodeURIComponent(select ?? "*")}`];
      const filterQs = filtersToQs(filters as RawFilter[] | undefined);
      if (filterQs) qsParts.push(filterQs);
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// SEARCH TOOL
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_search",
  "Fuzzy multi-table search across the main entities (tickets, leads, clients, instalaciones, projects). Uses ilike on the most-searched text fields (folio, asunto, name, email, phone, company).",
  {
    query: z.string().describe("Search term (e.g. 'EFU-00514', 'juan@', 'fachada', '+528112345678')"),
    tables: z
      .string()
      .optional()
      .describe("Comma-separated table list to search. Default: tickets,leads,clients,instalaciones,projects"),
    limit_per_table: z.number().int().min(1).max(20).optional().describe("Max results per table (default 5)"),
  },
  async ({ query, tables, limit_per_table }) => {
    try {
      requireCredentials();
      const lim = Math.min(limit_per_table ?? 5, 20);
      const pattern = `*${query}*`; // PostgREST ilike uses * as wildcard
      const targets = (tables ?? "tickets,leads,clients,instalaciones,projects")
        .split(",")
        .map((s) => s.trim());

      const fieldMap: Record<string, { cols: string[]; select: string }> = {
        tickets: {
          cols: ["folio", "asunto", "descripcion", "cliente_nombre"],
          select: "id,folio,asunto,status,prioridad,created_at",
        },
        leads: {
          cols: ["first_name", "last_name", "email", "phone", "mobile_phone", "company"],
          select: "id,first_name,last_name,email,phone,status,created_at",
        },
        clients: {
          cols: ["nombre", "email", "telefono"],
          select: "id,nombre,email,telefono,created_at",
        },
        instalaciones: {
          cols: ["folio", "cliente_nombre"],
          select: "id,folio,estado,fecha_programada,created_at",
        },
        projects: {
          cols: ["nombre", "folio"],
          select: "id,nombre,folio,etapa,created_at",
        },
      };

      const sections: string[] = [];
      let total = 0;
      for (const t of targets) {
        const cfg = fieldMap[t];
        if (!cfg) {
          sections.push(`### ${t}\n*Unknown table, skipped.*`);
          continue;
        }
        // PostgREST OR clause: or=(col1.ilike.*kw*,col2.ilike.*kw*)
        const orClause = cfg.cols.map((c) => `${c}.ilike.${pattern}`).join(",");
        try {
          const data = await sbApi(
            `/${t}?or=(${encodeURIComponent(orClause)})&select=${encodeURIComponent(cfg.select)}&limit=${lim}`
          );
          const rows = Array.isArray(data) ? data : [data];
          total += rows.length;
          if (rows.length === 0) {
            sections.push(`### ${t}\n*No matches.*`);
          } else {
            sections.push(`### ${t} (${rows.length})\n\n${renderRecords(rows)}`);
          }
        } catch (err: any) {
          sections.push(`### ${t}\n*Error: ${err.message}*`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `## Search: "${query}" — ${total} result(s) across ${targets.length} table(s)\n\n${sections.join("\n\n")}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// KPI & ANALYTICS TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_lead_kpis",
  "Lead pipeline KPIs (org-wide). Returns total leads, closed amount, close rate, average ticket, projects sold, average sales cycle (days), open pipeline value, and breakdown by status. Mirrors the `useMyPipelineKPIs` widget on VentasHome but org-scoped (service role bypasses RLS).",
  {
    period: z
      .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
      .optional()
      .describe("Period filter on created_at. Default: this_month"),
    assigned_to: z.string().optional().describe("Restrict to a single owner uuid"),
  },
  async ({ period, assigned_to }) => {
    try {
      requireCredentials();
      const range = periodToRange(period ?? "this_month");
      const filters: RawFilter[] = [];
      if (range.gte) filters.push({ column: "created_at", op: "gte", value: range.gte });
      if (range.lte) filters.push({ column: "created_at", op: "lt", value: range.lte });
      if (assigned_to) filters.push({ column: "assigned_to", op: "eq", value: assigned_to });

      const baseQs = filtersToQs(filters);
      const allLeads: any[] = await sbApi(
        `/leads?${baseQs ? baseQs + "&" : ""}select=id,status,project_amount,is_converted,converted_at,created_at,assigned_to&limit=5000`
      );

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
      const cycleDays =
        converted.length > 0
          ? converted.reduce((s, l) => {
              const c = new Date(l.created_at).getTime();
              const co = l.converted_at ? new Date(l.converted_at).getTime() : c;
              return s + (co - c) / (1000 * 60 * 60 * 24);
            }, 0) / converted.length
          : 0;

      // Group by status
      const byStatus: Record<string, number> = {};
      for (const l of allLeads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;

      const fmt = (n: number) =>
        n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

      const statusRows = LEAD_STATUS_VALUES.map(
        (s) =>
          `| ${LEAD_STATUS_LABELS[s] ?? s} | ${byStatus[s] ?? 0} | ${
            total > 0 ? (((byStatus[s] ?? 0) / total) * 100).toFixed(1) : "0.0"
          }% |`
      ).join("\n");

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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Lead KPIs failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_ticket_kpis",
  "Ticket health KPIs: open vs resolved counts, SLA breaches (priority drives deadline: alta=1d, media=2d, baja=3d laborales), breakdown by area, by status, and by responsable.",
  {
    period: z
      .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
      .optional()
      .describe("Period filter on fecha_creacion. Default: this_month"),
  },
  async ({ period }) => {
    try {
      requireCredentials();
      const range = periodToRange(period ?? "this_month");
      const filters: RawFilter[] = [];
      if (range.gte) filters.push({ column: "fecha_creacion", op: "gte", value: range.gte });
      if (range.lte) filters.push({ column: "fecha_creacion", op: "lt", value: range.lte });

      const baseQs = filtersToQs(filters);
      const tickets: any[] = await sbApi(
        `/tickets?${baseQs ? baseQs + "&" : ""}select=id,folio,status,prioridad,canal,area,responsable,fecha_creacion,fecha_vencimiento&limit=5000`
      );

      const total = tickets.length;
      const now = Date.now();
      const open = tickets.filter((t) => t.status !== "resuelto");
      const resolved = tickets.filter((t) => t.status === "resuelto");
      const overdue = open.filter(
        (t) => t.fecha_vencimiento && new Date(t.fecha_vencimiento).getTime() < now
      );

      // by status
      const byStatus: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      const byArea: Record<string, number> = {};
      const byChannel: Record<string, number> = {};
      const byResp: Record<string, number> = {};
      for (const t of tickets) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        byPriority[t.prioridad] = (byPriority[t.prioridad] ?? 0) + 1;
        byArea[t.area ?? "—"] = (byArea[t.area ?? "—"] ?? 0) + 1;
        byChannel[t.canal ?? "—"] = (byChannel[t.canal ?? "—"] ?? 0) + 1;
        byResp[t.responsable ?? "(sin asignar)"] = (byResp[t.responsable ?? "(sin asignar)"] ?? 0) + 1;
      }

      const slaTable = Object.entries(TICKET_PRIORITY_SLA_DAYS)
        .map(([p, d]) => `| ${p} | ${d} días laborales |`)
        .join("\n");

      const top = (m: Record<string, number>) =>
        Object.entries(m)
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Ticket KPIs failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_instalacion_kpis",
  "Field installation KPIs: status breakdown (asignada/pendiente/en_proceso/completada/cancelada), completion rate, total jobs in period, panels installed, and per-cuadrilla counts.",
  {
    period: z
      .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
      .optional()
      .describe("Period filter on fecha_programada. Default: this_month"),
  },
  async ({ period }) => {
    try {
      requireCredentials();
      const range = periodToRange(period ?? "this_month");
      const filters: RawFilter[] = [];
      if (range.gte) filters.push({ column: "fecha_programada", op: "gte", value: range.gte });
      if (range.lte) filters.push({ column: "fecha_programada", op: "lt", value: range.lte });

      const baseQs = filtersToQs(filters);
      const rows: any[] = await sbApi(
        `/instalaciones?${baseQs ? baseQs + "&" : ""}select=id,folio,estado,cuadrilla_id,paneles,fecha_programada,checkin_at,checkout_at&limit=5000`
      );

      const total = rows.length;
      const byEstado: Record<string, number> = {};
      const byCuadrilla: Record<string, { total: number; completed: number; panels: number }> = {};
      let totalPanels = 0;
      let completedPanels = 0;

      for (const r of rows) {
        const e = r.estado ?? "—";
        byEstado[e] = (byEstado[e] ?? 0) + 1;

        const c = r.cuadrilla_id ?? "(sin cuadrilla)";
        const slot = (byCuadrilla[c] ??= { total: 0, completed: 0, panels: 0 });
        slot.total += 1;
        if (e === "completada") slot.completed += 1;
        const p = Number(r.paneles) || 0;
        slot.panels += p;
        totalPanels += p;
        if (e === "completada") completedPanels += p;
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
        .map(
          ([k, s]) =>
            `| ${k.slice(0, 8)} | ${s.total} | ${s.completed} | ${
              s.total > 0 ? ((s.completed / s.total) * 100).toFixed(1) : "0.0"
            }% | ${s.panels} |`
        )
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Instalacion KPIs failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_drone_leaderboard",
  "Drone usage leaderboard. Calls the get_user_drone_rankings RPC for the user leaderboard, and optionally get_drone_kpis for a single drone.",
  {
    drone_id: z.string().optional().describe("If set, return per-drone metrics via get_drone_kpis"),
  },
  async ({ drone_id }) => {
    try {
      requireCredentials();
      const sections: string[] = [];

      // User leaderboard
      try {
        const ranks = await sbRpc("get_user_drone_rankings");
        if (Array.isArray(ranks) && ranks.length > 0) {
          sections.push(`## User leaderboard\n\n${renderRecords(ranks)}`);
        } else {
          sections.push(`## User leaderboard\n\n*No data.*`);
        }
      } catch (err: any) {
        sections.push(`## User leaderboard\n\n*Error calling get_user_drone_rankings: ${err.message}*`);
      }

      // Per-drone if requested
      if (drone_id) {
        try {
          const kpis = await sbRpc("get_drone_kpis", { p_drone_id: drone_id });
          sections.push(
            `## Drone ${drone_id}\n\n\`\`\`json\n${JSON.stringify(kpis, null, 2)}\n\`\`\``
          );
        } catch (err: any) {
          sections.push(`## Drone ${drone_id}\n\n*Error calling get_drone_kpis: ${err.message}*`);
        }
      }

      return {
        content: [
          { type: "text", text: `# Drone KPIs\n\n${sections.join("\n\n")}` },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Drone leaderboard failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "futurerp_aggregate",
  "Group-by aggregate over any table. Useful for status histograms, owner breakdowns, monthly trends. Implements GROUP BY client-side over a fetched sample (PostgREST has no native GROUP BY) — for large tables, narrow with `filters` first.",
  {
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
  },
  async ({ table, group_by, measure, measure_column, filters, sample_limit, top }) => {
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
      const filterQs = filtersToQs(filters as RawFilter[] | undefined);
      if (filterQs) qsParts.push(filterQs);
      qsParts.push(`limit=${lim}`);

      const data = await sbApi(`/${table}?${qsParts.join("&")}`);
      const rows: any[] = Array.isArray(data) ? data : [data];

      const groups: Record<string, number[]> = {};
      for (const r of rows) {
        const key = r[group_by] === null || r[group_by] === undefined ? "(null)" : String(r[group_by]);
        const slot = (groups[key] ??= []);
        if (fn !== "count") {
          const n = Number(r[measure_column!]);
          if (!Number.isNaN(n)) slot.push(n);
        } else {
          slot.push(1);
        }
      }

      type Out = { key: string; value: number };
      let out: Out[] = Object.entries(groups).map(([k, arr]) => {
        let value: number;
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
        .map(
          (g) =>
            `| ${g.key} | ${
              fn === "count" || fn === "min" || fn === "max"
                ? Math.round(g.value).toLocaleString()
                : g.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
            } |`
        )
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Aggregate failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// PROJECT / FULL-CONTEXT
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_get_lead",
  "Combined lead view: lead row + recent crm_activities + stage history + converted project (if any). One-call context dump for analyzing a single lead.",
  {
    lead_id: z.string().describe("Lead uuid"),
    activity_limit: z.number().int().min(1).max(50).optional().describe("Max crm_activities to include (default 20)"),
  },
  async ({ lead_id, activity_limit }) => {
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
        sbApi(
          `/crm_activities?entity_type=eq.lead&entity_id=eq.${encodeURIComponent(lead_id)}&select=id,activity_type,category,subject,description,performed_by,created_at&order=created_at.desc&limit=${aLim}`
        ).catch(() => []),
        sbApi(
          `/lead_stage_history?lead_id=eq.${encodeURIComponent(lead_id)}&select=*&order=changed_at.desc&limit=20`
        ).catch(() => []),
        lead.converted_project_id
          ? sbApi(
              `/projects?id=eq.${encodeURIComponent(lead.converted_project_id)}&select=*&limit=1`
            ).catch(() => [])
          : Promise.resolve([]),
      ]);

      const projectRows = Array.isArray(project) ? project : [project];

      return {
        content: [
          {
            type: "text",
            text: [
              `# Lead: ${lead.first_name ?? ""} ${lead.last_name ?? ""} (\`${lead.id}\`)`,
              `**Status:** ${LEAD_STATUS_LABELS[lead.status] ?? lead.status}  •  **Owner:** ${lead.assigned_to ?? "(unassigned)"}  •  **Source:** ${lead.lead_source ?? "—"}`,
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
              `## Recent CRM activities (${Array.isArray(activities) ? activities.length : 0})`,
              "",
              renderRecords(Array.isArray(activities) ? activities : []),
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
    } catch (e: any) {
      return { content: [{ type: "text", text: `Get lead failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// REFERENCE
// ────────────────────────────────────────────────────────────

server.tool(
  "futurerp_field_mappings",
  "Reference dump of FuturERP's static knowledge: enum value cheatsheets, RPC catalog by category, SLA rules, key field semantics, Pronto↔Salesforce crosswalk (kept in sync with salesforce-futurenergy MCP).",
  {
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
  },
  async ({ mapping }) => {
    const sections: string[] = [];

    if (mapping === "lead_enums" || mapping === "all") {
      sections.push(
        [
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
        ].join("\n")
      );
    }

    if (mapping === "ticket_enums" || mapping === "all") {
      const te = PRONTO_ENUMS.filter((e) => e.name.startsWith("ticket_") || e.name === "activity_type");
      const block = te
        .map(
          (e) =>
            `**${e.name}**: ${e.values.map((v) => `\`${v}\`${e.labels?.[v] ? ` (${e.labels[v]})` : ""}`).join(", ")}`
        )
        .join("\n\n");
      sections.push(`## Ticket enums\n\n${block}`);
    }

    if (mapping === "notification_types" || mapping === "all") {
      const nt = PRONTO_ENUMS.find((e) => e.name === "notification_type")!;
      sections.push(
        `## Notification types (${nt.values.length})\n\n${nt.values.map((v) => `- \`${v}\``).join("\n")}`
      );
    }

    if (mapping === "rpc_catalog" || mapping === "all") {
      const grouped = getRpcsByCategory();
      const block = Object.entries(grouped)
        .map(
          ([cat, list]) =>
            `### ${cat}\n${list
              .map((r) => `- \`${r.name}\`${r.mutating ? " (mutating)" : ""} — ${r.purpose}`)
              .join("\n")}`
        )
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
      sections.push(
        [
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
        ].join("\n")
      );
    }

    return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
  }
);

// ────────────────────────────────────────────────────────────
// MCP PROMPTS
// ────────────────────────────────────────────────────────────

server.prompt(
  "futurerp_context",
  "Essential context about FuturERP (pronto-resolver). Use this as a session primer to learn the data model, key tables, enum vocabulary, and when to prefer FuturERP vs the generic Supabase MCP.",
  () => ({
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

## Key tools for common questions
- "How are we doing this month?" → \`futurerp_lead_kpis\` then \`futurerp_ticket_kpis\`
- "What's stuck?" → \`futurerp_ticket_kpis\` (SLA-overdue) and \`futurerp_aggregate\` on \`tickets\` grouped by \`status\` or \`responsable\`.
- "Show me lead X" → \`futurerp_get_lead\` for full context (row + stage history + activities + converted project).
- "Who's busiest with drones?" → \`futurerp_drone_leaderboard\`.
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
  })
);

server.prompt(
  "lead_funnel_analysis",
  "Analyze the lead funnel: stage breakdown, conversion, owner performance.",
  { period: z.string().optional().describe("this_month, last_month, this_quarter, this_year, etc.") },
  ({ period }) => ({
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
5. Identify bottlenecks: which stages have the most stuck leads? Compare to the visual stage order (LEAD_PIPELINE_STAGES).
6. Summarize with 3 actionable insights.`,
        },
      },
    ],
  })
);

server.prompt(
  "ticket_health_check",
  "Quick ticket-health dashboard: open count, SLA breaches, top responsables, top areas.",
  () => ({
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
  })
);

// ── Start ──────────────────────────────────────────────────

async function main() {
  const mode = hasCredentials() ? "DIRECT to Supabase" : "NO CREDENTIALS";
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`FuturERP MCP v1.0 (${mode})`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
