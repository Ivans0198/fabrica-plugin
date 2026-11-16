import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Los comandos de la cola que usa la sesión interactiva: fabrica-next-issue,
 * fabrica-claim, fabrica-release y fabrica-check-done. Llevan a comandos las
 * garantías que antes solo daba process-backlog.sh, para que no dependan de
 * que el modelo se acuerde.
 */

const ISSUE_QUEUE = pluginFile("scripts/issue-queue.sh");
const TIMEOUT = 20_000;

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
    const child = spawn("bash", [ISSUE_QUEUE, ...args], {
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

function git(cwd: string, script: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
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

/**
 * Un `gh` de mentira que anota cada llamada y contesta según variables:
 * FAKE_PENDING (números de la cola), FAKE_LABELS_<N> (etiquetas de N),
 * FAKE_STATE_<N> (estado de N), FAKE_OTHERS (assignees ajenos) y
 * FAKE_PR_COUNT (PRs con "Closes #N").
 */
async function installFakeGh(dir: string): Promise<string> {
  const binDir = path.join(dir, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const log = path.join(dir, "gh-calls.log");
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1 $2" in
  "api user") echo "\${FAKE_ME:-tester}" ;;
  "issue list") for n in \${FAKE_PENDING:-}; do echo "$n"; done ;;
  "issue view")
    n="$3"; shift 3
    case "$*" in
      *labels*) var="FAKE_LABELS_$n"; for l in \${!var:-}; do echo "$l"; done ;;
      *assignees*) echo "\${FAKE_OTHERS:-0}" ;;
      *state*) var="FAKE_STATE_$n"; echo "\${!var:-OPEN}" ;;
    esac ;;
  "pr list") echo "\${FAKE_PR_COUNT:-0}" ;;
