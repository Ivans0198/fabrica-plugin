import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const HOOK_SCRIPT = pluginFile(".claude/hooks/post-edit-lint.sh");

/** Lanzan bash y node de verdad: ver el mismo comentario en stop-gate.test.ts. */
const REAL_PROCESS_TEST_TIMEOUT_MS = 20_000;

const REMOVE_TEMP_DIR_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

function isJqInstalled(): boolean {
  return spawnSync("bash", ["-c", "command -v jq"]).status === 0;
}

const READERS = isJqInstalled() ? ["node", "jq"] : ["node"];

interface HookResult {
  code: number | null;
}

function runHook(
  cwd: string,
  input: object,
  env: NodeJS.ProcessEnv,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [HOOK_SCRIPT], {
      cwd,
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe.each(READERS)("hook de formato (lector: %s)", (reader) => {
  let workDir = "";
  let helperDir = "";

  afterEach(async () => {
    for (const dir of [workDir, helperDir]) {
      if (dir) await rm(dir, REMOVE_TEMP_DIR_OPTIONS);
    }
    workDir = "";
    helperDir = "";
  });

  /**
   * Proyecto con dos reglas de formato que en vez de formatear anotan con qué
   * los llamaron: "fmt" para .ts y .md, "fix" solo para .ts.
   */
  async function prepare(options: { withConfig: boolean }): Promise<{
    logFile: string;
  }> {
    workDir = await mkdtemp(path.join(tmpdir(), "seadragons-post-edit-"));
    helperDir = await mkdtemp(path.join(tmpdir(), "seadragons-post-edit-rec-"));
    const logFile = path.join(helperDir, "calls.log");
    const recorder = path.join(helperDir, "record.js");
    await writeFile(
      recorder,
      `require("fs").appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    if (options.withConfig) {
      await writeFile(
        path.join(workDir, "factory.json"),
        JSON.stringify({
          stack: "node-ts",
          commands: {},
          format: [
            { extensions: ["ts", "md"], cmd: ["node", recorder, "fmt"] },
            { extensions: ["ts"], cmd: ["node", recorder, "fix"] },
          ],
        }),
      );
    }
    return { logFile };
  }

  async function editedFile(relativePath: string): Promise<string> {
    const filePath = path.join(workDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "contenido\n");
    return filePath;
  }

  async function recordedCalls(logFile: string): Promise<string[][]> {
    try {
      const text = await readFile(logFile, "utf8");
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  }

  function runEditHook(filePath: string): Promise<HookResult> {
    return runHook(
      workDir,
      { tool_name: "Edit", tool_input: { file_path: filePath } },
      {
        ...process.env,
        FACTORY_JSON_READER: reader,
        CLAUDE_PROJECT_DIR: workDir,
      },
    );
  }

  it(
    "corre cada regla que aplica a la extensión, en orden, con el archivo al final",
    async () => {
      const { logFile } = await prepare({ withConfig: true });
      const file = await editedFile("src/foo.ts");

      const { code } = await runEditHook(file);

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([
        ["fmt", file],
        ["fix", file],
      ]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // claude-mentions.yml lo apaga en el PR de alguien sin escritura: ahí el
  // factory.json y lo que sus comandos cargan vienen de la rama del PR.
  it(
    "con FACTORY_LINT=off no corre ninguna regla",
    async () => {
      const { logFile } = await prepare({ withConfig: true });
      const file = await editedFile("src/foo.ts");

      const { code } = await runHook(
        workDir,
        { tool_name: "Edit", tool_input: { file_path: file } },
        {
          ...process.env,
          FACTORY_JSON_READER: reader,
          CLAUDE_PROJECT_DIR: workDir,
          FACTORY_LINT: "off",
        },
      );

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "corre solo las reglas de la extensión del archivo",
    async () => {
      const { logFile } = await prepare({ withConfig: true });
      const file = await editedFile("README.md");

      await runEditHook(file);

      expect(await recordedCalls(logFile)).toEqual([["fmt", file]]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no toca un archivo sin regla para su extensión",
    async () => {
      const { logFile } = await prepare({ withConfig: true });
      const file = await editedFile("main.py");

      const { code } = await runEditHook(file);

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each(["specs/001-login/spec.md", ".specify/templates/plan-template.md"])(
    "no formatea los documentos de Spec Kit (%s)",
    async (relativePath) => {
      // Los scripts de Spec Kit leen esos archivos con su formato exacto: un
      // formateador que los reescribe los puede romper.
      const { logFile } = await prepare({ withConfig: true });
      const file = await editedFile(relativePath);

      await runEditHook(file);

      expect(await recordedCalls(logFile)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no hace nada en un repo sin factory.json",
    async () => {
      const { logFile } = await prepare({ withConfig: false });
      const file = await editedFile("src/foo.ts");

      const { code } = await runEditHook(file);

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "sale 0 aunque factory.json esté roto: el que avisa es el Stop gate",
    async () => {
      await prepare({ withConfig: false });
      await writeFile(path.join(workDir, "factory.json"), "{ roto");
      const file = await editedFile("src/foo.ts");

      const { code } = await runEditHook(file);

      expect(code).toBe(0);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
