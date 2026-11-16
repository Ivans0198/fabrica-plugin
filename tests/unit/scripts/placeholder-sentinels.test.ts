import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";


/**
 * No todas las llaves dobles de este repositorio son huecos que rellenar.
 *
 * Dos sitios las usan como CENTINELA: buscan el texto literal `{{...}}` para
 * negarse a funcionar mientras el bootstrap no haya pasado. (El Stop gate y
 * checks.yml ya no: se arman cuando existe factory.json, que no se puede
 * borrar por accidente con un buscar y reemplazar.) Un reemplazo mecánico de
 * placeholders se los lleva
 * por delante, y lo peor es que nada se rompe ese día: los guardias
 * simplemente dejan de guardar, en silencio, hasta que meses después alguien
 * arranca un servidor sobre un puerto ajeno o el Stop gate se dispara en un
 * repositorio a medio configurar.
 *
 * Este test es el que hace ruido en su lugar. Si falla después de un
 * bootstrap, el bootstrap rellenó de más.
 */
interface Sentinel {
  /** Archivo que contiene el centinela. */
  readonly file: string;
  /** El texto exacto que NO se puede rellenar. */
  readonly literal: string;
  /** Qué deja de funcionar si desaparece. */
  readonly protects: string;
}

const SENTINELS: readonly Sentinel[] = [
  {
    file: "scripts/ui-preflight.sh",
    literal: "*'{{'*)",
    protects:
      "la negativa a levantar el dev server con la URL y el comando sin rellenar",
  },
  {
    file: "tests/unit/scripts/report-visual-incident.test.ts",
    literal: 'FACTORY_EPIC: "{{FACTORY_EPIC}}"',
    protects:
      "el test que comprueba que un incidente visual no se cuelga de un issue ajeno",
  },
];

describe("centinelas de placeholders", () => {
  it.each(SENTINELS)(
    "$file conserva el literal que protege $protects",
    ({ file, literal }) => {
      const source = readFileSync(pluginFile(file), "utf8");

      expect(source).toContain(literal);
    },
  );
});
