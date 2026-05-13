/**
 * Static schema knowledge for FuturERP (pronto-resolver-61, Future Energy's internal ERP on Supabase).
 *
 * Acts as the "expert brain" when live OpenAPI describe is unavailable, and embeds domain
 * knowledge (enum values, RPC catalog, SLA rules, Pronto↔Salesforce field crosswalk) that
 * isn't recoverable from PostgREST metadata alone.
 *
 * Source of truth: pronto-resolver-61 (commit on `main`/`dev` at scaffold time).
 * Refresh when src/types/*.ts, src/integrations/supabase/types.ts, or migrations change.
 */
// ── Tables ──────────────────────────────────────────────────
export const PRONTO_TABLES = [
    // Lead domain
    { name: "leads", category: "lead", purpose: "Lead prospects in the sales pipeline. Primary CRM entity." },
    { name: "lead_stage_history", category: "junction", purpose: "Audit trail of lead.status transitions." },
    { name: "lead_transfer_history", category: "junction", purpose: "Audit trail of lead ownership changes (assigned_to / co_owner)." },
    { name: "lead_assignment_log", category: "junction", purpose: "Round-robin assignment log for diagnostics." },
    { name: "lead_files", category: "junction", purpose: "Files attached to leads (Firebase Storage refs)." },
    { name: "lead_filter_rules", category: "lead", purpose: "Admin-defined discard rules evaluated against new leads." },
    { name: "lead_mejoravit_details", category: "lead", purpose: "Mejoravit-program-specific lead detail rows." },
    { name: "lead_pyme_details", category: "lead", purpose: "PYME-program-specific lead detail rows." },
    { name: "lead_consumption_equipment", category: "junction", purpose: "Lead's high-consumption appliances list." },
    { name: "lead_round_robin_pointer", category: "system", purpose: "Pointer state for round-robin lead distribution." },
    { name: "crm_activities", category: "junction", purpose: "Activity log (note/call/email/meeting) on lead/contact/project." },
    // Ticket domain
    { name: "tickets", category: "ticket", purpose: "Internal support tickets (incidencias). Folio'd, SLA-tracked." },
    { name: "ticket_activities", category: "junction", purpose: "Comments + status/priority/assignment change log per ticket." },
    // Project / customer domain
    { name: "projects", category: "project", purpose: "Customer projects (converted leads, in execution)." },
    { name: "project_stage_history", category: "junction", purpose: "Audit trail of project stage transitions." },
    { name: "project_checklists", category: "project", purpose: "Per-project checklist instances." },
    { name: "project_clients", category: "junction", purpose: "Many-to-many between projects and clients." },
    { name: "project_consumption_equipment", category: "junction", purpose: "Project's installed high-consumption appliances." },
    { name: "project_docs_operativos", category: "project", purpose: "Operational documents per project." },
    { name: "project_documents", category: "project", purpose: "Generic document attachments per project." },
    { name: "project_expenses", category: "finance", purpose: "Expenses recorded against a project." },
    { name: "project_extra_works", category: "project", purpose: "Out-of-scope work items added to a project." },
    { name: "project_files", category: "junction", purpose: "File attachments per project." },
    { name: "project_products", category: "project", purpose: "Products/BOM lines per project." },
    { name: "project_receipts", category: "finance", purpose: "Payment receipts per project." },
    { name: "project_scheduled_payments", category: "finance", purpose: "Scheduled payment milestones per project." },
    { name: "project_tramites", category: "project", purpose: "Trámites (permits/paperwork) per project." },
    { name: "clients", category: "project", purpose: "Customer contact records." },
    { name: "tramite_file_links", category: "junction", purpose: "Files linked to a project_tramite." },
    // Instalacion (field installation)
    { name: "instalaciones", category: "instalacion", purpose: "Field installation work orders. Folio'd, scheduled, cuadrilla-assigned." },
    { name: "instalacion_fotos", category: "junction", purpose: "Photos attached to instalaciones." },
    { name: "instalacion_income_schedule", category: "finance", purpose: "Payment milestone schedule per instalacion." },
    { name: "instalacion_line_items", category: "instalacion", purpose: "Budget/BOM line items per instalacion." },
    { name: "installation_reports", category: "instalacion", purpose: "Installer-submitted post-work reports." },
    { name: "installation_report_messages", category: "junction", purpose: "Chat thread between installer and ops on a report." },
    { name: "installation_visits", category: "instalacion", purpose: "Installation visit log (multi-day jobs)." },
    { name: "gps_override_requests", category: "instalacion", purpose: "Installer requests to override GPS-based check-in location." },
    { name: "visitas_tecnicas", category: "instalacion", purpose: "Technical site survey visits (pre-installation)." },
    { name: "visita_tecnica_photos", category: "junction", purpose: "Photos attached to a visita tecnica." },
    // Drone inventory
    { name: "drones", category: "drone", purpose: "Drone inventory (DJI, Autel, etc.). Status, battery, location." },
    { name: "drone_sessions", category: "drone", purpose: "Checkout/checkin/charging sessions per drone." },
    // Cantina (break-room)
    { name: "cantina_resources", category: "cantina", purpose: "Break-room resources users queue for (water, ice, milk, coffee)." },
    { name: "cantina_signups", category: "cantina", purpose: "User signups in resource queues." },
    { name: "cantina_resource_status", category: "cantina", purpose: "Current stock status per resource." },
    { name: "cantina_attachments", category: "cantina", purpose: "Photos/proof attached to resource events." },
    { name: "cantina_notifications", category: "cantina", purpose: "Notification queue for cantina events." },
    // Reports / dashboards
    { name: "reports", category: "report", purpose: "User-defined custom reports (saved query + viz config)." },
    { name: "report_types", category: "report", purpose: "Available report base types (tickets, leads, instalaciones, ...)." },
    { name: "report_type_fields", category: "report", purpose: "Fields available per report type for selection/filter." },
    { name: "report_folders", category: "report", purpose: "Folder organization for reports." },
    { name: "report_folder_shares", category: "junction", purpose: "Folder sharing permissions." },
    { name: "report_shares", category: "junction", purpose: "Direct report sharing permissions." },
    { name: "report_favorites", category: "junction", purpose: "Per-user favorited reports." },
    { name: "report_read_status", category: "junction", purpose: "Per-user read state for reports." },
    { name: "report_run_log", category: "junction", purpose: "Audit log of report executions." },
    { name: "report_snapshots", category: "report", purpose: "Cached results of report runs for sharing." },
    { name: "report_subscriptions", category: "report", purpose: "Scheduled email subscriptions per report." },
    { name: "report_cross_filter_fields", category: "report", purpose: "Cross-report filter config: fields." },
    { name: "report_cross_filter_joins", category: "report", purpose: "Cross-report filter config: joins." },
    { name: "dashboards", category: "report", purpose: "User-defined dashboards (collections of widgets)." },
    { name: "dashboard_widgets", category: "report", purpose: "Widgets within a dashboard (charts/metrics/lists)." },
    { name: "dashboard_shares", category: "junction", purpose: "Dashboard sharing permissions." },
    // User / permissions
    { name: "profiles", category: "user", purpose: "Per-user app profile (extends auth.users)." },
    { name: "user_roles", category: "user", purpose: "Global app-role assignments (admin/technician/user)." },
    { name: "crm_roles", category: "user", purpose: "CRM permission role definitions." },
    { name: "user_crm_roles", category: "junction", purpose: "User → CRM role assignments." },
    { name: "user_config", category: "user", purpose: "Per-user preferences (accepted lead types, filters, etc.)." },
    { name: "user_home_config", category: "user", purpose: "Per-user home dashboard layout config." },
    { name: "saved_filters", category: "user", purpose: "Per-user saved filter presets." },
    // Finance
    { name: "expenses", category: "finance", purpose: "Generic expense entries (not project-scoped)." },
    { name: "payment_methods", category: "finance", purpose: "Accepted payment methods registry." },
    { name: "purchase_orders", category: "finance", purpose: "PO headers for procurement." },
    { name: "purchase_order_items", category: "finance", purpose: "PO line items." },
    { name: "inventory_movements", category: "finance", purpose: "Inventory in/out/transfer movements." },
    { name: "inventory_movement_files", category: "junction", purpose: "Evidence files attached to inventory movements." },
    { name: "accounting_categories", category: "finance", purpose: "Expense categorization (parent)." },
    { name: "accounting_subcategories", category: "finance", purpose: "Expense subcategorization." },
    { name: "marketing_spend", category: "finance", purpose: "Marketing/ad-spend records by campaign." },
    { name: "sales_targets", category: "finance", purpose: "Team/individual sales goal definitions." },
    { name: "financial_config", category: "finance", purpose: "Payment terms / currency / tax settings." },
    { name: "suppliers", category: "finance", purpose: "Supplier directory." },
    { name: "gestoras", category: "finance", purpose: "Gestoras (financing partners) directory." },
    // Catalog
    { name: "catalog_categories", category: "catalog", purpose: "Catalog item categories (panels, inversores, materiales)." },
    { name: "catalog_items", category: "catalog", purpose: "Equipment/materials catalog used in projects/instalaciones." },
    { name: "consumption_equipment", category: "catalog", purpose: "High-consumption appliance catalog (referenced by lead/project)." },
    { name: "simulation_templates", category: "catalog", purpose: "Solar sizing simulation template headers." },
    { name: "simulation_template_items", category: "catalog", purpose: "Items within a simulation template." },
    { name: "simulation_template_dependencies", category: "catalog", purpose: "Dependencies between simulation template items." },
    // Notifications + announcements
    { name: "notifications", category: "notification", purpose: "Per-user notification feed (typed: ticket/lead/instalacion/system…)." },
    { name: "announcements", category: "notification", purpose: "Org-wide broadcast announcements." },
    { name: "announcement_reads", category: "junction", purpose: "Per-user announcement read state." },
    { name: "announcement_attachments", category: "junction", purpose: "Files attached to announcements." },
    { name: "push_subscriptions", category: "notification", purpose: "Web push subscription endpoints per user." },
    { name: "reminders", category: "notification", purpose: "Personal reminders scheduled by users." },
    { name: "tasks", category: "notification", purpose: "Personal tasks (todo-style)." },
    // Integration
    { name: "google_calendar_tokens", category: "integration", purpose: "Per-user Google Calendar OAuth tokens." },
    { name: "chat_assignment_state", category: "integration", purpose: "Routing state for installer-report chat handlers." },
    { name: "ai_chat_messages", category: "integration", purpose: "Gemini AI chat thread messages (lead/project assistant)." },
    // System
    { name: "system_config", category: "system", purpose: "Global config key-value store." },
    { name: "short_links", category: "system", purpose: "Short link redirects." },
];
// ── Enums ──────────────────────────────────────────────────
export const PRONTO_ENUMS = [
    {
        name: "ticket_status",
        values: ["abierto", "en_progreso", "resuelto", "escalado"],
        labels: { abierto: "Abierto", en_progreso: "En Progreso", resuelto: "Resuelto", escalado: "Escalado" },
        description: "Ticket lifecycle state.",
    },
    {
        name: "ticket_priority",
        values: ["alta", "media", "baja"],
        labels: { alta: "Alta", media: "Media", baja: "Baja" },
        description: "Ticket urgency tier. Drives SLA: alta=1d, media=2d, baja=3d (laborales).",
    },
    {
        name: "ticket_channel",
        values: ["whatsapp", "email", "telefono", "presencial", "reporte"],
        labels: {
            whatsapp: "WhatsApp",
            email: "Email",
            telefono: "Teléfono",
            presencial: "Presencial",
            reporte: "Reporte",
        },
        description: "How the ticket originated.",
    },
    {
        name: "activity_type",
        values: ["comment", "status_change", "priority_change", "assignment_change", "created", "updated", "transfer"],
        description: "Event type on a ticket_activities row.",
    },
    {
        name: "app_role",
        values: ["admin", "technician", "user"],
        description: "Global app-role granted via user_roles.",
    },
    {
        name: "drone_status",
        values: ["available", "checked_out", "maintenance", "lost"],
        description: "Lifecycle state of a drone in inventory.",
    },
    {
        name: "resource_type",
        values: ["water", "ice", "milk", "coffee"],
        description: "Cantina (break-room) resource categories.",
    },
    {
        name: "resource_status",
        values: ["available", "out_of_stock", "being_restocked"],
        description: "Current stock state of a cantina resource.",
    },
    {
        name: "announcement_category",
        values: ["system_update", "event", "maintenance", "general", "urgent", "policy"],
        description: "Topic category of an announcement.",
    },
    {
        name: "announcement_visibility",
        values: ["all_users", "admin_only", "technician_only", "specific_departments"],
        description: "Who can see an announcement.",
    },
    {
        name: "notification_resource_type",
        values: ["ticket", "visita", "announcement", "system", "reminder", "instalacion", "lead", "project"],
        description: "Entity type a notification points at.",
    },
    {
        name: "notification_type",
        values: [
            "ticket_assigned",
            "ticket_transferred",
            "ticket_status_changed",
            "ticket_comment",
            "ticket_sla_warning",
            "ticket_created",
            "ticket_updated",
            "visita_created",
            "visita_updated",
            "announcement_published",
            "system",
            "todo_reminder",
            "gps_override_request",
            "gps_override_response",
            "installation_report_created",
            "installation_report_response",
            "lead_assigned",
            "lead_status_changed",
            "lead_sla_warning",
            "lead_aging_warning",
            "project_assigned",
            "project_stage_changed",
            "hitos_pago_validation_request",
            "anticipo1_validation_request",
        ],
        description: "Type discriminator for the notifications table.",
    },
    {
        name: "ai_chat_entity_type",
        values: ["project", "lead"],
        description: "Entity that an AI chat thread is anchored to.",
    },
];
// ── Lead string-typed enums (TS-level, not PG enums) ─────────
export const LEAD_STATUS_VALUES = [
    "nuevo",
    "asignado",
    "primer_contacto",
    "seguimiento",
    "visita_en_sitio",
    "negociacion",
    "calificado",
    "descalificado",
];
export const LEAD_STATUS_LABELS = {
    nuevo: "Nuevo",
    asignado: "Asignado",
    primer_contacto: "Primer Contacto",
    seguimiento: "Seguimiento",
    visita_en_sitio: "Visita en sitio",
    negociacion: "Negociación",
    calificado: "Calificado",
    descalificado: "Descalificado",
};
export const LEAD_QUALIFICATION_VALUES = [
    "Good Lead",
    "Warm Lead",
    "Cold Lead",
    "HOT Lead",
    "Bad Lead",
];
export const VENDOR_QUALIFICATION_VALUES = [
    "Super Hot",
    "Hot",
    "Warm",
    "Cold",
    "Super Cold",
];
export const LEAD_PROGRAM_VALUES = ["mejoravit", "pyme"];
export const CRM_ACTIVITY_TYPES = [
    "note",
    "status_change",
    "call",
    "email",
    "meeting",
    "assignment",
    "field_update",
    "conversion",
    "system",
    "reminder",
];
export const CRM_ACTIVITY_CATEGORIES = [
    "incidencia_interna",
    "incidencia_externa",
    "retrabajo",
    "trabajo_electrico",
];
// ── SLA rules ─────────────────────────────────────────────
/** Días laborales hasta vencimiento por prioridad (ticket). */
export const TICKET_PRIORITY_SLA_DAYS = {
    alta: 1,
    media: 2,
    baja: 3,
};
// ── RPC catalog ──────────────────────────────────────────
export const PRONTO_RPCS = [
    // KPI / analytics (read)
    { name: "get_sales_ranking", category: "kpi", purpose: "Top vendors by closed amount over a period." },
    { name: "get_marketing_lead_stats", category: "kpi", purpose: "Lead counts grouped by source / program / status." },
    { name: "get_user_performance_details", category: "kpi", purpose: "Per-user activity + outcome metrics." },
    { name: "get_user_response_times", category: "kpi", purpose: "Per-user first-response + follow-up latency stats." },
    { name: "get_drone_kpis", category: "kpi", purpose: "Per-drone usage stats (checkouts, minutes, battery)." },
    { name: "get_user_drone_kpis", category: "kpi", purpose: "Per-user drone usage stats." },
    { name: "get_user_drone_rankings", category: "kpi", purpose: "User leaderboard for drone checkouts/duration." },
    { name: "get_cantina_resource_metrics", category: "kpi", purpose: "Restocking timelines + assignment metrics per resource." },
    { name: "get_cantina_time_series", category: "kpi", purpose: "Cantina request/fulfillment time series." },
    { name: "get_cantina_user_metrics", category: "kpi", purpose: "Per-user cantina signup metrics." },
    { name: "get_announcement_statistics", category: "kpi", purpose: "Read/unread counts per announcement." },
    { name: "get_lead_stage_history_for_dashboard", category: "kpi", purpose: "Stage transition history scoped to visible leads." },
    // Lead management
    { name: "get_lead_assignable_users", category: "lead", purpose: "List users eligible to receive new leads." },
    { name: "evaluate_lead_filter_rules", category: "lead", purpose: "Test which discard rules a lead would match." },
    { name: "lead_filter_eval_condition", category: "lead", purpose: "Internal helper for filter rule evaluation." },
    // Ticket (mutating — exposed in catalog only, not as MCP tool)
    { name: "transfer_ticket", category: "ticket", purpose: "Reassign a ticket to a new primary responsable.", mutating: true },
    { name: "transfer_ticket_multi", category: "ticket", purpose: "Set multiple ticket responsables at once.", mutating: true },
    { name: "queue_ticket_notification", category: "ticket", purpose: "Queue a ticket-related notification (internal helper).", mutating: true },
    // Drone (mutating)
    { name: "checkout_drone", category: "drone", purpose: "Begin a drone checkout session.", mutating: true },
    { name: "checkin_drone", category: "drone", purpose: "End a drone session, update battery.", mutating: true },
    { name: "start_charging", category: "drone", purpose: "Mark a drone as charging.", mutating: true },
    { name: "get_current_battery_level", category: "drone", purpose: "Latest battery percentage for a drone." },
    // Cantina (mostly mutating)
    { name: "admin_inscribe_cantina_user", category: "cantina", purpose: "Add a user to a cantina resource queue.", mutating: true },
    { name: "admin_remove_cantina_user", category: "cantina", purpose: "Remove a user from a cantina resource queue.", mutating: true },
    { name: "advance_cantina_queue_on_completion", category: "cantina", purpose: "Advance queue after delivery.", mutating: true },
    { name: "reorder_cantina_queue", category: "cantina", purpose: "Reorder a cantina signup queue.", mutating: true },
    { name: "queue_cantina_notification", category: "cantina", purpose: "Queue a cantina-related notification.", mutating: true },
    // Reports (mostly read with internal helpers)
    { name: "run_report", category: "report", purpose: "Execute a custom report and return rows." },
    { name: "run_report_as_dashboard", category: "report", purpose: "Execute a report shaped for dashboard widget rendering." },
    { name: "list_report_tags", category: "report", purpose: "List report folder tags." },
    { name: "manage_report_tag", category: "report", purpose: "Create/update/delete a report tag.", mutating: true },
    { name: "build_report_sql", category: "report", purpose: "Compile a report definition to SQL (internal helper)." },
    { name: "capture_report_snapshot", category: "report", purpose: "Save current report results as a snapshot.", mutating: true },
    { name: "prune_report_snapshots", category: "report", purpose: "Garbage-collect old snapshots.", mutating: true },
    { name: "process_report_subscriptions", category: "report", purpose: "Run scheduled report email subscriptions.", mutating: true },
    // Permissions (read)
    { name: "has_role", category: "permission", purpose: "Check if caller has a given app_role." },
    { name: "has_crm_permission", category: "permission", purpose: "Check CRM-resource-level permission." },
    { name: "has_financial_admin_access", category: "permission", purpose: "Check finance-admin access." },
    { name: "user_has_dashboard_permission", category: "permission", purpose: "Check dashboard visibility for a user." },
    { name: "user_has_folder_permission", category: "permission", purpose: "Check report folder visibility for a user." },
    { name: "user_has_report_permission", category: "permission", purpose: "Check report visibility for a user." },
    // Notifications (mutating)
    { name: "create_notification", category: "notification", purpose: "Insert a notification row for a user.", mutating: true },
    { name: "mark_notification_read", category: "notification", purpose: "Mark a notification as read.", mutating: true },
    { name: "mark_announcement_as_read", category: "notification", purpose: "Mark an announcement as read by current user.", mutating: true },
    { name: "get_announcements_with_read_status", category: "notification", purpose: "Announcements with per-user read flag." },
    // Finance (mutating)
    { name: "approve_hitos_pago", category: "finance", purpose: "Approve a payment milestone on an instalacion.", mutating: true },
    { name: "pay_purchase_order_debt", category: "finance", purpose: "Record payment against a PO.", mutating: true },
    { name: "receive_purchase_order", category: "finance", purpose: "Mark a PO as received.", mutating: true },
    { name: "set_project_zona_cfe", category: "finance", purpose: "Set CFE tariff zone on a project from address.", mutating: true },
    { name: "link_projects_to_clients", category: "finance", purpose: "Backfill project↔client links.", mutating: true },
    { name: "convert_simulation", category: "finance", purpose: "Convert a sizing simulation into a project record.", mutating: true },
    // User
    { name: "get_user_info_for_webhook", category: "user", purpose: "Serialize a user (name/email/role) for outbound webhooks." },
    { name: "get_users_by_department", category: "user", purpose: "List users filtered by department." },
    // Integration
    { name: "get_webhook_config", category: "integration", purpose: "Fetch configured outbound webhook destinations." },
    { name: "short_link_resolve", category: "integration", purpose: "Resolve a short_links code to its target URL." },
    // System / config
    { name: "set_config", category: "internal", purpose: "Update a system_config key.", mutating: true },
];
/** Convenience: RPCs grouped by category for the `futurerp_list_rpcs` tool. */
export function getRpcsByCategory() {
    return PRONTO_RPCS.reduce((acc, rpc) => {
        (acc[rpc.category] ??= []).push(rpc);
        return acc;
    }, {});
}
// ── Pronto ↔ Salesforce crosswalk (mirrors salesforce-futurenergy schema.ts) ───
/**
 * Photo category (Pronto Visita Tecnica) → Salesforce Documento__c name.
 * Source: salesforce-futurenergy/src/schema.ts (kept in sync — update both sides together).
 */
