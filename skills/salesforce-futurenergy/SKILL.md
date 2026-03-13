---
name: salesforce-futurenergy
description: |
  Expert knowledge of Future Energy's Salesforce org structure, objects, custom fields,
  picklist values, field mappings, and integration patterns. Companion to the salesforce
  MCP server for live queries.

  Use when: working with Salesforce data, querying SF objects/fields, understanding
  custom fields, writing SF integrations, syncing data to/from Salesforce, debugging
  SF API errors, or understanding the CRM data model.
---

# Future Energy Salesforce Expert

## MCP Server

A live Salesforce MCP server is available with these tools:

| Tool | Purpose |
|------|---------|
| `salesforce_search` | Search by name, EFU, or project ID |
| `salesforce_get_opportunity` | Get full opportunity details |
| `salesforce_get_account` | Get account/contact details |
| `salesforce_get_documents` | List Documento__c records for an opportunity |
| `salesforce_get_document_files` | List files attached to a document |
| `salesforce_describe_object` | Describe object schema (fields, types, picklists) |
| `salesforce_list_objects` | List all known objects |
| `salesforce_get_field` | Look up a specific field |
| `salesforce_search_fields` | Search fields by keyword |
| `salesforce_field_mappings` | Show VT->SF field/document mappings |
| `salesforce_update_opportunity` | Update opportunity fields |

Use these tools for live data. The schema below is reference material.

---

## Middleware API

