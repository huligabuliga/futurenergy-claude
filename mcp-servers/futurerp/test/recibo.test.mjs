import test from "node:test";
import assert from "node:assert/strict";
import { parseRecibo, esRecibo, fechaCfe } from "../dist/recibo.js";

// Synthetic text with the layout pdf-parse produces for a real CFE bill.
const SAMPLE = `Comisión Federal de Electricidad
Av. Paseo de la Reforma 164, Col. Juárez,
Alcaldía: Cuauhtémoc, Código Postal: 06600,
Ciudad de México. RFC: CFE370814QI0
PEREZ LOPEZ MARIA FERNANDA
RIO EJEMPLO 100
COL CENTRO C.P.66646
APODACA N.L.,N.L.
TOTAL A PAGAR:
$4,025
(CUATRO MIL VEINTICINCO PESOS M.N.)
NO. DE SERVICIO:420200000001
RMU:66646 24-02-09 PELM-900101 003 CFE
CUENTA:25DD11H062500001
LÍMITE DE PAGO:02 OCT 26
CORTE A PARTIR:03 OCT 26
TARIFA:1CNO. MEDIDOR:ABC123
MULTIPLICADOR:1
PERIODO FACTURADO:15 JUL 26-14 SEP 26
Energía (kWh)
Básico
`;

test("fechaCfe", () => {
  assert.equal(fechaCfe("02 OCT 26"), "2026-10-02");
  assert.equal(fechaCfe("x"), null);
});
test("parseRecibo reads the fields the trámite needs", () => {
  assert.equal(esRecibo(SAMPLE), true);
  const r = parseRecibo(SAMPLE, new Date("2026-10-10T12:00:00-06:00"));
  assert.equal(r.titular, "PEREZ LOPEZ MARIA FERNANDA");
  assert.equal(r.numero_servicio, "420200000001");
  assert.equal(r.cuenta, "25DD11H062500001");
  assert.equal(r.zona, "DD11");
  assert.equal(r.tarifa, "1C");
  assert.equal(r.medidor, "ABC123");
  assert.equal(r.rmu_cp, "66646");
  assert.equal(r.periodo_inicio, "2026-07-15");
  assert.equal(r.periodo_fin, "2026-09-14");
  assert.equal(r.total, 4025);
  assert.equal(r.limite_pago, "2026-10-02");
  assert.equal(r.corte_a_partir, "2026-10-03");
  assert.deepEqual(r.senales_adeudo, []);
  assert.equal(r.antiguedad_dias, 26);
});
test("adeudo signals and DD12 account", () => {
  const r = parseRecibo(SAMPLE.replace("CUENTA:25DD11H", "CUENTA:25DD12H") + "\nADEUDO ANTERIOR\n$1,200\nAVISO DE CORTE");
  assert.equal(r.zona, "DD12");
  assert.equal(r.adeudo_anterior, 1200);
  assert.deepEqual(r.senales_adeudo, ["ADEUDO ANTERIOR", "AVISO DE CORTE"]);
  const cero = parseRecibo(SAMPLE + "\nADEUDO ANTERIOR\n$0.00");
  assert.equal(cero.adeudo_anterior, 0);
  assert.deepEqual(cero.senales_adeudo, []);
});
test("not a recibo", () => {
  assert.equal(esRecibo("INSTITUTO NACIONAL ELECTORAL CREDENCIAL PARA VOTAR"), false);
  assert.equal(parseRecibo("hola").titular, null);
});
