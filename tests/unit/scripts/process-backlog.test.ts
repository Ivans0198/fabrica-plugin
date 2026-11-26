import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT, pluginFile } from "../../support/plugin-paths";

const PROCESS_BACKLOG_SCRIPT = pluginFile("scripts/process-backlog.sh");
const TASK_STATUS_SCRIPT = pluginFile("scripts/task-status.sh");

/**
 * Estos tests lanzan bash y git de verdad, no los imitan. Bajo `npm test`
 * completo compiten por CPU con el resto de los workers de Vitest (y en CI,
 * con antivirus/indexado de Windows), así que el timeout de 5 s pensado para
 * tests puros no alcanza: ver issue #50.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = 20_000;

/**
 * En Windows, `git.exe` puede tardar en soltar el handle del directorio de
 * trabajo después de que su proceso reporta `close`, y un `rm` inmediato
 * falla con `EBUSY: resource busy or locked`. `maxRetries`/`retryDelay` hacen
 * que `fs.rm` reintente en vez de tumbar el test por un problema de limpieza
 * ajeno a lo que el test verifica.
 */
const REMOVE_TEMP_DIR_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function toBashPath(nativePath: string): string {
  return nativePath.replace(/\\/g, "/");
}

function runBash(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `gh` de mentira: registra cada invocación en un log y responde según las
 * variables de entorno, para no tocar GitHub real. El patrón sigue el de
 * `tests/unit/scripts/file-incident.test.ts`.
 */
async function installFakeGh(
  cwd: string,
): Promise<{ binDir: string; logFile: string }> {
  const binDir = path.join(cwd, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const ghPath = path.join(binDir, "gh");
  const logFile = path.join(cwd, "gh-calls.log");
  const script = `#!/usr/bin/env bash
echo "$@" >> "${toBashPath(logFile)}"

if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "acme/repo"
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  if [ -n "\${FAIL_ISSUE_VIEW_FOR:-}" ] && [ "$3" = "$FAIL_ISSUE_VIEW_FOR" ]; then
    echo "GraphQL: Could not resolve to an issue (issue #$3)" >&2
    exit 1
  fi
  if [ -n "\${ISSUE_VIEW_JSON:-}" ]; then
    echo "$ISSUE_VIEW_JSON"
  else
    echo '{"state":"OPEN","labels":[]}'
  fi
  exit 0
fi

if [ "$1" = "issue" ]; then
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -n "\${FAIL_PR_LIST:-}" ]; then
    echo "gh: API rate limit exceeded" >&2
    exit 1
  fi
  echo "\${PR_LIST_COUNT:-0}"
  exit 0
fi

if [ "$1" = "project" ] && [ "$2" = "item-list" ]; then
  if [ -n "\${FAIL_ITEM_LIST:-}" ]; then
    echo "error: your authentication token is missing required scopes [read:project]" >&2
    exit 1
  fi
  if [ -n "\${ITEM_LIST_JSON:-}" ]; then
    echo "$ITEM_LIST_JSON"
  else
    echo '{"items": []}'
  fi
  exit 0
fi

if [ "$1" = "project" ] && [ "$2" = "item-add" ]; then
  echo '{"id": "ITEM123"}'
  exit 0
fi

if [ "$1" = "project" ] && [ "$2" = "item-edit" ]; then
  exit 0
fi

exit 0
`;
  await writeFile(ghPath, script);
  await chmod(ghPath, 0o755);
  await writeFile(logFile, "");
  return { binDir, logFile };
}

async function readLog(logFile: string): Promise<string> {
  return readFile(logFile, "utf8");
}

/**
 * `jq` de mentira que reproduce el bug real: el binario de `jq` en Windows
 * termina líneas con CRLF. Solo afecta al filtro de `reconcile_board` (el
 * único que menciona `Todo`); todo lo demás se delega al `jq` real del PATH,
 * para no romper el resto del script.
 */
async function installFakeJq(binDir: string): Promise<void> {
  const jqPath = path.join(binDir, "jq");
  const script = `#!/usr/bin/env bash
stub_dir=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
real_jq=""
IFS=':' read -ra parts <<< "$PATH"
for p in "\${parts[@]}"; do
  [ "$p" = "$stub_dir" ] && continue
  if [ -x "$p/jq" ]; then real_jq="$p/jq"; break; fi
done
[ -n "$real_jq" ] || { echo "fake jq: no encontré el jq real en el PATH" >&2; exit 1; }

if printf '%s\\n' "$@" | grep -q 'status=="Todo"'; then
  "$real_jq" "$@" | sed 's/$/\\r/'
else
  exec "$real_jq" "$@"
fi
`;
  await writeFile(jqPath, script);
  await chmod(jqPath, 0o755);
}

const WORKER_DISALLOWED_TOOLS_FILE = pluginFile(
  "scripts/worker-disallowed-tools.txt",
);
const CLAUDE_BACKLOG_WORKFLOW = pluginFile(
  ".github/workflows/claude-backlog.yml",
);
const CLAUDE_MENTIONS_WORKFLOW = pluginFile(
  ".github/workflows/claude-mentions.yml",
);
const FACTORY_CONFIG_LIB = pluginFile("scripts/lib/factory-config.sh");
const BACKLOG_QUEUE_LIB = pluginFile("scripts/lib/backlog-queue.sh");

async function setupWorkDir(): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), "seadragons-backlog-"));
  await mkdir(path.join(workDir, "scripts"), { recursive: true });
  await copyFile(
    PROCESS_BACKLOG_SCRIPT,
    path.join(workDir, "scripts/process-backlog.sh"),
  );
  await copyFile(
    TASK_STATUS_SCRIPT,
    path.join(workDir, "scripts/task-status.sh"),
  );
  await copyFile(
    pluginFile("scripts/worker-prompt.sh"),
    path.join(workDir, "scripts/worker-prompt.sh"),
  );
  await copyFile(
    WORKER_DISALLOWED_TOOLS_FILE,
    path.join(workDir, "scripts/worker-disallowed-tools.txt"),
  );
  await mkdir(path.join(workDir, "scripts/lib"), { recursive: true });
  await copyFile(
    FACTORY_CONFIG_LIB,
    path.join(workDir, "scripts/lib/factory-config.sh"),
  );
  await copyFile(
    BACKLOG_QUEUE_LIB,
    path.join(workDir, "scripts/lib/backlog-queue.sh"),
  );
  await runBash("git init -q", workDir, process.env);
  // `run_worker` ahora crea el worktree del ticket con `git worktree add`, y
  // eso exige un HEAD válido: sin este commit inicial, un repo recién
  // inicializado no tiene de dónde ramificar.
  await runBash(
    "git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m 'estado inicial'",
    workDir,
    process.env,
  );
  return workDir;
}

/**
 * `claude` de mentira: registra su invocación completa (prompt + flags) y
 * termina al instante, para no lanzar un worker real desde un test.
 */