Base: `https://salesforce-futurenergy-api-production.up.railway.app`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search?q=<query>` | GET | Search opportunities/accounts |
| `/api/opportunities/<id>` | GET | Get opportunity details |
| `/api/opportunities/<id>` | PATCH | Update opportunity fields |
| `/api/opportunities/<id>/documents` | GET | Get opportunity with Documento__c records |
| `/api/accounts/<id>` | GET | Get account details |
| `/api/documents/<id>/content-links` | GET | Get files for a document |
| `/api/documents/<id>/upload` | POST | Upload file (base64) to document |
| `/api/documents/<id>` | PATCH | Update document record |
| `/api/documents/download/<id>/file` | GET | Download file |

---

## Objects

### Opportunity

Solar installation projects. Main entity.

**Key custom fields:**

| API Name | Label | Type | Values |
|----------|-------|------|--------|
| `ID_de_proyecto__c` | Project ID | string | e.g. PRJ-001 |
| `Paneles_Solicitados_Requeridos__c` | Required Panels | number | |
| `Medida_Real__c` | Real Measurement | string | e.g. "4.5 kW" |
| `Tipo_de_techo__c` | Roof Type | picklist | Concreto, Concreto aligerado, Barroblock, Vigueta y bovedilla, Pergola, Envigado, Otro |
| `Tipo_de_techo_otro__c` | Other Roof Type | string | free text when "Otro" |
| `Observaciones_generales_del_techo__c` | Roof Observations | textarea | |
| `Obst_culos_del_techo__c` | Roof Obstacles | textarea | |
| `Fotos_del_techo_fueron_tomadas__c` | Roof Photos Taken | boolean | |
| `Ruta_de_canalizaci_n_desde_paneles__c` | Electrical Route | textarea | |
| `Ubicaci_n_del_centro_de_carga__c` | Load Center Location | string | |
| `Condiciones_del_centro_de_carga__c` | Load Center Conditions | picklist | Saturado, Disponible, Requiere adecuaciones |
| `Foto_de_medidor_tomada__c` | Meter Photo Taken | boolean | |
| `Proveedor_de_internet__c` | Internet Provider | string | |
| `Tipo_de_red__c` | Network Type | picklist | 2.4 GHz, 5 GHz, Ambas |
| `Tr_mites_que_se_requieren__c` | Required Procedures | multi-picklist | Cambio de nombre, aumento de voltaje, Tramite de medidor bidireccional, Alta de servicio, Baja de servicio, Factibilidad tecnica, UVIE, UIIE, Retiro de pago automatico con tarjeta, Otro |
| `Comentarios_Adicionales__c` | Additional Comments | textarea | |
| `Direcci_n_Del_Proyecto__c` | Project Address | address (compound) | .street, .city, .state, .postalCode |

**Address sub-fields** (individual access):
- `Direcci_n_Del_Proyecto__Street__s`
- `Direcci_n_Del_Proyecto__City__s`
- `Direcci_n_Del_Proyecto__StateCode__s`
- `Direcci_n_Del_Proyecto__PostalCode__s`
- `Direcci_n_Del_Proyecto__CountryCode__s`

**Standard fields used:** Id, Name, StageName, AccountId, OwnerId, CreatedDate, LastModifiedDate.

### Account

Client accounts (Person or Business).

| API Name | Label | Type | Notes |
|----------|-------|------|-------|
| `PersonEmail` | Person Email | email | Person Account type |
| `PersonMobilePhone` | Person Mobile | phone | Person Account type |
| `Email__c` | Email (custom) | email | Business Account |
| `Correo_Electronico__c` | Electronic Mail | email | Alternative |
| `Email_Facturaci_n__c` | Billing Email | email | Invoicing |
| `Phone` | Phone | phone | Standard |

**Email extraction priority:** PersonEmail -> Email__c -> Correo_Electronico__c -> Email_Facturaci_n__c

### Documento__c (Custom)

Document tracking per opportunity. Each record = a document type (e.g., "Fotos de droneo").

| API Name | Label | Type |
|----------|-------|------|
| `Name` | Document Name | string |
| `Cliente__c` | Client | reference |
| `Oportunidad__c` | Opportunity | reference |
| `Requerido__c` | Required | boolean |
| `Documento_Agregado__c` | Document Added | boolean |

**Known document types per opportunity:**
- Fotos de droneo (drone photos)
- Fachada (facade)
- Foto de medidor (meter photo)
- Centro de carga (load center)
- 90 grados helioscope
- isometria helioscope

### ContentDocument & ContentDocumentLink

Standard Salesforce file storage. Files attached to Documento__c via ContentDocumentLink.

---

## Field Mappings

### Visita Tecnica -> Opportunity

| VT Field | SF Opportunity Field |
|----------|---------------------|
| roof_type | `Tipo_de_techo__c` |
| roof_type_other | `Tipo_de_techo_otro__c` |
| roof_observations | `Observaciones_generales_del_techo__c` |
| roof_obstacles | `Obst_culos_del_techo__c` |
| electrical_route_proposed | `Ruta_de_canalizaci_n_desde_paneles__c` |
| load_center_location | `Ubicaci_n_del_centro_de_carga__c` |
| load_center_conditions | `Condiciones_del_centro_de_carga__c` |
| internet_provider | `Proveedor_de_internet__c` |
| network_type | `Tipo_de_red__c` |
| additional_comments | `Comentarios_Adicionales__c` |
| required_procedures | `Tr_mites_que_se_requieren__c` |

### Photo Category -> Documento__c

| Photo Category | SF Document Name |
|---------------|-----------------|
| drone_photos | Fotos de droneo |
| roof_facade | Fachada |
| meter | Foto de medidor |
| load_center | Centro de carga |
| roof_obstacles | Fotos de droneo |
| roof_multiple_levels | Fotos de droneo |

### Picklist Legacy Value Mappings

**Roof type:** Pergola (legacy) -> Pergola, Lamina (legacy) -> Otro, Teja (legacy) -> Otro.
**Network type:** WiFi 2.4GHz -> 2.4 GHz, WiFi 5GHz -> 5 GHz, Ethernet -> Ambas.
**Procedures:** Cambio de voltaje (110V a 220V) -> aumento de voltaje.

---

## Integration Patterns

### Search -> Fetch Flow
1. `searchSalesforce(query)` -> matches
2. `getOpportunityById(id)` -> full opportunity
3. `getAccountById(opportunity.AccountId)` -> client contact info

### Document Upload Flow
1. `getOpportunityWithDocuments(oppId)` -> Documento__c records
2. Match photo category to document name via mapping
3. Convert photo to base64
4. `uploadToDocumento(documentoId, fileName, base64)`
5. `markDocumentoAsComplete(documentoId)` -> sets `Documento_Agregado__c = true`

### Field Sync Flow
1. Map VT fields to SF fields via `VT_FIELD_MAPPINGS`
2. Normalize picklist values via `VT_PICKLIST_MAPPINGS`
3. Multi-select values joined with `;` separator
4. `PATCH /api/opportunities/<id>` with changed fields only
5. On error, retry without failing fields

### Error Handling
- `SalesforceUpdateError` has `.failingFields` and `.salesforceErrors` arrays
- Account fetch failures are non-fatal (return null)
- Individual field retry if bulk update fails

---

## Updating This Skill

When new custom fields, objects, or picklist values are added to Salesforce:
1. Update `~/.claude/mcp-servers/salesforce-futurenergy/src/schema.ts`
2. Rebuild: `cd ~/.claude/mcp-servers/salesforce-futurenergy && npx tsc`
3. Update this skill file
4. Update `src/services/salesforceService.ts` if field mappings change
