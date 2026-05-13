# Future Energy — Claude Config

Claude dotfiles for Future Energy. Contains MCP servers, skills, and an install script that sets everything up on any machine.

## What's included

```
futurenergy-claude/
├── mcp-servers/
│   ├── salesforce-futurenergy/   # Salesforce MCP (17 tools, KPIs, queries, documents)
│   └── futurerp/                 # FuturERP MCP (17 tools, tickets/leads/instalaciones KPIs)
├── skills/
│   ├── salesforce-futurenergy/   # Salesforce org knowledge
│   └── futurerp/                 # Pronto Resolver (internal ERP) knowledge
├── setup.sh                      # One-command installer
└── README.md
```

## Quick Setup (Mac)

### Prerequisites
- **Node.js** — [nodejs.org](https://nodejs.org) (LTS version, click the big green button)
- **Claude Desktop** — [claude.ai/download](https://claude.ai/download)

### Install

**Option A — Download from GitHub (no git needed):**
1. Go to https://github.com/huligabuliga/futurenergy-claude
2. Click the green **Code** button → **Download ZIP**
3. Unzip it (double-click the .zip in Finder)
4. Open Terminal and run:
```bash
cd ~/Downloads/futurenergy-claude-main
chmod +x setup.sh
./setup.sh
```

**Option B — With git:**
```bash
git clone https://github.com/huligabuliga/futurenergy-claude.git
cd futurenergy-claude
./setup.sh
```

### After setup

Edit the `.env` files with the credentials Jonas sent you:

```bash
nano mcp-servers/salesforce-futurenergy/.env   # SF_CLIENT_ID, SF_CLIENT_SECRET
nano mcp-servers/futurerp/.env                  # SUPABASE_SERVICE_ROLE_KEY
```

Then **quit and reopen Claude Desktop** for the MCP servers to connect.

Test it by asking Claude:
- Salesforce: **"Dame los KPIs de este mes"**
- FuturERP: **"¿Cuántos tickets abiertos hay por área?"**

## Updating

Re-download the ZIP (or `git pull` if you used git), then run `./setup.sh` again. Restart Claude after updating.

---

## Salesforce MCP Tools

Future Energy's customer-facing CRM (Opportunities, Accounts, Leads, Documento__c).

### KPI & Analytics
- **salesforce_kpis** — Full dashboard: pipeline, conversion, leads, owners, projects
- **salesforce_aggregate** — Group-by queries: monthly trends, breakdowns by any field

### Data Access
- **salesforce_query** — Run any SOQL query
- **salesforce_search** — Search across all objects
- **salesforce_get_record** — Get any single record
- **salesforce_get_related** — Get child records
- **salesforce_recent_records** — Latest records for any object
- **salesforce_count** — Count records with filters
- **salesforce_get_project** — Full project overview

### Schema & Metadata
- **salesforce_describe_object** — All fields, types, picklist values
- **salesforce_list_objects** — List all Salesforce objects
- **salesforce_get_field** — Detailed field info
- **salesforce_search_fields** — Find fields by keyword

### Documents & Files
- **salesforce_get_documents** — Document checklist for an Opportunity
- **salesforce_get_document_files** — Files attached to any record
- **salesforce_download_file** — Download a file locally

### Reference
- **salesforce_field_mappings** — Pronto Resolver ↔ Salesforce mappings

---

## FuturERP MCP Tools

Future Energy's internal operations platform — **pronto-resolver-61** on Supabase: tickets, leads (pronto-side), instalaciones, drones, cantina, reports, dashboards, financial milestones, notifications. Read-only — bypasses RLS via the service role key.

### Schema & Metadata
- **futurerp_describe_table** — Live column list for any table (types, nullability, defaults, FK refs)
- **futurerp_list_tables** — All tables grouped by domain category
- **futurerp_list_enums** — PG enums + lead string-typed enums + CRM activity types
- **futurerp_list_rpcs** — Catalog of DB RPCs by category, with mutating flag

### Data Access
- **futurerp_query** — Generic select with structured filters (PostgREST under the hood)
- **futurerp_count** — Fast row count with filters
- **futurerp_get_record** — Single row by id (or any unique column)
- **futurerp_get_related** — Child rows by FK (e.g. ticket_activities for a ticket)
- **futurerp_recent_records** — Last N rows of any table

### Search
- **futurerp_search** — Fuzzy ilike across tickets, leads, clients, instalaciones, projects

### KPIs & Analytics
- **futurerp_lead_kpis** — Pipeline KPIs (close rate, avg ticket, projects sold, pipeline value, cycle days)
- **futurerp_ticket_kpis** — Open vs resolved, SLA breaches, by area / responsable / channel
- **futurerp_instalacion_kpis** — Status breakdown, completion rate, per-cuadrilla counts
- **futurerp_drone_leaderboard** — User leaderboard + per-drone metrics (via existing RPCs)
- **futurerp_aggregate** — Generic GROUP BY (count / sum / avg / min / max)

### Context
- **futurerp_get_lead** — Lead row + crm_activities + stage history + converted project, one call

### Reference
- **futurerp_field_mappings** — Lead/ticket enums, notification types, RPC catalog, SLA rules, key fields, Pronto↔Salesforce crosswalk
