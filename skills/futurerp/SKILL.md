---
name: futurerp
description: |
  Expert knowledge of FuturERP — Future Energy's internal operations platform
  (pronto-resolver-61, Supabase). Covers tickets, leads (pronto-side), instalaciones,
  drones, cantina, financial milestones, reports, and notifications. Companion to the
  futurerp MCP server for live queries.

  Use when: working with pronto-resolver data, ticket lifecycles, lead pipelines,
  installation KPIs, drone usage, cantina queues, custom reports, notifications,
  or anything in the company's day-to-day ops system. Distinct from Salesforce
  (which is the customer-facing sales CRM).
---

# FuturERP Expert

Knowledge of Future Energy's internal ERP — **pronto-resolver-61**, a React 18 + Supabase app that runs the day-to-day operations: tickets, leads, installations, drones, break-room (cantina), reports, dashboards, financial milestones, and notifications.

## When to use FuturERP vs other MCPs

| You want… | Use |
|---|---|
| Tickets, internal leads, instalaciones, drones, cantina, reports, dashboards, financial milestones, notifications | `futurerp_*` |
| Generic SQL / migrations / advisors / branch ops | `supabase_*` |
| Sales pipeline (Salesforce Opportunities, Accounts, customer-facing CRM) | `salesforce_*` |

> ⚠️ Pronto has its own `leads` table (internal CRM, marketing intake). Salesforce has its own `Lead` and `Opportunity` objects (customer-facing sales). They sync via `leads.salesforce_lead_id` but live in different MCPs.

## MCP tools

### Schema & metadata
| Tool | Purpose |
|---|---|
| `futurerp_describe_table` | Live column list for any table (types, nullability, defaults). Read this before querying an unfamiliar table. |
| `futurerp_list_tables` | List all tables grouped by domain category. Filter by keyword. |
| `futurerp_list_enums` | All PG enums + lead string-typed enums + CRM activity types. Read this before filtering by status/priority/type. |
| `futurerp_list_rpcs` | Catalog of all DB RPCs by category. Notes which mutate state (FuturERP only invokes read-only ones). |

### Data access
| Tool | Purpose |
|---|---|
| `futurerp_query` | Generic select with structured `filters`. Read-only. Max 200 rows. |
| `futurerp_count` | Fast count via HEAD + Prefer: count=exact. |
| `futurerp_get_record` | One row by id (or any unique column). |
| `futurerp_get_related` | Child rows by FK. E.g. ticket_activities for a ticket. |
| `futurerp_recent_records` | Last N rows of any table. Default order: `created_at.desc`. |

### Search
| Tool | Purpose |
|---|---|
| `futurerp_search` | Fuzzy ilike across tickets / leads / clients / instalaciones / projects. |

### KPIs & analytics
| Tool | Purpose |
|---|---|
| `futurerp_lead_kpis` | Pipeline KPIs (org-wide, scoped to a period). Mirrors VentasHome's Mi Pipeline widget but org-scoped. |
| `futurerp_ticket_kpis` | Open vs resolved, SLA breaches, breakdown by status / priority / area / channel / responsable. |
| `futurerp_instalacion_kpis` | Status breakdown, completion rate, per-cuadrilla panels and counts. |
| `futurerp_drone_leaderboard` | User leaderboard via `get_user_drone_rankings()`; per-drone via `get_drone_kpis()`. |
| `futurerp_aggregate` | Generic GROUP BY (count / sum / avg / min / max). Client-side over a row sample (cap 10k). |

### Context dumps
| Tool | Purpose |
|---|---|
| `futurerp_get_lead` | Combined lead view: row + crm_activities + stage history + converted project. |
| `futurerp_get_ticket` | Ticket + activities + linked project / lead / cliente. Accepts uuid or folio. |
| `futurerp_get_project` | Project row + files + tramites + scheduled_payments + instalaciones + expenses + client. Accepts uuid or EFU code. |
| `futurerp_get_instalacion` | Instalacion + photos + line items + visits (check-in/out) + reports + cuadrilla profiles. |
| `futurerp_field_mappings` | Static reference: lead_enums, ticket_enums, notification_types, rpc_catalog, sla_rules, key_fields, salesforce_crosswalk. |

