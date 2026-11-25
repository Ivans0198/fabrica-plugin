import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../support/plugin-paths";

/**
 * Un proyecto con pnpm no pasaba la CI: setup-node trae Node y npm, y
 * `fabrica-cmd install` corría `pnpm install` sin pnpm (truckconnect-mobile,
 * 2026-11-26). El proyecto dice que usa pnpm con `packageManager` en su
 * package.json, y cada job lo activa con corepack, que viene con Node 24.
 */

const PNPM_STEP = "Activa pnpm si el proyecto lo usa";
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github/workflows");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

// kit.yml es la CI del propio plugin, que usa npm: no corre en un proyecto.
const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml") && f !== "kit.yml")
  .map((file) => ({
    file,
    parsed: load(
      readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"),
    ) as Workflow,
  }));

function jobsWithNode(): { where: string; steps: Step[]; at: number }[] {
  return workflows.flatMap(({ file, parsed }) =>
    Object.entries(parsed.jobs).flatMap(([job, { steps = [] }]) =>
      steps.flatMap((step, at) =>
        step.uses?.startsWith("actions/setup-node@")
          ? [{ where: `${file} → ${job}`, steps, at }]
          : [],
      ),
    ),
  );
}

function stepOf(file: string, name: string): Step {
  const wf = workflows.find((w) => w.file === file);
  const step = Object.values(wf?.parsed.jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .find((s) => s.name === name);
  if (!step?.run) throw new Error(`${file} no tiene el paso "${name}"`);
  return step;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Corre el script de un paso en un proyecto con comandos falsos que anotan su llamada. */
function runStep(
  step: Step,
  packageJson: object | null,
): { code: number | null; calls: string[]; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fabrica-pm-"));
  temps.push(dir);
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  for (const cmd of ["corepack", "pnpm", "npm"]) {
    const file = path.join(bin, cmd);
    writeFileSync(file, `#!/bin/sh\necho "${cmd} $*" >> "${log}"\n`);
    chmodSync(file, 0o755);
  }
  if (packageJson)
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson));
  const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...step.env, PATH: `${bin}:${process.env.PATH}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return { code: result.status, calls, stderr: result.stderr };
}

describe("pnpm en los workflows", () => {
  it("cada job con Node activa pnpm justo después de setup-node, con la misma condición", () => {
    const jobs = jobsWithNode();

    expect(jobs.length).toBeGreaterThanOrEqual(5);
    for (const { where, steps, at } of jobs) {
      const next = steps[at + 1];
      expect(next?.name, where).toBe(PNPM_STEP);
      expect(next?.if, where).toBe(steps[at].if);
      expect(next?.env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, where).toBe("0");
    }
  });

  it("ningún job instala con npm a secas", () => {
    for (const { file, parsed } of workflows) {
      for (const step of Object.values(parsed.jobs).flatMap(
        (j) => j.steps ?? [],
      )) {
        expect(step.run?.trim() ?? "", `${file}: ${step.name}`).not.toMatch(
          /^npm (ci|install)\b/,
        );
      }
    }
  });

  it("con packageManager pnpm@, activa corepack", () => {
    const step = stepOf("checks.yml", PNPM_STEP);

    const { code, calls } = runStep(step, { packageManager: "pnpm@10.4.1" });

    expect(code).toBe(0);
    expect(calls).toContain("corepack enable");
  });

  it("con npm o sin packageManager, no toca nada", () => {
    const step = stepOf("checks.yml", PNPM_STEP);

    for (const pkg of [{ packageManager: "npm@11.0.0" }, {}, null]) {
      const { code, calls } = runStep(step, pkg);
      expect(code, JSON.stringify(pkg)).toBe(0);
      expect(calls, JSON.stringify(pkg)).toEqual([]);
    }
  });

  it("todos los pasos de pnpm son el mismo script", () => {
    const scripts = jobsWithNode().map(
      ({ steps, at }) => steps[at + 1]?.run?.trim() ?? "",
    );

    expect(new Set(scripts).size).toBe(1);
  });
});

describe("las dependencias de visual-baselines", () => {
  it("con pnpm instala con pnpm y el lockfile congelado", () => {
    const step = stepOf("visual-baselines.yml", "Dependencias del proyecto");

    const { code, calls } = runStep(step, { packageManager: "pnpm@10.4.1" });

    expect(code).toBe(0);
    expect(calls).toEqual(["pnpm install --frozen-lockfile"]);
  });

  it("sin pnpm sigue con npm ci", () => {
    const step = stepOf("visual-baselines.yml", "Dependencias del proyecto");

    const { code, calls } = runStep(step, {});

    expect(code).toBe(0);
    expect(calls).toEqual(["npm ci"]);
  });
});
