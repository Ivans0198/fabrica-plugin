import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const FACTORY_CONFIG_LIB = pluginFile("scripts/lib/factory-config.sh")
  .replace(/\\/g, "/");

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

interface ModelResult {
  model: string;
  warning: string;
}

function readModel(
  cwd: string,
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<ModelResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        `source "${FACTORY_CONFIG_LIB}"; factory_read_model "$1" sonnet`,
        "_",
        key,
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ model: stdout.trim(), warning: stderr }));
  });
}

describe.each(READERS)("factory_read_model (lector: %s)", (reader) => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function projectWith(config: unknown): Promise<void> {
    workDir = await mkdtemp(path.join(tmpdir(), "seadragons-factory-model-"));
    if (config !== undefined) {
      await writeFile(
        path.join(workDir, "factory.json"),
        typeof config === "string" ? config : JSON.stringify(config),
      );
    }
  }

  function run(key: string): Promise<ModelResult> {
    return readModel(workDir, key, {
      ...process.env,
      FACTORY_JSON_READER: reader,
    });
  }

  it(
    "devuelve el modelo de models.<clave>",
    async () => {
      await projectWith({ models: { worker: "haiku", codeReviewer: "opus" } });

      expect(await run("worker")).toEqual({ model: "haiku", warning: "" });
      expect((await run("codeReviewer")).model).toBe("opus");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "acepta un ID completo de modelo",
    async () => {
      await projectWith({ models: { worker: "claude-sonnet-5-5" } });

      expect((await run("worker")).model).toBe("claude-sonnet-5-5");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "usa el valor por defecto sin avisar cuando no hay factory.json (plantilla sin bootstrap)",
    async () => {
      await projectWith(undefined);

      expect(await run("worker")).toEqual({ model: "sonnet", warning: "" });
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "usa el valor por defecto y lo dice cuando falta la clave",
    async () => {
      await projectWith({ commands: {} });

      const { model, warning } = await run("worker");

      expect(model).toBe("sonnet");
      expect(warning).toContain("models.worker");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "con espacios, que metería argumentos",
      "opus --dangerously-skip-permissions",
    ],
    ["con salto de línea, que metería variables en GITHUB_ENV", "opus\nEVIL=1"],
    ["vacío", ""],
    ["que no es texto", 5],
  ])(
    "rechaza un valor %s",
    async (_description, value) => {
      await projectWith({ models: { worker: value } });

      const { model, warning } = await run("worker");

      expect(model).toBe("sonnet");
      expect(warning).toContain("models.worker");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "usa el valor por defecto y lo dice cuando factory.json no es JSON válido",
    async () => {
      await projectWith("{ roto");

      const { model, warning } = await run("worker");

      expect(model).toBe("sonnet");
      expect(warning).toContain("factory.json");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "avisa que factory-models.json ya no se lee",
    async () => {
      await projectWith({ models: { worker: "haiku" } });
      await writeFile(
        path.join(workDir, "factory-models.json"),
        JSON.stringify({ models: { worker: "opus" } }),
      );

      const { model, warning } = await run("worker");

      expect(model).toBe("haiku");
      expect(warning).toContain("factory-models.json ya no se lee");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
