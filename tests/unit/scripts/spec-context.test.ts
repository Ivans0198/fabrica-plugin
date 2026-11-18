import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Fase 5: fabrica-spec-context lee la marca fabrica-spec que
 * fabrica-create-issues deja en cada issue de una feature, y le da al worker
 * su parte de la spec: las tareas de su issue y los escenarios de su
 * historia. Sin marca, la issue es suelta y el ciclo sigue como antes.
 */

const SPEC_CONTEXT = pluginFile("scripts/spec-context.sh");
const TIMEOUT = 20_000;
const DIR = "specs/11-opciones-salida";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SPEC_CONTEXT, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const SPEC = `# Feature Specification: Opciones de salida

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Salida en JSON (Priority: P1)

Quien usa el CLI desde un script pide JSON.

**Acceptance Scenarios**:

1. **Given** 100 y 15, **When** --json, **Then** {"propina":15,"total":115}

---

### User Story 2 - Redondear (Priority: P2)

Quien divide la cuenta redondea.

**Acceptance Scenarios**:

1. **Given** 100 15 4, **When** --redondear, **Then** 29.00

### Edge Cases

- Opciones en cualquier posición.

## Requirements *(mandatory)*

- **FR-001**: algo
`;

const TASKS = `# Tasks: Opciones de salida

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T001 [P] Test de separarArgumentos en tests/argumentos.test.ts
- [ ] T002 Implementar separarArgumentos en src/argumentos.ts

## Phase 3: User Story 1 - Salida en JSON (Priority: P1)

### Tests for User Story 1 (MANDATORY, write first) ⚠️

- [ ] T005 [P] [US1] Test de formatearJson en tests/salida.test.ts

### Implementation for User Story 1

- [ ] T007 [US1] Implementar formatearJson en src/salida.ts

## Phase 4: User Story 2 - Redondear (Priority: P2)

- [ ] T009 [P] [US2] Test de redondearArriba
- [ ] T011 [US2] Implementar redondearArriba
`;

function marker(fields: string): string {
  return `Cuerpo de la issue.\n\n<!-- fabrica-key: 11/US1 sha=abc -->\n<!-- fabrica-spec: ${fields} -->\n`;
}

describe("fabrica-spec-context", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  /** Un repo con la spec de prueba y un gh que devuelve FAKE_BODY. */
  async function prepare(): Promise<{
    repo: string;
    env: NodeJS.ProcessEnv;
  }> {
    dir = await mkdtemp(path.join(tmpdir(), "spec-context-"));
    const repo = path.join(dir, "repo");
    const feature = path.join(repo, DIR);
    await mkdir(path.join(feature, "contracts"), { recursive: true });
    await writeFile(path.join(feature, "spec.md"), SPEC);
    await writeFile(path.join(feature, "tasks.md"), TASKS);
    await writeFile(path.join(feature, "plan.md"), "# Plan\n");
    await writeFile(path.join(feature, "contracts", "cli.md"), "# CLI\n");
    const init = spawn("git", ["init", "-q"], { cwd: repo });
    await new Promise((resolve) => init.on("close", resolve));

    const binDir = path.join(dir, "stub-bin");
    await mkdir(binDir);
    await writeFile(
      path.join(binDir, "gh"),
      `#!/usr/bin/env bash
[ "$1 $2" = "issue view" ] && printf '%s' "\${FAKE_BODY:-}"
`,
    );
    await chmod(path.join(binDir, "gh"), 0o755);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    return { repo, env };
  }

  it(
    "imprime las tareas de la issue y los escenarios de su historia",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(
        `dir=${DIR} story=US1 phase=story tasks=T005,T007`,
      );

      const { code, stdout, stderr } = await run(["14"], repo, env);

      expect(code, stderr).toBe(0);
      expect(stdout).toContain(DIR);
      expect(stdout).toContain("T005 [P] [US1] Test de formatearJson");
      expect(stdout).toContain("T007 [US1] Implementar formatearJson");
      expect(stdout).not.toContain("T001");
      expect(stdout).not.toContain("T009");
      expect(stdout).toContain("### User Story 1 - Salida en JSON");
      expect(stdout).toContain('{"propina":15,"total":115}');
      expect(stdout).not.toContain("User Story 2");
      expect(stdout.trimEnd()).not.toMatch(/---$/);
      expect(stdout).toContain(`${DIR}/plan.md`);
      expect(stdout).toContain(`${DIR}/contracts/`);
      expect(stdout).toMatch(/tasks\.md/);
    },
    TIMEOUT,
  );

  it(
    "en Setup o Polish imprime las tareas, sin historia",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(`dir=${DIR} story=- phase=setup tasks=T001,T002`);

      const { code, stdout } = await run(["13"], repo, env);

      expect(code).toBe(0);
      expect(stdout).toContain("T001 [P] Test de separarArgumentos");
      expect(stdout).toContain("T002 Implementar separarArgumentos");
      expect(stdout).not.toContain("### User Story");
    },
    TIMEOUT,
  );

  it(
    "una issue sin marca es suelta: sale con 1 y no imprime nada",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = "Una issue escrita a mano.";

      const { code, stdout, stderr } = await run(["9"], repo, env);

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "❌ La issue #9 no viene de una spec: no tiene la marca fabrica-spec.\n",
      );
    },
    TIMEOUT,
  );

  it(
    "si la carpeta de la spec no está en la rama, sale con 2",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(
        "dir=specs/99-otra story=US1 phase=story tasks=T005",
      );

      const { code, stderr } = await run(["14"], repo, env);

      expect(code).toBe(2);
      expect(stderr).toContain("specs/99-otra");
    },
    TIMEOUT,
  );

  it(
    "si una tarea de la issue ya no está en tasks.md, sale con 2 y la nombra",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(
        `dir=${DIR} story=US1 phase=story tasks=T005,T042`,
      );

      const { code, stderr } = await run(["14"], repo, env);

      expect(code).toBe(2);
      expect(stderr).toContain("T042");
    },
    TIMEOUT,
  );

  it(
    "si la historia no está en spec.md, sale con 2",
    async () => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(`dir=${DIR} story=US7 phase=story tasks=T005`);

      const { code, stderr } = await run(["14"], repo, env);

      expect(code).toBe(2);
      expect(stderr).toContain("US7");
    },
    TIMEOUT,
  );

  it.each([
    "dir=specs/../../etc story=US1 phase=story tasks=T005",
    "dir=/tmp/specs story=US1 phase=story tasks=T005",
    `dir=${DIR} story=US1;rm phase=story tasks=T005`,
    `dir=${DIR} story=US1 phase=story tasks=T005;rm`,
  ])(
    "rechaza una marca mal formada (%s) con 2",
    async (fields) => {
      const { repo, env } = await prepare();
      env.FAKE_BODY = marker(fields);

      const { code } = await run(["14"], repo, env);

      expect(code).toBe(2);
    },
    TIMEOUT,
  );

  it.each([[[]], [["abc"]]])(
    "sin un número de issue sale con 64 (%j)",
    async (args) => {
      const { repo, env } = await prepare();

      const { code } = await run(args, repo, env);

      expect(code).toBe(64);
    },
    TIMEOUT,
  );
});
