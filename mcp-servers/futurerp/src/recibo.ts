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
  /** Previous balance carried on the bill (ADEUDO/SALDO ANTERIOR), 0 when the line says 0. */
  adeudo_anterior: number | null;
  /** Signals that the client owes CFE something: a non-zero previous balance, a cut-off notice, a suspended service. */
  senales_adeudo: string[];
  /** Days from periodo_fin to `hoy` (null when the period is unreadable). */
  antiguedad_dias: number | null;
}

const MESES: Record<string, string> = { ENE: "01", FEB: "02", MAR: "03", ABR: "04", MAY: "05", JUN: "06", JUL: "07", AGO: "08", SEP: "09", OCT: "10", NOV: "11", DIC: "12" };
/** "02 OCT 26" → "2026-10-02". */
export function fechaCfe(s: string | null | undefined): string | null {
  const m = s?.toUpperCase().match(/(\d{2}) ([A-Z]{3}) (\d{2})/);
  if (!m || !MESES[m[2]]) return null;
  return `20${m[3]}-${MESES[m[2]]}-${m[1]}`;
}

const SKIP = /COMISI[ÓO]N FEDERAL|^CFE|^RFC|AV\. PASEO|ALCALD[ÍI]A|CIUDAD DE M[ÉE]XICO|TOTAL A PAGAR|PESOS|^C\.P\.|^CP\.|^\$|N\.L\.|^RMU|^NO\. |CUENTA:|TARIFA:|L[ÍI]MITE|CORTE|PERIODO|MULTIPLICADOR|HILOS|MEDIDOR|ENERG[ÍI]A|B[ÁA]SICO|INTERMEDIO|EXCEDENTE|SUBSIDIO|^IVA|DAP|SALDO|ADEUDO|AVISO|DESGLOSE|IMPORTE|CONCEPTO|LECTURA|CARGO|CR[ÉE]DITO|FACTURA|HISTORIAL|CONSUMO|MEDIDA|ESTIMADA|FRACC|COL\b/;

export function esRecibo(text: string): boolean {
  return /NO\. DE SERVICIO|COMISI[ÓO]N FEDERAL DE ELECTRICIDAD|RMU:/i.test(text);
}

export function parseRecibo(text: string, hoy: Date = new Date()): Recibo {
  const t = text.replace(/\r/g, "");
  const u = t.toUpperCase();
  const g = (re: RegExp) => u.match(re)?.[1]?.trim() ?? null;

  // Titular: the first caps-only line after CFE's own header (its RFC line);
  // every layout prints the customer right there. Fallback: first caps line.
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const esNombre = (line: string) => !SKIP.test(line) && !/\d/.test(line) && /^[A-ZÁÉÍÓÚÑ.\- ]{6,}$/.test(line) && line.split(/\s+/).length >= 2;
  let titular: string | null = null;
  const rfcIdx = lines.findIndex((l) => /CFE370814QI0|RFC:\s*CFE/i.test(l));
  for (const raw of lines.slice(rfcIdx >= 0 ? rfcIdx + 1 : 0, (rfcIdx >= 0 ? rfcIdx + 1 : 0) + 12)) {
    const line = raw.toUpperCase();
    if (esNombre(line)) { titular = line.replace(/\s+/g, " "); break; }
  }
  if (!titular) for (const raw of lines.slice(0, 40)) { const line = raw.toUpperCase(); if (esNombre(line)) { titular = line.replace(/\s+/g, " "); break; } }

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
