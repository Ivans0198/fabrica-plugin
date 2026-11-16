import path from "node:path";

/** Raíz del repo del plugin. */
export const REPO_ROOT = path.resolve(__dirname, "../..");

/** Raíz del plugin `fabrica`. */
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/fabrica");

/** Archivos que `init` copia al proyecto. */
export const TEMPLATES_ROOT = path.join(PLUGIN_ROOT, "templates");

/**
 * Dónde vive hoy cada ruta que en un proyecto de la plantilla vieja estaba en
 * la raíz. La maquinaria pasó al plugin; lo demás es plantilla de proyecto.
 */
const MACHINERY: ReadonlyArray<readonly [string, string]> = [
  [".claude/hooks/", "hooks/"],
  [".claude/agents", "agents"],
  [".claude/skills", "skills"],
  ["scripts/", "scripts/"],
  ["rules/", "rules/"],
  ["GUIA-DE-LA-FABRICA.md", "docs/GUIA-DE-LA-FABRICA.md"],
];

/**
 * Traduce una ruta tal como se escribía en la plantilla (`scripts/x.sh`,
 * `CLAUDE.md`) a su lugar en este repo.
 */
export function pluginFile(projectPath: string): string {
  // Los tests del kit y los reusable workflows viven en la raíz de este repo,
  // no en el plugin. Las llamadas cortas del proyecto se leen de
  // TEMPLATES_ROOT a propósito.
  if (
    projectPath === "README.md" ||
    projectPath.startsWith("tests/unit/") ||
    projectPath.startsWith(".github/workflows/")
  ) {
    return path.join(REPO_ROOT, projectPath);
  }
  for (const [from, to] of MACHINERY) {
    if (projectPath.startsWith(from)) {
      return path.join(PLUGIN_ROOT, to + projectPath.slice(from.length));
    }
  }
  return path.join(TEMPLATES_ROOT, projectPath);
}