### Files & documents
| Tool | Purpose |
|---|---|
| `futurerp_list_files` | List files for any entity (project, lead, instalacion, visita, inventory_movement, announcement, cantina). Returns metadata + public download URL. |
| `futurerp_download_file` | Download a file by URL and save locally. Defaults to `~/Downloads/futurerp/`. |

### Financials
| Tool | Purpose |
|---|---|
| `futurerp_get_project_financials` | Rolled-up P&L: budget vs expenses (approved/paid/pending), payments (scheduled/received/overdue), gross margin + status. |

### Named RPC wrappers
| Tool | Purpose |
|---|---|
| `futurerp_sales_ranking` | Wraps `get_sales_ranking(p_period_start, p_period_end)`. Vendor leaderboard. |
| `futurerp_marketing_stats` | Wraps `get_marketing_lead_stats(range_start?, range_end?)`. Lead source attribution + conversion. |

## Hard rules

- **Read-only**: the MCP never mutates. No INSERT / UPDATE / DELETE. Mutating RPCs are catalogued for reference only.
- **Service-role-equivalent key bypasses RLS**: results are org-wide. Always filter by `assigned_to` / `responsable` if you want a single-user view.
- **Spanish UI / es-MX locale**: dates `dd/mm/yyyy`, currency MXN, labels in Spanish where rendered for humans.
- **Auth key is sensitive**: lives in `~/.claude/mcp-servers/futurerp/.env` (gitignored). Never commit, never echo to user output. Either a new-style `sb_secret_*` key or the legacy `service_role` JWT works — both give the same access.

---

## Domain quick reference

### Leads (internal CRM)
- Pipeline stages: `nuevo → asignado → primer_contacto → seguimiento → visita_en_sitio → negociacion → calificado | descalificado`.
- `lead_qualification` (system-computed): `Good Lead`, `Warm Lead`, `Cold Lead`, `HOT Lead`, `Bad Lead`.
- `vendor_qualification` (manual override): `Super Hot`, `Hot`, `Warm`, `Cold`, `Super Cold`.
- `program`: `mejoravit` | `pyme` — drives which detail subtable applies (`lead_mejoravit_details` / `lead_pyme_details`).
- `is_discarded` + `discarded_by_rule_id` — filter rules in `lead_filter_rules` decide this.
- `salesforce_lead_id` — FK to Salesforce after sync.
- Round-robin assignment: pointer in `lead_round_robin_pointer`, log in `lead_assignment_log`.

### Tickets (incidencias)
- Folio format: `EFU-XXXXX-X`. Generated by RPC `generate_ticket_folio`.
- `prioridad` drives SLA:
  - `alta` → 1 día laboral (8 hours)
  - `media` → 2 días laborales (16 hours)
  - `baja` → 3 días laborales (24 hours)
- `status`: `abierto`, `en_progreso`, `resuelto`, `escalado`.
- `responsables_ids` (uuid[]) — authoritative; `responsables` (text[]) is just display names.
- `canal`: how it came in (whatsapp / email / telefono / presencial / reporte).
- Audit log: `ticket_activities` rows with `activity_type` discriminator.
- Overdue check: `status != 'resuelto' AND fecha_vencimiento < now()`.

### Instalaciones (field installs)
- `estado`: text column (NOT a PG enum). Values: `asignada`, `pendiente`, `en_proceso`, `completada`, `cancelada`.
- `cuadrilla_id`: FK to the installing team.
- GPS-tracked: `checkin_at`, `checkout_at`. GPS overrides go through `gps_override_requests`.
- Photos in `instalacion_fotos`; BOM in `instalacion_line_items`; payment milestones in `instalacion_income_schedule`.
- Per-cuadrilla KPIs: completion rate, panels installed, panels/hour, incidencia counts. See `futurerp_instalacion_kpis`.

