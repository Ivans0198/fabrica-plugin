import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const FACTORY_CMD_SCRIPT = pluginFile("scripts/factory-cmd.sh");

/** Lanzan bash y node de verdad: ver el mismo comentario en stop-gate.test.ts. */
const REAL_PROCESS_TEST_TIMEOUT_MS = 20_000;

const REMOVE_TEMP_DIR_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

const CONFIG_ERROR_EXIT = 4;

function isJqInstalled(): boolean {
  return spawnSync("bash", ["-c", "command -v jq"]).status === 0;
}

const READERS = isJqInstalled() ? ["node", "jq"] : ["node"];

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFactoryCmd(
  cwd: string,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [FACTORY_CMD_SCRIPT, name], {
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

describe.each(READERS)("factory-cmd.sh (lector: %s)", (reader) => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function projectWith(commands: Record<string, unknown>): Promise<void> {
    workDir = await mkdtemp(path.join(tmpdir(), "seadragons-factory-cmd-"));
    await writeFile(
      path.join(workDir, "factory.json"),
      JSON.stringify({ stack: "node-ts", commands, format: [] }),
    );
  }

  function run(name: string): Promise<CommandResult> {
    return runFactoryCmd(workDir, name, {
      ...process.env,
      FACTORY_JSON_READER: reader,
    });
  }

  it(
    "pasa cada elemento de la lista como un argumento, sin interpretarlo",
    async () => {
      await projectWith({
        test: [
          "node",
          "-e",
          "console.log(JSON.stringify(process.argv.slice(1)))",
          "dos palabras",
          "$(echo inyectado)",
          "*",
        ],
      });

      const { code, stdout } = await run("test");

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        "dos palabras",
        "$(echo inyectado)",
        "*",
      ]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "sale con el código del comando",
    async () => {
      await projectWith({ test: ["node", "-e", "process.exit(7)"] });

      const { code } = await run("test");

      expect(code).toBe(7);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "sale 0 y lo dice cuando el comando está en null",
    async () => {
      await projectWith({ build: null });

      const { code, stdout } = await run("build");

      expect(code).toBe(0);
      expect(stdout).toContain("commands.build está en null");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "falla diciendo qué clave falta",
    async () => {
      await projectWith({ test: ["true"] });

      const { code, stderr } = await run("lint");

      expect(code).toBe(CONFIG_ERROR_EXIT);
      expect(stderr).toContain("falta commands.lint");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "falla cuando el comando es un texto en vez de una lista",
    async () => {
      await projectWith({ test: "npm test" });

      const { code, stderr } = await run("test");

      expect(code).toBe(CONFIG_ERROR_EXIT);
      expect(stderr).toContain("commands.test tiene que ser null o una lista");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("factory-cmd.sh sin factory.json", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  it(
    "falla pidiendo el bootstrap",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-factory-cmd-"));

      const { code, stderr } = await runFactoryCmd(
        workDir,
        "test",
        process.env,
      );

      expect(code).toBe(CONFIG_ERROR_EXIT);
      expect(stderr).toContain("bootstrap");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
