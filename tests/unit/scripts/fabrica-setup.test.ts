import { spawnSync } from "node:child_process";
import {
  cpSync,
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

const SETUP = path
  .join(PLUGIN_ROOT, "scripts/fabrica-setup.sh")
  .replace(/\\/g, "/");
const PLUGIN_VERSION = (
  JSON.parse(
    readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8"),
  ) as {
    version: string;
  }
).version;
const PLUGIN_REPO = (
  JSON.parse(
    readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8"),
  ) as { repository: string }
).repository
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "");
const RULES = ".factory/rules/fabrica.md";
const PROFILE = ".factory/rules/stacks/node-ts.md";
const CALLERS = [
  "checks.yml",
  "claude-backlog.yml",
  "claude-mentions.yml",
  "labels-cleanup.yml",
  "pr-conflicts.yml",
];

/** Lanzan bash y git de verdad. */
const TIMEOUT = 20_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir("fabrica-setup-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function setup(cwd: string, args: string[], pluginRoot?: string) {
  const env = { ...process.env };
  if (pluginRoot) env.FABRICA_PLUGIN_ROOT = pluginRoot.replace(/\\/g, "/");
  else delete env.FABRICA_PLUGIN_ROOT;
  const result = spawnSync("bash", [SETUP, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), "utf8");
}

/** Copia del plugin con la versión y las reglas cambiadas: una "versión nueva". */
function newerPlugin(version: string, rulesSuffix: string): string {
  const copy = tempDir("fabrica-plugin-");
  cpSync(PLUGIN_ROOT, copy, { recursive: true });
  const manifestPath = path.join(copy, ".claude-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: string;
  };
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const rulesPath = path.join(copy, "rules/fabrica.md");
  writeFileSync(rulesPath, readFileSync(rulesPath, "utf8") + rulesSuffix);
  return copy;
}

const TEMPLATE_PERMISSIONS = (
  JSON.parse(
    readFileSync(
      path.join(PLUGIN_ROOT, "templates/.claude/settings.json"),
      "utf8",
    ),
  ) as { permissions: { allow: string[]; deny: string[] } }
).permissions;