### Drones
- `estado` PG enum: `available`, `checked_out`, `maintenance`, `lost`.
- Sessions in `drone_sessions` (checkout, checkin, charging cycles).
- RPC `get_current_battery_level(p_drone_id)` for live battery %.
- Leaderboard RPC: `get_user_drone_rankings`.

### Cantina (break-room)
- Resources: `water`, `ice`, `milk`, `coffee` (PG enum `resource_type`).
- Per-resource signup queue in `cantina_signups`.
- Status in `cantina_resource_status` (`available`, `out_of_stock`, `being_restocked`).
- Queue advances via RPC `advance_cantina_queue_on_completion`.

### Notifications
- 25 types in PG enum `notification_type` (ticket_*, lead_*, instalacion_*, gps_override_*, hitos_pago_*, anticipo1_*, `egresos_reales_validation_request`, system, etc.).
- `resource_type` (PG enum `notification_resource_type`) + `resource_id` say what the notification points at.
- Browser push subscriptions in `push_subscriptions`. Personal reminders in `reminders`.

### Approver workflows (server-enforced)
Three configurable email allowlists in `system_config`, each gating a `SECURITY DEFINER` RPC:
- `hitos_pago_approvers` → RPC `approve_hitos_pago(p_project_id)` — gates custom hitos when a project picks "Otro" in `hitos_pago`.
- `finanzas_approvers` → RPC `approve_anticipo1(p_project_id)` — gates a project leaving stage "Anticipo 1 Pagado".
- `egresos_reales_approvers` → RPC `approve_project_expense(p_expense_id)` — gates per-expense `draft → approved` on `project_expenses`. A `BEFORE INSERT OR UPDATE` trigger on `project_expenses` blocks direct status transitions into `approved`; the RPC bypasses via the `app.bypass_approve` GUC.

Each project (for hitos/anticipo) or expense row (for egresos) tracks `validation_requested_by`, `validation_requested_at`, `*validated_by` (or `approved_by`), `*validated_at` (or `approved_at`). Requesting validation fires a notification of the matching type (`hitos_pago_validation_request`, `anticipo1_validation_request`, `egresos_reales_validation_request`).

### Reports & dashboards
- Custom reports: definition in `reports`, executed via RPC `run_report(p_report_id, p_filters)`.
- Snapshots cached in `report_snapshots`. Subscriptions emailed by `process_report_subscriptions`.
- User-built dashboards = collections of `dashboard_widgets`. Visibility checked by `user_has_dashboard_permission`.
- Hardcoded **Dirección Comercial** dashboard at `/dashboards/direccion-comercial`. Gated by RBAC permission `dashboards.direccion_comercial.view` (seeded for Director Comercial + Director General). Six dedicated `SECURITY INVOKER` RPCs all check `has_crm_permission(auth.uid(), 'dashboards.direccion_comercial.view')`:
  - `dashboard_dc_kpis_month(p_month_start date)` — top KPI strip (ingreso, paneles, leads, cierre%, unassigned-projects)
  - `dashboard_dc_pipeline()` — 3 rows for mes/trim/anio (forecast/won/new-open/cierre%)
  - `dashboard_dc_sales_by_person(p_month_start date)` — per-rep ventas table
  - `dashboard_dc_funnel_by_person(p_period text)` — `'mes'|'trim'`, per-rep lead funnel by stage
  - `dashboard_dc_activity_by_person(p_month_start date)` — Llamada (`activity_type='call'`) + Cita (`'meeting'`) counts per rep
  - `dashboard_dc_alltime_totals()` — paneles + proyectos vendidos siempre

---

## RLS, permissions, and the service role key

The MCP uses Supabase's **service_role** key (server-to-server, bypasses RLS). That means:

- You see **every row in every table**, regardless of who's logged in to the app.
- For "what would Juan see?" questions, manually filter by `assigned_to = '<juan-uuid>'` or `responsables_ids = ANY(...)`.
- App-side permission checks (`has_role`, `has_crm_permission`, `user_has_dashboard_permission`) are bypassed — useful for analytics, but don't reproduce them in code paths that should respect RLS.

