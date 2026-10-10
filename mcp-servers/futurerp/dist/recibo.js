const MESES = { ENE: "01", FEB: "02", MAR: "03", ABR: "04", MAY: "05", JUN: "06", JUL: "07", AGO: "08", SEP: "09", OCT: "10", NOV: "11", DIC: "12" };
/** "02 OCT 26" → "2026-10-02". */
export function fechaCfe(s) {
    const m = s?.toUpperCase().match(/(\d{2}) ([A-Z]{3}) (\d{2})/);
    if (!m || !MESES[m[2]])
        return null;
    return `20${m[3]}-${MESES[m[2]]}-${m[1]}`;
}
const SKIP = /COMISI[ÓO]N FEDERAL|^CFE|^RFC|AV\. PASEO|ALCALD[ÍI]A|CIUDAD DE M[ÉE]XICO|TOTAL A PAGAR|PESOS|^C\.P\.|^CP\.|^\$|N\.L\.|^RMU|^NO\. |CUENTA:|TARIFA:|L[ÍI]MITE|CORTE|PERIODO|MULTIPLICADOR|HILOS|MEDIDOR|ENERG[ÍI]A|B[ÁA]SICO|INTERMEDIO|EXCEDENTE|SUBSIDIO|^IVA|DAP|SALDO|ADEUDO|AVISO/;
export function esRecibo(text) {
    return /NO\. DE SERVICIO|COMISI[ÓO]N FEDERAL DE ELECTRICIDAD|RMU:/i.test(text);
}
export function parseRecibo(text, hoy = new Date()) {
    const t = text.replace(/\r/g, "");
    const u = t.toUpperCase();
    const g = (re) => u.match(re)?.[1]?.trim() ?? null;
    // Titular: first line in caps, letters only, 2+ words, before the address block.
    let titular = null;
    for (const raw of t.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 40)) {
        const line = raw.toUpperCase();
        if (SKIP.test(line) || /\d/.test(line))
            continue;
        if (/^[A-ZÁÉÍÓÚÑ.\- ]{6,}$/.test(line) && line.split(/\s+/).length >= 2) {
            titular = line.replace(/\s+/g, " ");
            break;
        }
    }
    const cuenta = g(/CUENTA:\s*([0-9A-Z]{8,})/);
    const zona = cuenta?.match(/\d{2}(DD\d{2})/)?.[1] ?? null;
    const periodo = u.match(/PERIODO FACTURADO:\s*(\d{2} [A-Z]{3} \d{2})\s*-\s*(\d{2} [A-Z]{3} \d{2})/);
    const periodo_fin = fechaCfe(periodo?.[2]);
    const totalRaw = g(/TOTAL A PAGAR:\s*\$?\s*([\d,]+(?:\.\d+)?)/);
    // Every bill prints an "ADEUDO ANTERIOR" line; it only matters when the amount is not zero.
    const adeudoRaw = u.match(/(?:ADEUDO|SALDO) ANTERIOR[^\d$\n]*\n?\s*\$?\s*([\d,]+(?:\.\d+)?)/)?.[1] ?? null;
    const adeudo_anterior = adeudoRaw != null ? Number(adeudoRaw.replace(/,/g, "")) : null;
    const senales = [
        ...(adeudo_anterior ? ["ADEUDO ANTERIOR"] : []),
        ...["AVISO DE CORTE", "SERVICIO SUSPENDIDO", "RECONEXI"].filter((w) => u.includes(w)),
    ];
    return {
        titular,
        numero_servicio: g(/NO\. DE SERVICIO:\s*(\d{10,14})/),
        cuenta,
        zona,
        tarifa: g(/TARIFA:\s*([A-Z0-9]{1,8}?)(?=NO\.|\s|$)/),
        medidor: g(/NO\. MEDIDOR:\s*([A-Z0-9]{3,})/),
        rmu_cp: g(/RMU:\s*(\d{5})/),
        periodo_inicio: fechaCfe(periodo?.[1]),
        periodo_fin,
        total: totalRaw ? Number(totalRaw.replace(/,/g, "")) : null,
        limite_pago: fechaCfe(g(/L[ÍI]MITE DE PAGO:\s*(\d{2} [A-Z]{3} \d{2})/)),
        corte_a_partir: fechaCfe(g(/CORTE A PARTIR:\s*(\d{2} [A-Z]{3} \d{2})/)),
        adeudo_anterior,
        senales_adeudo: senales,
        antiguedad_dias: periodo_fin ? Math.round((hoy.getTime() - new Date(periodo_fin + "T12:00:00-06:00").getTime()) / 86_400_000) : null,
    };
}