function writeSettings(dir: string, settings: unknown): void {
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude/settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

function isIgnored(dir: string, file: string): boolean {
  return (
    spawnSync("git", ["check-ignore", "-q", file], { cwd: dir }).status === 0
  );
}

describe("fabrica-setup init", () => {
  it(
    "en un repo vacío copia las reglas, el perfil y los archivos del proyecto, y guarda versión y manifiesto",
    () => {
      const dir = gitRepo();

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      expect(read(dir, RULES)).toBe(read(PLUGIN_ROOT, "rules/fabrica.md"));
      expect(read(dir, PROFILE)).toBe(
        read(PLUGIN_ROOT, "rules/stacks/node-ts.md"),
      );
      expect(read(dir, "CLAUDE.md")).toContain("@.factory/rules/fabrica.md");
      expect(JSON.parse(read(dir, "factory.json"))).toEqual(
        JSON.parse(read(PLUGIN_ROOT, "templates/factory.example.json")),
      );
      expect(read(dir, ".factory/version").trim()).toBe(PLUGIN_VERSION);
      const manifest = JSON.parse(read(dir, ".factory/manifest.json")) as {
        version: string;
        files: Record<string, string>;
      };
      expect(manifest.version).toBe(PLUGIN_VERSION);
      expect(Object.keys(manifest.files)).toEqual(
        expect.arrayContaining([RULES, PROFILE]),
      );
      expect(manifest.files[RULES]).toMatch(/^[0-9a-f]{40}$/);
    },
    TIMEOUT,
  );

  it(
    "commitea reglas, versión y manifiesto, e ignora el estado de las corridas",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);

      expect(isIgnored(dir, RULES)).toBe(false);
      expect(isIgnored(dir, ".factory/version")).toBe(false);
      expect(isIgnored(dir, ".factory/manifest.json")).toBe(false);
      expect(isIgnored(dir, ".factory/state/stop-gate-count")).toBe(true);
      expect(isIgnored(dir, ".factory/review/code-round-1.md")).toBe(true);
      expect(isIgnored(dir, ".factory/gate-gave-up")).toBe(true);
    },
    TIMEOUT,
  );

  it.each([".factory/", ".factory", "/.factory/", "/.factory"])(
    "cambia un `%s` que ignoraba todo, porque no deja commitear el manifiesto",
    (line) => {
      const dir = gitRepo();
      writeFileSync(path.join(dir, ".gitignore"), `node_modules/\n${line}\n`);

      setup(dir, ["init"]);

      const lines = read(dir, ".gitignore").split("\n");
      expect(lines).toContain("node_modules/");
      expect(lines).not.toContain(line);
      expect(isIgnored(dir, ".factory/manifest.json")).toBe(false);
      expect(isIgnored(dir, ".factory/state/stop-gate-count")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "ignora los .fabrica-new, que son para combinar y nunca para commitear",
    () => {
      const dir = gitRepo();

      setup(dir, ["init"]);

      expect(isIgnored(dir, ".factory/rules/fabrica.md.fabrica-new")).toBe(
        true,
      );
      expect(isIgnored(dir, ".github/workflows/checks.yml.fabrica-new")).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  it(
    "ignora los worktrees de las issues, para que el checkout principal no quede sucio",
    () => {
      const dir = gitRepo();

      setup(dir, ["init"]);

      expect(isIgnored(dir, ".claude/worktrees/impl-7/package.json")).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  it(
    "escribe los permisos del proyecto sin hooks propios, que ahora trae el plugin",
    () => {
      const dir = gitRepo();

      setup(dir, ["init"]);

      const settings = JSON.parse(read(dir, ".claude/settings.json")) as {
        hooks?: unknown;
        permissions: { allow: string[]; deny: string[] };
      };
      expect(settings.hooks).toBeUndefined();
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining([
          "Read(**/.env)",
          "Read(**/.env.local)",
          "Bash(git push --force)",
          "Bash(git push * --force)",
          "Bash(sudo *)",
        ]),
      );
      // Revisión del 2026-11-23: con --force-with-lease permitido, se podía
      // reescribir la rama base sin preguntar.
      expect(settings.permissions.allow).not.toContain(
        "Bash(git push --force-with-lease:*)",
      );
    },
    TIMEOUT,
  );

  it(
    "los permisos niegan los .env reales pero no .env.example, y los push forzados también con lease",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const { deny } = (
        JSON.parse(read(dir, ".claude/settings.json")) as {
          permissions: { deny: string[] };
        }
      ).permissions;

      // Las reglas usan * como comodín de texto; se comprueban igual aquí.
      const matches = (rule: string, tool: string, arg: string) => {
        const m = rule.match(/^(\w+)\((.*)\)$/);
        if (!m || m[1] !== tool) return false;
        const pattern = m[2]
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "(?:.*/)?")
          .replace(/\*/g, ".*");
        return new RegExp(`^${pattern}$`).test(arg);
      };
      const denied = (tool: string, arg: string) =>
        deny.some((r) => matches(r, tool, arg));

      expect(denied("Read", ".env")).toBe(true);
      expect(denied("Read", "app/.env.local")).toBe(true);
      expect(denied("Read", ".env.example")).toBe(false);
      expect(denied("Bash", "git push --force")).toBe(true);
      expect(denied("Bash", "git push origin main --force")).toBe(true);
      expect(denied("Bash", "git push -f origin main")).toBe(true);
      expect(denied("Bash", "git push --force-with-lease")).toBe(true);
      expect(denied("Bash", "git push origin impl-7 --force-with-lease")).toBe(
        true,
      );
      expect(
        denied("Bash", "git push origin HEAD:main --force-with-lease=main"),
      ).toBe(true);
      expect(denied("Bash", "git push -u origin impl-7")).toBe(false);
      expect(denied("Bash", "rm -rf /")).toBe(true);
      expect(denied("Bash", "rm -rf /tmp/build")).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "no pisa un CLAUDE.md ni un factory.json que ya existen",
    () => {
      const dir = gitRepo();
      writeFileSync(path.join(dir, "CLAUDE.md"), "# mío\n");
      writeFileSync(path.join(dir, "factory.json"), '{"stack": "go"}\n');

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      expect(read(dir, "CLAUDE.md")).toBe("# mío\n");
      expect(read(dir, "factory.json")).toBe('{"stack": "go"}\n');
    },
    TIMEOUT,
  );

  // El README manda a instalar el plugin antes de bootstrap, y
  // `claude plugin install --scope project` crea settings.json solo con
  // enabledPlugins.
  it(
    "suma los permisos a un settings.json que ya creó claude plugin install, sin quitarle nada",
    () => {
      const dir = gitRepo();
      writeSettings(dir, { enabledPlugins: { "fabrica@fabrica-local": true } });

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      const settings = JSON.parse(read(dir, ".claude/settings.json")) as {
        enabledPlugins: unknown;
        permissions: { allow: string[]; deny: string[] };
      };
      expect(settings.enabledPlugins).toEqual({
        "fabrica@fabrica-local": true,
      });
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(TEMPLATE_PERMISSIONS.deny),
      );
      expect(settings.permissions.allow).toEqual(
        expect.arrayContaining(TEMPLATE_PERMISSIONS.allow),
      );
      expect(out).not.toMatch(/Activa el plugin/);
    },
    TIMEOUT,
  );

  it(
    "conserva los permisos propios del proyecto y no repite los que ya estaban",
    () => {
      const dir = gitRepo();
      writeSettings(dir, {
        permissions: {
          allow: ["Bash(make:*)"],
          deny: ["Read(**/.env)", "Bash(docker *)"],
        },
      });

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      const { allow, deny } = (
        JSON.parse(read(dir, ".claude/settings.json")) as {
          permissions: { allow: string[]; deny: string[] };
        }
      ).permissions;
      expect(allow).toContain("Bash(make:*)");
      expect(deny).toContain("Bash(docker *)");
      expect(deny).toEqual(expect.arrayContaining(TEMPLATE_PERMISSIONS.deny));
      expect(deny.filter((rule) => rule === "Read(**/.env)")).toHaveLength(1);
      expect(out).toMatch(/Activa el plugin/);
    },
    TIMEOUT,
  );

  it.each([
    ["no es JSON", "{ no es json\n"],
    ["deny no es una lista", '{"permissions": {"deny": "Read(**/.env)"}}\n'],
  ])(
    "un settings.json que %s lo para antes de escribir nada",
    (_caso, body) => {
      const dir = gitRepo();
      mkdirSync(path.join(dir, ".claude"));
      writeFileSync(path.join(dir, ".claude/settings.json"), body);

      const { code, out } = setup(dir, ["init"]);

      expect(code).not.toBe(0);
      expect(out).toContain(".claude/settings.json");
      expect(read(dir, ".claude/settings.json")).toBe(body);
      expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
      expect(existsSync(path.join(dir, ".factory/version"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "no corre dos veces: un proyecto ya iniciado se actualiza con refresh",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);

      const { code, out } = setup(dir, ["init"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/refresh/);
    },
    TIMEOUT,
  );

  it(
    "escribe las llamadas a los workflows del plugin con su repo y su versión",
    () => {
      const dir = gitRepo();

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      const manifest = JSON.parse(read(dir, ".factory/manifest.json")) as {
        files: Record<string, string>;
      };
      for (const caller of CALLERS) {
        const file = `.github/workflows/${caller}`;
        const body = read(dir, file);
        expect(body, file).toContain(
          `uses: ${PLUGIN_REPO}/.github/workflows/${caller}@v${PLUGIN_VERSION}`,
        );
        expect(body, file).not.toContain("__FABRICA_");
        expect(Object.keys(manifest.files)).toContain(file);
      }
    },
    TIMEOUT,
  );

  it(
    "escribe el workflow visual solo si el proyecto tiene módulo visual",
    () => {
      const sinUi = gitRepo();
      setup(sinUi, ["init"]);
      expect(
        existsSync(path.join(sinUi, ".github/workflows/visual-baselines.yml")),
      ).toBe(false);

      const conUi = gitRepo();
      mkdirSync(path.join(conUi, "tests"));
      writeFileSync(path.join(conUi, "tests/ui.spec.ts"), "// ui\n");
      setup(conUi, ["init"]);
      expect(read(conUi, ".github/workflows/visual-baselines.yml")).toContain(
        `@v${PLUGIN_VERSION}`,
      );
    },
    TIMEOUT,
  );

  it(
    "falla fuera de un repo git",
    () => {
      const dir = tempDir("fabrica-nogit-");

      const { code, out } = setup(dir, ["init"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/git/);
      expect(existsSync(path.join(dir, ".factory"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("fabrica-setup check", () => {
  it(
    "pasa callado cuando el proyecto está en la versión del plugin",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);

      const { code, out } = setup(dir, ["check"]);

      expect(code, out).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "falla y manda a refresh cuando el plugin es de otra versión",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);

      const { code, out } = setup(dir, ["check"], newerPlugin("9.9.9", ""));

      expect(code).not.toBe(0);
      expect(out).toContain(PLUGIN_VERSION);
      expect(out).toContain("9.9.9");
      expect(out).toMatch(/fabrica-setup refresh/);
    },
    TIMEOUT,
  );

  it(
    "falla mientras quede un .fabrica-new sin combinar",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const file = ".github/workflows/claude-backlog.yml";
      writeFileSync(path.join(dir, file), `${read(dir, file)}# mi cron\n`);
      const plugin = newerPlugin("9.9.9", "");
      setup(dir, ["refresh"], plugin);

      const { code, out } = setup(dir, ["check"], plugin);

      expect(code).not.toBe(0);
      expect(out).toContain(`${file}.fabrica-new`);
    },
    TIMEOUT,
  );

  it(
    "falla si una llamada a un workflow quedó en otra versión, y pasa cuando se combina",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const file = ".github/workflows/claude-backlog.yml";
      writeFileSync(path.join(dir, file), `${read(dir, file)}# mi cron\n`);
      const plugin = newerPlugin("9.9.9", "");
      setup(dir, ["refresh"], plugin);
      const merged = `${read(dir, `${file}.fabrica-new`)}# mi cron\n`;
      rmSync(path.join(dir, `${file}.fabrica-new`));

      const stale = setup(dir, ["check"], plugin);

      expect(stale.code).not.toBe(0);
      expect(stale.out).toContain(file);
      expect(stale.out).toContain("v9.9.9");

      writeFileSync(path.join(dir, file), merged);
      const fixed = setup(dir, ["check"], plugin);

      expect(fixed.code, fixed.out).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "avisa, sin fallar, si el firewall del dev container es de antes de la marca",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      mkdirSync(path.join(dir, ".devcontainer"));
      writeFileSync(
        path.join(dir, ".devcontainer/init-firewall.sh"),
        "#!/bin/bash\necho firewall viejo\n",
      );

      const old = setup(dir, ["check"]);

      expect(old.code, old.out).toBe(0);
      expect(old.out).toMatch(/fabrica-devcontainer --force/);

      cpSync(
        path.join(PLUGIN_ROOT, "templates/.devcontainer/init-firewall.sh"),
        path.join(dir, ".devcontainer/init-firewall.sh"),
      );
      const fresh = setup(dir, ["check"]);

      expect(fresh.code, fresh.out).toBe(0);
      expect(fresh.out).not.toMatch(/fabrica-devcontainer/);
    },
    TIMEOUT,
  );

  it(
    "falla y manda a init cuando el proyecto no está iniciado",
    () => {
      const dir = gitRepo();

      const { code, out } = setup(dir, ["check"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/fabrica-setup init/);
    },
    TIMEOUT,
  );
});

describe("fabrica-setup refresh", () => {
  it(
    "reemplaza una copia que nadie tocó y actualiza versión y hash",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const before = JSON.parse(read(dir, ".factory/manifest.json")).files[
        RULES
      ];
      const plugin = newerPlugin("9.9.9", "\nRegla nueva.\n");

      const { code, out } = setup(dir, ["refresh"], plugin);

      expect(code, out).toBe(0);
      expect(read(dir, RULES)).toContain("Regla nueva.");
      expect(read(dir, ".factory/version").trim()).toBe("9.9.9");
      expect(
        JSON.parse(read(dir, ".factory/manifest.json")).files[RULES],
      ).not.toBe(before);
      expect(existsSync(path.join(dir, `${RULES}.fabrica-new`))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "no pisa una copia editada a mano: deja la nueva al lado y lo dice",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeFileSync(path.join(dir, RULES), "# editado a mano\n");
      const plugin = newerPlugin("9.9.9", "\nRegla nueva.\n");

      const { code, out } = setup(dir, ["refresh"], plugin);

      expect(code, out).toBe(0);
      expect(read(dir, RULES)).toBe("# editado a mano\n");
      expect(read(dir, `${RULES}.fabrica-new`)).toContain("Regla nueva.");
      expect(out).toContain(`${RULES}.fabrica-new`);
    },
    TIMEOUT,
  );

  it(
    "solo actualiza el hash cuando la copia ya es igual a la versión nueva",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const plugin = newerPlugin("9.9.9", "\nRegla nueva.\n");
      writeFileSync(path.join(dir, RULES), read(plugin, "rules/fabrica.md"));

      const { code, out } = setup(dir, ["refresh"], plugin);

      expect(code, out).toBe(0);
      expect(existsSync(path.join(dir, `${RULES}.fabrica-new`))).toBe(false);
      expect(setup(dir, ["check"], plugin).code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "lleva las llamadas a los workflows a la versión nueva",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);

      const { code, out } = setup(dir, ["refresh"], newerPlugin("9.9.9", ""));

      expect(code, out).toBe(0);
      expect(read(dir, ".github/workflows/checks.yml")).toContain(
        `checks.yml@v9.9.9`,
      );
      expect(read(dir, ".github/workflows/checks.yml")).toContain(
        "fabrica_ref: v9.9.9",
      );
    },
    TIMEOUT,
  );

  it(
    "vuelve a escribir una copia borrada",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      rmSync(path.join(dir, PROFILE));

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(read(dir, PROFILE)).toBe(
        read(PLUGIN_ROOT, "rules/stacks/node-ts.md"),
      );
    },
    TIMEOUT,
  );

  it(
    "un archivo propio que ya existía antes de init sigue a salvo en los refresh siguientes",
    () => {
      const dir = gitRepo();
      const file = ".github/workflows/checks.yml";
      mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(path.join(dir, file), "name: mío\n");
      setup(dir, ["init"]);
      expect(read(dir, file)).toBe("name: mío\n");

      const { code, out } = setup(dir, ["refresh"], newerPlugin("9.9.9", ""));

      expect(code, out).toBe(0);
      expect(read(dir, file)).toBe("name: mío\n");
      expect(read(dir, `${file}.fabrica-new`)).toContain("@v9.9.9");
    },
    TIMEOUT,
  );

  it(
    "borra una copia que el plugin ya no trae, si nadie la tocó",
    () => {
      const dir = gitRepo();
      const older = newerPlugin("0.0.1", "");
      writeFileSync(path.join(older, "rules/stacks/go.md"), "# go\n");
      setup(dir, ["init"], older);
      expect(read(dir, ".factory/rules/stacks/go.md")).toBe("# go\n");

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(exists(dir, ".factory/rules/stacks/go.md")).toBe(false);
      expect(
        Object.keys(JSON.parse(read(dir, ".factory/manifest.json")).files),
      ).not.toContain(".factory/rules/stacks/go.md");
    },
    TIMEOUT,
  );

  it(
    "conserva una copia que el plugin ya no trae si alguien la editó, y lo avisa",
    () => {
      const dir = gitRepo();
      const older = newerPlugin("0.0.1", "");
      writeFileSync(path.join(older, "rules/stacks/go.md"), "# go\n");
      setup(dir, ["init"], older);
      writeFileSync(path.join(dir, ".factory/rules/stacks/go.md"), "# mío\n");

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(read(dir, ".factory/rules/stacks/go.md")).toBe("# mío\n");
      expect(out).toContain(".factory/rules/stacks/go.md");
    },
    TIMEOUT,
  );

  it(
    "no confunde los finales de línea de Windows con una edición a mano",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const crlf = read(dir, RULES).replace(/\n/g, "\r\n");
      writeFileSync(path.join(dir, RULES), crlf);
      const plugin = newerPlugin("9.9.9", "\nRegla nueva.\n");

      setup(dir, ["refresh"], plugin);

      expect(read(dir, RULES)).toContain("Regla nueva.");
      expect(existsSync(path.join(dir, `${RULES}.fabrica-new`))).toBe(false);
    },
    TIMEOUT,
  );
});

const OLD_CLAUDE_MD = `# CLAUDE.md: Tienda

## Project

Una tienda en línea para vender cerámica.

Stack: Next.js. Its stack profile is
\`rules/stacks/<stack>.md\`, with \`<stack>\` taken from \`factory.json\` → \`stack\`.

## Commands

The commands live in \`factory.json\`.

## Project skills (load them, don't improvise)

| Skill          | Load it when…                 |
| -------------- | ----------------------------- |
| \`write-prd\`    | planning a feature            |
| \`write-ticket\` | creating or refining issues   |
| \`bootstrap\`    | initializing a new project    |
| \`pagos\`        | touching anything in payments |
| <!-- add project skills here, e.g.: --> |      |
`;

const OLD_SETTINGS = {
  permissions: {
    allow: ["Bash(git push --force-with-lease:*)", "Bash(make:*)"],
  },
  hooks: {
    PostToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [
          { type: "command", command: "bash .claude/hooks/post-edit-lint.sh" },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: "bash .claude/hooks/stop-gate.sh",
            timeout: 600,
          },
          { type: "command", command: "bash tools/aviso.sh" },
        ],
      },
    ],
  },
};

const OLD_PACKAGE = {
  name: "tienda",
  scripts: {
    test: "vitest run",
    "test:kit": "vitest run --config vitest.kit.config.mts",
    "ui:screenshots": "node --experimental-strip-types scripts/capture-ui.ts",
    dev: "next dev -p 3412",
  },
};

/**
 * Un proyecto creado con fabrica-template antes del plugin, ya commiteado.
 * `overrides` cambia o agrega archivos antes del commit.
 */
function templateProject(overrides: Record<string, string> = {}): string {
  const dir = gitRepo();
  const files: Record<string, string> = {
    "CLAUDE.md": OLD_CLAUDE_MD,
    ".claude/settings.json": JSON.stringify(OLD_SETTINGS, null, 2),
    ".claude/hooks/stop-gate.sh": "# gate viejo\n",
    ".claude/hooks/post-edit-lint.sh": "# formato viejo\n",
    ".claude/agents/code-reviewer.md": "# revisor viejo\n",
    ".claude/skills/write-ticket/SKILL.md": "# skill vieja\n",
    ".claude/skills/pagos/SKILL.md": "# skill del proyecto\n",
    ".github/workflows/checks.yml": "name: checks\n# copia vieja\n",
    ".github/workflows/deploy.yml": "name: deploy\n",
    "scripts/process-backlog.sh": "# viejo\n",
    "scripts/lib/factory-config.sh": "# viejo\n",
    "scripts/seed-db.sh": "# del proyecto\n",
    "rules/stacks/node-ts.md": read(PLUGIN_ROOT, "rules/stacks/node-ts.md"),
    "tests/unit/scripts/factory-cmd.test.ts": "// kit\n",
    "tests/unit/carrito.test.ts": "// del proyecto\n",
    "tests/ui.spec.ts": "// ui del proyecto\n",
    "vitest.kit.config.mts": "// kit\n",
    "user-level/settings.json": "{}\n",
    "factory.json":
      '{"stack": "node-ts", "commands": {"test": ["npm", "test"]}}\n',
    "package.json": `${JSON.stringify(OLD_PACKAGE, null, 2)}\n`,
    ...overrides,
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  commitAll(dir, "plantilla");
  return dir;
}

function commitAll(dir: string, message: string) {
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
    });
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/** Sin cambios en los archivos commiteados (los nuevos sin commitear no cuentan). */
function trackedUnchanged(dir: string): boolean {
  return (
    spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: dir }).status ===
    0
  );
}

const exists = (dir: string, file: string) => existsSync(path.join(dir, file));

describe("fabrica-setup init en un proyecto de la plantilla", () => {
  it(
    "borra la maquinaria copiada y deja lo que es del proyecto",
    () => {
      const dir = templateProject();

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      for (const gone of [
        ".claude/hooks/stop-gate.sh",
        ".claude/hooks/post-edit-lint.sh",
        ".claude/agents/code-reviewer.md",
        ".claude/skills/write-ticket/SKILL.md",
        "scripts/process-backlog.sh",
        "scripts/lib/factory-config.sh",
        "tests/unit/scripts/factory-cmd.test.ts",
        "vitest.kit.config.mts",
        "user-level/settings.json",
        "rules/stacks/node-ts.md",
      ]) {
        expect(exists(dir, gone), gone).toBe(false);
      }
      for (const kept of [
        ".claude/skills/pagos/SKILL.md",
        ".github/workflows/deploy.yml",
        "scripts/seed-db.sh",
        "tests/unit/carrito.test.ts",
        "tests/ui.spec.ts",
      ]) {
        expect(exists(dir, kept), kept).toBe(true);
      }
      expect(out).toContain("scripts/process-backlog.sh");
    },
    TIMEOUT,
  );

  it(
    "conserva factory.json y cambia las copias viejas de los workflows por las llamadas al plugin",
    () => {
      const dir = templateProject();

      setup(dir, ["init"]);

      expect(read(dir, "factory.json")).toBe(
        '{"stack": "node-ts", "commands": {"test": ["npm", "test"]}}\n',
      );
      expect(read(dir, ".github/workflows/checks.yml")).toContain(
        `${PLUGIN_REPO}/.github/workflows/checks.yml@v${PLUGIN_VERSION}`,
      );
      expect(read(dir, ".github/workflows/visual-baselines.yml")).toContain(
        `@v${PLUGIN_VERSION}`,
      );
      expect(exists(dir, ".github/workflows/checks.yml.fabrica-new")).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  it(
    "deja en CLAUDE.md lo propio del proyecto e importa las reglas del plugin",
    () => {
      const dir = templateProject();

      setup(dir, ["init"]);

      const claude = read(dir, "CLAUDE.md");
      expect(claude).toMatch(/^# CLAUDE\.md: Tienda$/m);
      expect(claude).toContain("Una tienda en línea para vender cerámica.");
      expect(claude).toContain("`.factory/rules/stacks/<stack>.md`");
      expect(claude).toContain("| `pagos`");
      expect(claude).not.toContain("`write-ticket`");
      expect(claude).not.toContain("## Commands");
      expect(claude).not.toContain("{{");
      expect(claude).toContain("@.factory/rules/fabrica.md");
    },
    TIMEOUT,
  );

  it(
    "quita de settings.json los hooks viejos y suma los permisos, sin tocar lo demás",
    () => {
      const dir = templateProject();

      setup(dir, ["init"]);

      const settings = JSON.parse(read(dir, ".claude/settings.json")) as {
        permissions: { allow: string[]; deny: string[] };
        hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(settings.permissions.allow).toContain("Bash(make:*)");
      expect(settings.permissions.allow).toContain("Bash(fabrica-cmd:*)");
      expect(settings.permissions.deny).toContain("Read(**/.env)");
      expect(settings.hooks?.PostToolUse).toBeUndefined();
      expect(
        settings.hooks?.Stop?.flatMap((g) => g.hooks.map((h) => h.command)),
      ).toEqual(["bash tools/aviso.sh"]);
    },
    TIMEOUT,
  );

  it(
    "quita de package.json los scripts del kit y deja los del proyecto",
    () => {
      const dir = templateProject();

      setup(dir, ["init"]);

      const pkg = JSON.parse(read(dir, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts["test:kit"]).toBeUndefined();
      expect(pkg.scripts["ui:screenshots"]).toBeUndefined();
      expect(pkg.scripts.test).toBe("vitest run");
      expect(pkg.scripts.dev).toBe("next dev -p 3412");
    },
    TIMEOUT,
  );

  it(
    "mueve un perfil de stack editado a .factory/rules sin perder lo editado",
    () => {
      const dir = templateProject({
        "rules/stacks/node-ts.md": "# perfil propio\n",
      });

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      expect(read(dir, PROFILE)).toBe("# perfil propio\n");
      expect(read(dir, `${PROFILE}.fabrica-new`)).toBe(
        read(PLUGIN_ROOT, "rules/stacks/node-ts.md"),
      );
    },
    TIMEOUT,
  );

  it(
    "si la migración falla no borra nada, y se puede volver a correr",
    () => {
      const dir = templateProject({ ".claude/settings.json": "{ no es json" });

      const failed = setup(dir, ["init"]);

      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain(".claude/settings.json");
      expect(exists(dir, ".claude/hooks/stop-gate.sh")).toBe(true);
      expect(exists(dir, "scripts/process-backlog.sh")).toBe(true);
      expect(exists(dir, "rules/stacks/node-ts.md")).toBe(true);
      expect(exists(dir, ".factory/version")).toBe(false);
      expect(trackedUnchanged(dir)).toBe(true);

      writeFileSync(
        path.join(dir, ".claude/settings.json"),
        JSON.stringify(OLD_SETTINGS, null, 2),
      );
      commitAll(dir, "arregla settings");
      const retried = setup(dir, ["init"]);

      expect(retried.code, retried.out).toBe(0);
      expect(exists(dir, ".claude/hooks/stop-gate.sh")).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "en un repo sin commits pide el primer commit, no que guarde cambios",
    () => {
      const dir = gitRepo();
      mkdirSync(path.join(dir, ".claude/hooks"), { recursive: true });
      writeFileSync(
        path.join(dir, ".claude/hooks/stop-gate.sh"),
        "# gate viejo\n",
      );

      const { code, out } = setup(dir, ["init"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/no tiene commits/);
      expect(exists(dir, ".claude/hooks/stop-gate.sh")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "migra un settings.json guardado con BOM",
    () => {
      const dir = templateProject({
        ".claude/settings.json": `﻿${JSON.stringify(OLD_SETTINGS, null, 2)}`,
      });

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      const settings = JSON.parse(read(dir, ".claude/settings.json")) as {
        hooks?: Record<string, unknown>;
      };
      expect(settings.hooks?.PostToolUse).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "no migra con cambios sin commitear, y no toca nada",
    () => {
      const dir = templateProject();
      writeFileSync(
        path.join(dir, "scripts/process-backlog.sh"),
        "# a medias\n",
      );

      const { code, out } = setup(dir, ["init"]);

      expect(code).not.toBe(0);
      expect(out).toMatch(/commit/);
      expect(read(dir, "scripts/process-backlog.sh")).toBe("# a medias\n");
      expect(exists(dir, ".claude/hooks/stop-gate.sh")).toBe(true);
      expect(exists(dir, ".factory")).toBe(false);
    },
    TIMEOUT,
  );
});

// Los commits no mencionan a Claude ni a Anthropic, tampoco los de los
// workers. Claude Code agrega Co-Authored-By y, en la web, Claude-Session si
// el settings.json del proyecto no los apaga.
describe("fabrica-setup y la atribución de los commits", () => {
  const SIN_ATRIBUCION = { commit: "", sessionUrl: false };
  const attributionOf = (dir: string): unknown =>
    (
      JSON.parse(read(dir, ".claude/settings.json")) as {
        attribution?: unknown;
      }
    ).attribution;

  it(
    "init en un repo vacío la deja apagada",
    () => {
      const dir = gitRepo();

      setup(dir, ["init"]);

      expect(attributionOf(dir)).toEqual(SIN_ATRIBUCION);
    },
    TIMEOUT,
  );

  it(
    "init la apaga en un settings.json que ya existía",
    () => {
      const dir = gitRepo();
      writeSettings(dir, { enabledPlugins: { "fabrica@fabrica-local": true } });

      setup(dir, ["init"]);

      expect(attributionOf(dir)).toEqual(SIN_ATRIBUCION);
    },
    TIMEOUT,
  );

  it(
    "init la apaga al migrar un proyecto de fabrica-template",
    () => {
      const dir = templateProject();

      const { code, out } = setup(dir, ["init"]);

      expect(code, out).toBe(0);
      expect(attributionOf(dir)).toEqual(SIN_ATRIBUCION);
    },
    TIMEOUT,
  );

  it(
    "refresh la apaga en un proyecto que ya existía, avisa y no le devuelve los permisos que quitó",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      const before = {
        enabledPlugins: { "fabrica@fabrica-local": true },
        permissions: { allow: ["Bash(make:*)"], deny: [] },
      };
      writeSettings(dir, before);

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(JSON.parse(read(dir, ".claude/settings.json"))).toEqual({
        ...before,
        attribution: SIN_ATRIBUCION,
      });
      expect(out).toMatch(/\.claude\/settings\.json.*Claude/);
    },
    TIMEOUT,
  );

  // fabrica-epic llegó en la 0.5.24 (truckconnect-mobile, 2026-11-26): un
  // proyecto de antes tiene que recibir su permiso, uno que ya lo tuvo y lo
  // quitó no.
  it(
    "refresh suma los permisos que la fábrica agregó después de la versión del proyecto",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeFileSync(path.join(dir, ".factory/version"), "0.5.23\n");
      writeSettings(dir, {
        attribution: SIN_ATRIBUCION,
        permissions: { allow: ["Bash(make:*)"] },
      });

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(
        (
          JSON.parse(read(dir, ".claude/settings.json")) as {
            permissions: { allow: string[] };
          }
        ).permissions.allow,
      ).toEqual(["Bash(make:*)", "Bash(fabrica-epic:*)"]);
    },
    TIMEOUT,
  );

  it(
    "refresh le quita a un proyecto el permiso viejo de --force-with-lease, sin tocar los suyos",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeSettings(dir, {
        attribution: SIN_ATRIBUCION,
        permissions: {
          allow: ["Bash(git push --force-with-lease:*)", "Bash(make:*)"],
        },
      });

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(
        (
          JSON.parse(read(dir, ".claude/settings.json")) as {
            permissions: { allow: string[] };
          }
        ).permissions.allow,
      ).toEqual(["Bash(make:*)"]);
      // La atribución ya estaba apagada: el aviso no puede decir que cambió.
      expect(out).not.toMatch(/ya no mencionan/);
      expect(out).toMatch(/\.claude\/settings\.json/);
    },
    TIMEOUT,
  );

  it.each([
    ["un texto propio", { commit: "Equipo X", sessionUrl: true }],
    ["todo apagado", false],
    ["todo prendido", true],
  ])(
    "refresh respeta lo que el proyecto eligió (%s)",
    (_caso, attribution) => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeSettings(dir, { attribution });

      const { code, out } = setup(dir, ["refresh"]);

      expect(code, out).toBe(0);
      expect(attributionOf(dir)).toEqual(attribution);
    },
    TIMEOUT,
  );

  it(
    "refresh completa solo lo que falta",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeSettings(dir, { attribution: { pr: "" } });

      setup(dir, ["refresh"]);

      expect(attributionOf(dir)).toEqual({ pr: "", ...SIN_ATRIBUCION });
    },
    TIMEOUT,
  );

  it(
    "refresh para antes de actualizar nada si settings.json no es JSON",
    () => {
      const dir = gitRepo();
      setup(dir, ["init"]);
      writeFileSync(path.join(dir, ".claude/settings.json"), "{ no es json\n");

      const { code, out } = setup(dir, ["refresh"], newerPlugin("9.9.9", ""));

      expect(code).not.toBe(0);
      expect(out).toContain(".claude/settings.json");
      expect(read(dir, ".factory/version").trim()).toBe(PLUGIN_VERSION);
    },
    TIMEOUT,
  );
});
