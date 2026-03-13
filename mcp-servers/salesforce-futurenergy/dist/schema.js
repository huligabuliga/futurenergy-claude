/**
 * Static Salesforce schema knowledge for Future Energy's org.
 * This serves as the "expert brain" when live describe isn't available.
 */
export const SALESFORCE_SCHEMA = {
    Opportunity: {
        name: "Opportunity",
        label: "Opportunity (Oportunidad)",
        description: "Solar installation projects for Future Energy clients. Each opportunity represents a potential or active solar panel installation project.",
        relationships: [
            "Account (AccountId) - Client account",
            "Documento__c (Oportunidad__c) - Related documents",
            "ContentDocumentLink - Attached files",
        ],
        fields: [
            // Standard fields
            { name: "Id", label: "Record ID", type: "id", custom: false },
            { name: "Name", label: "Opportunity Name", type: "string", custom: false },
            { name: "StageName", label: "Stage", type: "picklist", custom: false },
            { name: "AccountId", label: "Account ID", type: "reference", custom: false },
            { name: "OwnerId", label: "Owner ID", type: "reference", custom: false },
            { name: "CreatedDate", label: "Created Date", type: "datetime", custom: false },
            { name: "LastModifiedDate", label: "Last Modified Date", type: "datetime", custom: false },
            // Custom fields - Project Info
            {
                name: "ID_de_proyecto__c",
                label: "Project ID",
                type: "string",
                custom: true,
                description: "Internal project identifier (e.g., PRJ-001)",
            },
            {
                name: "Paneles_Solicitados_Requeridos__c",
                label: "Requested/Required Panels",
                type: "number",
                custom: true,
                description: "Number of solar panels requested for the installation",
            },
            {
                name: "Medida_Real__c",
                label: "Real Measurement",
                type: "string",
                custom: true,
                description: "Actual system size (e.g., '4.5 kW')",
            },
            // Custom fields - Roof
            {
                name: "Tipo_de_techo__c",
                label: "Roof Type",
                type: "picklist",
                custom: true,
                picklistValues: [
                    "Concreto",
                    "Concreto aligerado",
                    "Barroblock",
                    "Vigueta y bovedilla",
                    "Pergola",
                    "Envigado",
                    "Otro",
                ],
                description: "Type of roof at the installation site",
            },
            {
                name: "Tipo_de_techo_otro__c",
                label: "Other Roof Type",
                type: "string",
                custom: true,
                description: "Free text when roof type is 'Otro'",
            },
            {
                name: "Observaciones_generales_del_techo__c",
                label: "General Roof Observations",
                type: "textarea",
                custom: true,
                description: "General observations about the roof condition",
            },
            {
                name: "Obst_culos_del_techo__c",
                label: "Roof Obstacles",
                type: "textarea",
                custom: true,
                description: "Description of obstacles on the roof",
            },
            {
                name: "Fotos_del_techo_fueron_tomadas__c",
                label: "Roof Photos Taken",
                type: "boolean",
                custom: true,
                description: "Whether drone/roof photos have been uploaded",
            },
            // Custom fields - Address (compound)
            {
                name: "Direcci_n_Del_Proyecto__c",
                label: "Project Address (compound)",
                type: "address",
                custom: true,
                description: "Compound address field with sub-fields: street, city, state, stateCode, postalCode, country, countryCode, latitude, longitude",
            },
            {
                name: "Direcci_n_Del_Proyecto__Street__s",
                label: "Project Address - Street",
                type: "string",
                custom: true,
            },
            {
                name: "Direcci_n_Del_Proyecto__City__s",
                label: "Project Address - City",
                type: "string",
                custom: true,
            },
            {
                name: "Direcci_n_Del_Proyecto__StateCode__s",
                label: "Project Address - State Code",
                type: "string",
                custom: true,
            },
            {
                name: "Direcci_n_Del_Proyecto__PostalCode__s",
                label: "Project Address - Postal Code",
                type: "string",
                custom: true,
            },
            {
                name: "Direcci_n_Del_Proyecto__CountryCode__s",
                label: "Project Address - Country Code",
                type: "string",
                custom: true,
            },
            // Custom fields - Electrical
            {
                name: "Ruta_de_canalizaci_n_desde_paneles__c",
                label: "Electrical Route from Panels",
                type: "textarea",
                custom: true,
                description: "Proposed electrical routing from panels to load center",
            },
            {
                name: "Ubicaci_n_del_centro_de_carga__c",
                label: "Load Center Location",
                type: "string",
                custom: true,
                description: "Physical location of the electrical load center",
            },
            {
                name: "Condiciones_del_centro_de_carga__c",
                label: "Load Center Conditions",
                type: "picklist",
                custom: true,
                picklistValues: ["Saturado", "Disponible", "Requiere adecuaciones"],
                description: "Condition of the load center",
            },
            {
                name: "Foto_de_medidor_tomada__c",
                label: "Meter Photo Taken",
                type: "boolean",
                custom: true,
                description: "Whether meter photo has been uploaded",
            },
            // Custom fields - Internet
            {
                name: "Proveedor_de_internet__c",
                label: "Internet Provider",
                type: "string",
                custom: true,
                description: "Client's ISP name",
            },
            {
                name: "Tipo_de_red__c",
                label: "Network Type",
                type: "picklist",
                custom: true,
                picklistValues: ["2.4 GHz", "5 GHz", "Ambas"],
                description: "WiFi network frequency type",
            },
            // Custom fields - Procedures
            {
                name: "Tr_mites_que_se_requieren__c",
                label: "Required Procedures",
                type: "multipicklist",
                custom: true,
                picklistValues: [
                    "Cambio de nombre",
                    "aumento de voltaje",
                    "Trámite de medidor bidireccional",
                    "Alta de servicio",
                    "Baja de servicio",
                    "Factibilidad técnica",
                    "UVIE",
                    "UIIE",
                    "Retiro de pago automático con tarjeta",
                    "Otro",
                ],
                description: "CFE procedures required for the installation. Multi-select, values separated by semicolons in API.",
            },
            // Custom fields - Other
            {
                name: "Comentarios_Adicionales__c",
                label: "Additional Comments",
                type: "textarea",
                custom: true,
                description: "Additional comments from the technical visit",
            },
        ],
    },
    Account: {
        name: "Account",
        label: "Account (Cuenta)",
        description: "Client accounts (can be Person Accounts or Business Accounts). Linked to Opportunities.",
        relationships: [
            "Opportunity (AccountId) - Related opportunities",
        ],
        fields: [
            { name: "Id", label: "Record ID", type: "id", custom: false },
            { name: "Name", label: "Account Name", type: "string", custom: false },
            { name: "Phone", label: "Phone", type: "phone", custom: false },
            {
                name: "PersonEmail",
                label: "Person Email",
                type: "email",
                custom: false,
                description: "Email for Person Account type",
            },
            {
                name: "PersonMobilePhone",
                label: "Person Mobile Phone",
                type: "phone",
                custom: false,
                description: "Mobile phone for Person Account type",
            },
            {
                name: "Email_Facturaci_n__c",
                label: "Billing Email",
                type: "email",
                custom: true,
                description: "Email for billing/invoicing",
            },
        ],
    },
    Documento__c: {
        name: "Documento__c",
        label: "Document (Documento)",
        description: "Custom object for tracking required documents per opportunity. Each record represents a document type (e.g., drone photos, meter photo). Files are attached as ContentDocumentLinks.",
        relationships: [
            "Opportunity (Oportunidad__c) - Parent opportunity",
            "ContentDocumentLink - Attached files",
        ],
        fields: [
            { name: "Id", label: "Record ID", type: "id", custom: false },
            { name: "Name", label: "Document Name", type: "string", custom: false },
            {
                name: "Cliente__c",
                label: "Client",
                type: "reference",
                custom: true,
                description: "Reference to client/account",
            },
            {
                name: "Oportunidad__c",
                label: "Opportunity",
                type: "reference",
                custom: true,
                description: "Reference to parent opportunity",
            },
            {
                name: "Requerido__c",
                label: "Required",
                type: "boolean",
                custom: true,
                description: "Whether this document is required for the project",
            },
            {
                name: "Documento_Agregado__c",
                label: "Document Added",
                type: "boolean",
                custom: true,
                description: "Whether files have been uploaded to this document record",
            },
            { name: "CreatedDate", label: "Created Date", type: "datetime", custom: false },
            { name: "LastModifiedDate", label: "Last Modified Date", type: "datetime", custom: false },
        ],
    },
    ContentDocument: {
        name: "ContentDocument",
        label: "Content Document (File)",
        description: "Standard Salesforce file storage. Files are linked to records via ContentDocumentLink.",
        relationships: [
            "ContentDocumentLink - Links to parent records",
            "ContentVersion (LatestPublishedVersionId) - Latest version",
        ],
        fields: [
            { name: "Id", label: "Content Document ID", type: "id", custom: false },
            { name: "Title", label: "Title", type: "string", custom: false },
            { name: "FileType", label: "File Type", type: "string", custom: false },
            { name: "FileExtension", label: "File Extension", type: "string", custom: false },
            { name: "ContentSize", label: "File Size (bytes)", type: "number", custom: false },
            {
                name: "LatestPublishedVersionId",
                label: "Latest Version ID",
                type: "reference",
                custom: false,
            },
            { name: "CreatedDate", label: "Created Date", type: "datetime", custom: false },
            { name: "LastModifiedDate", label: "Last Modified Date", type: "datetime", custom: false },
        ],
    },
    ContentDocumentLink: {
        name: "ContentDocumentLink",
        label: "Content Document Link",
        description: "Junction object linking ContentDocument (files) to any Salesforce record.",
        fields: [
            { name: "Id", label: "Link ID", type: "id", custom: false },
            { name: "ContentDocumentId", label: "Content Document ID", type: "reference", custom: false },
            { name: "LinkedEntityId", label: "Linked Entity ID", type: "reference", custom: false },
            {
                name: "ShareType",
                label: "Share Type",
                type: "picklist",
                custom: false,
                picklistValues: ["V", "C", "I"],
                description: "V=Viewer, C=Collaborator, I=Inferred",
            },
            {
                name: "Visibility",
                label: "Visibility",
                type: "picklist",
                custom: false,
                picklistValues: ["AllUsers", "InternalUsers", "SharedUsers"],
            },
        ],
    },
};
/** Known document types that exist per Opportunity */
export const KNOWN_DOCUMENT_TYPES = [
    "Fotos de droneo",
    "Fachada",
    "Foto de medidor",
    "Centro de carga",
    "90 grados helioscope",
    "isometría helioscope",
];
/** Photo category to Salesforce document name mapping */
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
/** Visita Tecnica field to Salesforce Opportunity field mapping */
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
/** Email field priority order for Account */
export const ACCOUNT_EMAIL_FIELDS = [
    "PersonEmail",
    "Email_Facturaci_n__c",
];
