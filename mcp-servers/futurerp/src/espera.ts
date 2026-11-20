/**
 * Hard guard for tramites-reglas "Cuándo empezar": in DD10/DD11 the expediente goes to the
 * gestora 1 to 2 weeks after the anticipo, never sooner (if CFE changes the meter before the
 * panels are up, the client gets charged). Used by futurerp_mail_draft ("Trámite nuevo – …")
 * and futurerp_tramite_update (enviado / documentacion_con_gestor), live and in shadow.
 *
 * The anticipo date is the first time the project entered the stage "anticipo 1 pagado"
 * (project_stage_history.entered_at, Monterrey day); projects.fecha_anticipo_completo is the
 * fallback. last_stage_change_date is empty in prod, so it is not used. The wait is
 * max(trami_reglas_zona.espera_dias, DIAS_ESPERA_ANTICIPO).
 */
type SbApi = (path: string, headers?: Record<string, string>) => Promise<any>;

// ponytail: the floor, not the wait. The wait is trami_reglas_zona.espera_dias (tramitología edits it in
// Ajustes); they can raise it, never lower it under this. The sweep (trami_barrido_delta) uses the same max.
export const DIAS_ESPERA_ANTICIPO = 7;
const ZONAS_CON_ESPERA = ["DD10", "DD11"];
const ANTICIPO_STAGE = "anticipo 1 pagado";

const diaMty = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Monterrey" });

/** Why the project's expediente may not go out yet, or null when it may (or its zone has no wait). */
export async function esperaAnticipo(sbApi: SbApi, headers: Record<string, string>, projectId: string, now = Date.now()): Promise<string | null> {
  const p = (await sbApi(`/projects?id=eq.${projectId}&select=id,efu,zona_cfe,fecha_anticipo_completo&limit=1`, headers))?.[0];
  if (!p || !ZONAS_CON_ESPERA.includes(p.zona_cfe)) return null;
  const h = (await sbApi(`/project_stage_history?project_id=eq.${p.id}&stage=eq.${encodeURIComponent(ANTICIPO_STAGE)}&select=entered_at&order=entered_at.asc&limit=1`, headers))?.[0];
  const anticipo: string | null = h?.entered_at ? diaMty(Date.parse(h.entered_at)) : p.fecha_anticipo_completo ?? null;
  const quien = `${p.efu ?? p.id} (${p.zona_cfe})`;
  if (!anticipo) return `${quien}: no hay anticipo pagado registrado (etapa "${ANTICIPO_STAGE}"), así que el expediente todavía no va a la gestora. Deja una nota en el timeline y no mandes nada.`;
  const regla = (await sbApi(`/trami_reglas_zona?zona=eq.${encodeURIComponent(p.zona_cfe)}&select=espera_dias&limit=1`, headers).catch(() => null))?.[0];
  const dias = Math.max(DIAS_ESPERA_ANTICIPO, Number(regla?.espera_dias) || 0);
  const desde = new Date(Date.parse(anticipo) + dias * 86_400_000).toISOString().slice(0, 10);
  if (desde <= diaMty(now)) return null;
  return `${quien}: el anticipo se pagó el ${anticipo}; en DD10/DD11 el expediente se manda a la gestora desde el ${desde} (${dias} días después, nunca antes). Deja una nota en el timeline con esa fecha y no mandes nada hoy, ni correo ni mensaje al grupo.`;
}
