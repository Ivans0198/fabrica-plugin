import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/**
 * La nube trabaja una issue por corrida, solo cuando una persona le pone
 * `ready-for-dev`. No hay cron ni disparo a mano: un lote en una sola sesión
 * dejaba al Stop gate revisando solo la última issue.
 */

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/claude-backlog.yml",
);
const CALLER_PATH = path.join(
  TEMPLATES_ROOT,
  ".github/workflows/claude-backlog.yml",
);

const GITHUB_JOB_HARD_CAP_MINUTES = 360;
const MAX_TURNS = 200;
const TIMEOUT_MINUTES = 120;

interface WorkflowFile {
  on: Record<string, unknown>;
  jobs: {
    implement: {
      if?: string;
      "timeout-minutes": number | string;
      steps: Array<{
        name?: string;
        with?: { claude_args?: string };
      }>;
    };
  };
}

function parse(file: string): WorkflowFile {
  return load(readFileSync(file, "utf8")) as WorkflowFile;
}

function findClaudeArgs(workflow: WorkflowFile): string {
  const step = workflow.jobs.implement.steps.find(
    (candidate) => candidate.with?.claude_args !== undefined,
  );
  if (!step?.with?.claude_args) {
    throw new Error("no se encontró el paso con claude_args");
  }
  return step.with.claude_args;
}

describe("claude-backlog.yml", () => {
  it("la llamada del proyecto solo se dispara cuando una issue recibe una etiqueta", () => {
    const on = (load(readFileSync(CALLER_PATH, "utf8")) as WorkflowFile).on;

    expect(Object.keys(on)).toEqual(["issues"]);
    expect(on.issues).toEqual({ types: ["labeled"] });
  });

  it("el job corre solo con la etiqueta ready-for-dev, aunque una llamada vieja traiga el cron", () => {
    const condition = parse(WORKFLOW_PATH).jobs.implement.if ?? "";

    expect(condition).toContain("github.event_name == 'issues'");
    expect(condition).toContain("github.event.label.name == 'ready-for-dev'");
    expect(condition).not.toContain("!=");
  });

  it(`usa ${MAX_TURNS} turnos y ${TIMEOUT_MINUTES} minutos, por debajo del tope de 6 horas de GitHub`, () => {
    const workflow = parse(WORKFLOW_PATH);

    expect(findClaudeArgs(workflow)).toMatch(
      new RegExp(`--max-turns ${MAX_TURNS}\\b`),
    );
    expect(workflow.jobs.implement["timeout-minutes"]).toBe(TIMEOUT_MINUTES);
    expect(TIMEOUT_MINUTES).toBeLessThan(GITHUB_JOB_HARD_CAP_MINUTES);
  });

  it("no queda nada del cron: ni schedule, ni lote, ni su credencial", () => {
    for (const file of [WORKFLOW_PATH, CALLER_PATH]) {
      const source = readFileSync(file, "utf8");

      expect(source, file).not.toMatch(/schedule|cron|workflow_dispatch/i);
      expect(source, file).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(source, file).not.toContain("fabrica-worker-prompt batch");
    }
  });
});
