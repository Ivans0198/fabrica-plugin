import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/** El reusable workflow vive en el repo del plugin; el proyecto lo llama. */
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/checks.yml");
const CALLER_PATH = path.join(TEMPLATES_ROOT, ".github/workflows/checks.yml");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: { "node-version"?: number };
}

interface WorkflowJob {
  if?: string;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}

interface WorkflowFile {
  on: {
    pull_request?: { types?: string[] };
    push?: { branches?: string[] };
  };
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, WorkflowJob>;
}

function parse(file: string): WorkflowFile {
  return load(readFileSync(file, "utf8")) as WorkflowFile;
}

function parseWorkflow(): WorkflowFile {
  return parse(WORKFLOW_PATH);
}

function allSteps(): WorkflowStep[] {
  return Object.values(parseWorkflow().jobs).flatMap((job) => job.steps);
}

function stepNamed(name: string): WorkflowStep {
  const step = allSteps().find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`el workflow no tiene ningún paso llamado "${name}"`);
  }
  return step;
}

describe("workflow de checks", () => {
  it("parsea como YAML válido", () => {
    expect(() => parseWorkflow()).not.toThrow();
    expect(() => parse(CALLER_PATH)).not.toThrow();
  });

  it("el proyecto lo dispara en pull_request y en push a main", () => {
    const { on } = parse(CALLER_PATH);

    expect(on.pull_request?.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened"]),
    );
    expect(on.push?.branches).toContain("main");
  });

  it("corre los comandos de factory.json con fabrica-cmd, los mismos que el Stop gate", () => {
    // Un `npm test` escrito a mano en el workflow solo sirve en proyectos
    // Node, y además podría divergir de lo que verifica el gate.
    const expected: Record<string, string> = {
      "Dependencias del proyecto": "install",
      Tests: "test",
      Lint: "lint",
      Tipos: "typecheck",
      Build: "build",
    };

    for (const [name, command] of Object.entries(expected)) {
      expect(stepNamed(name).run).toBe(`fabrica-cmd ${command}`);
    }
  });

  it("ningún paso lleva continue-on-error ni termina en || true", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    for (const step of allSteps()) {
      expect(step["continue-on-error"]).not.toBe(true);
    }
    expect(source).not.toMatch(/\|\|\s*true/);
  });

  it("solo usa un secreto opcional, para leer el plugin si su repo es privado", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const secrets = [...source.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);

    expect(new Set(secrets)).toEqual(new Set(["FABRICA_PLUGIN_TOKEN"]));
    expect(source).toMatch(/secrets\.FABRICA_PLUGIN_TOKEN \|\| github\.token/);
  });

  it("el proyecto declara concurrency con cancel-in-progress para no acumular corridas viejas", () => {
    const { concurrency } = parse(CALLER_PATH);

    expect(concurrency?.["cancel-in-progress"]).toBe(true);
    // El group debe depender de la rama/PR: uno constante cancelaría corridas
    // de ramas distintas entre sí en vez de sólo las de la misma rama.
    expect(concurrency?.group).toMatch(/pull_request\.number|github\.ref/);
  });

  it("declara permissions y sólo pide contents: read", () => {
    expect(parseWorkflow().permissions).toEqual({ contents: "read" });
    expect(parse(CALLER_PATH).permissions).toEqual({ contents: "read" });
  });

  it("usa setup-node con la misma versión que visual-baselines.yml", () => {
    const step = allSteps().find((s) =>
      s.uses?.startsWith("actions/setup-node"),
    );

    expect(step?.with?.["node-version"]).toBe(20);
  });

  it("instala chromium después de las dependencias y antes de los tests", () => {
    const steps = allSteps();
    const depsIndex = steps.findIndex((s) => s.run === "fabrica-cmd install");
    const installIndex = steps.findIndex((step) =>
      step.run?.includes("playwright install"),
    );
    const testIndex = steps.findIndex((s) => s.run === "fabrica-cmd test");

    expect(installIndex).toBeGreaterThan(depsIndex);
    expect(testIndex).toBeGreaterThan(installIndex);
  });

  /**
   * Un repo que todavía no pasó por el bootstrap no tiene factory.json. Sin
   * guardia, cada PR saldría rojo por comandos que todavía no existen, que no
   * es trabajo mal hecho sino un repositorio que aún no es un proyecto. La
   * condición es la misma que desarma el Stop gate.
   */
  it("salta los comandos de la app mientras el repositorio no haya pasado por el bootstrap", () => {
    for (const name of [
      "Dependencias del proyecto",
      "Tests",
      "Lint",
      "Tipos",
      "Build",
    ]) {
      expect(
        stepNamed(name).if,
        `el paso ${name} corre aunque el proyecto no esté bootstrapeado`,
      ).toMatch(/steps\.repo\.outputs\.bootstrapped == 'true'/);
    }
  });

  it("no corre los tests del kit: viven y corren en el repo del plugin", () => {
    expect(readFileSync(WORKFLOW_PATH, "utf8")).not.toMatch(/test:kit/);
  });

  it("averigua si hay bootstrap mirando factory.json, no adivinando", () => {
    const probe = stepNamed("Averigua qué comandos están configurados");

    expect(probe.run).toMatch(/-f factory\.json/);
  });
});
