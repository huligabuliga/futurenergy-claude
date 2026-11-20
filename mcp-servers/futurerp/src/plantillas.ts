/**
 * The only WhatsApp messages Trami may send a client: plantillas_cliente.json
 * (package root, one source for the guard and the tool description the skill
 * points to). A message matches when it is one template with every {hueco}
 * filled in its own format; the introduction may follow the greeting. Nothing
 * else goes to a client: no extra sentence, no free text inside a hueco.
 */
import { readFileSync } from "node:fs";

type Plantilla = { id: string; cuando: string; texto: string };
const data: { presentacion: string; huecos: Record<string, string>; plantillas: Plantilla[] } =
  JSON.parse(readFileSync(new URL("../plantillas_cliente.json", import.meta.url), "utf8"));

const LETRA = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";
const HUECO: Record<string, string> = {
  nombre: `[${LETRA}]+(?: [${LETRA}]+){0,3}`,
  si: "SI[0-9A-Z]{6,20}",
  fecha: "\\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?: de \\d{4})?",
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const SALUDO = "Hola {nombre}, buen día.";

const reglas = data.plantillas.map((p) => {
  let src = esc(norm(p.texto));
  // The introduction goes only in the first message, right after the greeting.
  if (p.texto.startsWith(SALUDO)) src = src.replace(esc(SALUDO), `${esc(SALUDO)}(?: ${esc(norm(data.presentacion))})?`);
  src = src.replace(/\\\{(\w+)\\\}/g, (_, h) => {
    if (!HUECO[h]) throw new Error(`plantillas_cliente.json: hueco desconocido {${h}} en ${p.id}`);
    return `(?:${HUECO[h]})`;
  });
  return { id: p.id, rx: new RegExp(`^${src}$`, "u") };
});

/** The id of the template `text` is, or null. */
export function plantillaDe(text: string): string | null {
  const t = norm(text);
  return reglas.find((r) => r.rx.test(t))?.id ?? null;
}

/** For the tool description: each template with when it goes. */
export function listaPlantillas(): string {
  return data.plantillas.map((p) => `[${p.id}] ${p.cuando} Texto: "${p.texto}"`).join(" ")
    + ` Huecos: ${Object.entries(data.huecos).map(([k, v]) => `{${k}} = ${v}`).join("; ")}. En el primer mensaje a ese cliente, después del saludo va: "${data.presentacion}"`;
}
