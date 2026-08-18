# Future Energy — Claude Config

Claude dotfiles for Future Energy. Contains MCP servers, skills, and an install script that sets everything up on any machine.

## What's included

```
futurenergy-claude/
├── mcp-servers/
│   ├── salesforce-futurenergy/   # Salesforce MCP (17 tools, KPIs, queries, documents)
│   └── futurerp/                 # FuturERP MCP (remote HTTP + OAuth; 30 tools — tickets/leads/instalaciones/WhatsApp)
├── skills/
│   ├── salesforce-futurenergy/   # Salesforce org knowledge
│   └── futurerp/                 # Pronto Resolver (internal ERP) knowledge
├── setup.sh                      # One-command installer
└── README.md
```

## Quick Setup (Mac)

### Prerequisites
- **Node.js 18+** and **npm** — [nodejs.org](https://nodejs.org) (LTS version, click the big green button)
- **Git** — optional if you download the ZIP instead of cloning
- **Claude Desktop** — [claude.ai/download](https://claude.ai/download) (or Claude Code)

`./setup.sh` checks for these and prints the right install command for your OS if anything's missing.

<details>
<summary>Install commands per OS</summary>

**macOS** (Homebrew):
```bash
brew install git node
```

**Ubuntu/Debian:**
```bash
sudo apt-get install -y git nodejs npm
# If apt's nodejs is < 18, use NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Arch / Manjaro:**
```bash
sudo pacman -S --noconfirm git nodejs npm
```

**Fedora / RHEL:**
```bash
sudo dnf install -y git nodejs npm
```

</details>

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

Edit the Salesforce `.env` with the credentials Jonas sent you:

```bash
nano mcp-servers/salesforce-futurenergy/.env   # SF_CLIENT_ID, SF_CLIENT_SECRET
```

Then **quit and reopen Claude Desktop** for the MCP servers to connect.

### FuturERP MCP (remote — no install, no keys)

FuturERP runs as a hosted MCP server. You log in with your **FuturERP account** (same as tickets.futurenergy.mx); what you can see follows your role there.

- **Claude Code**: `setup.sh` already registers it. Run `/mcp` → `futurerp` → **Authenticate** → your browser opens FuturERP → **Autorizar**. (Manual: `claude mcp add --transport http futurerp https://futurerp-mcp-production.up.railway.app/mcp`.)
- **Claude Desktop / claude.ai / mobile**: Settings → Connectors → **Add custom connector** → URL `https://futurerp-mcp-production.up.railway.app/mcp` → Connect → log in.

The exact URL is announced by Jonas; nothing else to configure. Access is granted per user in FuturERP → Admin → Permisos (`MCP / Claude`).

<details>
<summary>Operating it (Jonas): Railway service <code>futurerp-mcp</code> in "Futurenergy Stack"</summary>

```bash
cd mcp-servers/futurerp
railway link -p 68cd19f3-287d-4997-855c-41129a46e358 -e production -s futurerp-mcp   # once per machine
# env (once): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (data reads), SUPABASE_PUBLISHABLE_KEY (token check),
#             MCP_PUBLIC_URL=https://futurerp-mcp-production.up.railway.app/mcp
railway variables --set "KEY=value" ...
railway up --service futurerp-mcp        # build (npm ci + npm run build) and deploy this directory
railway logs                             # audit lines: {"t":…,"email":…,"tool":…}
```

Prerequisites on the Supabase project (`rczhnuurvcxtkfussmfj`): Authentication → OAuth Server **enabled**, Authorization Path `/oauth/consent`, Dynamic Client Registration **on**; the consent page ships with pronto-resolver-61 (`/oauth/consent`). Roles `MCP Básico` / `MCP WhatsApp` come from its migration `20260818120000_mcp_permissions.sql`.
</details>

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

Future Energy's internal operations platform — **pronto-resolver-61** on Supabase: tickets, leads (pronto-side), instalaciones, drones, cantina, reports, dashboards, financial milestones, notifications, WhatsApp. Read-only. Remote server (Streamable HTTP) with OAuth: you sign in with your FuturERP account; tools are visible per role — `mcp.access` (everything below) + `mcp.whatsapp` (the WhatsApp tools).

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

### Context dumps
- **futurerp_get_lead** — Lead row + crm_activities + stage history + converted project
- **futurerp_get_ticket** — Ticket + activities + linked project/lead/cliente (accepts folio or uuid)
- **futurerp_get_project** — Project + files + tramites + scheduled_payments + instalaciones + expenses + client
- **futurerp_get_instalacion** — Instalacion + photos + line items + visits + reports + cuadrilla profiles

### Files & documents
- **futurerp_list_files** — List files for any entity (project/lead/instalacion/visita/inventory_movement/announcement/cantina) with public download URLs
- **futurerp_download_file** — Fetch a file by URL: metadata + inline text for small text/JSON files (remote server — binaries via the URL)

### Financials
- **futurerp_get_project_financials** — Rolled-up P&L: budget vs expenses (approved/paid/pending), scheduled vs received payments, gross margin + status

### Named RPC wrappers
- **futurerp_sales_ranking** — Wraps `get_sales_ranking` RPC — vendor leaderboard
- **futurerp_marketing_stats** — Wraps `get_marketing_lead_stats` RPC — lead source attribution

### WhatsApp (requires `mcp.whatsapp`)
- **futurerp_whatsapp_chats** — Bot conversations overview (pending contacts + leads with bot activity)
- **futurerp_whatsapp_conversation** — Full thread for one contact (by lead_id / respond_contact_id / phone)
- **futurerp_whatsapp_stats** — In/out message stats by channel/day + funnel
- **futurerp_whatsapp_health** — Bot error log + webhook failures + stuck inbound buffer
- **futurerp_whatsapp_seguimientos** — Sales inbox (OpenWA) follow-up audit: unanswered clients, cold leads, per-vendor stats

### Reference
- **futurerp_field_mappings** — Lead/ticket enums, notification types, RPC catalog, SLA rules, key fields, Pronto↔Salesforce crosswalk
