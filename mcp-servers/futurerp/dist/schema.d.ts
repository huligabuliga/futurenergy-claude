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
export interface ProntoTable {
    name: string;
    category: TableCategory;
    purpose: string;
}
export type TableCategory = "lead" | "ticket" | "project" | "instalacion" | "drone" | "cantina" | "report" | "user" | "finance" | "catalog" | "notification" | "integration" | "system" | "junction";
export interface ProntoEnum {
    name: string;
    values: string[];
    /** Optional human-readable label for each value (Spanish UI). */
    labels?: Record<string, string>;
    description?: string;
}
export interface ProntoRpc {
    name: string;
    category: RpcCategory;
    purpose: string;
    /** True if the RPC mutates state. FuturERP MCP only exposes read-only ones, but the catalog lists all for reference. */
    mutating?: boolean;
}
export type RpcCategory = "kpi" | "lead" | "ticket" | "drone" | "cantina" | "report" | "permission" | "notification" | "finance" | "user" | "integration" | "internal";
export declare const PRONTO_TABLES: ProntoTable[];
export declare const PRONTO_ENUMS: ProntoEnum[];
export declare const LEAD_STATUS_VALUES: readonly ["nuevo", "asignado", "primer_contacto", "seguimiento", "visita_en_sitio", "negociacion", "calificado", "descalificado"];
export declare const LEAD_STATUS_LABELS: Record<string, string>;
export declare const LEAD_QUALIFICATION_VALUES: readonly ["Good Lead", "Warm Lead", "Cold Lead", "HOT Lead", "Bad Lead"];
export declare const VENDOR_QUALIFICATION_VALUES: readonly ["Super Hot", "Hot", "Warm", "Cold", "Super Cold"];
export declare const LEAD_PROGRAM_VALUES: readonly ["mejoravit", "pyme"];
export declare const CRM_ACTIVITY_TYPES: readonly ["note", "status_change", "call", "email", "meeting", "assignment", "field_update", "conversion", "system", "reminder"];
export declare const CRM_ACTIVITY_CATEGORIES: readonly ["incidencia_interna", "incidencia_externa", "retrabajo", "trabajo_electrico"];
/** Días laborales hasta vencimiento por prioridad (ticket). */
export declare const TICKET_PRIORITY_SLA_DAYS: Record<string, number>;
export declare const PRONTO_RPCS: ProntoRpc[];
/** Convenience: RPCs grouped by category for the `futurerp_list_rpcs` tool. */
export declare function getRpcsByCategory(): Record<string, ProntoRpc[]>;
/**
 * Photo category (Pronto Visita Tecnica) → Salesforce Documento__c name.
 * Source: salesforce-futurenergy/src/schema.ts (kept in sync — update both sides together).
 */
export declare const PHOTO_TO_DOCUMENT_MAP: Record<string, string>;
/**
 * Visita Tecnica form field (Pronto) → Salesforce Opportunity custom field.
 * Source: salesforce-futurenergy/src/schema.ts (kept in sync).
 */
export declare const VT_TO_SF_FIELD_MAP: Record<string, string>;
/** Salesforce Account email field priority order. */
export declare const ACCOUNT_EMAIL_FIELDS: string[];
export declare const KEY_FIELDS: Record<string, Record<string, string>>;
/**
 * Maps an "entity type" (the thing files attach to) to the table that stores those files
 * and the columns that hold url / filename / size / mime / uploader / category metadata.
 *
 * All blobs live in **Firebase Cloud Storage** (`firebase_url` columns) except announcement
 * and cantina attachments, which use Google Drive. Firebase URLs are *permanent* public
 * download URLs (Firebase mints them via getDownloadURL), so fetching them needs no auth.
 */
export interface FileTableSpec {
    table: string;
    fk: string;
    url: string;
    filename: string;
    size?: string;
    mime?: string;
    extension?: string;
    uploader?: string;
    category?: string;
    subcategory?: string;
    thumbnail?: string;
    /** Timestamp column to ORDER BY (most tables use `created_at`; visita_tecnica_photos and cantina_attachments use `uploaded_at`). */
    created?: string;
    /** Free-form notes about quirks (Google Drive vs Firebase, missing columns, etc.) */
    notes?: string;
}
export declare const FILE_TABLES: Record<string, FileTableSpec>;
export declare const FILE_ENTITY_TYPES: Array<keyof typeof FILE_TABLES>;