---

## How to answer common questions

| Question | Tool sequence |
|---|---|
| "How are we doing this month?" | `futurerp_lead_kpis period=this_month` → `futurerp_ticket_kpis period=this_month` → `futurerp_instalacion_kpis period=this_month`. |
| "What's overdue?" | `futurerp_ticket_kpis` (shows SLA-overdue count) → `futurerp_recent_records table=tickets filters=[{status, neq, resuelto}] order=fecha_vencimiento.asc`. |
| "Show me ticket EFU-00514-1" | `futurerp_get_ticket ticket_id=EFU-00514-1` — accepts folio or uuid, returns activities + linked records. |
| "Show me project EFU-00514-1" | `futurerp_get_project project_id=EFU-00514-1` — files, tramites, payments, instalaciones in one call. |
| "Show me lead X" | `futurerp_get_lead lead_id=<uuid>`. |
| "Show me instalacion X" | `futurerp_get_instalacion instalacion_id=<folio-or-uuid>` — photos, visits, reports, BOM. |
| "Get the photos / files for X" | `futurerp_list_files entity_type=<project\|lead\|instalacion\|visita\|...> parent_id=<uuid>` → optionally `futurerp_download_file url=<firebase_url>`. |
| "Is project X profitable?" | `futurerp_get_project_financials project_id=<EFU-or-uuid>` — budget, expenses, payments, margin. |
| "Top vendors in the last 90 days" | `futurerp_sales_ranking` (defaults: last 90 days). |
| "Where are leads coming from?" | `futurerp_marketing_stats range_start=<iso> range_end=<iso>`. |
| "Who's busiest?" | `futurerp_aggregate table=tickets group_by=responsable measure=count`. |
| "What stages have leads stuck?" | `futurerp_aggregate table=leads group_by=status measure=count`. |
| "Top vendors by closed amount" | `futurerp_aggregate table=leads group_by=assigned_to measure=sum measure_column=project_amount filters=[{is_converted, eq, true}]`. |
| "Drone usage" | `futurerp_drone_leaderboard`. |
| "What tables/fields exist?" | `futurerp_list_tables` → `futurerp_describe_table table=<name>`. |
| "What status values are valid?" | `futurerp_list_enums`. |
| "What RPCs can I call?" | `futurerp_list_rpcs`. |

## PostgREST filter cheat sheet

`filters` arrays use this shape:

```jsonc
[
  { "column": "status",         "op": "eq",   "value": "abierto" },
  { "column": "fecha_creacion", "op": "gte",  "value": "2026-05-01" },
  { "column": "fecha_creacion", "op": "lt",   "value": "2026-06-01" },
  { "column": "prioridad",      "op": "in",   "value": ["alta", "media"] },
  { "column": "responsable",    "op": "ilike","value": "*juan*" },
  { "column": "assigned_to",    "op": "is",   "value": "null" }
]
```

Supported ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`, `not.is`.

For `ilike`, use `*` as wildcard (PostgREST converts to `%`).

## Pronto ↔ Salesforce crosswalk

Mirrored from the `salesforce-futurenergy` MCP — kept in sync between both MCPs (update both schemas when one changes).

- **Visita Tecnica → Opportunity**: see `futurerp_field_mappings mapping=salesforce_crosswalk` or the SF MCP's `salesforce_field_mappings mapping_type=visita_to_opportunity`.
- **Photo category → Documento__c name**: same source.
- **Account email priority**: `PersonEmail` then `Email_Facturaci_n__c`.

## Don't memorize, ask the MCP

The schema is large (100 tables, 13 enums, ~50 callable RPCs). Instead of guessing column names or enum values:

1. `futurerp_list_tables` to find the table.
2. `futurerp_describe_table` to see its columns.
3. `futurerp_list_enums` to see valid values for any enum column.
4. `futurerp_field_mappings mapping=key_fields` for semantic hints on the important columns.
