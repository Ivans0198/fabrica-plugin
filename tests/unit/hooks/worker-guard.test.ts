import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * Que un worker no mergee ni empuje a la rama base era solo texto de las
 * reglas, y un repo privado gratis no tiene branch protection: un texto
 * escondido en una issue bastaba (revisión del 2026-11-23). El hook corre
 * antes de cada Bash, también con bypassPermissions.
 */

const GUARD = path.join(PLUGIN_ROOT, "hooks/worker-guard.sh");
const TIMEOUT = 20_000;

interface RunResult {
  code: number | null;
  stderr: string;
}

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function project(base?: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "fabrica-guard-"));
  await writeFile(
    path.join(dir, "factory.json"),
    JSON.stringify(base ? { baseBranch: base } : {}),
  );
  return dir;
}

function guard(
  cwd: string,
  command: string,
  worker = true,
  tool = "Bash",
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
    if (worker) env.FABRICA_WORKER = "1";
    else delete env.FABRICA_WORKER;
    const child = spawn("bash", [GUARD], {
      cwd,
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.end(
      JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("guardia del worker", () => {
  it.each([
    "gh pr merge 12 --squash",
    "gh pr ready 12 && gh pr merge --auto --squash",
    "gh api -X PUT repos/o/r/pulls/12/merge",
    "git push origin HEAD:main",
    "git push origin main",
    "git push --force origin impl-7",
    "git push -f",
    "git push --force-with-lease origin impl-7",
    "git push origin +impl-7",
    "git push origin --delete impl-3",
    "cd sub && git push origin HEAD:refs/heads/main",
  ])(
    "un worker no puede correr: %s",
    async (command) => {
      const cwd = await project();

      const { code, stderr } = await guard(cwd, command);

      expect(code).toBe(2);
      expect(stderr).toMatch(/worker/i);
    },
    TIMEOUT,
  );

  it.each([
    "git push -u origin impl-7",
    "git push",
    "gh pr create --draft --body-file /tmp/pr-7.md",
    "gh pr view 12 --json mergeable",
    "git log origin/main..HEAD",
    "echo 'gh pr merge' > notas.txt",
  ])(
    "un worker sí puede correr: %s",
    async (command) => {
      const cwd = await project();

      const { code } = await guard(cwd, command);

      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "la rama base sale de factory.json",
    async () => {
      const cwd = await project("develop");

      expect((await guard(cwd, "git push origin HEAD:develop")).code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "fuera de un worker no bloquea nada: ahí pregunta Claude Code",
    async () => {
      const cwd = await project();

      expect((await guard(cwd, "gh pr merge 12", false)).code).toBe(0);
    },
    TIMEOUT,
  );
});

describe("quién es worker", () => {
  it("hooks.json corre el guardia antes de cada Bash", () => {
    const hooks = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { command: string }[] }[]
      >;
    };

    const pre = hooks.hooks.PreToolUse ?? [];
    expect(
      pre.some(
        (h) =>
          h.matcher === "Bash" &&
          h.hooks.some((c) => c.command.includes("hooks/worker-guard.sh")),
      ),
    ).toBe(true);
  });

  it("fabrica-backlog lanza al worker con FABRICA_WORKER=1", () => {
    const script = readFileSync(
      path.join(PLUGIN_ROOT, "scripts/process-backlog.sh"),
      "utf8",
    );

    expect(script).toMatch(
      /export FABRICA_WORKER=1\n(.*\n){0,8}\s*exec claude -p/,
    );
  });

  it("la nube lanza al agente con FABRICA_WORKER=1", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/claude-backlog.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/FABRICA_WORKER: "1"/);
  });
});
