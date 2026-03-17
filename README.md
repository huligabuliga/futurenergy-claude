# Future Energy — Claude Config

Claude dotfiles for Future Energy. Contains MCP servers, skills, and an install script that sets everything up on any machine.

## What's included

```
futurenergy-claude/
├── mcp-servers/
│   └── salesforce-futurenergy/     # Salesforce MCP (17 tools, KPIs, queries)
├── skills/
│   └── salesforce-futurenergy/     # Salesforce org knowledge
├── setup.sh                        # One-command installer
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

Edit the `.env` file with the credentials Jonas sent you:
```bash
nano mcp-servers/salesforce-futurenergy/.env
```

Then **quit and reopen Claude Desktop** for the MCP server to connect.

Test it by asking Claude: **"Dame los KPIs de este mes"**

## Updating

Re-download the ZIP (or `git pull` if you used git), then run `./setup.sh` again. Restart Claude after updating.

## Salesforce MCP Tools

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
- **salesforce_field_mappings** — Pronto Resolver <> Salesforce mappings