async function installFakeClaude(
  cwd: string,
): Promise<{ binDir: string; logFile: string }> {
  const binDir = path.join(cwd, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const claudePath = path.join(binDir, "claude");
  const logFile = path.join(cwd, "claude-calls.log");
  const script = `#!/usr/bin/env bash
echo "$@" >> "${toBashPath(logFile)}"
echo "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=\${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" >> "${toBashPath(logFile)}"
exit 0
`;
  await writeFile(claudePath, script);
  await chmod(claudePath, 0o755);
  await writeFile(logFile, "");
  return { binDir, logFile };
}

function extractDisallowedTools(invocation: string): string[] {
  const match = invocation.match(/--disallowedTools\s+(\S+)/);
  const value = match?.[1];
  if (!value) return [];
  return value.split(",").filter(Boolean);
}

/**
 * Extrae el cuerpo de un `run: |` de un step de GitHub Actions por el
 * nombre de su `- name:`, para poder ejecutarlo de verdad en un test en vez
 * de solo inspeccionar el YAML como texto.
 */
function extractWorkflowRunBlock(workflow: string, stepName: string): string {
  const stepIndex = workflow.indexOf(`- name: ${stepName}`);
  if (stepIndex === -1) {
    throw new Error(`No encontré el step "${stepName}" en el workflow`);
  }
  const runMarker = "run: |";
  const runIndex = workflow.indexOf(runMarker, stepIndex);
  if (runIndex === -1) {
    throw new Error(`El step "${stepName}" no tiene un bloque "run: |"`);
  }
  const lines = workflow
    .slice(runIndex + runMarker.length)
    .split("\n")
    .slice(1);
  const bodyLines: string[] = [];
  let baseIndent: number | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      bodyLines.push("");
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;
    bodyLines.push(line.slice(baseIndent));
  }
  return bodyLines.join("\n");
}

async function writeProjectConfig(
  workDir: string,
  statusOptions: Record<string, string>,
): Promise<void> {
  await mkdir(path.join(workDir, ".plan"), { recursive: true });
  await writeFile(
    path.join(workDir, ".plan/project.json"),
    JSON.stringify({
      owner: "acme",
      projectNumber: 5,
      projectId: "PVT_1",
      statusFieldId: "FIELD_1",
      statusOptions,
    }),
  );
}

const FULL_STATUS_OPTIONS = {
  Todo: "opt-todo",
  "In Progress": "opt-ip",
  Done: "opt-done",
  Blocked: "opt-blocked",
};

const OPEN_IN_PROGRESS_ISSUE = JSON.stringify({
  state: "OPEN",
  labels: [{ name: "in-progress" }],
});

