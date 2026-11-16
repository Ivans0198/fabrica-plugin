import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * El ciclo de revisión lo ejecuta un modelo, así que ningún test del kit puede
 * probar que el worker arregle un Major. Lo que sí se puede fijar es que todos
 * los documentos que lo gobiernan digan lo mismo: qué severidades hay, qué
 * bloquea el APPROVED, qué recibe el revisor y qué pasa tras la tercera
 * ronda. Si uno de ellos se queda con la regla vieja, el worker recibe dos
 * órdenes distintas y elige una.
 */

function read(relativePath: string): string {
  return readFileSync(pluginFile(relativePath), "utf8");
}

/** Normaliza espacios para que el envoltorio a 80 columnas no esconda frases. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

const CODE_REVIEWER = ".claude/agents/code-reviewer.md";
const UI_REVIEWER = ".claude/agents/ui-reviewer.md";
const REVIEWERS = [CODE_REVIEWER, UI_REVIEWER];

const DOCS_WITH_SEVERITIES = [
  ...REVIEWERS,
  "rules/fabrica.md",
  "rules/stacks/node-ts.md",
  "GUIA-DE-LA-FABRICA.md",
];

const OLD_SEVERITY =
  /`(Critical|High|Medium|Low)`\+?|\[(Critical|High|Medium|Low)\]|\((Critical|High|Medium|Low)\/|(Critical|High|Medium|Low)\/(Critical|High|Medium|Low)/;

const APPROVAL_RULE = "no Blocker and no Major";

function reviewStep(): string {
  const claude = read("rules/fabrica.md");
  const start = claude.indexOf("5. **Review**");
  const end = claude.indexOf("6. **Check the boxes**");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return flat(claude.slice(start, end));
}

function filesUnder(dir: string, extension: string): string[] {
  const absolute = pluginFile(dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(dir, String(entry)).split(path.sep).join("/"))
    .filter((file) => file.endsWith(extension));
}

describe("contrato del revisor", () => {
  it.each(DOCS_WITH_SEVERITIES)(
    "%s no usa la escala vieja Critical/High/Medium/Low",
    (file) => {
      expect(flat(read(file))).not.toMatch(OLD_SEVERITY);
    },
  );

  it.each(REVIEWERS)("%s declara Blocker, Major y Minor", (file) => {
    const text = read(file);
    for (const severity of ["`Blocker`", "`Major`", "`Minor`"]) {
      expect(text).toContain(severity);
    }
  });

  it.each([...REVIEWERS, "rules/fabrica.md"])(
    "%s dice que APPROVED es no Blocker and no Major",
    (file) => {
      expect(flat(read(file))).toContain(APPROVAL_RULE);
    },
  );

  it.each(REVIEWERS)(
    "%s deja lo que sigue abierto en la tercera ronda bajo PENDING FOR HUMAN:",
    (file) => {
      expect(read(file)).toContain("PENDING FOR HUMAN:");
    },
  );

  it("el code-reviewer pide un fallo concreto o una regla citada por hallazgo", () => {
    const text = flat(read(CODE_REVIEWER));

    expect(text).toContain("| Failure or rule |");
    expect(text).toMatch(/concrete failure/);
    expect(text).toMatch(/mandatory rule/);
  });

  // Un merge con una dependencia en versión de prueba termina
  // publicado sobre un build de prueba.
  it("el code-reviewer marca como Major una dependencia que pasa a una versión de prueba", () => {
    const text = flat(read(CODE_REVIEWER));

    expect(text).toMatch(/pre-release version/);
    expect(text).toMatch(/`-alpha`, `-beta`, `-rc`/);
    const major = text.slice(
      text.indexOf("- `Major`:"),
      text.indexOf("- `Minor`:"),
    );
    expect(major).toMatch(/pre-release/);
  });

  it("el code-reviewer ignora la opinión del autor", () => {
    expect(flat(read(CODE_REVIEWER))).toMatch(
      /opinion about the code.*ignore it/,
    );
  });

  it("el code-reviewer separa los defectos fuera del ticket y no bloquea por ellos", () => {
    const text = flat(read(CODE_REVIEWER));

    expect(text).toContain("OUTSIDE THIS TICKET:");
    expect(text).toMatch(
      /OUTSIDE THIS TICKET: findings never block `APPROVED`/,
    );
  });

  it("el perfil del stack marca qué reglas son obligatorias y que romperlas es Major", () => {
    const profile = flat(read("rules/stacks/node-ts.md"));

    expect(profile).toContain("(mandatory)");
    expect(profile).toMatch(/mandatory.*`Major`/);
  });

  it("CLAUDE.md, paso 5: qué recibe el revisor, dónde queda su respuesta y con qué modelo", () => {
    const step = reviewStep();

    expect(step).toContain("models.codeReviewer");
    expect(step).toContain("models.uiReviewer");
    expect(step).toContain(".factory/review/");
    expect(step).toMatch(/never your opinion/i);
    expect(step).toContain(APPROVAL_RULE);
  });

  it("CLAUDE.md, paso 5: PENDING FOR HUMAN lleva a needs-human, y los defectos fuera del ticket van al PR", () => {
    const step = reviewStep();

    expect(step).toMatch(/PENDING FOR HUMAN.*needs-human/);
    expect(step).toMatch(/OUTSIDE THIS TICKET.*PR description/);
  });

  it("CLAUDE.md, paso 5: un Blocker o Major que necesita una decisión humana corta las rondas y va al paso 8", () => {
    const step = reviewStep();

    expect(step).toMatch(
      /Blocker.*Major.*needs a human decision.*do not run more rounds: follow step 8 now/,
    );
  });
});

describe("configuración de modelos", () => {
  const GOVERNED = [
    "CLAUDE.md",
    "rules/fabrica.md",
    "README.md",
    "GUIA-DE-LA-FABRICA.md",
    "scripts/process-backlog.sh",
    "factory.example.json",
    ...filesUnder(".claude/agents", ".md"),
    ...filesUnder(".claude/skills", ".md"),
    ...filesUnder(".github/workflows", ".yml"),
  ];

  it.each(GOVERNED)(
    "%s no remite a factory-models.json ni a apply-models.sh",
    (file) => {
      const text = read(file);
      expect(text).not.toContain("factory-models.json");
      expect(text).not.toContain("apply-models.sh");
    },
  );

  it("factory-models.json y apply-models.sh ya no existen", () => {
    expect(existsSync(pluginFile("factory-models.json"))).toBe(false);
    expect(existsSync(pluginFile("scripts/apply-models.sh"))).toBe(false);
  });

  it("factory.example.json trae los modelos y la política de revisión visual", () => {
    const example = JSON.parse(read("factory.example.json")) as {
      models?: Record<string, unknown>;
      review?: Record<string, unknown>;
    };

    expect(Object.keys(example.models ?? {}).sort()).toEqual([
      "codeReviewer",
      "planning",
      "uiReviewer",
      "worker",
    ]);
    expect(example.review?.uiReview).toBe("label");
  });
});

describe("prompts del worker", () => {
  // El ciclo vive en las reglas. El prompt solo despacha: con el mismo
  // comienzo que citan las reglas en "Autonomy boundary", para que el modelo
  // lo reconozca como despacho, y remitiendo a los comandos de la cola.
  const prompt = (...args: string[]) =>
    execFileSync("bash", [pluginFile("scripts/worker-prompt.sh"), ...args], {
      encoding: "utf8",
    });

  it("despacha una issue con fabrica-claim y fabrica-release, y remite a factory.json", () => {
    const text = flat(prompt("one", "7"));

    expect(text).toMatch(
      /^Process GitHub issue #7 following the issue lifecycle in CLAUDE\.md/,
    );
    expect(text).toContain("fabrica-claim 7");
    expect(text).toContain("fabrica-release 7 --needs-human");
    expect(text).toContain("Closes #7");
    expect(text).toContain("factory.json");
  });

  it("despacha un lote con fabrica-next-issue y respeta el máximo", () => {
    const text = flat(prompt("batch", "3"));

    expect(text).toMatch(
      /^Process up to 3 eligible pending issues per CLAUDE\.md/,
    );
    expect(text).toContain("fabrica-next-issue");
    expect(text).toContain("fabrica-claim");
    expect(text).toContain("needs-human");
    expect(text).toContain("factory.json");
  });

  it("rechaza lo que no es un número", () => {
    expect(() => prompt("one", "7; rm -rf /")).toThrow();
    expect(() => prompt("batch", "x")).toThrow();
  });

  it("process-backlog.sh y claude-backlog.yml toman el prompt del generador", () => {
    const script = read("scripts/process-backlog.sh");
    const workflow = read(".github/workflows/claude-backlog.yml");

    expect(script).toMatch(/worker-prompt\.sh" one "\$n"/);
    expect(workflow).toContain("fabrica-worker-prompt one");
    expect(workflow).toContain("fabrica-worker-prompt batch");
    expect(workflow).toContain("prompt: ${{ steps.prompt.outputs.text }}");
  });

  it("el texto del despacho está en un solo lugar", () => {
    for (const file of [
      "scripts/process-backlog.sh",
      ".github/workflows/claude-backlog.yml",
    ]) {
      expect(read(file), file).not.toContain("Process GitHub issue #");
      expect(read(file), file).not.toContain(
        "eligible pending issues per CLAUDE.md",
      );
    }
  });

  it("las reglas tienen lo que antes solo decían los prompts", () => {
    const rules = flat(read("rules/fabrica.md"));

    expect(rules).toMatch(/Commit as you go/);
    expect(rules).toMatch(/assigned to someone else/);
  });
});
