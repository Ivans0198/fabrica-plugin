import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/**
 * Un PR choca después de abierto cuando `main` se mueve, o cuando su propia
 * rama cambia. El workflow repasa los PRs abiertos en los dos casos.
 */

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/pr-conflicts.yml",
);
const CALLER_PATH = path.join(
  TEMPLATES_ROOT,
  ".github/workflows/pr-conflicts.yml",
);

interface Job {
  if?: string;
  env?: Record<string, string>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  steps: Array<{ uses?: string; run?: string; env?: Record<string, string> }>;
}

interface WorkflowFile {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function parse(file: string): WorkflowFile {
  return load(readFileSync(file, "utf8")) as WorkflowFile;
}

function job(): Job {
  return parse(WORKFLOW_PATH).jobs.conflicts!;
}

describe("pr-conflicts.yml", () => {
  it("el proyecto lo llama en cada push y cuando un PR se abre o cambia", () => {
    const on = parse(CALLER_PATH).on;

    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(on.pull_request).toEqual({
      types: ["opened", "reopened", "synchronize"],
    });
  });

  it("en un push solo corre si es a la rama principal", () => {
    const condition = job().if ?? "";

    expect(condition).toContain("github.event.repository.default_branch");
    expect(condition).toContain("github.event_name == 'pull_request'");
  });

  it("puede etiquetar y comentar PRs, y clonar el plugin privado", () => {
    expect(job().permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    });
    expect(parse(CALLER_PATH).permissions).toMatchObject(job().permissions);
  });

  it("una corrida a la vez, para no comentar dos veces el mismo PR", () => {
    const { concurrency } = job();

    expect(concurrency?.group).toContain("github.repository");
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("trae el plugin antes de correr el script", () => {
    const { steps } = job();
    const checkout = steps.findIndex((s) =>
      s.uses?.startsWith("actions/checkout"),
    );
    const script = steps.findIndex((s) => s.run?.includes("flag-conflicts.sh"));

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(script).toBeGreaterThan(checkout);
  });

  // Sin branch protection nada frena un push a main: la fábrica avisa
  // (revisión del 2026-11-26; la persona decidió no pagar GitHub Pro todavía).
  describe("direct-push", () => {
    const direct = () => parse(WORKFLOW_PATH).jobs["direct-push"]!;

    it("corre solo en un push a la rama principal", () => {
      const condition = direct().if ?? "";

      expect(condition).toContain("github.event_name == 'push'");
      expect(condition).toContain("github.event.repository.default_branch");
    });

    it("pasa before y after por env, no dentro del script", () => {
      const step = direct().steps.find((s) =>
        s.run?.includes("main-push-check.sh"),
      )!;

      expect(step.env).toEqual({
        BEFORE: "${{ github.event.before }}",
        AFTER: "${{ github.event.after }}",
      });
      expect(step.run).not.toContain("${{");
      expect(step.run).toContain('"$BEFORE" "$AFTER"');
    });

    it("puede abrir issues y le alcanzan los permisos del proyecto", () => {
      expect(direct().permissions).toEqual({
        contents: "read",
        issues: "write",
        "pull-requests": "read",
      });
      const caller = parse(CALLER_PATH).permissions ?? {};
      expect(caller.issues).toBe("write");
      expect(caller.contents).toBe("read");
      expect(caller["pull-requests"]).toMatch(/read|write/);
    });
  });
});
