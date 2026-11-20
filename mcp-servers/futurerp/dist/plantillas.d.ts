/** The template `text` is and what fills each hueco ({nombre: ["Ana"], si: [...]}), or null. */
export declare function leerPlantilla(text: string): {
    id: string;
    huecos: Record<string, string[]>;
} | null;
export declare const plantillaDe: (text: string) => string | null;
/** For the tool description: each template with when it goes. */
export declare function listaPlantillas(): string;
