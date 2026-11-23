import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * Lo que lee el modelo (reglas, agentes, skills) no puede apuntar a rutas del
 * proyecto que ya no existen, ni nombrar comandos o agentes que el plugin no
 * trae. Un nombre roto no falla en ningún test de script: falla cuando un
 * worker lo intenta usar a mitad de un ticket.
 */

function markdownUnder(dir: string): string[] {
  const absolute = path.join(PLUGIN_ROOT, dir);
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(dir, String(entry)).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".md"));
}

const MODEL_FACING = [
  "rules/fabrica.md",
  ...markdownUnder("agents"),
  ...markdownUnder("skills").filter((file) => file.endsWith("SKILL.md")),
];

// bootstrap nombra a propósito los placeholders de los archivos del proyecto
// que tiene que rellenar (CLAUDE.md, design-system.md).
const NAMES_PROJECT_PLACEHOLDERS = ["skills/bootstrap/SKILL.md"];

function read(file: string): string {
  return readFileSync(path.join(PLUGIN_ROOT, file), "utf8");
}

const BIN = readdirSync(path.join(PLUGIN_ROOT, "bin"));
const AGENTS = readdirSync(path.join(PLUGIN_ROOT, "agents")).map((f) =>
  f.replace(/\.md$/, ""),
);
const SKILLS = readdirSync(path.join(PLUGIN_ROOT, "skills"));