describe("cleanup de process-backlog", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  // Claude Code exporta CLAUDE_PID con su propio PID. Si cleanup() matara un
  // PID heredado del entorno, cerraría la sesión que corre la fábrica o los
  // tests (exit 143).
  it(
    "no mata un PID heredado del entorno si no lanzó ningún worker",
    async () => {
      workDir = await setupWorkDir();
      const victim = spawn("sleep", ["300"], { stdio: "ignore" });
      try {
        const pid = String(victim.pid);
        await runBash("source scripts/process-backlog.sh; cleanup", workDir, {
          ...process.env,
          CLAUDE_PID: pid,
          WORKER_PID: pid,
        });

        expect(() => process.kill(victim.pid!, 0)).not.toThrow();
      } finally {
        victim.kill("SIGKILL");
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "devuelve la etiqueta pending y mueve la tarjeta a Blocked",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=5; ME=tester; cleanup",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(130);
      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 5 --add-label pending --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
      expect(log).toMatch(/project item-edit --id ITEM123.*opt-blocked/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "termina bien aunque el tablero rechace el estado",
    async () => {
      workDir = await setupWorkDir();
      // Sin la opción Blocked: task-status.sh debe fallar, pero cleanup() no.
      await writeProjectConfig(workDir, {
        Todo: "opt-todo",
        "In Progress": "opt-ip",
        Done: "opt-done",
      });
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=5; ME=tester; cleanup",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(130);
      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 5 --add-label pending --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no falla cuando no existe .plan/project.json",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=5; ME=tester; cleanup",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(130);
      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 5 --add-label pending --remove-label in-progress/,
      );
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("reconcile_board", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  // En el dev container, gh entró sin el permiso project: item-list falló y
  // el set -e mató fabrica-backlog a los 3,5 s sin decir nada
  // (truckconnect-mobile #9, 2026-11-26).
  it(
    "si no puede leer el tablero, avisa con el permiso que falta y sigue",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir } = await installFakeGh(workDir);

      const { code, stdout, stderr } = await runBash(
        "set -euo pipefail; source scripts/process-backlog.sh; reconcile_board; echo sigue",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          FAIL_ITEM_LIST: "1",
        },
      );

      expect(code, stderr).toBe(0);
      expect(stdout).toContain("sigue");
      expect(stderr).toMatch(/tablero/);
      expect(stderr).toContain("gh auth refresh -h github.com -s project");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "ignora las tarjetas en Blocked con needs-human",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [
          {
            status: "Blocked",
            content: { number: 22 },
          },
        ],
      });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
        },
      );

      const log = await readLog(logFile);
      expect(log).not.toMatch(/issue view 22/);
      expect(log).not.toMatch(/issue edit 22/);
      expect(log).not.toMatch(/issue reopen 22/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reencola una tarjeta que pasó de Blocked a Todo",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [
          {
            status: "Todo",
            content: { number: 22 },
          },
        ],
      });
      const issueViewJson = JSON.stringify({
        state: "OPEN",
        labels: [{ name: "needs-human" }],
      });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
        },
      );

      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 22 --add-label pending --remove-label needs-human --remove-label in-progress/,
      );
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "encola un issue abierto que no tiene etiqueta de cola",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [{ status: "Todo", content: { number: 31 } }],
      });
      const issueViewJson = JSON.stringify({ state: "OPEN", labels: [] });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
        },
      );

      const log = await readLog(logFile);
      expect(log).toMatch(/issue edit 31 --add-label pending/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reabre y encola un issue cerrado que está en Todo",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [{ status: "Todo", content: { number: 22 } }],
      });
      const issueViewJson = JSON.stringify({ state: "CLOSED", labels: [] });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
        },
      );

      const log = await readLog(logFile);
      expect(log).toMatch(/issue reopen 22/);
      expect(log).toMatch(
        /issue edit 22 --add-label pending --remove-label in-progress --remove-label needs-human/,
      );
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "ignora las tarjetas de epics",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [{ status: "Todo", content: { number: 7 } }],
      });
      const issueViewJson = JSON.stringify({
        state: "OPEN",
        labels: [{ name: "epic" }],
      });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
        },
      );

      const log = await readLog(logFile);
      expect(log).not.toMatch(/issue edit 7/);
      expect(log).not.toMatch(/issue reopen 7/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "procesa todas las tarjetas cuando la entrada llega con CRLF",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      await installFakeJq(binDir);
      const itemListJson = JSON.stringify({
        items: [
          { status: "Todo", content: { number: 31 } },
          { status: "Todo", content: { number: 33 } },
        ],
      });
      const issueViewJson = JSON.stringify({ state: "OPEN", labels: [] });

      await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
        },
      );

      const log = await readLog(logFile);
      // El bug real: con \r pegado, "31\r" no matchea y la tarjeta se salta en
      // silencio. Si las dos aparecen limpias, el CRLF no rompió el bucle.
      expect(log).toMatch(/issue edit 31 --add-label pending/);
      expect(log).toMatch(/issue edit 33 --add-label pending/);
      expect(log).not.toMatch(/issue view 31\r/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "avisa por stderr cuando gh falla para un issue concreto",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const itemListJson = JSON.stringify({
        items: [
          { status: "Todo", content: { number: 40 } },
          { status: "Todo", content: { number: 41 } },
        ],
      });
      const issueViewJson = JSON.stringify({ state: "OPEN", labels: [] });

      const { stderr } = await runBash(
        "source scripts/process-backlog.sh; reconcile_board",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ITEM_LIST_JSON: itemListJson,
          ISSUE_VIEW_JSON: issueViewJson,
          FAIL_ISSUE_VIEW_FOR: "40",
        },
      );

      expect(stderr).toMatch(/#40/);
      const log = await readLog(logFile);
      expect(log).toMatch(/issue edit 41 --add-label pending/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("task-status", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "falla con las opciones conocidas cuando el estado no existe",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, {
        Todo: "opt-todo",
        "In Progress": "opt-ip",
        Done: "opt-done",
      });
      const { binDir } = await installFakeGh(workDir);

      const { code, stderr } = await runBash(
        "bash scripts/task-status.sh 5 Blocked",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/Unknown status 'Blocked'/);
      expect(stderr).toMatch(/Todo/);
      expect(stderr).toMatch(/In Progress/);
      expect(stderr).toMatch(/Done/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("lanzamiento del worker", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "crea el worktree desde lo último de origin, aunque la copia local no haya hecho pull",
    async () => {
      workDir = await setupWorkDir();
      const origin = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-origin`),
      );
      const other = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-other`),
      );
      const prepared = await runBash(
        `set -e
         git init -q --bare -b main "${origin}"
         git remote add origin "${origin}"
         git push -q origin HEAD:main
         git fetch -q origin
         git clone -q "${origin}" "${other}"
         cd "${other}"
         git config user.email t@t.com && git config user.name t
         mkdir -p specs/12-favoritos && echo '# Spec' > specs/12-favoritos/spec.md
         git add -A && git commit -q -m spec && git push -q origin HEAD:main`,
        workDir,
        process.env,
      );
      expect(prepared.code, prepared.stderr).toBe(0);
      const { binDir } = await installFakeClaude(workDir);

      const { code, stderr } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );

      const tracking = await runBash(
        "git config --get branch.impl-77.merge || echo sin-seguimiento",
        workDir,
        process.env,
      );
      await rm(origin, REMOVE_TEMP_DIR_OPTIONS);
      await rm(other, REMOVE_TEMP_DIR_OPTIONS);
      expect(code, stderr).toBe(0);
      // Una rama que sigue a origin/main empujaría ahí con un `git push` a secas.
      expect(tracking.stdout.trim()).toBe("sin-seguimiento");
      expect(
        existsSync(
          path.join(
            workDir,
            ".claude/worktrees/impl-77/specs/12-favoritos/spec.md",
          ),
        ),
      ).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Con las tareas en segundo plano, el worker lanza al revisor, termina su
  // turno esperando la notificación, y `claude -p` se cierra sin la
  // respuesta: no hay PR (probado el 2026-11-16).
  it(
    "lanza al worker con los subagentes en primer plano",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "",
        },
      );

      expect(code).toBe(0);
      expect(await readLog(logFile)).toContain(
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
      );
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "niega ScheduleWakeup con --disallowedTools",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );

      expect(code).toBe(0);
      const invocation = await readLog(logFile);
      const disallowed = extractDisallowedTools(invocation);
      expect(disallowed).toContain("ScheduleWakeup");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no niega Agent, porque el lifecycle depende de lanzar subagentes con ella",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );

      expect(code).toBe(0);
      const invocation = await readLog(logFile);
      expect(invocation).toMatch(/--disallowedTools/);
      const disallowed = extractDisallowedTools(invocation);
      expect(disallowed.length).toBeGreaterThan(0);
      expect(disallowed).not.toContain("Agent");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "la lista de negadas es la misma en process-backlog.sh y en claude-backlog.yml",
    async () => {
      const workflow = await readFile(CLAUDE_BACKLOG_WORKFLOW, "utf8");

      // Ambos consumidores deben leer el mismo archivo fuente: si alguno
      // pasa a tener su propia copia, dejan de estar garantizadamente en
      // sincronía y este test deja de probar lo que dice probar.
      expect(workflow).toMatch(/scripts\/worker-disallowed-tools\.txt/);

      const listFile = await readFile(WORKER_DISALLOWED_TOOLS_FILE, "utf8");
      const toolsFromFile = listFile
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      expect(toolsFromFile).toContain("ScheduleWakeup");
      expect(toolsFromFile).not.toContain("Agent");

      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);
      await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );
      const invocation = await readLog(logFile);
      const disallowedFromScript = extractDisallowedTools(invocation).sort();

      expect(disallowedFromScript).toEqual([...toolsFromFile].sort());

      // No basta con que el YAML mencione el archivo: hay que ejecutar su
      // propio paso de verdad y comprobar que calcula la misma lista que
      // process-backlog.sh, para que un typo en el step no pase inadvertido.
      const runBlock = extractWorkflowRunBlock(
        workflow,
        "Lee las herramientas prohibidas al worker",
      );
      const githubEnvFile = path.join(workDir, "github_env");
      await writeFile(githubEnvFile, "");
      const { code: workflowStepCode } = await runBash(runBlock, workDir, {
        ...process.env,
        FABRICA: toBashPath(workDir),
        GITHUB_ENV: toBashPath(githubEnvFile),
      });
      expect(workflowStepCode).toBe(0);
      const githubEnvContent = await readFile(githubEnvFile, "utf8");
      const workflowMatch = githubEnvContent.match(
        /WORKER_DISALLOWED_TOOLS=(.*)/,
      );
      const disallowedFromWorkflow = (workflowMatch?.[1] ?? "")
        .split(",")
        .filter(Boolean)
        .sort();

      expect(disallowedFromWorkflow).toEqual(disallowedFromScript);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "falla en vez de lanzar el worker sin restricciones cuando falta la lista de negadas",
    async () => {
      workDir = await setupWorkDir();
      await rm(path.join(workDir, "scripts/worker-disallowed-tools.txt"));
      const { binDir, logFile } = await installFakeClaude(workDir);

      const { code, stderr } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/worker-disallowed-tools\.txt/);
      const invocation = await readLog(logFile);
      expect(invocation).toBe("");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "falla en vez de lanzar el worker sin restricciones cuando la lista de negadas queda vacía",
    async () => {
      workDir = await setupWorkDir();
      await writeFile(
        path.join(workDir, "scripts/worker-disallowed-tools.txt"),
        "# solo comentarios, ninguna herramienta listada\n",
      );
      const { binDir, logFile } = await installFakeClaude(workDir);

      const { code, stderr } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          MAX_TURNS: "5",
          WORKER_MODEL: "sonnet",
        },
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/worker-disallowed-tools\.txt/);
      const invocation = await readLog(logFile);
      expect(invocation).toBe("");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("modelo del worker", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function writeFactoryJson(models: Record<string, string>) {
    await writeFile(
      path.join(workDir, "factory.json"),
      JSON.stringify({ stack: "node-ts", commands: {}, models }),
    );
  }

  /** Lanza el worker con `claude` y `gh` falsos y devuelve con qué lo llamó. */
  async function launchWorker(
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ invocation: string; stderr: string }> {
    const { binDir, logFile } = await installFakeClaude(workDir);
    await installFakeGh(workDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      PERMISSION_MODE: "auto",
      MAX_TURNS: "5",
      ...extraEnv,
    };
    if (!("WORKER_MODEL" in extraEnv)) delete env.WORKER_MODEL;
    const { code, stderr } = await runBash(
      'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
      workDir,
      env,
    );
    expect(code).toBe(0);
    return { invocation: await readLog(logFile), stderr };
  }

  it(
    "lee models.worker de factory.json cuando no hay WORKER_MODEL",
    async () => {
      workDir = await setupWorkDir();
      await writeFactoryJson({ worker: "haiku" });

      const { invocation } = await launchWorker();

      expect(invocation).toMatch(/--model haiku(\s|$)/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "WORKER_MODEL del entorno gana sobre factory.json",
    async () => {
      workDir = await setupWorkDir();
      await writeFactoryJson({ worker: "haiku" });

      const { invocation } = await launchWorker({ WORKER_MODEL: "opus" });

      expect(invocation).toMatch(/--model opus(\s|$)/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "usa sonnet cuando el proyecto todavía no tiene factory.json",
    async () => {
      workDir = await setupWorkDir();

      const { invocation } = await launchWorker();

      expect(invocation).toMatch(/--model sonnet(\s|$)/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no lee factory-models.json, y avisa que quedó sin uso",
    async () => {
      workDir = await setupWorkDir();
      await writeFile(
        path.join(workDir, "factory-models.json"),
        JSON.stringify({ models: { worker: "opus" } }),
      );

      const { invocation, stderr } = await launchWorker();

      expect(invocation).toMatch(/--model sonnet(\s|$)/);
      expect(stderr).toContain("factory-models.json ya no se lee");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    ["claude-backlog.yml", CLAUDE_BACKLOG_WORKFLOW],
    ["claude-mentions.yml", CLAUDE_MENTIONS_WORKFLOW],
  ])(
    "%s calcula el mismo modelo que process-backlog.sh y se lo pasa al worker",
    async (_name, workflowPath) => {
      workDir = await setupWorkDir();
      await writeFactoryJson({ worker: "haiku" });
      const workflow = await readFile(workflowPath, "utf8");

      // Se ejecuta el paso de verdad, no basta con que el YAML nombre el
      // archivo: un typo en el step pasaría inadvertido.
      const runBlock = extractWorkflowRunBlock(
        workflow,
        "Lee el modelo del worker de factory.json",
      );
      const githubEnvFile = path.join(workDir, "github_env");
      await writeFile(githubEnvFile, "");
      // En la nube, FABRICA apunta al plugin traído por checkout; aquí, a la
      // copia de scripts/lib que deja setupWorkDir.
      const { code } = await runBash(runBlock, workDir, {
        ...process.env,
        FABRICA: toBashPath(workDir),
        GITHUB_ENV: toBashPath(githubEnvFile),
      });

      expect(code).toBe(0);
      expect(await readFile(githubEnvFile, "utf8")).toMatch(
        /^FACTORY_MODEL=haiku$/m,
      );
      expect(workflow).toContain("--model ${{ env.FACTORY_MODEL }}");
      expect(workflow).not.toContain("factory-models.json");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("rama del worker", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  const WORKER_ENV = {
    PERMISSION_MODE: "auto",
    MAX_TURNS: "5",
    WORKER_MODEL: "sonnet",
  };

  async function listBranches(cwd: string): Promise<string[]> {
    const { stdout } = await runBash("git branch --list", cwd, process.env);
    return stdout
      .split("\n")
      .map((line) => line.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
  }

  it(
    "la invocación produce una rama llamada impl-N para el ticket N",
    async () => {
      workDir = await setupWorkDir();
      const { binDir } = await installFakeClaude(workDir);

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ...WORKER_ENV,
        },
      );

      expect(code).toBe(0);
      const branches = await listBranches(workDir);
      expect(branches).toContain("impl-77");
      expect(branches).not.toContain("worktree-impl-77");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "relanzar el mismo ticket no crea una segunda rama con otro nombre",
    async () => {
      workDir = await setupWorkDir();
      const { binDir } = await installFakeClaude(workDir);
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ...WORKER_ENV,
      };
      const runOnce = () =>
        runBash(
          'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
          workDir,
          env,
        );

      await runOnce();
      await runOnce();

      const branches = await listBranches(workDir);
      expect(branches.filter((b) => b.includes("77"))).toEqual(["impl-77"]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "el nombre no depende de si el worktree ya existía",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);
      // Simula una corrida anterior que ya dejó el worktree en disco.
      await runBash(
        "git worktree add .claude/worktrees/impl-77 -b impl-77",
        workDir,
        process.env,
      );

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ...WORKER_ENV,
        },
      );

      expect(code).toBe(0);
      const invocation = await readLog(logFile);
      expect(invocation).not.toBe("");
      const branches = await listBranches(workDir);
      expect(branches.filter((b) => b.includes("77"))).toEqual(["impl-77"]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reutiliza una rama impl-N que quedó de una corrida anterior sin su worktree",
    async () => {
      workDir = await setupWorkDir();
      const { binDir, logFile } = await installFakeClaude(workDir);
      // Simula una rama que sobrevivió a un worktree ya borrado (p. ej. tras
      // un cleanup manual): la rama existe, el directorio no.
      await runBash("git branch impl-77", workDir, process.env);

      const { code } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ...WORKER_ENV,
        },
      );

      expect(code).toBe(0);
      const invocation = await readLog(logFile);
      expect(invocation).not.toBe("");
      const branches = await listBranches(workDir);
      expect(branches.filter((b) => b.includes("77"))).toEqual(["impl-77"]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

// La etiqueta se lee antes de lanzar al worker: si el agente se la pusiera
// él mismo, no cuenta (revisión del 2026-11-23).
describe("auto-merge al terminar", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function decide(
    startLabels: string,
    setup?: (dir: string) => Promise<void>,
  ): Promise<string> {
    workDir = await setupWorkDir();
    const { binDir } = await installFakeGh(workDir);
    await setup?.(workDir);
    const { stdout } = await runBash(
      `source scripts/process-backlog.sh
automerge_issue() { echo "automerge $1"; }
maybe_automerge 42 "${startLabels}"`,
      workDir,
      {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ISSUE_VIEW_JSON: JSON.stringify({ state: "OPEN", labels: [] }),
        PR_LIST_COUNT: "1",
      },
    );
    return stdout;
  }

  it(
    "si la issue tenía auto-merge al empezar, lo pone",
    async () => {
      expect(await decide("pending\nauto-merge")).toMatch(/automerge 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "si no la tenía al empezar, no lo pone aunque la tenga ahora",
    async () => {
      expect(await decide("pending")).not.toMatch(/automerge/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "si el Stop gate se rindió, no lo pone",
    async () => {
      const out = await decide("auto-merge", async (dir) => {
        const factory = path.join(dir, ".claude/worktrees/impl-42/.factory");
        await mkdir(factory, { recursive: true });
        await writeFile(path.join(factory, "gate-gave-up"), "x");
      });
      expect(out).not.toMatch(/automerge/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("worker sin PR", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "etiqueta needs-human, quita el assignee y comenta cuando el worker salió 0 sin dejar PR",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "0",
        },
      );

      expect(code).toBe(0);
      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 42 --add-label needs-human --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 42 --remove-assignee @me/);
      expect(log).toMatch(/project item-edit --id ITEM123.*opt-blocked/);
      expect(log).toMatch(/issue comment 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no toca nada si el worker sí dejó un PR con Closes #N",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "1",
        },
      );

      const log = await readLog(logFile);
      expect(log).not.toMatch(/needs-human/);
      expect(log).not.toMatch(/issue comment 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // El gate se rinde dejando `.factory/gate-gave-up` y prohíbe el PR solo en
  // el texto de las reglas: si el worker lo abre igual, no puede contar como
  // éxito.
  it(
    "si el Stop gate se rindió, va a needs-human aunque haya PR",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);
      const factoryDir = path.join(
        workDir,
        ".claude/worktrees/impl-42/.factory",
      );
      await mkdir(factoryDir, { recursive: true });
      await writeFile(path.join(factoryDir, "gate-gave-up"), "x");

      await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "1",
        },
      );

      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 42 --add-label needs-human --remove-label in-progress/,
      );
      expect(log).toMatch(/issue comment 42 .*Stop gate/s);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no toca nada si gh falla al comprobar si hay PR (falla segura, no falso positivo)",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { stderr } = await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          FAIL_PR_LIST: "1",
        },
      );

      expect(stderr).toMatch(/#42/);
      const log = await readLog(logFile);
      expect(log).not.toMatch(/needs-human/);
      expect(log).not.toMatch(/issue comment 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no toca nada si el worker cerró el issue por idempotencia",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: JSON.stringify({ state: "CLOSED", labels: [] }),
          PR_LIST_COUNT: "0",
        },
      );

      const log = await readLog(logFile);
      expect(log).not.toMatch(/needs-human/);
      expect(log).not.toMatch(/issue comment 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "el comentario nombra el último commit de la rama y cuántos archivos quedaron sin commitear",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const wtDir = path.join(workDir, ".claude/worktrees/impl-42");
      await mkdir(wtDir, { recursive: true });
      await runBash("git init -q", wtDir, process.env);
      await runBash(
        "git config user.email t@t.com && git config user.name t",
        wtDir,
        process.env,
      );
      await writeFile(path.join(wtDir, "a.txt"), "hola");
      await runBash(
        "git add a.txt && git commit -q -m 'trabajo parcial del ticket'",
        wtDir,
        process.env,
      );
      await writeFile(path.join(wtDir, "b.txt"), "sin commitear");

      await runBash(
        "source scripts/process-backlog.sh; ME=tester; check_worker_left_no_pr 42",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "0",
        },
      );

      const log = await readLog(logFile);
      expect(log).toMatch(/trabajo parcial del ticket/);
      expect(log).toMatch(/Archivos sin commitear.*: 1/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "cuando el worker sale distinto de cero, comenta needs-human una sola vez",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        `source scripts/process-backlog.sh
ME=tester
N=9
bash -c 'exit 1' &
WORKER_PID=$!
if wait "$WORKER_PID"; then EXIT_CODE=0; else EXIT_CODE=$?; fi
handle_worker_exit "$N" "$EXIT_CODE"`,
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "0",
        },
      );

      expect(code).toBe(0);
      const log = await readLog(logFile);
      const commentCalls = log
        .split("\n")
        .filter((line) => line.startsWith("issue comment 9 ")).length;
      expect(commentCalls).toBe(1);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

/**
 * #83: `process-backlog.sh` moría en silencio después de que el worker
 * terminaba, sin epílogo ni aviso needs-human. La causa raíz encontrada: el
 * bucle de heartbeat asigna la salida de varios pipelines (`ls`, `find`,
 * `tail`) directamente a variables, sin protegerlas; bajo `set -euo
 * pipefail`, si CUALQUIER etapa de esos pipelines falla (un glob sin match,
 * un archivo de sesión que rota justo cuando se lee), la asignación entera
 * cuenta como un comando fallido y el script aborta sin imprimir nada. La
 * línea `LINES=...` de al lado ya tenía el guardado correcto (`|| echo 0`);
 * estas no lo tenían. Estos tests ejercitan las funciones extraídas
 * directamente, sin esperar los 60 s del `sleep` real del heartbeat.
 */
describe("resiliencia del heartbeat ante fallos de ls/find/tail (#83)", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "latest_session_file no aborta el shell si ningún directorio de sesión matchea",
    async () => {
      workDir = await setupWorkDir();
      const emptyHome = path.join(workDir, "empty-home");
      await mkdir(emptyHome, { recursive: true });

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; latest_session_file 999999; echo "DESPUES:$?"',
        workDir,
        { ...process.env, HOME: emptyHome },
      );

      expect(code).toBe(0);
      expect(stdout).toContain("DESPUES:0");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "latest_touched_file no aborta el shell si el worktree no existe",
    async () => {
      workDir = await setupWorkDir();

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; latest_touched_file /no/existe/de/verdad; echo "DESPUES:$?"',
        workDir,
        process.env,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("DESPUES:0");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "latest_worker_activity no aborta el shell si el archivo de sesión desaparece entre el ls y la lectura",
    async () => {
      workDir = await setupWorkDir();

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; latest_worker_activity /no/existe/sesion.jsonl; echo "DESPUES:$?"',
        workDir,
        process.env,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("DESPUES:0");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "worker_tool_error_count devuelve 0 y no aborta el shell sin sesión",
    async () => {
      workDir = await setupWorkDir();

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; worker_tool_error_count ""; echo "DESPUES:$?"',
        workDir,
        process.env,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("DESPUES:0");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "worker_tool_error_count devuelve un solo 0 limpio, no duplicado, cuando el archivo de sesión no existe",
    async () => {
      workDir = await setupWorkDir();

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; result=$(worker_tool_error_count /no/existe/sesion.jsonl); echo "RESULT=[$result]"',
        workDir,
        process.env,
      );

      expect(code).toBe(0);
      // Con un `tail` que falla (archivo inexistente) pero un `wc -l | tr -d
      // ' '` que igual imprime "0" sobre entrada vacía, un `|| echo 0` mal
      // puesto duplica la salida ("0\n0") en vez de devolver un solo "0": ver
      // #83, donde ese exacto patrón corrompía ERR y rompía la comparación
      // numérica del heartbeat.
      expect(stdout).toContain("RESULT=[0]");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "dirty_file_count devuelve un solo 0 limpio, no duplicado, cuando el worktree no existe",
    async () => {
      workDir = await setupWorkDir();

      const { code, stdout } = await runBash(
        'source scripts/process-backlog.sh; result=$(dirty_file_count /no/existe/de/verdad); echo "RESULT=[$result]"',
        workDir,
        process.env,
      );

      expect(code).toBe(0);
      // Mismo defecto que worker_tool_error_count, reintroducido en la
      // línea FILES= del heartbeat por el propio fix de #83: `git status`
      // falla (worktree inexistente) pero `wc -l | tr -d ' '` igual imprime
      // "0" sobre entrada vacía, y un `|| echo 0` mal puesto duplicaba la
      // salida a "0\n0" en vez de devolver un solo "0".
      expect(stdout).toContain("RESULT=[0]");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

/**
 * #83: incluso arreglado el pipeline sin proteger, nada garantiza que sea
 * el ÚNICO comando capaz de matar el script en silencio; toda la red de
 * seguridad del #69 depende de que el script siga vivo para ejecutarla. Este
 * trap es la red de última instancia: si el script muere por CUALQUIER
 * razón después de lanzar un worker y antes de que su desenlace quede
 * registrado, el ticket no debe quedar colgado en in-progress.
 */
describe("red de seguridad si process-backlog.sh muere tras lanzar el worker (#83)", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "marca needs-human si el script termina sin haber registrado el desenlace del ticket",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=42; ME=tester; WORKER_LAUNCHED=1; safety_net",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(0);
      const log = await readLog(logFile);
      expect(log).toMatch(
        /issue edit 42 --add-label needs-human --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 42 --remove-assignee @me/);
      expect(log).toMatch(/project item-edit --id ITEM123.*opt-blocked/);
      expect(log).toMatch(/issue comment 42/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no hace nada si el ticket ya quedó resuelto (handle_worker_exit ya corrió)",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=42; ME=tester; WORKER_LAUNCHED=1; TICKET_OUTCOME_RECORDED=1; safety_net",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(0);
      const log = await readLog(logFile);
      expect(log).not.toMatch(/needs-human/);
      expect(log).not.toMatch(/issue comment/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no hace nada si todavía no se había lanzado ningún worker",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        "source scripts/process-backlog.sh; N=42; ME=tester; safety_net",
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      );

      expect(code).toBe(0);
      const log = await readLog(logFile);
      expect(log).not.toMatch(/needs-human/);
      expect(log).not.toMatch(/issue comment/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "un fallo inesperado del script tras lanzar el worker activa el trap sin que nadie llame a la red de seguridad a mano",
    async () => {
      workDir = await setupWorkDir();
      await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
      const { binDir, logFile } = await installFakeGh(workDir);

      const { code } = await runBash(
        `source scripts/process-backlog.sh
ME=tester
N=77
WORKER_LAUNCHED=1
trap safety_net EXIT
false`,
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
          PR_LIST_COUNT: "0",
        },
      );

      expect(code).not.toBe(0);
      const log = await readLog(logFile);
      expect(log).toMatch(/issue edit 77 --add-label needs-human/);
      expect(log).toMatch(/issue comment 77/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("rules/fabrica.md", () => {
  it("documenta que el agente también escribe el estado Blocked", async () => {
    const claudeMd = await readFile(pluginFile("rules/fabrica.md"), "utf8");
    const boardRules = claudeMd.slice(claudeMd.indexOf("Board rules:"));

    expect(boardRules).toMatch(/"Blocked"/);
    expect(boardRules).toMatch(/reconcile_board/);
  });

  it("instruye mover la tarjeta a Blocked al parar por un blocker", async () => {
    const claudeMd = await readFile(pluginFile("rules/fabrica.md"), "utf8");
    const blockersStep = claudeMd.slice(
      claudeMd.indexOf("8. **Blockers.**"),
      claudeMd.indexOf("## Skills (load them"),
    );

    expect(claudeMd.indexOf("## Skills (load them")).toBeGreaterThan(-1);
    expect(blockersStep).toMatch(/fabrica-task-status N Blocked/);
  });

  it("instruye mover a Blocked el propio ticket al volver a pending por blocked-by-N", async () => {
    const claudeMd = await readFile(pluginFile("rules/fabrica.md"), "utf8");
    const mainIsBrokenBullet = claudeMd.slice(
      claudeMd.indexOf("**Main is broken"),
      claudeMd.indexOf("**Rebase conflict"),
    );

    expect(mainIsBrokenBullet).toMatch(/blocked-by-<that incident>/);
    expect(mainIsBrokenBullet).toMatch(/return.*to `pending`/s);
    expect(mainIsBrokenBullet).toMatch(/fabrica-task-status N Blocked/);
  });

  it("aplica el mismo Blocked a todos los needs-human de Exceptional situations, no solo a uno", async () => {
    const claudeMd = await readFile(pluginFile("rules/fabrica.md"), "utf8");
    const exceptionalSituations = claudeMd.slice(
      claudeMd.indexOf("## Exceptional situations"),
      claudeMd.indexOf("Board rules:"),
    );
    const blanketSentenceIndex = exceptionalSituations.indexOf(
      "carries the same board update as step 8",
    );

    expect(blanketSentenceIndex).toBeGreaterThan(-1);
    // La frase paraguas debe preceder a las viñetas que cubre: si alguien la
    // borra o la mueve después de "Rebase conflict", esas viñetas vuelven a
    // quedar con needs-human sin ligar a Blocked (el hallazgo original).
    expect(blanketSentenceIndex).toBeLessThan(
      exceptionalSituations.indexOf("Rebase conflict"),
    );
    expect(blanketSentenceIndex).toBeLessThan(
      exceptionalSituations.indexOf("Flaky test"),
    );
    expect(blanketSentenceIndex).toBeLessThan(
      exceptionalSituations.indexOf("Stop gate gave up"),
    );
    expect(blanketSentenceIndex).toBeLessThan(
      exceptionalSituations.indexOf("Integration tests without credentials"),
    );
  });
});

describe("plugin listo antes de lanzar workers", () => {
  // Un worker `claude -p` sin el plugin instalado corre sin Stop gate ni
  // revisores, y no avisa (fase 0 del plan). Por eso se mira antes.
  const PLUGIN_VERSION = (
    JSON.parse(
      readFileSync(
        path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function prepare(projectVersion: string | null): Promise<string> {
    workDir = await setupWorkDir();
    await copyFile(
      pluginFile("scripts/fabrica-setup.sh"),
      path.join(workDir, "scripts/fabrica-setup.sh"),
    );
    if (projectVersion !== null) {
      await mkdir(path.join(workDir, ".factory"), { recursive: true });
      await writeFile(
        path.join(workDir, ".factory/version"),
        `${projectVersion}\n`,
      );
    }
    // El worker trabaja sobre el último commit: lo instalado va commiteado.
    await runBash(
      "git add -A && git commit -q -m fabrica",
      workDir,
      process.env,
    );
    const binDir = path.join(workDir, "stub-bin");
    await mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");
    await writeFile(
      claudePath,
      `#!/usr/bin/env bash
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' "$PLUGIN_LIST_JSON"
  exit 0
fi
exit 0
`,
    );
    await chmod(claudePath, 0o755);
    // Cargar el script pregunta `gh api user`: sin este gh, el test saldría
    // a GitHub de verdad.
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(ghPath, 0o755);
    return binDir;
  }

  async function check(binDir: string, pluginList: unknown) {
    return runBash(
      "source scripts/process-backlog.sh; check_plugin_ready",
      workDir,
      {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        FABRICA_PLUGIN_ROOT: toBashPath(PLUGIN_ROOT),
        PLUGIN_LIST_JSON: JSON.stringify(pluginList),
      },
    );
  }

  const installed = (overrides: Record<string, unknown> = {}) => ({
    id: "fabrica@fabrica-local",
    version: PLUGIN_VERSION,
    scope: "project",
    enabled: true,
    ...overrides,
  });

  it(
    "pasa con el plugin instalado, habilitado y en la versión del proyecto",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);

      const { code, stderr } = await check(binDir, [installed()]);

      expect(code, stderr).toBe(0);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "para y da el comando de instalación cuando el plugin no está instalado",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);

      const { code, stderr } = await check(binDir, [
        { id: "otro@otro-marketplace", version: "0.7.1", enabled: true },
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/claude plugin install fabrica@/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "para cuando el plugin está instalado pero deshabilitado",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);

      const { code, stderr } = await check(binDir, [
        installed({ enabled: false }),
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/deshabilitado/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "para cuando el plugin instalado es de otra versión",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);

      const { code, stderr } = await check(binDir, [
        installed({ version: "0.0.9" }),
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toContain("0.0.9");
      expect(stderr).toContain(PLUGIN_VERSION);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "para cuando el proyecto no está al día con el plugin",
    async () => {
      const binDir = await prepare("0.0.1");

      const { code, stderr } = await check(binDir, [installed()]);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/fabrica-setup refresh/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "para cuando la configuración de la fábrica no está commiteada, porque el worker no la vería",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);
      await writeFile(path.join(workDir, "factory.json"), "{}\n");
      await runBash(
        "git add factory.json && git commit -q -m factory",
        workDir,
        process.env,
      );
      await writeFile(path.join(workDir, "factory.json"), '{"stack": "go"}\n');
      await mkdir(path.join(workDir, ".claude"), { recursive: true });
      await writeFile(
        path.join(workDir, ".claude/settings.json"),
        '{"enabledPlugins": {"fabrica@fabrica-local": true}}\n',
      );

      const { code, stderr } = await check(binDir, [installed()]);

      expect(code).not.toBe(0);
      expect(stderr).toContain("factory.json");
      expect(stderr).toContain(".claude/settings.json");
      expect(stderr).toMatch(/commit/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // `claude plugin install --scope project` reescribe settings.json con las
  // claves en otro orden: mismo contenido, otro texto. Dentro del dev
  // container eso frenaba la fábrica (fabrica-prueba, 2026-11-23).
  it(
    "no para por un .json con el mismo contenido en otro orden o con otro formato",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);
      await mkdir(path.join(workDir, ".claude"), { recursive: true });
      await writeFile(
        path.join(workDir, ".claude/settings.json"),
        '{\n  "enabledPlugins": {"fabrica@fabrica-local": true},\n  "attribution": {"commit": ""}\n}\n',
      );
      await runBash(
        "git add .claude/settings.json && git commit -q -m settings",
        workDir,
        process.env,
      );
      await writeFile(
        path.join(workDir, ".claude/settings.json"),
        '{"attribution": {"commit": ""}, "enabledPlugins": {"fabrica@fabrica-local": true}}\n',
      );

      const { code, stderr } = await check(binDir, [installed()]);

      expect(code, stderr).toBe(0);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "con remoto, para si la configuración está commiteada pero no subida: el worktree sale de origin",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);
      const origin = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-origin`),
      );
      await runBash(
        `set -e
         git init -q --bare "${origin}"
         git remote add origin "${origin}"
         git push -q origin HEAD:main
         git fetch -q origin
         echo '{}' > factory.json
         git add factory.json && git commit -q -m factory`,
        workDir,
        process.env,
      );

      const { code, stderr } = await check(binDir, [installed()]);

      await rm(origin, REMOVE_TEMP_DIR_OPTIONS);
      expect(code).not.toBe(0);
      expect(stderr).toContain("factory.json");
      expect(stderr).toMatch(/origin\/main/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "si la copia local está atrás de origin, pide pull y no commit",
    async () => {
      const binDir = await prepare(PLUGIN_VERSION);
      const origin = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-origin`),
      );
      const other = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-other`),
      );
      const prepared = await runBash(
        `set -e
         git init -q --bare -b main "${origin}"
         git remote add origin "${origin}"
         git push -q origin HEAD:main
         git clone -q "${origin}" "${other}"
         cd "${other}"
         git config user.email t@t.com && git config user.name t
         echo '{"stack": "go"}' > factory.json
         git add factory.json && git commit -q -m factory && git push -q origin HEAD:main`,
        workDir,
        process.env,
      );
      expect(prepared.code, prepared.stderr).toBe(0);

      const { code, stderr } = await check(binDir, [installed()]);

      await rm(origin, REMOVE_TEMP_DIR_OPTIONS);
      await rm(other, REMOVE_TEMP_DIR_OPTIONS);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/git pull/);
      expect(stderr).not.toMatch(/Haz commit/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("bypassPermissions solo en un contenedor", () => {
  // Sin preguntar nada, un worker puede borrar o mandar a la red lo que sea.
  // Eso solo es aceptable en un contenedor desechable con el firewall arriba.
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "fabrica-backlog se niega a correr con bypassPermissions fuera de un contenedor",
    async () => {
      workDir = await setupWorkDir();
      const { binDir } = await installFakeGh(workDir);
      const claude = await installFakeClaude(workDir);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${claude.binDir}${path.delimiter}${process.env.PATH}`,
        PERMISSION_MODE: "bypassPermissions",
      };
      delete env.DEVCONTAINER;

      const { code, stderr } = await runBash(
        "bash scripts/process-backlog.sh",
        workDir,
        env,
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/contenedor/);
      expect(await readLog(claude.logFile)).toBe("");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Un contenedor cualquiera, o uno cuyo firewall falló al arrancar, deja la
  // red abierta (revisión del 2026-11-23). init-firewall.sh deja la marca al
  // final, y la red se prueba en el momento.
  async function bypassInContainer(
    mark: boolean,
    reachable: boolean,
  ): Promise<{ code: number | null; stderr: string }> {
    workDir = await setupWorkDir();
    const { binDir } = await installFakeGh(workDir);
    const claude = await installFakeClaude(workDir);
    await writeFile(
      path.join(binDir, "curl"),
      `#!/usr/bin/env bash\nexit ${reachable ? 0 : 7}\n`,
    );
    await chmod(path.join(binDir, "curl"), 0o755);
    const markFile = path.join(workDir, "fabrica-firewall-ok");
    if (mark) await writeFile(markFile, "");
    return runBash("bash scripts/process-backlog.sh", workDir, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${claude.binDir}${path.delimiter}${process.env.PATH}`,
      PERMISSION_MODE: "bypassPermissions",
      DEVCONTAINER: "true",
      FABRICA_FIREWALL_MARK: markFile,
    });
  }

  it(
    "dentro de un contenedor, se niega si el firewall no dejó su marca",
    async () => {
      const { code, stderr } = await bypassInContainer(false, false);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/firewall/);
      // Un .devcontainer/ de antes de la 0.5.0 nunca deja la marca: correr su
      // firewall otra vez no sirve, hay que regenerarlo.
      expect(stderr).toMatch(/fabrica-devcontainer --force/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "dentro de un contenedor, se niega si la red deja salir a example.com",
    async () => {
      const { code, stderr } = await bypassInContainer(true, true);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/example\.com/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "con la marca y la red cerrada, la guarda deja pasar",
    async () => {
      const { stderr } = await bypassInContainer(true, false);

      expect(stderr).not.toMatch(/firewall|contenedor|example\.com/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

// El worker de #6 se cortó a los 6 min por el límite de uso de la cuenta y
// fabrica-backlog lo trató como una falla: needs-human y la tarjeta en
// Blocked (truckconnect-mobile, 2026-11-26). Un límite no lo resuelve una
// persona: la issue vuelve a la cola y el lote para.
describe("límite de uso de la cuenta", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  const LIMIT =
    "You've hit your 5-hour limit · resets 5:30pm (Australia/Melbourne)";

  async function exitWith(output: string) {
    workDir = await setupWorkDir();
    await writeProjectConfig(workDir, FULL_STATUS_OPTIONS);
    const { binDir, logFile } = await installFakeGh(workDir);
    await mkdir(path.join(workDir, ".claude/worktrees"), { recursive: true });
    await writeFile(
      path.join(workDir, ".claude/worktrees/impl-42.log"),
      output,
    );
    const result = await runBash(
      'source scripts/process-backlog.sh; ME=tester; handle_worker_exit 42 1; echo "LIMIT=${USAGE_LIMIT_HIT:-}"',
      workDir,
      {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ISSUE_VIEW_JSON: OPEN_IN_PROGRESS_ISSUE,
      },
    );
    return { ...result, log: await readLog(logFile) };
  }

  it(
    "devuelve la issue a la cola, sin needs-human, y dice cuándo se reinicia",
    async () => {
      const { stdout, log } = await exitWith(`${LIMIT}\n`);

      expect(log).toMatch(
        /issue edit 42 --add-label pending --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 42 --remove-assignee @me/);
      expect(log).toMatch(/project item-edit --id ITEM123.*opt-todo/);
      expect(log).not.toMatch(/needs-human/);
      expect(log).toMatch(/issue comment 42 .*límite de uso/s);
      expect(stdout).toContain(`LIMIT=${LIMIT}`);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reconoce también el aviso viejo de la API",
    async () => {
      const { log } = await exitWith(
        "Claude AI usage limit reached|1764140400\n",
      );

      expect(log).not.toMatch(/needs-human/);
      expect(log).toMatch(/--add-label pending/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "un resumen que solo cita el aviso a mitad de línea sigue siendo una falla",
    async () => {
      const { stdout, log } = await exitWith(
        `The banner now shows "${LIMIT}" to the driver.\n`,
      );

      expect(log).toMatch(/--add-label needs-human/);
      expect(stdout).toContain("LIMIT=\n");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "run_worker guarda la salida del worker junto a su worktree y le dice que la issue ya está reclamada",
    async () => {
      workDir = await setupWorkDir();
      const binDir = path.join(workDir, "stub-bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bash\necho "resumen final"\necho "reclamada=\${FABRICA_CLAIMED:-}" >&2\nexit 3\n`,
      );
      await chmod(path.join(binDir, "claude"), 0o755);

      const { stdout } = await runBash(
        'source scripts/process-backlog.sh; run_worker 77; wait "$WORKER_PID" || echo "salida=$?"',
        workDir,
        {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          PERMISSION_MODE: "auto",
          WORKER_MODEL: "sonnet",
        },
      );

      expect(stdout).toContain("salida=3");
      const saved = await readFile(
        path.join(workDir, ".claude/worktrees/impl-77.log"),
        "utf8",
      );
      expect(saved).toContain("resumen final");
      expect(saved).toContain("reclamada=77");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

// Hallazgos de truckconnect-mobile (2026-11-26) que viven en las reglas.
describe("rules/fabrica.md después de truckconnect-mobile", () => {
  const rules = () => readFileSync(pluginFile("rules/fabrica.md"), "utf8");
  const section = (from: string, to: string) => {
    const text = rules();
    const start = text.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf(to, start));
  };

  // #16: devuelta a la cola, el worker vio el PR y paró.
  it("un PR abierto de la issue no la da por hecha", () => {
    const check = section("2. **Already-done check", "3. **Claim**");

    expect(check).toMatch(/open PR/);
    expect(check).toMatch(/fabrica-claim N/);
    expect(check).toMatch(/not done/);
  });

  // #16: la sesión cambió el código después del APPROVED y no volvió a
  // pasar el revisor.
  it("un cambio después del APPROVED pide otra ronda", () => {
    const review = section("5. **Review**", "6. **Check the boxes**");

    expect(review).toMatch(/APPROVED.*covers the commit it reviewed/s);
    expect(review).toMatch(/new round/);
  });

  // #5, #8, #16: nada detrás del login se veía en web ni en el emulador.
  it("las pruebas de una app con login entran con una sesión de prueba", () => {
    const login = section("### Apps with sign-in", "## Workflow: TDD first");

    expect(login).toMatch(/Playwright/);
    expect(login).toMatch(/native/i);
    expect(login).toMatch(/dev build|development build/);
    expect(login).toMatch(/production/);
  });
});
