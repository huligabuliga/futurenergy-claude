#!/usr/bin/env node

/**
 * Salesforce Future Energy MCP Server v3.0
 *
 * Read-only Salesforce expert. Connects directly via OAuth2.
 * Can describe any object, query any data, get any record, search everything.
 *
 * Env vars:
 *   SF_CLIENT_ID       - Connected App Client ID
 *   SF_CLIENT_SECRET    - Connected App Client Secret
 *   SF_TOKEN_URL        - Override token URL (optional)
 *   SF_API_VERSION      - Override API version (optional)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
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
  SALESFORCE_SCHEMA,
  PHOTO_TO_DOCUMENT_MAP,
  VT_TO_SF_FIELD_MAP,
  ACCOUNT_EMAIL_FIELDS,
} from "./schema.js";

// ── Salesforce Connection ──────────────────────────────────

const SF_TOKEN_URL =
  process.env.SF_TOKEN_URL ??
  "https://energy-computing-2717.my.salesforce.com/services/oauth2/token";
const SF_API_VERSION = process.env.SF_API_VERSION ?? "v59.0";
const SF_CLIENT_ID = process.env.SF_CLIENT_ID ?? "";
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET ?? "";

let cachedToken: { accessToken: string; instanceUrl: string } | null = null;
let tokenExpiry: number | null = null;

// Describe cache: object name -> { data, fetchedAt }
const describeCache = new Map<string, { data: any; fetchedAt: number }>();
const DESCRIBE_TTL = 2 * 60 * 60 * 1000; // 2 hours

function hasCredentials(): boolean {
  return !!(SF_CLIENT_ID && SF_CLIENT_SECRET);
}

function requireCredentials() {
  if (!hasCredentials()) {
    throw new Error(
      "No Salesforce credentials. Set SF_CLIENT_ID and SF_CLIENT_SECRET in .mcp.json env."
    );
  }
}

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", SF_CLIENT_ID);
  params.append("client_secret", SF_CLIENT_SECRET);

  const res = await fetch(SF_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  cachedToken = { accessToken: data.access_token, instanceUrl: data.instance_url };
  tokenExpiry = Date.now() + 1.5 * 60 * 60 * 1000;
  return cachedToken;
}

async function sfApi(path: string): Promise<any> {
  const { accessToken, instanceUrl } = await getAccessToken();
  const url = `${instanceUrl}/services/data/${SF_API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce ${res.status}: ${text}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

async function sfDescribe(objectName: string): Promise<any> {
  const cached = describeCache.get(objectName);
  if (cached && Date.now() - cached.fetchedAt < DESCRIBE_TTL) {
    return cached.data;
  }
  const data = await sfApi(`/sobjects/${objectName}/describe`);
  describeCache.set(objectName, { data, fetchedAt: Date.now() });
  return data;
}

/**
 * Escape SOSL reserved characters so queries like "EFU-00514-1" don't break.
 * SOSL reserved chars: ? & | ! { } [ ] ( ) ^ ~ * : \ " ' + -
 */
function escapeSosl(query: string): string {
  return query.replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, "\\$&");
}

function cleanRecord(record: any): any {
  const cleaned = { ...record };
  delete cleaned.attributes;
  return cleaned;
}

function formatRecord(record: any, indent = 2): string {
  return JSON.stringify(cleanRecord(record), null, indent);
}

// ── Server ─────────────────────────────────────────────────

const server = new McpServer({
  name: "salesforce-futurenergy",
  version: "4.0.0",
});

