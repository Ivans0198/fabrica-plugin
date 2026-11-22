import { spawn } from "node:child_process";
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
 * Un PR de la fábrica puede chocar con `main` después de abierto, cuando se
 * mergea otro. Nadie le hace rebase, y resolverlo solo es arriesgado: el
 * merge a mano del #19 de fabrica-prueba pasó los tests y estaba mal. Así que
 * la fábrica solo avisa: etiqueta el PR y comenta una vez.
 */

const SCRIPT = pluginFile("scripts/flag-conflicts.sh");
const LABEL = "merge-conflict";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Pr {
  number: number;
  headRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  labels?: string[];
}

let workDir = "";

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = "";
  }
});

/**
 * `gh` de mentira: registra cada llamada y responde a `pr list` con la
 * respuesta número k de `responses` (la última se repite), para simular que
 * GitHub todavía no calculó si un PR se puede mergear. El --jq lo pasa por
 * jq de verdad, como haría gh.
 */
async function run(
  responses: Pr[][],
  env: Record<string, string> = {},
): Promise<RunResult & { log: string[]; lists: number }> {
  workDir = await mkdtemp(path.join(tmpdir(), "fabrica-flag-conflicts-"));
  const binDir = path.join(workDir, "bin");
  await mkdir(binDir);
  const logFile = path.join(workDir, "gh.log");
  const countFile = path.join(workDir, "count");
  await writeFile(logFile, "");
  await writeFile(countFile, "0");
  for (const [i, prs] of responses.entries()) {
    const json = prs.map((pr) => ({
      ...pr,
      labels: (pr.labels ?? []).map((name) => ({ name })),
    }));
    await writeFile(
      path.join(workDir, `list-${i + 1}.json`),
      JSON.stringify(json),
    );
  }
  const last = responses.length;
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logFile}"
if [ "$1 $2" = "pr list" ]; then
  n=$(( $(cat "${countFile}") + 1 )); echo "$n" > "${countFile}"
  [ "$n" -le ${last} ] || n=${last}
  filter=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--jq" ]; then filter="$2"; fi
    shift
  done
  jq -r "$filter" "${workDir}/list-$n.json"
  exit 0
fi
if [ "$1 $2" = "pr edit" ] && [ "$3" = "\${FAIL_PR:-}" ]; then
  echo "gh: no se pudo editar $3" >&2
  exit 1
fi
exit 0
`,
  );
  await chmod(path.join(binDir, "gh"), 0o755);

  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        FABRICA_CONFLICT_WAIT: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const log = (await readFile(logFile, "utf8")).split("\n").filter(Boolean);
  const lists = Number(await readFile(countFile, "utf8"));
  return { ...result, log, lists };
}

function writes(log: string[]): string[] {
  return log.filter((line) => !line.startsWith("pr list"));
}

describe("flag-conflicts", () => {
  it("etiqueta y comenta una vez un PR de la fábrica que choca con main", async () => {
    const { code, log, stdout } = await run([
      [{ number: 31, headRefName: "impl-27", mergeable: "CONFLICTING" }],
    ]);

    expect(code).toBe(0);
    expect(log.some((l) => l.startsWith(`label create ${LABEL}`))).toBe(true);
    expect(log).toContain(`pr edit 31 --add-label ${LABEL}`);
    const comment = log.find((l) => l.startsWith("pr comment 31"));
    expect(comment).toMatch(/choca con/);
    expect(comment).not.toMatch(/@claude/);
    expect(stdout).toMatch(/#31/);
  });

  it("no vuelve a comentar un PR que ya tiene la etiqueta", async () => {
    const { code, log } = await run([
      [
        {
          number: 31,
          headRefName: "impl-27",
          mergeable: "CONFLICTING",
          labels: [LABEL],
        },
      ],
    ]);

    expect(code).toBe(0);
    expect(writes(log)).toEqual([]);
  });

  it("quita la etiqueta cuando el PR vuelve a poder mergearse, sin comentar", async () => {
    const { log } = await run([
      [
        {
          number: 31,
          headRefName: "impl-27",
          mergeable: "MERGEABLE",
          labels: ["pending", LABEL],
        },
      ],
    ]);

    expect(writes(log)).toEqual([`pr edit 31 --remove-label ${LABEL}`]);
  });

  it("no toca un PR sin conflicto y sin etiqueta", async () => {
    const { log } = await run([
      [{ number: 31, headRefName: "impl-27", mergeable: "MERGEABLE" }],
    ]);

    expect(writes(log)).toEqual([]);
  });

  it("también avisa en el PR de una spec", async () => {
    const { log } = await run([
      [{ number: 23, headRefName: "spec-22", mergeable: "CONFLICTING" }],
    ]);

    expect(log).toContain(`pr edit 23 --add-label ${LABEL}`);
  });

  it("deja en paz los PRs que no son de la fábrica", async () => {
    const { log } = await run([
      [
        { number: 40, headRefName: "mi-arreglo", mergeable: "CONFLICTING" },
        { number: 41, headRefName: "impl-7-viejo", mergeable: "CONFLICTING" },
      ],
    ]);

    expect(writes(log)).toEqual([]);
  });

  it("espera a que GitHub calcule si se puede mergear", async () => {
    const { log, lists } = await run([
      [{ number: 31, headRefName: "impl-27", mergeable: "UNKNOWN" }],
      [{ number: 31, headRefName: "impl-27", mergeable: "CONFLICTING" }],
    ]);

    expect(lists).toBe(2);
    expect(log).toContain(`pr edit 31 --add-label ${LABEL}`);
  });

  it("se rinde sin tocar nada si GitHub nunca lo calcula", async () => {
    const { code, log, lists, stdout } = await run(
      [[{ number: 31, headRefName: "impl-27", mergeable: "UNKNOWN" }]],
      { FABRICA_CONFLICT_TRIES: "3" },
    );

    expect(code).toBe(0);
    expect(lists).toBe(3);
    expect(writes(log)).toEqual([]);
    expect(stdout).toMatch(/#31/);
  });

  it("sigue con los demás si uno falla, y sale con error", async () => {
    const { code, log } = await run(
      [
        [
          { number: 31, headRefName: "impl-27", mergeable: "CONFLICTING" },
          { number: 32, headRefName: "impl-28", mergeable: "CONFLICTING" },
        ],
      ],
      { FAIL_PR: "31" },
    );

    expect(code).not.toBe(0);
    expect(log).toContain(`pr edit 32 --add-label ${LABEL}`);
    expect(log.some((l) => l.startsWith("pr comment 31"))).toBe(false);
  });
});
