/**
 * CFE bill (recibo) parser over the text layer of the PDF. Pure, tested.
 * Field names are what the trámites team uses; absent fields are null.
 */
export interface Recibo {
    titular: string | null;
    numero_servicio: string | null;
    cuenta: string | null;
    /** Zona CFE read from the account number (…25DD11H… → DD11). */
    zona: string | null;
    tarifa: string | null;
    medidor: string | null;
    rmu_cp: string | null;
    periodo_inicio: string | null;
    periodo_fin: string | null;
    total: number | null;
    limite_pago: string | null;
    corte_a_partir: string | null;
    /** Words on the bill that mean the client owes CFE something. */
    senales_adeudo: string[];
    /** Days from periodo_fin to `hoy` (null when the period is unreadable). */
    antiguedad_dias: number | null;
}
/** "02 OCT 26" → "2026-10-02". */
export declare function fechaCfe(s: string | null | undefined): string | null;
export declare function esRecibo(text: string): boolean;
export declare function parseRecibo(text: string, hoy?: Date): Recibo;