export const PHOTO_TO_DOCUMENT_MAP = {
    drone_photos: "Fotos de droneo",
    roof_facade: "Fachada",
    meter: "Foto de medidor",
    load_center: "Centro de carga",
    roof_obstacles: "Fotos de droneo",
    roof_multiple_levels: "Fotos de droneo",
    roof_90_degrees: "Fotos de droneo",
    roof_isometric: "Fotos de droneo",
};
/**
 * Visita Tecnica form field (Pronto) → Salesforce Opportunity custom field.
 * Source: salesforce-futurenergy/src/schema.ts (kept in sync).
 */
export const VT_TO_SF_FIELD_MAP = {
    roof_type: "Tipo_de_techo__c",
    roof_type_other: "Tipo_de_techo_otro__c",
    roof_observations: "Observaciones_generales_del_techo__c",
    roof_obstacles: "Obst_culos_del_techo__c",
    electrical_route_proposed: "Ruta_de_canalizaci_n_desde_paneles__c",
    load_center_location: "Ubicaci_n_del_centro_de_carga__c",
    load_center_conditions: "Condiciones_del_centro_de_carga__c",
    internet_provider: "Proveedor_de_internet__c",
    network_type: "Tipo_de_red__c",
    additional_comments: "Comentarios_Adicionales__c",
    required_procedures: "Tr_mites_que_se_requieren__c",
};
/** Salesforce Account email field priority order. */
export const ACCOUNT_EMAIL_FIELDS = ["PersonEmail", "Email_Facturaci_n__c"];
// ── Key fields per primary entity (semantic hints for Claude) ───
export const KEY_FIELDS = {
    tickets: {
        folio: "Human-readable ticket code, e.g. EFU-00514-1. Unique, sequentially assigned by RPC generate_ticket_folio.",
        estado: "ticket_status enum. NB: Spanish 'estado' on Domain type but `status` on the DB row.",
        prioridad: "ticket_priority enum. Drives SLA via TICKET_PRIORITY_SLA_DAYS.",
        responsables_ids: "uuid[] — authoritative list of assignees. Display names live in `responsables` (text[]).",
        fecha_vencimiento: "Computed SLA deadline. Use this for overdue queries.",
        fecha_creacion: "Creation timestamp.",
        canal: "ticket_channel enum — origin of the request.",
    },
    leads: {
        status: "LeadStatus string enum (nuevo, asignado, primer_contacto, seguimiento, visita_en_sitio, negociacion, calificado, descalificado).",
        lead_qualification: "System-computed: Good/Warm/Cold/HOT/Bad Lead.",
        vendor_qualification: "Manual override: Super Hot, Hot, Warm, Cold, Super Cold.",
        assigned_to: "Primary owner (uuid).",
        co_owner_id: "Secondary owner.",
        next_contact_at: "Scheduled timestamp for next outreach. Singleton — rescheduling overwrites.",
        is_discarded: "True if filtered out by lead_filter_rules. discarded_by_rule_id points to rule.",
        salesforce_lead_id: "FK to Salesforce Lead Id (post-sync).",
        program: "mejoravit | pyme — drives which detail subtable applies.",
    },
    instalaciones: {
        folio: "Human-readable installation code.",
        cuadrilla_id: "FK to the installing team.",
        estado: "Installation state (asignada/pendiente/en_proceso/completada/cancelada — text column, not a PG enum).",
        fecha_programada: "Scheduled date.",
        checkin_at: "GPS check-in timestamp.",
        checkout_at: "GPS check-out timestamp.",
    },
    drones: {
        estado: "drone_status enum.",
        bateria_actual: "Latest battery percentage. See get_current_battery_level RPC.",
        manufacturer: "DJI, Autel, etc.",
    },
    notifications: {
        type: "notification_type enum (24 values — see PRONTO_ENUMS).",
        resource_type: "notification_resource_type enum.",
        resource_id: "FK into whichever table resource_type names.",
        read: "boolean — false until mark_notification_read.",
    },
};
