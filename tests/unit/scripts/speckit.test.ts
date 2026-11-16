import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT } from "../../support/plugin-paths";

/**
 * `fabrica-setup speckit` arma `.specify/` en cada máquina: Spec Kit del
 * plugin, la constitución y la plantilla de tareas con tests obligatorios.
 * No se commitea, así que tiene que poder rehacerse sin perder nada propio.
 * `fabrica-feature` dice en qué feature se está trabajando, porque Spec Kit
 * no lo deduce de la rama y su `feature.json` es local.
 */

const SETUP = path
  .join(PLUGIN_ROOT, "scripts/fabrica-setup.sh")
  .replace(/\\/g, "/");
const FEATURE = path
  .join(PLUGIN_ROOT, "scripts/feature.sh")
  .replace(/\\/g, "/");
const TIMEOUT = 30_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function gitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fabrica-speckit-"));
  temps.push(dir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function run(script: string, cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.FABRICA_PLUGIN_ROOT;
  const result = spawnSync("bash", [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const setup = (cwd: string, ...args: string[]) => run(SETUP, cwd, args);
const read = (dir: string, file: string) =>
  readFileSync(path.join(dir, file), "utf8");
const exists = (dir: string, file: string) => existsSync(path.join(dir, file));
const write = (dir: string, file: string, body: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
};
const isIgnored = (dir: string, file: string) =>
  spawnSync("git", ["check-ignore", "-q", file], { cwd: dir }).status === 0;

function project(): string {
  const dir = gitRepo();
  const init = setup(dir, "init");
  expect(init.code, init.out).toBe(0);
  return dir;
}

function setStack(dir: string, stack: string) {
  const factory = JSON.parse(read(dir, "factory.json")) as { stack: string };
  factory.stack = stack;
  writeFileSync(path.join(dir, "factory.json"), JSON.stringify(factory));
}

describe("fabrica-setup speckit", () => {
  it(
    "arma .specify con los scripts de Spec Kit, la constitución y la plantilla de tareas con tests obligatorios",
    () => {
      const dir = project();

      const { code, out } = setup(dir, "speckit");

      expect(code, out).toBe(0);
      expect(exists(dir, ".specify/scripts/bash/common.sh")).toBe(true);
      expect(exists(dir, ".specify/scripts/bash/setup-plan.sh")).toBe(true);
      for (const c of ["specify", "clarify", "plan", "tasks"]) {
        expect(exists(dir, `.specify/commands/speckit-${c}.md`), c).toBe(true);
      }
      expect(read(dir, ".specify/extensions.yml")).toMatch(/^hooks: \{\}$/m);
      const constitution = read(dir, ".specify/memory/constitution.md");
      expect(constitution).toMatch(/Test-first/);
      expect(constitution).toContain("## Stack profile: node-ts");
      expect(constitution).toContain(
        read(dir, ".factory/rules/stacks/node-ts.md").split(/\r?\n/)[0],
      );
      const tasks = read(dir, ".specify/templates/overrides/tasks-template.md");
      expect(tasks).not.toMatch(/OPTIONAL/);
      expect(tasks).toMatch(/MANDATORY/);
      expect(exists(dir, ".specify/fabrica-version")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "deja .specify fuera de git, también en un proyecto iniciado antes de que existiera",
    () => {
      const dir = project();
      const gitignore = read(dir, ".gitignore")
        .split("\n")
        .filter((line) => line.trim() !== ".specify/")
        .join("\n");
      writeFileSync(path.join(dir, ".gitignore"), gitignore);

      setup(dir, "speckit");

      expect(isIgnored(dir, ".specify/memory/constitution.md")).toBe(true);
      expect(isIgnored(dir, ".specify.tmp.Ab12Cd/scripts/x.sh")).toBe(true);
      expect(isIgnored(dir, "specs/12-x/spec.md")).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "con la misma versión, stack, reglas y perfil no rehace nada",
    () => {
      const dir = project();
      setup(dir, "speckit");
      write(dir, ".specify/marca.txt", "sigo aquí\n");

      const { code, out } = setup(dir, "speckit");

      expect(code, out).toBe(0);
      expect(exists(dir, ".specify/marca.txt")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "si cambia el stack lo rehace entero, borra lo que sobra y conserva feature.json",
    () => {
      const dir = project();
      setup(dir, "speckit");
      write(dir, ".specify/marca.txt", "sobra\n");
      write(
        dir,
        ".specify/feature.json",
        '{"feature_directory": "specs/7-x"}\n',
      );
      write(dir, ".factory/rules/stacks/go.md", "# Perfil de Go\n");
      setStack(dir, "go");

      const { code, out } = setup(dir, "speckit");

      expect(code, out).toBe(0);
      expect(exists(dir, ".specify/marca.txt")).toBe(false);
      expect(read(dir, ".specify/feature.json")).toContain("specs/7-x");
      expect(read(dir, ".specify/memory/constitution.md")).toContain(
        "# Perfil de Go",
      );
    },
    TIMEOUT,
  );

  it(
    "si el perfil del stack cambia, rehace la constitución",
    () => {
      const dir = project();
      setup(dir, "speckit");
      const profile = ".factory/rules/stacks/node-ts.md";
      write(dir, profile, `${read(dir, profile)}\nRegla nueva del equipo.\n`);

      setup(dir, "speckit");

      expect(read(dir, ".specify/memory/constitution.md")).toContain(
        "Regla nueva del equipo.",
      );
    },
    TIMEOUT,
  );

  it(
    "sin perfil para el stack lo dice en la constitución, no lo omite",
    () => {
      const dir = project();
      setStack(dir, "rust");

      const { code, out } = setup(dir, "speckit");

      expect(code, out).toBe(0);
      expect(read(dir, ".specify/memory/constitution.md")).toMatch(
        /No profile exists yet for the stack `rust`/,
      );
    },
    TIMEOUT,
  );

  it.each(["../../etc", "Node TS", "x/y"])(
    "rechaza un stack que no es un nombre (%s) y no arma nada",
    (stack) => {
      const dir = project();
      setStack(dir, stack);

      const { code, out } = setup(dir, "speckit");

      expect(code).not.toBe(0);
      expect(out).toMatch(/stack/);
      expect(exists(dir, ".specify")).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "no toca un .specify que no armó la fábrica",
    () => {
      const dir = project();
      write(dir, ".specify/bugs/b1.md", "# de otro\n");

      const { code, out } = setup(dir, "speckit");

      expect(code).not.toBe(0);
      expect(out).toMatch(/\.specify/);
      expect(read(dir, ".specify/bugs/b1.md")).toBe("# de otro\n");
    },
    TIMEOUT,
  );

  it(
    "pide init en un proyecto sin la fábrica",
    () => {
      const dir = gitRepo();

      const { code, out } = setup(dir, "speckit");

      expect(code).not.toBe(0);
      expect(out).toMatch(/fabrica-setup init/);
    },
    TIMEOUT,
  );
});

describe("fabrica-feature", () => {
  function withFeature(...folders: string[]): string {
    const dir = project();
    setup(dir, "speckit");
    for (const folder of folders) write(dir, `${folder}/spec.md`, "# spec\n");
    return dir;
  }

  const checkout = (dir: string, branch: string) =>
    spawnSync("git", ["checkout", "-q", "-b", branch], { cwd: dir });

  it(
    "en la rama spec-N encuentra specs/N-*, lo anota en feature.json y lo imprime",
    () => {
      const dir = withFeature("specs/12-favoritos", "specs/120-otra");
      checkout(dir, "spec-12");

      const { code, out } = run(FEATURE, dir, []);

      expect(code, out).toBe(0);
      expect(out.trim()).toBe("specs/12-favoritos");
      expect(
        JSON.parse(read(dir, ".specify/feature.json")).feature_directory,
      ).toBe("specs/12-favoritos");
    },
    TIMEOUT,
  );

  it(
    "los scripts de Spec Kit encuentran la feature y usan la plantilla de tareas de la fábrica",
    () => {
      const dir = withFeature("specs/12-favoritos");
      write(dir, "specs/12-favoritos/plan.md", "# Plan\n");
      checkout(dir, "spec-12");
      expect(run(FEATURE, dir, []).code).toBe(0);
      const speckit = (script: string, ...args: string[]) => {
        const result = spawnSync(
          "bash",
          [`.specify/scripts/bash/${script}`, ...args],
          { cwd: dir, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as Record<string, string>;
      };
      const slash = (p: string) => p.replace(/\\/g, "/");

      const paths = speckit("check-prerequisites.sh", "--json", "--paths-only");
      const tasks = speckit("setup-tasks.sh", "--json");

      expect(slash(paths.FEATURE_SPEC!)).toMatch(
        /specs\/12-favoritos\/spec\.md$/,
      );
      expect(slash(tasks.FEATURE_DIR!)).toMatch(/specs\/12-favoritos$/);
      expect(slash(tasks.TASKS_TEMPLATE!)).toMatch(
        /\.specify\/templates\/overrides\/tasks-template\.md$/,
      );
      expect(tasks.TASKS_TEMPLATE_CONTENT).toMatch(/MANDATORY/);
    },
    TIMEOUT,
  );

  it(
    "acepta el número como argumento desde cualquier rama",
    () => {
      const dir = withFeature("specs/7-carrito");

      const { code, out } = run(FEATURE, dir, ["7"]);

      expect(code, out).toBe(0);
      expect(out.trim()).toBe("specs/7-carrito");
    },
    TIMEOUT,
  );

  it(
    "fuera de una rama spec-N y sin número, dice cómo seguir",
    () => {
      const dir = withFeature("specs/7-carrito");

      const { code, out } = run(FEATURE, dir, []);

      expect(code).not.toBe(0);
      expect(out).toMatch(/spec-<N>/);
    },
    TIMEOUT,
  );

  it(
    "falla si no hay carpeta para ese número",
    () => {
      const dir = withFeature("specs/7-carrito");

      const { code, out } = run(FEATURE, dir, ["8"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/specs\/8-/);
    },
    TIMEOUT,
  );

  it(
    "falla si hay dos carpetas con el mismo número y las nombra",
    () => {
      const dir = withFeature("specs/7-carrito", "specs/7-checkout");

      const { code, out } = run(FEATURE, dir, ["7"]);

      expect(code).not.toBe(0);
      expect(out).toContain("specs/7-carrito");
      expect(out).toContain("specs/7-checkout");
    },
    TIMEOUT,
  );

  it.each(["7x", "-1", "../7"])(
    "rechaza un número que no es un número (%s)",
    (arg) => {
      const dir = withFeature("specs/7-carrito");

      const { code, out } = run(FEATURE, dir, [arg]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/no es un número de épica/);
    },
    TIMEOUT,
  );

  it(
    "pide fabrica-setup speckit si falta .specify",
    () => {
      const dir = project();
      write(dir, "specs/7-carrito/spec.md", "# spec\n");

      const { code, out } = run(FEATURE, dir, ["7"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/fabrica-setup speckit/);
    },
    TIMEOUT,
  );
});