// ────────────────────────────────────────────────────────────
// SCHEMA & METADATA TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "salesforce_describe_object",
  "Describe any Salesforce object live. Returns all fields with types, picklist values, required flags, and relationships. Use this to understand the structure of Lead, Opportunity, Account, Contact, or any custom object.",
  {
    object_name: z
      .string()
      .describe("Object API name: Lead, Opportunity, Account, Contact, Documento__c, User, etc."),
    custom_only: z.boolean().optional().describe("Only show custom fields (__c)"),
    picklists_only: z.boolean().optional().describe("Only show picklist/multipicklist fields with values"),
  },
  async ({ object_name, custom_only, picklists_only }) => {
    try {
      requireCredentials();
      const metadata = await sfDescribe(object_name);
      let fields: any[] = metadata.fields ?? [];

      if (custom_only) fields = fields.filter((f: any) => f.custom);
      if (picklists_only)
        fields = fields.filter(
          (f: any) => f.type === "picklist" || f.type === "multipicklist"
        );

      const fieldLines = fields.map((f: any) => {
        const req = !f.nillable && !f.defaultedOnCreate ? " *" : "";
        return `| \`${f.name}\` | ${f.label} | ${f.type}${req} | ${f.custom ? "Custom" : "Std"} |`;
      });

      const picklistFields = fields.filter(
        (f: any) =>
          (f.type === "picklist" || f.type === "multipicklist") &&
          f.picklistValues?.length > 0
      );
      const picklistSection = picklistFields
        .map((f: any) => {
          const values = f.picklistValues
            .filter((v: any) => v.active)
            .map((v: any) => `\`${v.value}\`${v.defaultValue ? " (default)" : ""}`)
            .join(", ");
          return `### ${f.label} (\`${f.name}\`)\n${f.type === "multipicklist" ? "*(multi-select)* " : ""}Values: ${values}`;
        })
        .join("\n\n");

      const totalCustom = (metadata.fields ?? []).filter((f: any) => f.custom).length;

      // Child relationships
      const children = (metadata.childRelationships ?? [])
        .filter((r: any) => r.relationshipName)
        .slice(0, 20)
        .map((r: any) => `- \`${r.relationshipName}\` -> ${r.childSObject} (via ${r.field})`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: [
              `## ${metadata.label} (\`${metadata.name}\`)`,
              `**Total fields:** ${metadata.fields?.length ?? 0} (${totalCustom} custom) | **Key prefix:** ${metadata.keyPrefix ?? "n/a"}`,
              `\n### Fields (${fields.length} shown)\n`,
              `| API Name | Label | Type | Custom |\n|----------|-------|------|--------|\n${fieldLines.join("\n")}`,
              picklistSection ? `\n## Picklist Values\n\n${picklistSection}` : "",
              children ? `\n## Child Relationships (top 20)\n\n${children}` : "",
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
  "salesforce_list_objects",
  "List Salesforce objects in the org. Filter by keyword or show only custom objects.",
  {
    filter: z.string().optional().describe("Keyword to filter (e.g., 'Lead', 'Document', 'Custom')"),
    custom_only: z.boolean().optional().describe("Only show custom objects"),
  },
  async ({ filter, custom_only }) => {
    try {
      requireCredentials();
      const data = await sfApi("/sobjects");
      let objects: any[] = data.sobjects ?? [];

      if (custom_only) objects = objects.filter((o: any) => o.custom);
      if (filter) {
        const kw = filter.toLowerCase();
        objects = objects.filter(
          (o: any) =>
            o.name.toLowerCase().includes(kw) || (o.label ?? "").toLowerCase().includes(kw)
        );
      }

      const lines = objects.map(
        (o: any) => `- **${o.label}** (\`${o.name}\`)${o.custom ? " [Custom]" : ""}`
      );
      return {
        content: [
          { type: "text", text: `## Salesforce Objects (${objects.length})\n\n${lines.join("\n")}` },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_get_field",
  "Get detailed info about a specific field: type, picklist values, required, formula, help text, references.",
  {
    object_name: z.string().describe("Object API name (e.g., 'Lead', 'Opportunity')"),
    field_name: z.string().describe("Field API name (e.g., 'Status', 'Tipo_de_techo__c')"),
  },
  async ({ object_name, field_name }) => {
    try {
      requireCredentials();
      const metadata = await sfDescribe(object_name);
      const field = (metadata.fields ?? []).find(
        (f: any) => f.name.toLowerCase() === field_name.toLowerCase()
      );
      if (!field)
        return {
          content: [{ type: "text", text: `Field "${field_name}" not found on ${object_name}.` }],
        };

      const lines = [
        `## ${field.label} (\`${field.name}\`)`,
        `- **Type:** ${field.type}`,
        `- **Custom:** ${field.custom}`,
        `- **Required:** ${!field.nillable}`,
        `- **Updateable:** ${field.updateable}`,
        `- **Length:** ${field.length || "n/a"}`,
      ];
      if (field.inlineHelpText) lines.push(`- **Help text:** ${field.inlineHelpText}`);
      if (field.calculatedFormula) lines.push(`- **Formula:** \`${field.calculatedFormula}\``);
      if (field.defaultValueFormula) lines.push(`- **Default:** \`${field.defaultValueFormula}\``);
      if (field.referenceTo?.length > 0)
        lines.push(`- **References:** ${field.referenceTo.join(", ")}`);
      if (field.picklistValues?.length > 0) {
        const vals = field.picklistValues
          .filter((v: any) => v.active)
          .map(
            (v: any) =>
              `  - \`${v.value}\`${v.label !== v.value ? ` (label: ${v.label})` : ""}${v.defaultValue ? " **default**" : ""}`
          )
          .join("\n");
        lines.push(`- **Picklist values:**\n${vals}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_search_fields",
  "Search for fields by keyword on any Salesforce object. Searches names, labels, and help text.",
  {
    object_name: z.string().describe("Object to search (e.g., 'Lead', 'Opportunity')"),
    keyword: z.string().describe("Keyword (e.g., 'email', 'phone', 'techo', 'status')"),
  },
  async ({ object_name, keyword }) => {
    try {
      requireCredentials();
      const metadata = await sfDescribe(object_name);
      const kw = keyword.toLowerCase();
      const matches = (metadata.fields ?? []).filter(
        (f: any) =>
          f.name.toLowerCase().includes(kw) ||
          f.label.toLowerCase().includes(kw) ||
          (f.inlineHelpText ?? "").toLowerCase().includes(kw)
      );

      if (matches.length === 0)
        return { content: [{ type: "text", text: `No fields matching "${keyword}" on ${object_name}.` }] };

      const lines = matches.map((f: any) => {
        let line = `- \`${f.name}\` (${f.type}${f.custom ? ", custom" : ""}) — ${f.label}`;
        if (f.picklistValues?.length > 0) {
          const vals = f.picklistValues
            .filter((v: any) => v.active)
            .slice(0, 8)
            .map((v: any) => v.value);
          const more = f.picklistValues.filter((v: any) => v.active).length > 8 ? "..." : "";
          line += `\n  Values: ${vals.map((v: string) => `\`${v}\``).join(", ")}${more}`;
        }
        return line;
      });

      return {
        content: [
          {
            type: "text",
            text: `## Fields matching "${keyword}" on ${object_name} (${matches.length})\n\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// DATA QUERY TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "salesforce_search",
  "Search Salesforce across objects using SOSL. Finds Leads, Opportunities, Accounts, Contacts, etc. by name, email, phone, or any text.",
  {
    query: z.string().describe("Search term (name, email, phone, EFU, project ID, etc.)"),
    objects: z
      .string()
      .optional()
      .describe("Comma-separated objects to search (default: Lead,Opportunity,Account,Contact)"),
  },
  async ({ query, objects }) => {
    try {
      requireCredentials();
      const objectList = objects ?? "Lead,Opportunity,Account,Contact";
      const returning = objectList
        .split(",")
        .map((o) => `${o.trim()}(Id, Name)`)
        .join(", ");
      const safeQuery = escapeSosl(query);
      const sosl = `FIND {${safeQuery}} IN ALL FIELDS RETURNING ${returning} LIMIT 25`;
      const data = await sfApi(`/search/?q=${encodeURIComponent(sosl)}`);
      const records = data.searchRecords ?? [];

      if (records.length === 0)
        return { content: [{ type: "text", text: `No results for "${query}".` }] };

      const lines = records.map(
        (r: any, i: number) =>
          `${i + 1}. **${r.Name}** (${r.attributes?.type}) — \`${r.Id}\``
      );
      return {
        content: [{ type: "text", text: `## Search: "${query}" (${records.length} results)\n\n${lines.join("\n")}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_query",
  "Run a SOQL query. Use this for flexible data retrieval: SELECT fields FROM object WHERE conditions. Returns up to 200 records.",
  {
    soql: z.string().describe("SOQL query, e.g. 'SELECT Id, Name, Status FROM Lead WHERE CreatedDate = THIS_MONTH LIMIT 10'"),
  },
  async ({ soql }) => {
    try {
      requireCredentials();
      const data = await sfApi(`/query/?q=${encodeURIComponent(soql)}`);
      const records = (data.records ?? []).map(cleanRecord);
      return {
        content: [
          {
            type: "text",
            text: `**${data.totalSize} record(s)**${data.totalSize > records.length ? ` (showing first ${records.length})` : ""}:\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Query failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_get_project",
  "Get a combined project overview in one call: Opportunity details + Account contact info + Documento__c checklist. Pass either a project_id (e.g. EFU-00514-1) or a Salesforce opportunity_id.",
  {
    project_id: z
      .string()
      .optional()
      .describe("Future Energy project ID, e.g. EFU-00514-1 (stored in ID_de_proyecto__c)"),
    opportunity_id: z
      .string()
      .optional()
      .describe("Salesforce Opportunity record ID (18-char). Used directly if project_id is not given."),
  },
  async ({ project_id, opportunity_id }) => {
    try {
      requireCredentials();

      if (!project_id && !opportunity_id) {
        return {
          content: [{ type: "text", text: "Provide project_id or opportunity_id." }],
          isError: true,
        };
      }

      // ── 1. Fetch Opportunity ─────────────────────────────────
      let opp: any;
      if (project_id) {
        const oppFields = [
          "Id", "Name", "StageName", "AccountId", "OwnerId",
          "ID_de_proyecto__c",
          "Paneles_Solicitados_Requeridos__c", "Medida_Real__c",
          "Tipo_de_techo__c", "Tipo_de_techo_otro__c", "Tipo_De_Proyecto__c",
          "Observaciones_generales_del_techo__c", "Obst_culos_del_techo__c",
          "Ruta_de_canalizaci_n_desde_paneles__c",
          "Ubicaci_n_del_centro_de_carga__c", "Condiciones_del_centro_de_carga__c",
          "Proveedor_de_internet__c", "Tipo_de_red__c",
          "Tr_mites_que_se_requieren__c", "Comentarios_Adicionales__c",
          "Direcci_n_Del_Proyecto__Street__s", "Direcci_n_Del_Proyecto__City__s",
          "Direcci_n_Del_Proyecto__StateCode__s", "Direcci_n_Del_Proyecto__PostalCode__s",
          "CreatedDate", "LastModifiedDate",
        ].join(", ");
        const soql = `SELECT ${oppFields} FROM Opportunity WHERE ID_de_proyecto__c = '${project_id}'`;
        const oppData = await sfApi(`/query/?q=${encodeURIComponent(soql)}`);
        if (!oppData.records?.length) {
          return {
            content: [{ type: "text", text: `No Opportunity found with ID_de_proyecto__c = '${project_id}'.` }],
            isError: true,
          };
        }
        opp = cleanRecord(oppData.records[0]);
      } else {
        opp = cleanRecord(await sfApi(`/sobjects/Opportunity/${opportunity_id}`));
      }

      // ── 2. Fetch Account ─────────────────────────────────────
      let account: any = null;
      if (opp.AccountId) {
        try {
          account = cleanRecord(
            await sfApi(
              `/sobjects/Account/${opp.AccountId}?fields=Id,Name,PersonEmail,PersonMobilePhone,Phone,Email_Facturaci_n__c`
            )
          );
        } catch {
          // PersonEmail may not exist on non-Person Accounts; retry without it
          try {
            account = cleanRecord(
              await sfApi(
                `/sobjects/Account/${opp.AccountId}?fields=Id,Name,PersonMobilePhone,Phone,Email_Facturaci_n__c`
              )
            );
          } catch {
            account = { Id: opp.AccountId, _error: "Could not fetch account details" };
          }
        }
      }

      // ── 3. Fetch Documents ───────────────────────────────────
      let docs: any[] = [];
      try {
        const docData = await sfApi(
          `/query/?q=${encodeURIComponent(
            `SELECT Id, Name, Requerido__c, Documento_Agregado__c FROM Documento__c WHERE Oportunidad__c = '${opp.Id}' ORDER BY Name`
          )}`
        );
        docs = (docData.records ?? []).map(cleanRecord);
      } catch {
        docs = [];
      }

      // ── 4. Format output ─────────────────────────────────────
      const addr = [
        opp["Direcci_n_Del_Proyecto__Street__s"],
        opp["Direcci_n_Del_Proyecto__City__s"],
        opp["Direcci_n_Del_Proyecto__StateCode__s"],
        opp["Direcci_n_Del_Proyecto__PostalCode__s"],
      ]
        .filter(Boolean)
        .join(", ");

      const oppLines = [
        `## Project: ${opp["ID_de_proyecto__c"] ?? opp.Name}`,
        `- **Opportunity:** ${opp.Name} (\`${opp.Id}\`)`,
        `- **Stage:** ${opp.StageName ?? "—"}`,
        `- **Type:** ${opp["Tipo_De_Proyecto__c"] ?? "—"}`,
        `- **Panels:** ${opp["Paneles_Solicitados_Requeridos__c"] ?? "—"} | **Size:** ${opp["Medida_Real__c"] ?? "—"}`,
        `- **Address:** ${addr || "—"}`,
        `- **Roof type:** ${opp["Tipo_de_techo__c"] ?? "—"}${opp["Tipo_de_techo_otro__c"] ? ` (${opp["Tipo_de_techo_otro__c"]})` : ""}`,
        opp["Observaciones_generales_del_techo__c"] ? `- **Roof notes:** ${opp["Observaciones_generales_del_techo__c"]}` : "",
        opp["Obst_culos_del_techo__c"] ? `- **Roof obstacles:** ${opp["Obst_culos_del_techo__c"]}` : "",
        `- **Electrical route:** ${opp["Ruta_de_canalizaci_n_desde_paneles__c"] ?? "—"}`,
        `- **Load center:** ${opp["Ubicaci_n_del_centro_de_carga__c"] ?? "—"} | **Condition:** ${opp["Condiciones_del_centro_de_carga__c"] ?? "—"}`,
        `- **Internet:** ${opp["Proveedor_de_internet__c"] ?? "—"} (${opp["Tipo_de_red__c"] ?? "—"})`,
        opp["Tr_mites_que_se_requieren__c"] ? `- **Procedures:** ${opp["Tr_mites_que_se_requieren__c"]}` : "",
        opp["Comentarios_Adicionales__c"] ? `- **Comments:** ${opp["Comentarios_Adicionales__c"]}` : "",
        `- **Created:** ${opp.CreatedDate?.slice(0, 10) ?? "—"} | **Modified:** ${opp.LastModifiedDate?.slice(0, 10) ?? "—"}`,
      ].filter(Boolean).join("\n");

      const accLines = account
        ? [
            `## Account`,
            `- **Name:** ${account.Name ?? "—"} (\`${account.Id}\`)`,
            `- **Email:** ${account.PersonEmail ?? account["Email_Facturaci_n__c"] ?? "—"}`,
            `- **Mobile:** ${account.PersonMobilePhone ?? "—"} | **Phone:** ${account.Phone ?? "—"}`,
          ].join("\n")
        : "## Account\n- No account linked.";

      const docLines =
        docs.length > 0
          ? [
              `## Documents (${docs.length})`,
              ...docs.map(
                (d) =>
                  `- **${d.Name}** | Required: ${d.Requerido__c ? "Yes" : "No"} | Files: ${d.Documento_Agregado__c ? "Yes" : "No"} | \`${d.Id}\``
              ),
            ].join("\n")
          : "## Documents\n- No Documento__c records found.";

      return {
        content: [
          {
            type: "text",
            text: [oppLines, accLines, docLines].join("\n\n---\n\n"),
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `salesforce_get_project failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_get_record",
  "Get a single Salesforce record by object type and ID. Works for any object: Lead, Opportunity, Account, Contact, User, Documento__c, etc.",
  {
    object_name: z.string().describe("Object API name (Lead, Opportunity, Account, Contact, User, etc.)"),
    record_id: z.string().describe("Salesforce record ID (15 or 18 char)"),
    fields: z
      .string()
      .optional()
      .describe("Comma-separated field names to return (default: all accessible fields)"),
  },
  async ({ object_name, record_id, fields }) => {
    try {
      requireCredentials();
      let path = `/sobjects/${object_name}/${record_id}`;
      if (fields) path += `?fields=${fields}`;
      const record = await sfApi(path);
      const name = record.Name ?? record.Id;
      return {
        content: [
          {
            type: "text",
            text: `## ${object_name}: ${name}\n\n\`\`\`json\n${formatRecord(record)}\n\`\`\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_get_related",
  "Get related records for a parent record. E.g., all Opportunities for an Account, all Activities for a Lead, all Documents for an Opportunity.",
  {
    object_name: z.string().describe("Parent object (e.g., 'Account', 'Opportunity', 'Lead')"),
    record_id: z.string().describe("Parent record ID"),
    relationship: z.string().describe("Relationship name (e.g., 'Opportunities', 'Contacts', 'Tasks', 'Notes', 'Documentos__r'). Use salesforce_describe_object to see available relationships."),
    fields: z.string().optional().describe("Comma-separated fields to return from child records (default: Id, Name)"),
  },
  async ({ object_name, record_id, relationship, fields }) => {
    try {
      requireCredentials();
      const fieldList = fields ?? "Id,Name";
      // Use relationship URL
      const path = `/sobjects/${object_name}/${record_id}/${relationship}`;
      const data = await sfApi(path);
      const records = (data.records ?? []).map(cleanRecord);

      if (records.length === 0)
        return { content: [{ type: "text", text: `No ${relationship} found for ${object_name} ${record_id}.` }] };

      return {
        content: [
          {
            type: "text",
            text: `## ${relationship} for ${object_name} ${record_id} (${data.totalSize ?? records.length})\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_recent_records",
  "Get recent records for any object type. Useful for seeing latest Leads, Opportunities, etc.",
  {
    object_name: z.string().describe("Object API name (Lead, Opportunity, Account, etc.)"),
    fields: z.string().optional().describe("Comma-separated fields (default: Id, Name, CreatedDate)"),
    limit: z.number().optional().describe("Max records to return (default: 10, max: 50)"),
    order_by: z.string().optional().describe("Field to order by (default: CreatedDate DESC)"),
    where: z.string().optional().describe("Optional WHERE clause without 'WHERE' keyword (e.g., \"Status = 'Open'\")"),
  },
  async ({ object_name, fields, limit, order_by, where }) => {
    try {
      requireCredentials();
      const fieldList = fields ?? "Id, Name, CreatedDate";
      const lim = Math.min(limit ?? 10, 50);
      const order = order_by ?? "CreatedDate DESC";
      const whereClause = where ? ` WHERE ${where}` : "";

      const soql = `SELECT ${fieldList} FROM ${object_name}${whereClause} ORDER BY ${order} LIMIT ${lim}`;
      const data = await sfApi(`/query/?q=${encodeURIComponent(soql)}`);
      const records = (data.records ?? []).map(cleanRecord);

      if (records.length === 0)
        return { content: [{ type: "text", text: `No ${object_name} records found.` }] };

      // Format as table if records have few fields
      const keys = Object.keys(records[0]);
      if (keys.length <= 6) {
        const header = `| ${keys.join(" | ")} |`;
        const sep = `| ${keys.map(() => "---").join(" | ")} |`;
        const rows = records.map(
          (r: any) => `| ${keys.map((k) => String(r[k] ?? "")).join(" | ")} |`
        );
        return {
          content: [
            {
              type: "text",
              text: `## Recent ${object_name} (${data.totalSize} total, showing ${records.length})\n\n${header}\n${sep}\n${rows.join("\n")}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `## Recent ${object_name} (${data.totalSize} total, showing ${records.length})\n\n\`\`\`json\n${JSON.stringify(records, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_count",
  "Count records for any object, optionally filtered. Quick way to get stats.",
  {
    object_name: z.string().describe("Object API name (Lead, Opportunity, Account, etc.)"),
    where: z.string().optional().describe("Optional WHERE clause (e.g., \"Status = 'Qualified'\" or \"CreatedDate = THIS_MONTH\")"),
  },
  async ({ object_name, where }) => {
    try {
      requireCredentials();
      const whereClause = where ? ` WHERE ${where}` : "";
      const soql = `SELECT COUNT() FROM ${object_name}${whereClause}`;
      const data = await sfApi(`/query/?q=${encodeURIComponent(soql)}`);
      const label = where ? `${object_name} where ${where}` : object_name;
      return {
        content: [{ type: "text", text: `**${data.totalSize}** ${label} records.` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// DOCUMENT TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "salesforce_get_documents",
  "Get Documento__c records for an Opportunity. Shows which documents exist, are required, and have files.",
  {
    opportunity_id: z.string().describe("Salesforce Opportunity ID"),
  },
  async ({ opportunity_id }) => {
    try {
      requireCredentials();
      const data = await sfApi(
        `/query/?q=${encodeURIComponent(
          `SELECT Id, Name, Requerido__c, Documento_Agregado__c FROM Documento__c WHERE Oportunidad__c = '${opportunity_id}' ORDER BY Name`
        )}`
      );
      const docs = (data.records ?? []).map(cleanRecord);
      if (docs.length === 0)
        return { content: [{ type: "text", text: "No Documento__c records found." }] };

      const lines = docs.map(
        (d: any) =>
          `- **${d.Name}** | Required: ${d.Requerido__c ? "Yes" : "No"} | Files: ${d.Documento_Agregado__c ? "Yes" : "No"} | \`${d.Id}\``
      );
      return {
        content: [{ type: "text", text: `## Documents (${docs.length})\n\n${lines.join("\n")}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_get_document_files",
  "Get files (ContentDocumentLinks) attached to a record. Works for Documento__c, Opportunity, Account, or any record.",
  {
    record_id: z.string().describe("Record ID to get files for (Documento__c ID, Opportunity ID, etc.)"),
  },
  async ({ record_id }) => {
    try {
      requireCredentials();
      const data = await sfApi(
        `/query/?q=${encodeURIComponent(
          `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileType, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '${record_id}'`
        )}`
      );
      const links = data.records ?? [];
      if (links.length === 0)
        return { content: [{ type: "text", text: "No files attached." }] };

      const lines = links.map((l: any) => {
        const cd = l.ContentDocument;
        const size = cd.ContentSize ? `${(cd.ContentSize / 1024).toFixed(1)} KB` : "?";
        return `- **${cd.Title}.${cd.FileExtension}** (${cd.FileType}, ${size}) — \`${l.ContentDocumentId}\` — ${cd.CreatedDate?.slice(0, 10) ?? ""}`;
      });

      return {
        content: [
          { type: "text", text: `## Files (${links.length})\n\n${lines.join("\n")}` },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_download_file",
  "Download a file from Salesforce by ContentDocumentId and save it locally. Returns the local file path.",
  {
    content_document_id: z.string().describe("ContentDocumentId of the file to download (from salesforce_get_document_files)"),
    save_dir: z.string().optional().describe("Directory to save the file to. Defaults to ~/Downloads/salesforce"),
  },
  async ({ content_document_id, save_dir }) => {
    try {
      requireCredentials();

      // Get the latest ContentVersion for this ContentDocument
      const versionData = await sfApi(
        `/query/?q=${encodeURIComponent(
          `SELECT Id, Title, FileExtension, ContentSize, VersionData FROM ContentVersion WHERE ContentDocumentId = '${content_document_id}' AND IsLatest = true LIMIT 1`
        )}`
      );

      const versions = versionData.records ?? [];
      if (versions.length === 0) {
        return { content: [{ type: "text", text: "No file version found for this ContentDocumentId." }], isError: true };
      }

      const version = versions[0];
      const fileName = `${version.Title}.${version.FileExtension}`;

      // Download the file binary
      const { accessToken, instanceUrl } = await getAccessToken();
      const downloadUrl = `${instanceUrl}/services/data/${SF_API_VERSION}/sobjects/ContentVersion/${version.Id}/VersionData`;
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Download failed ${res.status}: ${text}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // Save to local filesystem
      const targetDir = save_dir ?? join(homedir(), "Downloads", "salesforce");
      mkdirSync(targetDir, { recursive: true });
      const filePath = join(targetDir, fileName);
      writeFileSync(filePath, buffer);

      const sizeKB = (buffer.length / 1024).toFixed(1);

      return {
        content: [
          {
            type: "text",
            text: `## File Downloaded\n\n- **File:** ${fileName}\n- **Size:** ${sizeKB} KB\n- **Saved to:** \`${filePath}\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// KPI & ANALYTICS TOOLS
// ────────────────────────────────────────────────────────────

server.tool(
  "salesforce_kpis",
  "Get a full KPI dashboard for Future Energy in one call. Returns pipeline by stage, monthly trends, conversion metrics, project stats, and more. Perfect for management questions like 'how are we doing?' or 'show me the numbers'.",
  {
    period: z
      .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "all_time"])
      .optional()
      .describe("Time period for KPIs (default: this_month)"),
    include: z
      .enum(["all", "pipeline", "conversion", "projects", "owners", "leads"])
      .optional()
      .describe("Which KPI section to return (default: all)"),
  },
  async ({ period, include }) => {
    try {
      requireCredentials();

      const timePeriod = period ?? "this_month";
      const section = include ?? "all";

      // Build date filter based on period
      const dateFilters: Record<string, string> = {
        this_month: "CreatedDate = THIS_MONTH",
        last_month: "CreatedDate = LAST_MONTH",
        this_quarter: "CreatedDate = THIS_QUARTER",
        last_quarter: "CreatedDate = LAST_QUARTER",
        this_year: "CreatedDate = THIS_YEAR",
        last_year: "CreatedDate = LAST_YEAR",
        all_time: "",
      };
      const dateFilter = dateFilters[timePeriod];
      const whereDate = dateFilter ? ` WHERE ${dateFilter}` : "";
      const andDate = dateFilter ? ` AND ${dateFilter}` : "";

      const sections: string[] = [`# Future Energy KPIs — ${timePeriod.replace(/_/g, " ").toUpperCase()}\n`];

      // ── Pipeline by Stage ─────────────────────────────────
      if (section === "all" || section === "pipeline") {
        const stageData = await sfApi(
          `/query/?q=${encodeURIComponent(
            `SELECT StageName, COUNT(Id) cnt FROM Opportunity${whereDate} GROUP BY StageName ORDER BY COUNT(Id) DESC`
          )}`
        );
        const stageRecords = (stageData.records ?? []).map(cleanRecord);
        const totalOpps = stageRecords.reduce((sum: number, r: any) => sum + r.cnt, 0);

        const stageLines = stageRecords.map(
          (r: any) => `| ${r.StageName} | ${r.cnt} | ${totalOpps > 0 ? ((r.cnt / totalOpps) * 100).toFixed(1) : 0}% |`
        );
        sections.push(
          `## Pipeline by Stage (${totalOpps} total)\n\n| Stage | Count | % |\n|-------|-------|---|\n${stageLines.join("\n")}`
        );

        // Amount by stage (if Amount is populated)
        try {
          const amountData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT StageName, SUM(Amount) total, AVG(Amount) avg FROM Opportunity WHERE Amount != null${andDate ? andDate : whereDate ? andDate : ""} GROUP BY StageName ORDER BY SUM(Amount) DESC`
            )}`
          );
          const amountRecords = (amountData.records ?? []).map(cleanRecord);
          if (amountRecords.length > 0 && amountRecords.some((r: any) => r.total > 0)) {
            const amtLines = amountRecords
              .filter((r: any) => r.total > 0)
              .map(
                (r: any) =>
                  `| ${r.StageName} | $${Number(r.total).toLocaleString()} | $${Number(r.avg).toLocaleString(undefined, { maximumFractionDigits: 0 })} |`
              );
            sections.push(
              `## Revenue Pipeline\n\n| Stage | Total Amount | Avg Deal |\n|-------|-------------|----------|\n${amtLines.join("\n")}`
            );
          }
        } catch {}
      }

      // ── Conversion Metrics ────────────────────────────────
      if (section === "all" || section === "conversion") {
        const wonData = await sfApi(
          `/query/?q=${encodeURIComponent(
            `SELECT COUNT() FROM Opportunity WHERE IsWon = true${andDate}`
          )}`
        );
        const lostData = await sfApi(
          `/query/?q=${encodeURIComponent(
            `SELECT COUNT() FROM Opportunity WHERE IsClosed = true AND IsWon = false${andDate}`
          )}`
        );
        const totalData = await sfApi(
          `/query/?q=${encodeURIComponent(
            `SELECT COUNT() FROM Opportunity${whereDate}`
          )}`
        );

        const won = wonData.totalSize ?? 0;
        const lost = lostData.totalSize ?? 0;
        const total = totalData.totalSize ?? 0;
        const closed = won + lost;
        const open = total - closed;
        const winRate = closed > 0 ? ((won / closed) * 100).toFixed(1) : "N/A";

        sections.push(
          `## Conversion Metrics\n\n| Metric | Value |\n|--------|-------|\n| Total Opportunities | ${total} |\n| Won (Closed-Won) | ${won} |\n| Lost (Closed-Lost) | ${lost} |\n| Open (In Progress) | ${open} |\n| Win Rate | ${winRate}% |`
        );
      }

      // ── Project Stats ─────────────────────────────────────
      if (section === "all" || section === "projects") {
        // Roof type distribution
        try {
          const roofData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Tipo_de_techo__c, COUNT(Id) cnt FROM Opportunity WHERE Tipo_de_techo__c != null${andDate} GROUP BY Tipo_de_techo__c ORDER BY COUNT(Id) DESC`
            )}`
          );
          const roofRecords = (roofData.records ?? []).map(cleanRecord);
          if (roofRecords.length > 0) {
            const roofLines = roofRecords.map(
              (r: any) => `| ${r.Tipo_de_techo__c} | ${r.cnt} |`
            );
            sections.push(
              `## Roof Type Distribution\n\n| Type | Count |\n|------|-------|\n${roofLines.join("\n")}`
            );
          }
        } catch {}

        // Project type distribution
        try {
          const typeData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Tipo_De_Proyecto__c, COUNT(Id) cnt FROM Opportunity WHERE Tipo_De_Proyecto__c != null${andDate} GROUP BY Tipo_De_Proyecto__c ORDER BY COUNT(Id) DESC`
            )}`
          );
          const typeRecords = (typeData.records ?? []).map(cleanRecord);
          if (typeRecords.length > 0) {
            const typeLines = typeRecords.map(
              (r: any) => {
                // SF may return the field under various key casings
                const typeVal = r.Tipo_De_Proyecto__c ?? r.tipo_de_proyecto__c ?? Object.values(r).find((v: any) => typeof v === "string" && v !== "") ?? "Unknown";
                return `| ${typeVal} | ${r.cnt} |`;
              }
            );
            sections.push(
              `## Project Type Distribution\n\n| Type | Count |\n|------|-------|\n${typeLines.join("\n")}`
            );
          }
        } catch {}

        // Documents completion
        try {
          const docsTotal = await sfApi(
            `/query/?q=${encodeURIComponent(`SELECT COUNT() FROM Documento__c WHERE Requerido__c = true`)}`
          );
          const docsComplete = await sfApi(
            `/query/?q=${encodeURIComponent(`SELECT COUNT() FROM Documento__c WHERE Requerido__c = true AND Documento_Agregado__c = true`)}`
          );
          const docsTotalCount = docsTotal.totalSize ?? 0;
          const docsCompleteCount = docsComplete.totalSize ?? 0;
          const docsRate = docsTotalCount > 0 ? ((docsCompleteCount / docsTotalCount) * 100).toFixed(1) : "N/A";
          sections.push(
            `## Document Completion\n\n| Metric | Value |\n|--------|-------|\n| Required Documents | ${docsTotalCount} |\n| Completed | ${docsCompleteCount} |\n| Completion Rate | ${docsRate}% |`
          );
        } catch {}
      }

      // ── Owner Performance ─────────────────────────────────
      if (section === "all" || section === "owners") {
        try {
          const ownerData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Owner.Name, COUNT(Id) cnt FROM Opportunity${whereDate} GROUP BY Owner.Name ORDER BY COUNT(Id) DESC LIMIT 15`
            )}`
          );
          const ownerRecords = (ownerData.records ?? []).map(cleanRecord);
          if (ownerRecords.length > 0) {
            const ownerLines = ownerRecords.map(
              (r: any) => `| ${r.Name ?? "Unknown"} | ${r.cnt} |`
            );
            sections.push(
              `## Opportunities by Owner\n\n| Owner | Count |\n|-------|-------|\n${ownerLines.join("\n")}`
            );
          }
        } catch {}

        // Won by owner
        try {
          const wonOwnerData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Owner.Name, COUNT(Id) cnt FROM Opportunity WHERE IsWon = true${andDate} GROUP BY Owner.Name ORDER BY COUNT(Id) DESC LIMIT 15`
            )}`
          );
          const wonOwnerRecords = (wonOwnerData.records ?? []).map(cleanRecord);
          if (wonOwnerRecords.length > 0) {
            const wonOwnerLines = wonOwnerRecords.map(
              (r: any) => `| ${r.Name ?? "Unknown"} | ${r.cnt} |`
            );
            sections.push(
              `## Closed-Won by Owner\n\n| Owner | Won |\n|-------|-----|\n${wonOwnerLines.join("\n")}`
            );
          }
        } catch {}
      }

      // ── Lead Metrics ──────────────────────────────────────
      if (section === "all" || section === "leads") {
        // Total leads
        try {
          const leadTotal = await sfApi(
            `/query/?q=${encodeURIComponent(`SELECT COUNT() FROM Lead${whereDate}`)}`
          );
          sections.push(`## Leads Overview\n\n**Total Leads (${timePeriod.replace(/_/g, " ")}):** ${leadTotal.totalSize ?? 0}`);
        } catch {}

        // Leads by Status
        try {
          const statusData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Status, COUNT(Id) cnt FROM Lead${whereDate} GROUP BY Status ORDER BY COUNT(Id) DESC`
            )}`
          );
          const statusRecords = (statusData.records ?? []).map(cleanRecord);
          if (statusRecords.length > 0) {
            const totalLeads = statusRecords.reduce((sum: number, r: any) => sum + r.cnt, 0);
            const statusLines = statusRecords.map(
              (r: any) => `| ${r.Status ?? "—"} | ${r.cnt} | ${totalLeads > 0 ? ((r.cnt / totalLeads) * 100).toFixed(1) : 0}% |`
            );
            sections.push(
              `## Leads by Status\n\n| Status | Count | % |\n|--------|-------|---|\n${statusLines.join("\n")}`
            );
          }
        } catch {}

        // Leads by Source
        try {
          const sourceData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT LeadSource, COUNT(Id) cnt FROM Lead WHERE LeadSource != null${andDate} GROUP BY LeadSource ORDER BY COUNT(Id) DESC LIMIT 15`
            )}`
          );
          const sourceRecords = (sourceData.records ?? []).map(cleanRecord);
          if (sourceRecords.length > 0) {
            const sourceLines = sourceRecords.map(
              (r: any) => `| ${r.LeadSource} | ${r.cnt} |`
            );
            sections.push(
              `## Leads by Source\n\n| Source | Count |\n|--------|-------|\n${sourceLines.join("\n")}`
            );
          }
        } catch {}

        // Leads by Tipo_Lead__c (Hot/Warm/Cold)
        try {
          const tipoData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Tipo_Lead__c, COUNT(Id) cnt FROM Lead WHERE Tipo_Lead__c != null${andDate} GROUP BY Tipo_Lead__c ORDER BY COUNT(Id) DESC`
            )}`
          );
          const tipoRecords = (tipoData.records ?? []).map(cleanRecord);
          if (tipoRecords.length > 0) {
            const tipoLines = tipoRecords.map(
              (r: any) => `| ${r.Tipo_Lead__c} | ${r.cnt} |`
            );
            sections.push(
              `## Lead Quality (Tipo de Lead)\n\n| Type | Count |\n|------|-------|\n${tipoLines.join("\n")}`
            );
          }
        } catch {}

        // Lead conversion
        try {
          const convertedData = await sfApi(
            `/query/?q=${encodeURIComponent(`SELECT COUNT() FROM Lead WHERE IsConverted = true${andDate}`)}`
          );
          const unconvertedData = await sfApi(
            `/query/?q=${encodeURIComponent(`SELECT COUNT() FROM Lead WHERE IsConverted = false${andDate}`)}`
          );
          const converted = convertedData.totalSize ?? 0;
          const unconverted = unconvertedData.totalSize ?? 0;
          const totalLeads = converted + unconverted;
          const convRate = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : "N/A";
          sections.push(
            `## Lead Conversion\n\n| Metric | Value |\n|--------|-------|\n| Total Leads | ${totalLeads} |\n| Converted | ${converted} |\n| Not Converted | ${unconverted} |\n| Conversion Rate | ${convRate}% |`
          );
        } catch {}

        // Leads by Owner
        try {
          const leadOwnerData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Owner.Name, COUNT(Id) cnt FROM Lead${whereDate} GROUP BY Owner.Name ORDER BY COUNT(Id) DESC LIMIT 15`
            )}`
          );
          const leadOwnerRecords = (leadOwnerData.records ?? []).map(cleanRecord);
          if (leadOwnerRecords.length > 0) {
            const leadOwnerLines = leadOwnerRecords.map(
              (r: any) => `| ${r.Name ?? "Unknown"} | ${r.cnt} |`
            );
            sections.push(
              `## Leads by Owner\n\n| Owner | Count |\n|-------|-------|\n${leadOwnerLines.join("\n")}`
            );
          }
        } catch {}

        // Leads by Project Type
        try {
          const leadProjData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Tipo_De_Proyecto__c, COUNT(Id) cnt FROM Lead WHERE Tipo_De_Proyecto__c != null${andDate} GROUP BY Tipo_De_Proyecto__c ORDER BY COUNT(Id) DESC`
            )}`
          );
          const leadProjRecords = (leadProjData.records ?? []).map(cleanRecord);
          if (leadProjRecords.length > 0) {
            const leadProjLines = leadProjRecords.map(
              (r: any) => {
                const typeVal = r.Tipo_De_Proyecto__c ?? Object.values(r).find((v: any) => typeof v === "string" && v !== "") ?? "Unknown";
                return `| ${typeVal} | ${r.cnt} |`;
              }
            );
            sections.push(
              `## Leads by Project Type\n\n| Type | Count |\n|------|-------|\n${leadProjLines.join("\n")}`
            );
          }
        } catch {}

        // Disqualification reasons
        try {
          const dqData = await sfApi(
            `/query/?q=${encodeURIComponent(
              `SELECT Descalificacion_Opciones__c, COUNT(Id) cnt FROM Lead WHERE Descalificacion_Opciones__c != null${andDate} GROUP BY Descalificacion_Opciones__c ORDER BY COUNT(Id) DESC LIMIT 10`
            )}`
          );
          const dqRecords = (dqData.records ?? []).map(cleanRecord);
          if (dqRecords.length > 0) {
            const dqLines = dqRecords.map(
              (r: any) => `| ${r.Descalificacion_Opciones__c} | ${r.cnt} |`
            );
            sections.push(
              `## Top Disqualification Reasons\n\n| Reason | Count |\n|--------|-------|\n${dqLines.join("\n")}`
            );
          }
        } catch {}
      }

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `KPIs failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "salesforce_aggregate",
  "Run aggregate queries on Salesforce data without writing SOQL. Group by any field and get COUNT, SUM, AVG, MIN, MAX. Great for quick stats and breakdowns.",
  {
    object_name: z.string().describe("Object to aggregate (e.g., 'Opportunity', 'Lead', 'Account')"),
    group_by: z.string().describe("Field to group by (e.g., 'StageName', 'Tipo_de_techo__c', 'Owner.Name', 'CALENDAR_MONTH(CreatedDate)')"),
    measure: z
      .enum(["count", "sum", "avg", "min", "max"])
      .optional()
      .describe("Aggregate function (default: count)"),
    measure_field: z
      .string()
      .optional()
      .describe("Field to measure (required for sum/avg/min/max, e.g., 'Amount')"),
    where: z
      .string()
      .optional()
      .describe("Optional WHERE clause (e.g., \"CreatedDate = THIS_YEAR\", \"IsWon = true\")"),
    order_by: z
      .string()
      .optional()
      .describe("ORDER BY clause (default: count desc). Use 'value' to sort by the aggregate value."),
    limit: z.number().optional().describe("Max groups to return (default: 20)"),
  },
  async ({ object_name, group_by, measure, measure_field, where, order_by, limit }) => {
    try {
      requireCredentials();

      const fn = measure ?? "count";
      const lim = Math.min(limit ?? 20, 50);

      let selectExpr: string;
      let orderExpr: string;

      if (fn === "count") {
        selectExpr = `${group_by}, COUNT(Id) val`;
        orderExpr = order_by ?? "COUNT(Id) DESC";
      } else {
        if (!measure_field) {
          return {
            content: [{ type: "text", text: `measure_field is required for ${fn}. Provide a numeric field like 'Amount'.` }],
            isError: true,
          };
        }
        const fnUpper = fn.toUpperCase();
        selectExpr = `${group_by}, ${fnUpper}(${measure_field}) val`;
        orderExpr = order_by ?? `${fnUpper}(${measure_field}) DESC`;
      }

      const whereClause = where ? ` WHERE ${where}` : "";
      const soql = `SELECT ${selectExpr} FROM ${object_name}${whereClause} GROUP BY ${group_by} ORDER BY ${orderExpr} LIMIT ${lim}`;

      const data = await sfApi(`/query/?q=${encodeURIComponent(soql)}`);
      const records = (data.records ?? []).map(cleanRecord);

      if (records.length === 0) {
        return { content: [{ type: "text", text: `No results for aggregation on ${object_name}.` }] };
      }

      // Extract group value from record — SF uses expr0/expr1 for function-based group keys
      const getGroupVal = (r: any): string => {
        // Try direct field name
        const simpleKey = group_by.includes(".")
          ? group_by.split(".").pop()!
          : group_by;
        if (r[simpleKey] !== undefined) return String(r[simpleKey]);
        if (r[group_by] !== undefined) return String(r[group_by]);
        // For function expressions like CALENDAR_MONTH(CreatedDate), SF returns expr0
        for (const key of Object.keys(r)) {
          if (key.startsWith("expr") && key !== "val") return String(r[key]);
        }
        // Fallback: first non-val key
        for (const key of Object.keys(r)) {
          if (key !== "val") return String(r[key]);
        }
        return "null";
      };

      // Use a friendly label for function-based groupings
      const groupLabel = group_by;

      const header = `| ${groupLabel} | ${fn.toUpperCase()}${measure_field ? `(${measure_field})` : ""} |`;
      const sep = `|${"-".repeat(groupLabel.length + 2)}|${"-".repeat(20)}|`;
      const rows = records.map((r: any) => {
        const groupVal = getGroupVal(r);
        const val = fn === "count" ? r.val : Number(r.val).toLocaleString();
        return `| ${groupVal} | ${val} |`;
      });

      return {
        content: [
          {
            type: "text",
            text: `## ${fn.toUpperCase()} on ${object_name} grouped by ${group_by}\n\n${header}\n${sep}\n${rows.join("\n")}\n\n*SOQL:* \`${soql}\``,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Aggregate failed: ${e.message}` }], isError: true };
    }
  }
);

// ────────────────────────────────────────────────────────────
// MAPPING REFERENCE
// ────────────────────────────────────────────────────────────

server.tool(
  "salesforce_field_mappings",
  "Show Pronto Resolver <-> Salesforce field mappings: Visita Tecnica -> Opportunity, photo categories -> documents, email field priority.",
  {
    mapping_type: z
      .enum(["visita_to_opportunity", "photo_to_document", "email_fields", "all"])
      .describe("Which mapping to show"),
  },
  async ({ mapping_type }) => {
    const sections: string[] = [];

    if (mapping_type === "visita_to_opportunity" || mapping_type === "all") {
      const lines = Object.entries(VT_TO_SF_FIELD_MAP).map(
        ([vt, sf]) => `| ${vt} | \`${sf}\` |`
      );
      sections.push(
        `## Visita Tecnica -> Opportunity\n\n| VT Field | SF Field |\n|----------|----------|\n${lines.join("\n")}`
      );
    }
    if (mapping_type === "photo_to_document" || mapping_type === "all") {
      const lines = Object.entries(PHOTO_TO_DOCUMENT_MAP).map(
        ([cat, doc]) => `| ${cat} | ${doc} |`
      );
      sections.push(
        `## Photo -> Documento__c\n\n| Category | Document |\n|----------|----------|\n${lines.join("\n")}`
      );
    }
    if (mapping_type === "email_fields" || mapping_type === "all") {
      sections.push(
        `## Account Email Priority\n\n${ACCOUNT_EMAIL_FIELDS.map((f, i) => `${i + 1}. \`${f}\``).join("\n")}`
      );
    }

    return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
  }
);

// ────────────────────────────────────────────────────────────
// MCP PROMPTS (teach Claude Desktop about Future Energy's org)
// ────────────────────────────────────────────────────────────

server.prompt(
  "futurenergy_context",
  "Essential context about Future Energy's Salesforce org. Use this to understand the data model, key objects, stages, and how to answer questions about the solar installation business.",
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `You are a Salesforce expert for Future Energy (FutureEnergy), a solar panel installation company in Mexico. Here is the essential context about their Salesforce org:

## Business Model
Future Energy installs solar panels for residential and commercial clients in Mexico. Each project goes through stages from lead to installation.

## Key Salesforce Objects

### Opportunity (Main object — each = a solar project)
- **StageName** — pipeline stage (use salesforce_describe_object to see current picklist values)
- **ID_de_proyecto__c** — project ID like "EFU-00514-1"
- **Tipo_De_Proyecto__c** — project type (residential, commercial, etc.)
- **Paneles_Solicitados_Requeridos__c** — number of solar panels
- **Medida_Real__c** — system size in kW
- **Tipo_de_techo__c** — roof type (Concreto, Barroblock, Vigueta y bovedilla, Pergola, Envigado, Otro)
- **Condiciones_del_centro_de_carga__c** — load center condition (Saturado, Disponible, Requiere adecuaciones)
- **Tr_mites_que_se_requieren__c** — required CFE procedures (multi-select)
- **Amount** — deal value
- **AccountId** — linked client
- **OwnerId** — sales rep / project owner
- Address fields: Direcci_n_Del_Proyecto__Street__s, __City__s, __StateCode__s, __PostalCode__s

### Account (Client)
- Can be Person Account or Business Account
- **PersonEmail**, **Email_Facturaci_n__c** — email (check in this priority order)
- **PersonMobilePhone**, **Phone** — phone numbers

### Lead (Prospecto — incoming potential clients)
- **Status** — funnel stage: Nuevo, Asignado, Primer Contacto, Seguimiento, Visita en sitio, Negociación, Calificado, Descalificado
- **LeadSource** — where they came from: Facebook, Google AdWords, Instagram, Referido Por Cliente, WhatsApp, Landing page 2026, etc.
- **Tipo_Lead__c** — quality rating: HOT Lead, Good Lead, Warm Lead, Cold Lead, Bad Lead
- **Tipo_De_Proyecto__c** — Residencial, Comercial, Industrial
- **Tipo_de_Servicio__c** — PPA, Compra, Financiamiento, Mantenimiento, etc.
- **Paneles_Solicitados_Requeridos__c** — panels requested
- **Consumo_Energ_tico_Actual__c** — current energy consumption
- **Cuanto_Paga_Actualmente_en_Recibo__c** — current electricity bill range
- **Motivo_de_Interes__c** — reason: Reducción de Costos, Sostenibilidad, Independencia Energética, etc.
- **Descalificacion_Opciones__c** — disqualification reason (if applicable)
- **IsConverted** — whether lead became an Opportunity
- **OwnerId / Owner.Name** — assigned sales rep

### Documento__c (Document tracking per project)
- **Oportunidad__c** — parent Opportunity
- **Requerido__c** — is it required?
- **Documento_Agregado__c** — has file been uploaded?
- Document types: Fotos de droneo, Fachada, Foto de medidor, Centro de carga, 90 grados helioscope, isometría helioscope

## How to Answer KPI Questions
- **Pipeline overview:** Use salesforce_kpis with period filter, or salesforce_aggregate on Opportunity grouped by StageName
- **Conversion rate:** Won / (Won + Lost) — use salesforce_kpis with include="conversion"
- **Monthly trends:** salesforce_aggregate with group_by="CALENDAR_MONTH(CreatedDate)"
- **By sales rep:** salesforce_aggregate with group_by="Owner.Name"
- **Revenue:** salesforce_aggregate with measure="sum", measure_field="Amount"
- **Document completion:** salesforce_kpis with include="projects"
- **Project breakdown by type/roof/region:** salesforce_aggregate on the relevant field

## Important SOQL Date Literals
THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, THIS_YEAR, LAST_YEAR, TODAY, YESTERDAY, LAST_N_DAYS:30, THIS_FISCAL_YEAR

## Tips
- All custom fields end in __c
- Multi-picklist values are separated by semicolons in the API
- Use salesforce_describe_object to discover current picklist values for any field
- Project IDs (EFU-XXXXX-X) are in ID_de_proyecto__c
- For date-based graphs, group by CALENDAR_MONTH(CreatedDate) or CALENDAR_YEAR(CreatedDate)
- Present data in tables and suggest visualizations when asked about graphs`,
        },
      },
    ],
  })
);

server.prompt(
  "kpi_dashboard",
  "Quick prompt to get a full KPI dashboard. Just select this prompt and Claude will fetch all key metrics.",
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Give me a complete KPI dashboard for Future Energy. Use the salesforce_kpis tool with period='this_month' and include='all' to get the full overview. Then summarize the key insights and trends. If any numbers look notable (unusually high/low), call them out.",
        },
      },
    ],
  })
);

server.prompt(
  "pipeline_analysis",
  "Analyze the sales pipeline with stage breakdown, bottlenecks, and conversion insights.",
  { period: z.string().optional().describe("Time period: this_month, this_quarter, this_year, etc.") },
  ({ period }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Analyze Future Energy's sales pipeline for ${period ?? "this_quarter"}.
1. First use salesforce_kpis to get the overview
2. Then use salesforce_aggregate to break down by Owner.Name and by CALENDAR_MONTH(CreatedDate)
3. Identify bottlenecks: which stages have the most stuck deals?
4. What's the win rate? How does it compare across owners?
5. Summarize with actionable insights.`,
        },
      },
    ],
  })
);

// ── Start ──────────────────────────────────────────────────

async function main() {
  const mode = hasCredentials() ? "DIRECT to Salesforce" : "NO CREDENTIALS";
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Salesforce MCP v4.0 (${mode})`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
