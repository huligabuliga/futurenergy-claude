/**
 * Lead actions that the generic update tool can't do alone, because in the app
 * part of the work happens client-side:
 *   - futurerp_lead_set_stage: the "Cambio de etapa" row in the Actividad feed
 *     is written by the UI (the activity trigger skips leads.status).
 *   - futurerp_lead_schedule_next_contact: the personal reminder and the Google
 *     Calendar push (google-calendar-push edge fn) are called by the UI.
 * Both mirror LeadDetail.handleStageClick / handleDisqualifyConfirm and
 * ScheduleNextContactDialog in pronto-resolver-61. Registered with the write
 * tools (mcp.write) and run with the caller's token, so RLS decides as in the app.
 */
import { z } from "zod";
import { rest, ledger, text } from "./writes.js";
// Same labels as leadStatusLabels in src/types/lead.ts; an unknown key falls back to itself.
const STAGE_LABELS = {
    nuevo: "Nuevo",
    primer_contacto_agent: "Primer contacto AGENT",
    llamada_agendada_agent: "Llamada agendada AGENT",
    visita_agendada_agent: "Visita agendada AGENT",
    primer_contacto: "Primer Contacto",
    seguimiento: "Seguimiento",
    visita_en_sitio: "Visita en sitio",
    negociacion: "Negociación",
    calificado: "Calificado",
    descalificado: "Descalificado",
};
const label = (s) => STAGE_LABELS[s] ?? s;
const VENDOR_QUAL = ["Pendiente", "Super Hot", "Hot", "Warm", "Cold", "Super Cold"];
/** "YYYY-MM-DDTHH:MM" without offset = Monterrey wall clock (UTC-6, no DST since 2022). Exported for the check script. */
export function parseWhen(v) {
    const s = v.trim();
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    const d = new Date(hasZone ? s : `${s.length === 16 ? `${s}:00` : s}-06:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}
/** Fire the same calendar push the app does. Returns a short human status; never throws. */
async function pushCalendar(deps, body) {
    try {
        const res = await fetch(`${deps.supabaseUrl}/functions/v1/google-calendar-push`, {
            method: "POST",
            headers: deps.authHeaders(),
            body: JSON.stringify({ target: "lead_next_contact", ...body }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok)
            return `Google Calendar: failed (${res.status} ${j.error ?? ""})`.trim();
        if (j.skipped === "not_connected")
            return "Google Calendar: not connected for this user (connect it in the ERP to sync)";
        if (j.skipped)
            return `Google Calendar: skipped (${j.skipped})`;
        return "Google Calendar: synced";
    }
    catch (e) {
        return `Google Calendar: failed (${e?.message ?? e})`;
    }
}
async function getLead(deps, id, cols) {
    const rows = await rest(deps, "GET", `/leads?id=eq.${encodeURIComponent(id)}&select=${cols}`);
    if (!rows[0])
        throw new Error("Lead not found, or you don't have access to it.");
    return rows[0];
}
export function registerLeadActionTools(server, deps) {
    server.tool("futurerp_lead_set_stage", `Move a lead to another pipeline stage exactly like clicking the stage in the ERP: updates leads.status and writes the "Cambio de etapa" line in the lead's Actividad feed. Stages: ${Object.keys(STAGE_LABELS).join(", ")}. For 'descalificado' a reason is required; it also cancels the scheduled next contact (reminder + Google Calendar event), as the app does.`, {
        lead_id: z.string().uuid(),
        stage: z.string().describe("Target status key, e.g. seguimiento, negociacion, descalificado"),
        reason: z.string().optional().describe("Required for descalificado: disqualification reason"),
        description: z.string().optional().describe("Optional detail for descalificado"),
    }, async ({ lead_id, stage, reason, description }) => {
        try {
            const lead = await getLead(deps, lead_id, "id,status,next_contact_reminder_id,next_contact_google_event_id");
            if (lead.status === stage)
                return text(`No changes: the lead is already in ${label(stage)}.`);
            let patch = { status: stage };
            let newValue = label(stage);
            const notes = [];
            if (stage === "descalificado") {
                if (!reason?.trim())
                    throw new Error("Give a reason to disqualify the lead.");
                if (lead.next_contact_reminder_id) {
                    await rest(deps, "DELETE", `/reminders?id=eq.${lead.next_contact_reminder_id}`).catch(() => notes.push("Could not delete the previous reminder."));
                }
                if (lead.next_contact_google_event_id) {
                    notes.push(await pushCalendar(deps, { lead_id, op: "delete", google_event_id: lead.next_contact_google_event_id }));
                }
                patch = {
                    ...patch,
                    disqualification_reason: reason.trim(),
                    disqualification_description: description?.trim() || null,
                    descalificado_at: new Date().toISOString(),
                    next_contact_at: null, next_contact_note: null, next_contact_required: false,
                    next_contact_reminder_id: null, next_contact_google_event_id: null, next_contact_google_etag: null,
                };
                newValue = `${newValue} — ${reason.trim()}`;
            }
            const after = await rest(deps, "PATCH", `/leads?id=eq.${lead_id}`, patch, "return=representation");
            if (!after.length)
                throw new Error("Your FuturERP permissions don't allow editing this lead.");
            await rest(deps, "POST", "/crm_activities", {
                entity_type: "lead", entity_id: lead_id, activity_type: "status_change",
                subject: "Cambio de etapa", old_value: label(lead.status), new_value: newValue, performed_by: deps.userId,
            }, "return=minimal");
            await ledger(deps, { op: "update", table_name: "leads", match: [{ column: "id", op: "eq", value: lead_id }], payload: patch, antes: { id: lead_id, status: lead.status }, despues: { id: lead_id, status: stage }, row_count: 1 });
            return text([`Stage changed: ${label(lead.status)} → ${newValue}. Logged in the lead's Actividad.`, ...notes].join("\n"));
        }
        catch (e) {
            return text(`Stage change failed: ${e?.message ?? e}`, true);
        }
    });
    server.tool("futurerp_lead_schedule_next_contact", `Set (or reschedule) a lead's "Siguiente contacto" exactly like the ERP dialog: replaces the previous personal reminder with a new "Contactar a <lead>" reminder, saves leads.next_contact_*, and syncs the event to the user's Google Calendar (if connected). 'at' must be in the future; without a UTC offset it is Monterrey time. The app also asks for si_pero, vendor_qualification and project_amount: pass them when the user gives them.`, {
        lead_id: z.string().uuid(),
        at: z.string().describe("When: '2026-10-25T10:00' (Monterrey) or ISO with offset"),
        note: z.string().optional().describe("What the contact is about (default 'Seguimiento')"),
        si_pero: z.string().optional().describe("Objections / pains of the lead"),
        vendor_qualification: z.enum(VENDOR_QUAL).optional(),
        project_amount: z.number().positive().optional().describe("Preliminary amount in MXN"),
    }, async ({ lead_id, at, note, si_pero, vendor_qualification, project_amount }) => {
        try {
            const when = parseWhen(at);
            if (!when)
                throw new Error(`Invalid date "${at}".`);
            if (when.getTime() <= Date.now())
                throw new Error("The next contact must be in the future.");
            const lead = await getLead(deps, lead_id, "id,first_name,last_name,next_contact_at,next_contact_reminder_id");
            const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "el lead";
            const finalNote = note?.trim() || "Seguimiento";
            const iso = when.toISOString();
            const notes = [];
            if (lead.next_contact_reminder_id) {
                await rest(deps, "DELETE", `/reminders?id=eq.${lead.next_contact_reminder_id}`).catch(() => notes.push("Could not delete the previous reminder."));
            }
            const [reminder] = await rest(deps, "POST", "/reminders", {
                user_id: deps.userId, title: `Contactar a ${name}`, note: finalNote, remind_at: iso,
                is_completed: false, is_notified: false, recurrence_type: "none", original_time: iso.slice(11, 19),
            }, "return=representation");
            const patch = {
                next_contact_at: iso, next_contact_note: finalNote,
                next_contact_reminder_id: reminder?.id ?? null, next_contact_required: false,
                ...(si_pero?.trim() ? { si_pero: si_pero.trim() } : {}),
                ...(vendor_qualification ? { vendor_qualification } : {}),
                ...(project_amount != null ? { project_amount } : {}),
            };
            const after = await rest(deps, "PATCH", `/leads?id=eq.${lead_id}`, patch, "return=representation");
            if (!after.length) {
                if (reminder?.id)
                    await rest(deps, "DELETE", `/reminders?id=eq.${reminder.id}`).catch(() => { });
                throw new Error("Your FuturERP permissions don't allow editing this lead.");
            }
            notes.push(await pushCalendar(deps, { lead_id, op: lead.next_contact_at ? "update" : "create" }));
            await ledger(deps, { op: "update", table_name: "leads", match: [{ column: "id", op: "eq", value: lead_id }], payload: patch, antes: { id: lead_id, next_contact_at: lead.next_contact_at, next_contact_reminder_id: lead.next_contact_reminder_id }, despues: { id: lead_id, next_contact_at: iso }, row_count: 1 });
            const local = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Monterrey", dateStyle: "full", timeStyle: "short" }).format(when);
            return text([`Next contact ${lead.next_contact_at ? "rescheduled" : "scheduled"} for ${local}: "${finalNote}". Reminder created.`, ...notes].join("\n"));
        }
        catch (e) {
            return text(`Scheduling failed: ${e?.message ?? e}`, true);
        }
    });
}
