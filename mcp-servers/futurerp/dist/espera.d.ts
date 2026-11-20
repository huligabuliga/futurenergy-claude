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
export declare const DIAS_ESPERA_ANTICIPO = 7;
/** Why the project's expediente may not go out yet, or null when it may (or its zone has no wait). */
export declare function esperaAnticipo(sbApi: SbApi, headers: Record<string, string>, projectId: string, now?: number): Promise<string | null>;
export {};
