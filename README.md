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

## Quick Setup

### Prerequisites
- **Node.js** — [nodejs.org](https://nodejs.org) (LTS version)
- **Git** — usually pre-installed on Mac
- **Claude Desktop** or **Claude Code**

### Install

```bash
git clone https://github.com/huligabuliga/futurenergy-claude.git
cd futurenergy-claude
./setup.sh
```

The script will:
1. Symlink the MCP server into `~/.claude/mcp-servers/`
2. Symlink all skills into `~/.claude/skills/`
3. Install npm dependencies and build the MCP server
4. Create `.env` from template (you fill in credentials)
5. Set up Claude Desktop config (Mac only)

After setup, edit the `.env` file with real credentials (ask Jonas):
```bash
nano mcp-servers/salesforce-futurenergy/.env
```

Then restart Claude Desktop or reconnect MCP in Claude Code.

## Updating

```bash
cd futurenergy-claude
git pull
./setup.sh
```

Restart Claude after updating.

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
