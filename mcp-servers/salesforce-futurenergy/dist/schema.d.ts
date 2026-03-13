/**
 * Static Salesforce schema knowledge for Future Energy's org.
 * This serves as the "expert brain" when live describe isn't available.
 */
export interface SFField {
    name: string;
    label: string;
    type: string;
    custom: boolean;
    required?: boolean;
    picklistValues?: string[];
    description?: string;
}
export interface SFObject {
    name: string;
    label: string;
    description: string;
    fields: SFField[];
    relationships?: string[];
}
export declare const SALESFORCE_SCHEMA: Record<string, SFObject>;
/** Known document types that exist per Opportunity */
export declare const KNOWN_DOCUMENT_TYPES: string[];
/** Photo category to Salesforce document name mapping */
export declare const PHOTO_TO_DOCUMENT_MAP: Record<string, string>;
/** Visita Tecnica field to Salesforce Opportunity field mapping */
export declare const VT_TO_SF_FIELD_MAP: Record<string, string>;
/** Email field priority order for Account */
export declare const ACCOUNT_EMAIL_FIELDS: string[];
