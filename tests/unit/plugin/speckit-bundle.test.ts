import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * La copia de Spec Kit que trae el plugin. Los skills de Spec Kit ejecutan sus
 * scripts directamente: con finales de línea de Windows o sin permiso de
 * ejecución, fallan en la máquina de alguien y no aquí.
 */

const BUNDLE = path.join(PLUGIN_ROOT, "speckit-bundle");
const SPECIFY = path.join(BUNDLE, ".specify");
const SPECKIT_COMMANDS = ["specify", "clarify", "plan", "tasks"].map(
  (c) => `speckit-${c}`,
);

function indexEntries(
  relativeDir: string,
): Array<{ mode: string; file: string }> {
  const out = spawnSync("git", ["ls-files", "-s", "--", relativeDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      return { mode: meta!.split(" ")[0]!, file: file! };
    });
}

describe("speckit-bundle", () => {
  it("dice qué versión de Spec Kit trae, la misma que declara init-options", () => {
    const version = readFileSync(path.join(BUNDLE, "VERSION"), "utf8").trim();
    const options = JSON.parse(
      readFileSync(path.join(SPECIFY, "init-options.json"), "utf8"),
    ) as { speckit_version: string; script: string };

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(options.speckit_version).toBe(version);
    expect(options.script).toBe("sh");
    expect(readFileSync(path.join(BUNDLE, "LICENSE-spec-kit"), "utf8")).toMatch(
      /MIT License/,
    );
  });

  it("no trae extensiones, hooks ni workflows: Spec Kit pediría Python o crearía ramas", () => {
    const extensions = readFileSync(
      path.join(SPECIFY, "extensions.yml"),
      "utf8",
    );

    expect(extensions).toMatch(/^installed: \[\]$/m);
    expect(extensions).toMatch(/^hooks: \{\}$/m);
    expect(existsSync(path.join(SPECIFY, "extensions"))).toBe(false);
    expect(existsSync(path.join(SPECIFY, "workflows"))).toBe(false);
  });

  it("sus scripts no tienen finales de línea de Windows", () => {
    const scripts = readdirSync(path.join(SPECIFY, "scripts/bash"));

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const body = spawnSync(
        "git",
        [
          "show",
          `:plugins/fabrica/speckit-bundle/.specify/scripts/bash/${script}`,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).stdout;
      expect(body.length, script).toBeGreaterThan(0);
      expect(body, script).not.toContain("\r");
    }
  });

  it("sus scripts van commiteados como ejecutables", () => {
    const entries = indexEntries(
      "plugins/fabrica/speckit-bundle/.specify/scripts/bash",
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const { mode, file } of entries) expect(mode, file).toBe("100755");
  });

  it("el repo fija LF para los scripts, también los de bin/", () => {
    const attributes = readFileSync(
      path.join(REPO_ROOT, ".gitattributes"),
      "utf8",
    );

    expect(attributes).toMatch(/^\*\.sh\s+text\s+eol=lf$/m);
    expect(attributes).toMatch(/^plugins\/fabrica\/bin\/\*\s+text\s+eol=lf$/m);
  });

  it("no le quedan marcas sin reemplazar del código fuente de Spec Kit", () => {
    const files = [
      ...readdirSync(path.join(SPECIFY, "scripts/bash")).map((f) =>
        path.join(SPECIFY, "scripts/bash", f),
      ),
      ...readdirSync(path.join(SPECIFY, "templates")).map((f) =>
        path.join(SPECIFY, "templates", f),
      ),
      ...SPECKIT_COMMANDS.map((c) => path.join(BUNDLE, "commands", `${c}.md`)),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /__SPECKIT_COMMAND_|\$\(format_speckit_command|\{SCRIPT\}|\{ARGS\}/,
      );
    }
  });

  it.each(SPECKIT_COMMANDS)(
    "%s vive en el bundle y no como skill: el modelo no puede cargarlo por su cuenta",
    (command) => {
      const body = readFileSync(
        path.join(BUNDLE, "commands", `${command}.md`),
        "utf8",
      );

      expect(body).toMatch(new RegExp(`^name: "${command}"$`, "m"));
      expect(existsSync(path.join(PLUGIN_ROOT, "skills", command))).toBe(false);
    },
  );

  it("la plantilla de tareas de la fábrica pide tests en cada historia", () => {
    const override = readFileSync(
      path.join(PLUGIN_ROOT, "speckit-overrides/tasks-template.md"),
      "utf8",
    );

    expect(override).not.toMatch(/OPTIONAL/);
    expect(
      override.match(/MANDATORY, write first/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("la plantilla de tareas pide test primero también en Setup y Foundational", () => {
    const override = readFileSync(
      path.join(PLUGIN_ROOT, "speckit-overrides/tasks-template.md"),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(override).toMatch(
      /Setup and Foundational[^.]*after the task that writes its failing test/,
    );
  });
});