esac
exit 0
`,
  );
  await chmod(path.join(binDir, "gh"), 0o755);
  await writeFile(log, "");
  return binDir;
}

describe("comandos de la cola", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  /** Un proyecto con la configuración de la fábrica commiteada. */
  async function project(): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
    dir = await mkdtemp(path.join(tmpdir(), "fabrica-cola-"));
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    await writeFile(path.join(repo, "factory.json"), "{}\n");
    await writeFile(path.join(repo, "CLAUDE.md"), "# proyecto\n");
    await git(
      repo,
      "git init -q -b main && git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m inicial",
    );
    const binDir = await installFakeGh(dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    };
    // El CI del plugin corre en GitHub Actions: sin esto, fabrica-claim
    // tomaría el camino de la nube en todos los tests.
    delete env.GITHUB_ACTIONS;
    return { repo, env };
  }

  const calls = () => readFile(path.join(dir, "gh-calls.log"), "utf8");

  it(
    "fabrica-next-issue da la primera issue de la cola que no está bloqueada",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["next"], repo, {
        ...env,
        FAKE_PENDING: "3 4",
        FAKE_LABELS_3: "blocked-by-9",
        FAKE_STATE_9: "OPEN",
      });

      expect(code).toBe(0);
      expect(stdout.trim()).toBe("4");
    },
    TIMEOUT,
  );

  it(
    "fabrica-next-issue sale con 1 si no hay ninguna elegible",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["next"], repo, env);

      expect(code).toBe(1);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim reclama la issue, crea su worktree en impl-N con los .env locales e imprime la ruta",
    async () => {
      const { repo, env } = await project();
      await writeFile(path.join(repo, ".env.local"), "SECRETO=1\n");

      const { code, stdout } = await run(["claim", "5"], repo, env);

      expect(code).toBe(0);
      const worktree = stdout.trim().split("\n").pop()!;
      expect(worktree).toBe(path.join(repo, ".claude/worktrees/impl-5"));
      const branch = await git(worktree, "git branch --show-current");
      expect(branch.stdout.trim()).toBe("impl-5");
      expect(existsSync(path.join(worktree, ".env.local"))).toBe(true);
      const log = await calls();
      expect(log).toMatch(/issue edit 5 --add-assignee @me/);
      expect(log).toMatch(
        /issue edit 5 --add-label in-progress --remove-label pending/,
      );
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim sale con 2 y suelta el reclamo si la issue ya es de otra persona",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5"], repo, {
        ...env,
        FAKE_OTHERS: "1",
      });

      expect(code).toBe(2);
      expect(existsSync(path.join(repo, ".claude/worktrees/impl-5"))).toBe(
        false,
      );
      const log = await calls();
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
      expect(log).not.toMatch(/--add-label in-progress/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim para si la configuración de la fábrica no está commiteada",
    async () => {
      const { repo, env } = await project();
      await writeFile(path.join(repo, "factory.json"), '{"cambio":1}\n');

      const { code, stderr } = await run(["claim", "5"], repo, env);

      expect(code).toBe(1);
      expect(stderr).toMatch(/factory\.json/);
      expect(await calls()).not.toMatch(/--add-assignee/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim al retomar una issue borra el contador y la rendición del Stop gate",
    async () => {
      const { repo, env } = await project();
      await run(["claim", "5"], repo, env);
      const state = path.join(repo, ".claude/worktrees/impl-5/.factory");
      await mkdir(path.join(state, "state"), { recursive: true });
      await writeFile(path.join(state, "state/stop-gate-count"), "5");
      await writeFile(path.join(state, "gate-gave-up"), "x");

      const { code } = await run(["claim", "5"], repo, env);

      expect(code).toBe(0);
      expect(existsSync(path.join(state, "state/stop-gate-count"))).toBe(false);
      expect(existsSync(path.join(state, "gate-gave-up"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim desde dentro de un worktree crea el nuevo junto a los otros, en la raíz",
    async () => {
      const { repo, env } = await project();
      await run(["claim", "5"], repo, env);

      const { code, stdout } = await run(
        ["claim", "6"],
        path.join(repo, ".claude/worktrees/impl-5"),
        env,
      );

      expect(code).toBe(0);
      expect(stdout.trim().split("\n").pop()).toBe(
        path.join(repo, ".claude/worktrees/impl-6"),
      );
    },
    TIMEOUT,
  );

  // En la nube no hay EnterWorktree (está en las herramientas prohibidas) y
  // el runner es desechable: un worktree dejaría al agente trabajando en la
  // copia equivocada (probado en fabrica-prueba, 2026-11-16).
  it(
    "fabrica-claim en GitHub Actions trabaja en la rama impl-N del mismo checkout, sin worktree",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["claim", "5"], repo, {
        ...env,
        GITHUB_ACTIONS: "true",
      });

      expect(code).toBe(0);
      expect(stdout.trim().split("\n").pop()).toBe(repo);
      expect(existsSync(path.join(repo, ".claude/worktrees/impl-5"))).toBe(
        false,
      );
      const branch = await git(repo, "git branch --show-current");
      expect(branch.stdout.trim()).toBe("impl-5");
    },
    TIMEOUT,
  );

  it(
    "fabrica-release --pending devuelve la issue a la cola sin assignee",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["release", "5", "--pending"], repo, env);

      expect(code).toBe(0);
      const log = await calls();
      expect(log).toMatch(
        /issue edit 5 --add-label pending --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-release --needs-human marca la issue y deja el motivo en un comentario",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(
        ["release", "5", "--needs-human", "falta la clave de la API"],
        repo,
        env,
      );

      expect(code).toBe(0);
      const log = await calls();
      expect(log).toMatch(
        /issue edit 5 --add-label needs-human --remove-label in-progress/,
      );
      expect(log).toMatch(/issue comment 5 --body .*falta la clave de la API/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-check-done falla si la issue no tiene un PR que la cierre",
    async () => {
      const { repo, env } = await project();

      const sinPr = await run(["done", "5"], repo, env);
      const conPr = await run(["done", "5"], repo, {
        ...env,
        FAKE_PR_COUNT: "1",
      });

      expect(sinPr.code).toBe(1);
      expect(sinPr.stderr).toMatch(/Closes #5/);
      expect(conPr.code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "rechaza un número de issue que no es un número",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5; rm -rf /"], repo, env);

      expect(code).not.toBe(0);
      expect(await calls()).not.toMatch(/issue edit/);
    },
    TIMEOUT,
  );
});