describe("lo que lee el modelo", () => {
  it.each(MODEL_FACING)("%s no apunta a scripts/ del proyecto", (file) => {
    expect(read(file)).not.toMatch(/(^|[\s`(])scripts\//m);
  });

  it.each(
    MODEL_FACING.filter((file) => !NAMES_PROJECT_PLACEHOLDERS.includes(file)),
  )("%s no deja placeholders {{...}}", (file) => {
    expect(read(file)).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it.each(MODEL_FACING)(
    "%s solo nombra comandos que existen en bin/",
    (file) => {
      const named = [...read(file).matchAll(/\bfabrica-([a-z-]+)/g)]
        .map((m) => `fabrica-${m[1]}`)
        .filter(
          (name) =>
            ![
              "fabrica-new",
              "fabrica-local",
              "fabrica-template",
              "fabrica-plugin",
              // Marcas en el cuerpo de las issues y el sello de .specify/.
              "fabrica-key",
              "fabrica-spec",
              "fabrica-version",
            ].includes(name),
        );
      for (const command of named) {
        expect(BIN, `${file} nombra ${command}`).toContain(command);
      }
    },
  );

  it.each(MODEL_FACING)(
    "%s solo nombra agentes y skills que existen",
    (file) => {
      const named = [...read(file).matchAll(/fabrica:([a-z-]+)/g)].map(
        (m) => m[1],
      );
      for (const name of named) {
        expect(
          [...AGENTS, ...SKILLS],
          `${file} nombra fabrica:${name}`,
        ).toContain(name);
      }
    },
  );
});

describe("planeación con Spec Kit", () => {
  const PLANNING = ["spec", "plan", "tasks", "issues"];

  it.each(PLANNING)(
    "fabrica:%s solo lo arranca una persona con su comando",
    (skill) => {
      const body = read(`skills/${skill}/SKILL.md`);

      expect(body).toMatch(new RegExp(`^name: ${skill}$`, "m"));
      expect(body).toMatch(/^disable-model-invocation: true$/m);
      expect(body).toMatch(/headless/);
    },
  );

  it("write-prd se retiró y nadie lo nombra", () => {
    expect(existsSync(path.join(PLUGIN_ROOT, "skills/write-prd"))).toBe(false);
    for (const file of [
      ...MODEL_FACING,
      "docs/GUIA-DE-LA-FABRICA.md",
      "templates/CLAUDE.md",
    ]) {
      expect(read(file), file).not.toMatch(/write-prd|\bPRDs?\b/);
    }
    expect(readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")).not.toMatch(
      /write-prd/,
    );
  });

  it.each([
    ["spec", ["speckit-specify", "speckit-clarify"]],
    ["plan", ["speckit-plan"]],
    ["tasks", ["speckit-tasks"]],
  ])(
    "fabrica:%s sigue los comandos de Spec Kit desde .specify/commands/",
    (skill, commands) => {
      const body = read(`skills/${skill}/SKILL.md`);

      for (const command of commands) {
        expect(body).toContain(`.specify/commands/${command}.md`);
      }
    },
  );

  it("las reglas mandan a la persona al comando si pide planear con palabras", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).toMatch(/in their own words[^.]*`\/fabrica:spec`/);
    expect(rules).toMatch(/never follow `\.specify\/commands\/`/i);
  });

  it("fabrica:spec retoma con la rama spec-<N> aunque todavía no haya carpeta", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(/rama `spec-<N>`[^.]*basta/);
  });

  it("las ramas de spec no siguen a la rama base, y el plan las nombra igual que la spec", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(
      /git switch --no-track -c spec-<N> origin\/<base>/,
    );
    expect(read("skills/plan/SKILL.md")).toMatch(
      /`\*\*Branch\*\*`[^.]*`spec-<N>`/,
    );
  });

  // Test primero en todas las fases, y ningún criterio ni requisito
  // de la spec sin tarea.
  it("fabrica:tasks pide test primero también en Setup y Foundational", () => {
    const body = read("skills/tasks/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(
      /también en Setup y Foundational[^.]*después de la tarea que escribe su test/,
    );
  });

  it("fabrica:tasks revisa que cada criterio de aceptación y cada requisito tenga una tarea", () => {
    const body = read("skills/tasks/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(
      /cada criterio de aceptación y cada requisito funcional[^.]*al menos una tarea/,
    );
  });

  it("la constitución pide test primero también en Setup y Foundational", () => {
    expect(read("rules/constitution.md").replace(/\s+/g, " ")).toMatch(
      /Setup and Foundational[^.]*after the task that writes its failing test/,
    );
  });

  it("fabrica:spec crea el plan maestro si no existe, como piden las reglas", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(
      /plan-maestro\.md`?\s+no\s+existe,\s+cr[ée]alo/i,
    );
  });

  it("las reglas solo prohíben auto-merge al worker; en planeación lo pone quien la persona nombró", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).toMatch(/named in their OK/);
  });

  // Los scripts usan factory.json → baseBranch; con base develop, las reglas
  // rebaseaban sobre main y le daban al revisor otro merge-base.
  it("las reglas no fijan main como base: usan la de factory.json", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).not.toContain("origin/main");
    expect(rules).toMatch(/`<base>` is `factory\.json` → `baseBranch`/);
  });

  it("el PR de la spec nunca cierra la épica", () => {
    const spec = read("skills/spec/SKILL.md");

    expect(spec).toMatch(/Refs #<N>/);
    expect(spec).toMatch(/\*\*nunca\*\* `Closes #<N>`/);
  });

  // Los skills de planeación tienen disable-model-invocation: el modelo no
  // puede invocar el siguiente, así que lo encadena leyendo su SKILL.md.
  it("fabrica:spec sigue con el plan si no quedan dudas en la spec", () => {
    const body = read("skills/spec/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(/\[NEEDS CLARIFICATION/);
    expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/plan/SKILL.md");
  });

  it("fabrica:plan sigue con las tareas si pasa el Constitution Check", () => {
    const body = read("skills/plan/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(/Constitution Check[^.]*sin violaciones/);
    expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/tasks/SKILL.md");
  });

  it("el ciclo reclama con fabrica-claim y sigue en impl-N si ya está ahí", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toContain("fabrica-next-issue");
    expect(rules).toContain("fabrica-claim N");
    expect(rules).toMatch(/already on `impl-N`[^.]*keep working there/);
  });

  // Fase 5: una issue que viene de una spec se trabaja con su parte de la
  // spec, sin tocarla.
  it("los commits no mencionan a Claude ni a Anthropic", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toMatch(/Commit messages never mention Claude or Anthropic/);
    expect(rules).toContain("`Co-Authored-By`");
    expect(rules).toContain("`Claude-Session`");
  });

  it("el ciclo lee la spec de la issue con fabrica-spec-context y no la edita", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toContain("fabrica-spec-context N");
    expect(rules).toMatch(/exit 1[^.]*standalone/);
    expect(rules).toMatch(/exit 2[^.]*needs-human/);
    expect(rules).toMatch(/[Nn]ever edit[^.]*specs\//);
    expect(rules).toMatch(/speckit-implement/);
  });

  it("el revisor revisa contra los escenarios de la historia", () => {
    const body = read("agents/code-reviewer.md").replace(/\s+/g, " ");

    expect(body).toContain("fabrica-spec-context <N>");
    expect(body).toMatch(/[Aa]cceptance [Ss]cenario/);
  });

  it("fabrica:backlog trabaja en la sesión dentro del worktree, o lanza los workers si se pide", () => {
    const body = read("skills/backlog/SKILL.md").replace(/\s+/g, " ");

    for (const command of [
      "fabrica-next-issue",
      "fabrica-claim",
      "EnterWorktree",
      "fabrica-check-done",
      "fabrica-release",
      "fabrica-backlog",
    ]) {
      expect(body, command).toContain(command);
    }
  });

  // Sin la GitHub App de Claude en el repo, la nube falla con un 401 antes de
  // empezar (fabrica-prueba, 2026-11-16). gh no puede comprobarlo: solo una
  // App lista sus instalaciones. Por eso se pide y se nombra al fallar.
  it("el cierre del bootstrap pide instalar la GitHub App de Claude", () => {
    const keys = read("skills/bootstrap/SKILL.md").split(
      "### 4.1 Las llaves de la nube",
    )[1]!;
    const section = keys.split("### 4.1.5")[0]!.replace(/\s+/g, " ");

    expect(section).toContain("github.com/apps/claude");
    expect(section).toMatch(/401/);
  });

  // vitest en la raíz de fabrica-prueba corrió también los tests de cada
  // worktree (196 en vez de 62, 2 en rojo de otra rama, 2026-11-22): el Stop
  // gate de la raíz bloqueaba por código que no era de esa sesión.
  it("el bootstrap excluye los worktrees también del corredor de tests", () => {
    const verify = read("skills/bootstrap/SKILL.md")
      .split("## Fase 3: Verificación real y commit")[1]!
      .split("## Fase 4")[0]!
      .replace(/\s+/g, " ");
    const rule = verify
      .split("**")
      .find((part) => part.includes(".claude/worktrees/"));

    expect(rule).toMatch(/corredor de tests/);
  });

  it("el bootstrap ofrece el dev container en la propuesta y lo escribe con fabrica-devcontainer", () => {
    const body = read("skills/bootstrap/SKILL.md");
    const proposal = body
      .split("### 0.4 La propuesta de cáscara")[1]!
      .split("## Fase 1")[0]!;

    expect(proposal).toMatch(/\*\*Dev container\*\*/);
    expect(body).toContain("fabrica-devcontainer --feature");
  });

  it("el aviso de falla de la nube nombra la GitHub App", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/claude-backlog.yml"),
      "utf8",
    );
    const note = workflow
      .split("\n")
      .find((line) => line.includes("La corrida en la nube falló"));

    expect(note).toContain("github.com/apps/claude");
  });

  it("fabrica:tasks no encadena las issues: espera el merge", () => {
    const body = read("skills/tasks/SKILL.md");

    expect(body).not.toContain("skills/issues/SKILL.md");
    expect(body).toMatch(/mergees/);
  });
});

