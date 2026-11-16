import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/** El reusable workflow vive en el repo del plugin; el proyecto lo llama. */
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/labels-cleanup.yml",
);
const CALLER_PATH = path.join(
  TEMPLATES_ROOT,
  ".github/workflows/labels-cleanup.yml",
);

interface Job {
  if?: string;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  steps: Array<{ uses?: string; run?: string }>;
}

interface WorkflowFile {
  on: {
    issues?: { types: string[] };
    schedule?: Array<{ cron: string }>;
  };
  jobs: {
    cleanup: Job;
    "epic-status": Job;
    "reconcile-epics": Job;
  };
}

function parseWorkflow(): WorkflowFile {
  return load(readFileSync(WORKFLOW_PATH, "utf8")) as WorkflowFile;
}

describe("workflow labels-cleanup", () => {
  it("concede contents de lectura, sin lo cual el checkout no clona un repo privado", () => {
    const { permissions } = parseWorkflow().jobs.cleanup;

    expect(permissions.contents).toBe("read");
  });

  it("mantiene el permiso de escritura sobre issues que necesitan las etiquetas", () => {
    const { permissions } = parseWorkflow().jobs.cleanup;

    expect(permissions.issues).toBe("write");
  });

  it("hace checkout antes de invocar el script de bloqueadores", () => {
    const { steps } = parseWorkflow().jobs.cleanup;

    const checkoutIndex = steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout"),
    );
    const scriptIndex = steps.findIndex((step) =>
      step.run?.includes("clear-blockers.sh"),
    );

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBeGreaterThan(checkoutIndex);
  });

  it("solo limpia etiquetas cuando el issue se cierra, no cuando se reabre", () => {
    const { cleanup } = parseWorkflow().jobs;

    expect(cleanup.if).toMatch(/action == 'closed'/);
  });

  it("el proyecto escucha closed y reopened, además de una pasada periódica", () => {
    const { on } = load(readFileSync(CALLER_PATH, "utf8")) as WorkflowFile;

    expect(on.issues?.types).toEqual(
      expect.arrayContaining(["closed", "reopened"]),
    );
    expect(on.schedule?.length).toBeGreaterThan(0);
  });

  it("sincroniza la épica padre en cada evento de issue, cierre o reapertura", () => {
    const { "epic-status": epicStatus } = parseWorkflow().jobs;

    expect(epicStatus.if).toMatch(/event_name == 'issues'/);
    const step = epicStatus.steps.find((s) =>
      s.run?.includes("sync-epic-status.sh"),
    );
    // El número entra por el entorno, no pegado en el script.
    expect(step?.run).toMatch(/sync-epic-status\.sh"?\s+"\$NUM"/);
    expect(epicStatus.env?.NUM).toMatch(
      /\$\{\{\s*github\.event\.issue\.number\s*\}\}/,
    );
  });

  it("corre la reconciliación completa solo en la pasada periódica", () => {
    const { "reconcile-epics": reconcileEpics } = parseWorkflow().jobs;

    expect(reconcileEpics.if).toMatch(/event_name == 'schedule'/);
    expect(
      reconcileEpics.steps.some((s) =>
        s.run?.includes("reconcile-all-epics.sh"),
      ),
    ).toBe(true);
  });
});