describe("piezas del plugin", () => {
  it("el marketplace apunta al plugin y el plugin declara versión", () => {
    const marketplace = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string; source: string }> };
    const entry = marketplace.plugins.find((p) => p.name === "fabrica");

    expect(entry).toBeDefined();
    expect(path.resolve(REPO_ROOT, entry!.source)).toBe(PLUGIN_ROOT);

    const manifest = JSON.parse(
      readFileSync(
        path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as { name: string; version: string };
    expect(manifest.name).toBe("fabrica");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Los comandos de bin/ quedan en el PATH del modelo y se ejecutan directo:
  // sin el bit de ejecución en git, fallan con "Permission denied" en la
  // nube y en cualquier copia nueva del plugin.
  it("todos los comandos de bin/ son ejecutables en git", () => {
    const listing = execFileSync(
      "git",
      ["ls-files", "-s", "--", "plugins/fabrica/bin"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const notExecutable = listing
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("100755"))
      .map((line) => line.split("\t")[1]);

    expect(notExecutable).toEqual([]);
  });

  it("hooks.json solo llama scripts que existen", () => {
    const hooks = readFileSync(
      path.join(PLUGIN_ROOT, "hooks/hooks.json"),
      "utf8",
    );
    const scripts = [
      ...hooks.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)/g),
    ].map((m) => m[1]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(path.join(PLUGIN_ROOT, script)), script).toBe(true);
    }
  });

  it("ningún texto para personas manda a correr un script por su ruta en el proyecto", () => {
    // Los comentarios de los issues, el devcontainer y los mensajes de uso
    // los lee una persona en un proyecto que ya no tiene scripts/.
    const files = [
      "scripts/process-backlog.sh",
      "templates/.devcontainer/devcontainer.json",
      ...readdirSync(path.join(PLUGIN_ROOT, "scripts"))
        .filter((f) => f.endsWith(".sh"))
        .map((f) => `scripts/${f}`),
    ];
    const BIN_TARGETS = BIN.map((command) => {
      const body = readFileSync(path.join(PLUGIN_ROOT, "bin", command), "utf8");
      return body.match(/\/\.\.\/scripts\/([^"]+)"/)![1];
    });
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/bash scripts\/process-backlog\.sh/);
      for (const target of BIN_TARGETS) {
        expect(text, `${file} nombra scripts/${target}`).not.toMatch(
          new RegExp(`(bash |Usage: )scripts/${target.replace(".", "\\.")}`),
        );
      }
    }
  });

  it("todo script que infiere el repo con gh repo view respeta antes GH_REPO", () => {
    const scripts = readdirSync(path.join(PLUGIN_ROOT, "scripts"))
      .filter((f) => f.endsWith(".sh"))
      .map((f) => `scripts/${f}`);
    for (const file of scripts) {
      for (const line of read(file).split("\n")) {
        if (!/gh repo view/.test(line) || /^\s*#/.test(line)) continue;
        expect(line, file).toMatch(/\$\{GH_REPO:-\$\(gh repo view/);
      }
    }
  });

  it("el uso de fabrica-ui-preflight nombra los subcomandos del script", () => {
    const usage = read("bin/fabrica-ui-preflight");
    const script = read("scripts/ui-preflight.sh");

    for (const sub of ["up", "down", "check"]) {
      expect(usage).toMatch(new RegExp(`\\b${sub}\\b`));
      expect(script).toMatch(new RegExp(`^\\s*${sub}\\)`, "m"));
    }
    expect(usage).not.toMatch(/\bstatus\b/);
  });

  it.each(BIN)("bin/%s llama un script que existe", (command) => {
    const body = readFileSync(path.join(PLUGIN_ROOT, "bin", command), "utf8");
    const target = body.match(/\/\.\.\/(scripts\/[^"]+)"/);

    expect(target, `${command} no llama ../scripts/...`).not.toBeNull();
    expect(existsSync(path.join(PLUGIN_ROOT, target![1]))).toBe(true);
  });
});
