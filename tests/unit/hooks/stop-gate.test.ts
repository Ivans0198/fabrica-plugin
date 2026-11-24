import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const STOP_GATE_SCRIPT = pluginFile(".claude/hooks/stop-gate.sh");
const SESSION_START_SCRIPT = pluginFile(".claude/hooks/session-start.sh");
const FORMAT_HOOK_SCRIPT = pluginFile(".claude/hooks/post-edit-lint.sh");

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

/** Dónde deja el gate su contador de bloqueos, relativo al checkout. */
const COUNTER_FILE = ".factory/state/stop-gate-count";

type CommandList = readonly string[] | null;
type Commands = Record<string, CommandList>;

/** Las seis claves que el gate exige, todas apagadas. */
const ALL_COMMANDS_OFF: Commands = {
  install: null,
  lint: null,
  typecheck: null,
  test: null,
  build: null,
  e2e: null,
};

function factoryJson(commands: Commands, extra: object = {}): string {
  return JSON.stringify({
    stack: "node-ts",
    commands: { ...ALL_COMMANDS_OFF, ...commands },
    format: [],
    ...extra,
  });
}

interface RunResult {
  code: number | null;
  stderr: string;
}

function runStopGate(
  cwd: string,
  env: NodeJS.ProcessEnv,
  hookInput?: object,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [STOP_GATE_SCRIPT], {
      cwd,
      env,
      stdio: [hookInput ? "pipe" : "ignore", "ignore", "pipe"],
    });
    if (hookInput) {
      child.stdin!.end(JSON.stringify(hookInput));
    }
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Un `npx` de mentira: no instala nada, solo reporta si eslint "falló". */
async function installFakeEslintRunner(
  cwd: string,
  shouldFail: boolean,
): Promise<string> {
  const binDir = path.join(cwd, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const npxPath = path.join(binDir, "npx");
  const calledMarker = path.join(cwd, "npx-was-called");
  await writeFile(
    npxPath,
    `#!/usr/bin/env bash\ntouch "${calledMarker.replace(/\\/g, "/")}"\nif [ "$1" = "eslint" ]; then\n  exit ${shouldFail ? 1 : 0}\nfi\nexit 0\n`,
  );
  await chmod(npxPath, 0o755);
  return binDir;
}

describe("stop gate", () => {
  let workDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
  });

  async function prepareFailingLint(): Promise<string> {
    workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
    await writeFile(
      path.join(workDir, "factory.json"),
      factoryJson({ lint: ["npx", "eslint", "."] }),
    );
    return installFakeEslintRunner(workDir, true);
  }

  it(
    "sale 0 y no ejecuta ningún check cuando FACTORY_GATE=off",
    async () => {
      const binDir = await prepareFailingLint();

      const { code } = await runStopGate(workDir, {
        ...process.env,
        FACTORY_GATE: "off",
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      await expect(
        readFile(path.join(workDir, "npx-was-called")),
      ).rejects.toThrow();
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea con código 2 cuando la variable no está y el lint falla",
    async () => {
      const binDir = await prepareFailingLint();

      const { code } = await runStopGate(workDir, {
        ...process.env,
        FACTORY_GATE: undefined,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(2);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea tantas veces como ciclos de corrección dan las reglas, y después se rinde",
    async () => {
      const rules = await readFile(pluginFile("rules/fabrica.md"), "utf8");
      const budget = Number(rules.match(/Budget: (\d+) correction cycles/)![1]);
      const binDir = await prepareFailingLint();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };
      delete env.FACTORY_GATE;
      delete env.MAX_GATE_RUNS;

      const codes: Array<number | null> = [];
      for (let run = 0; run <= budget; run++) {
        codes.push((await runStopGate(workDir, env)).code);
      }

      expect(codes).toEqual([...Array(budget).fill(2), 0]);
      await expect(
        readFile(path.join(workDir, ".factory/gate-gave-up"), "utf8"),
      ).resolves.toBeTruthy();
    },
    REAL_PROCESS_TEST_TIMEOUT_MS * 2,
  );

  it(
    "verifica el proyecto aunque la sesión esté parada en una subcarpeta",
    async () => {
      const binDir = await prepareFailingLint();
      const subdir = path.join(workDir, "src");
      await mkdir(subdir, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: workDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };
      delete env.FACTORY_GATE;

      const { code } = await runStopGate(subdir, env);

      expect(code).toBe(2);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // EnterWorktree muda la sesión a .claude/worktrees/impl-N, pero
  // CLAUDE_PROJECT_DIR sigue en la raíz: solo el cwd de la entrada del hook
  // dice dónde está el trabajo (probado en fabrica-prueba, 2026-11-16).
  it(
    "verifica el worktree en el que trabaja la sesión aunque CLAUDE_PROJECT_DIR sea la raíz",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
      const root = path.join(workDir, "root");
      const worktree = path.join(root, ".claude/worktrees/impl-1");
      await mkdir(worktree, { recursive: true });
      spawnSync("git", ["init", "-q", root]);
      spawnSync("git", ["init", "-q", worktree]);
      await writeFile(
        path.join(worktree, "factory.json"),
        factoryJson({ lint: ["npx", "eslint", "."] }),
      );
      const binDir = await installFakeEslintRunner(workDir, true);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };
      delete env.FACTORY_GATE;

      const { code } = await runStopGate(root, env, { cwd: worktree });

      expect(code).toBe(2);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // En Windows CLAUDE_PROJECT_DIR llega con barras invertidas (C:\...) y git
  // contesta C:/...: no coincidían, el gate entraba a la raíz sin factory.json
  // y pasaba sin verificar el worktree. Lo mismo con una barra al final.
  it.each([
    ["con barra al final", (root: string) => `${root}/`],
    ["con barras invertidas", (root: string) => root.replace(/\//g, "\\")],
  ])(
    "reconoce el worktree con CLAUDE_PROJECT_DIR %s",
    async (_name, spell) => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
      const root = path.join(workDir, "root");
      const worktree = path.join(root, ".claude/worktrees/impl-1");
      await mkdir(worktree, { recursive: true });
      spawnSync("git", ["init", "-q", root]);
      spawnSync("git", ["init", "-q", worktree]);
      await writeFile(
        path.join(worktree, "factory.json"),
        factoryJson({ lint: ["npx", "eslint", "."] }),
      );
      const binDir = await installFakeEslintRunner(workDir, true);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: spell(root),
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };
      delete env.FACTORY_GATE;

      const { code, stderr } = await runStopGate(root, env, { cwd: worktree });

      expect(code).toBe(2);
      expect(stderr).toMatch(/Lint failed/);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "ignora un cwd que queda fuera del proyecto",
    async () => {
      const binDir = await prepareFailingLint();
      const elsewhere = await mkdtemp(path.join(tmpdir(), "seadragons-otro-"));
      spawnSync("git", ["init", "-q", elsewhere]);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: workDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };
      delete env.FACTORY_GATE;

      try {
        const { code } = await runStopGate(workDir, env, { cwd: elsewhere });

        expect(code).toBe(2);
      } finally {
        await rm(elsewhere, REMOVE_TEMP_DIR_OPTIONS);
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "deja intacto el archivo contador cuando está desarmado",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
      const counterFile = path.join(workDir, COUNTER_FILE);
      await mkdir(path.dirname(counterFile), { recursive: true });
      await writeFile(counterFile, "3");

      const { code } = await runStopGate(workDir, {
        ...process.env,
        FACTORY_GATE: "off",
      });

      expect(code).toBe(0);
      expect(await readFile(counterFile, "utf8")).toBe("3");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no hace nada en un repo sin factory.json, aunque tenga config de lint",
    async () => {
      // Es la plantilla antes del bootstrap: sin comandos de verdad, el gate
      // no tiene nada que exigir. Antes lo decidía el centinela {{TEST_CMD}}.
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
      await writeFile(
        path.join(workDir, "eslint.config.js"),
        "module.exports = [];\n",
      );
      const binDir = await installFakeEslintRunner(workDir, true);

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      await expect(
        readFile(path.join(workDir, "npx-was-called")),
      ).rejects.toThrow();
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea diciendo qué falta cuando no hay jq ni node para leer factory.json",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-stop-gate-"));
      await writeFile(path.join(workDir, "factory.json"), factoryJson({}));

      const { code, stderr } = await runStopGate(workDir, {
        ...process.env,
        FACTORY_JSON_READER: "none",
      });

      expect(code).toBe(2);
      expect(stderr).toContain("jq o node");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

function isJqInstalled(): boolean {
  return spawnSync("bash", ["-c", "command -v jq"]).status === 0;
}

/**
 * El gate lee factory.json con jq y, si no hay jq (Git Bash no lo trae), con
 * node. Los dos caminos tienen que decir lo mismo, así que cada caso corre con
 * cada lector disponible. En el runner de GitHub hay ambos.
 */
const READERS = isJqInstalled() ? ["node", "jq"] : ["node"];

describe.each(READERS)("comandos de factory.json (lector: %s)", (reader) => {
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
   * Un comando de mentira hecho con node: anota en un archivo los argumentos
   * que recibió, uno por línea de JSON, para ver exactamente qué ejecutó el
   * gate.
   */
  async function prepare(
    commands: (recorder: readonly string[]) => Commands,
    extra: object = {},
  ): Promise<{ logFile: string }> {
    workDir = await mkdtemp(path.join(tmpdir(), "seadragons-gate-cmds-"));
    helperDir = await mkdtemp(path.join(tmpdir(), "seadragons-gate-rec-"));
    const logFile = path.join(helperDir, "calls.log");
    const recorderScript = path.join(helperDir, "record.js");
    await writeFile(
      recorderScript,
      `require("fs").appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    await writeFile(
      path.join(workDir, "factory.json"),
      factoryJson(commands(["node", recorderScript]), extra),
    );
    return { logFile };
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

  function runGate(): Promise<RunResult> {
    return runStopGate(workDir, {
      ...process.env,
      FACTORY_JSON_READER: reader,
    });
  }

  it(
    "corre cada comando con sus argumentos exactos, sin pasar por un shell",
    async () => {
      const { logFile } = await prepare((rec) => ({
        test: [...rec, "con espacios", "$(echo inyectado)"],
      }));

      const { code } = await runGate();

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([
        ["con espacios", "$(echo inyectado)"],
      ]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "corre lint, typecheck, test, build y e2e en ese orden, y no corre los que están en null",
    async () => {
      const { logFile } = await prepare((rec) => ({
        lint: [...rec, "lint"],
        typecheck: [...rec, "typecheck"],
        test: null,
        build: [...rec, "build"],
        e2e: [...rec, "e2e"],
      }));

      const { code } = await runGate();

      expect(code).toBe(0);
      expect(await recordedCalls(logFile)).toEqual([
        ["lint"],
        ["typecheck"],
        ["build"],
        ["e2e"],
      ]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Una suite roja grande llenaba el contexto del worker con toda su salida
  // (revisión del 2026-11-23): van las últimas líneas y el resto a un log.
  it(
    "manda solo el final de la salida de un check que falla, y la guarda entera",
    async () => {
      await prepare(() => ({
        test: [
          "node",
          "-e",
          "for (let i = 1; i <= 1000; i++) console.log('linea ' + i); process.exit(1)",
        ],
      }));

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("linea 1000");
      expect(stderr).not.toContain("linea 1\n");
      expect(stderr).toContain(".factory/state/gate-test.log");
      const log = await readFile(
        path.join(workDir, ".factory/state/gate-test.log"),
        "utf8",
      );
      expect(log).toContain("linea 1\n");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "un check que se pasa de su plazo cuenta como fallido",
    async () => {
      await prepare(() => ({ test: ["sleep", "5"] }));

      const start = Date.now();
      const { code, stderr } = await runStopGate(workDir, {
        ...process.env,
        FACTORY_JSON_READER: reader,
        FACTORY_CHECK_TIMEOUT: "1",
      });

      expect(code).toBe(2);
      expect(stderr).toMatch(/plazo|timed out/i);
      expect(Date.now() - start).toBeLessThan(4000);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea y suma un intento cuando el comando falla",
    async () => {
      await prepare(() => ({ test: ["node", "-e", "process.exit(1)"] }));

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("Tests failed");
      expect(await readFile(path.join(workDir, COUNTER_FILE), "utf8")).toBe(
        "1\n",
      );
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea diciendo qué clave falta, para no confundir 'sin configurar' con 'no aplica'",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-gate-cmds-"));
      const { e2e: _omitted, ...withoutE2e } = ALL_COMMANDS_OFF;
      await writeFile(
        path.join(workDir, "factory.json"),
        JSON.stringify({ stack: "node-ts", commands: withoutE2e, format: [] }),
      );

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("commands.e2e");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    ["un texto en vez de una lista", "npm test"],
    ["una lista vacía", []],
    ["un argumento con salto de línea", ["npm", "te\nst"]],
  ])(
    "bloquea cuando commands.test es %s",
    async (_label, value) => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-gate-cmds-"));
      await writeFile(
        path.join(workDir, "factory.json"),
        JSON.stringify({
          stack: "node-ts",
          commands: { ...ALL_COMMANDS_OFF, test: value },
          format: [],
        }),
      );

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("commands.test");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea cuando factory.json no es JSON válido",
    async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "seadragons-gate-cmds-"));
      await writeFile(path.join(workDir, "factory.json"), "{ esto no es json");

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("no es JSON válido");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "bloquea cuando una regla de format está mal, porque el hook de formato no puede avisar",
    async () => {
      await prepare(() => ({}), {
        format: [{ extensions: "ts", cmd: ["npx", "prettier", "--write"] }],
      });

      const { code, stderr } = await runGate();

      expect(code).toBe(2);
      expect(stderr).toContain("format");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

interface BashScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBashScript(
  cwd: string,
  script: string,
  input?: string,
): Promise<BashScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin!.end(input);
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

function toBashPath(nativePath: string): string {
  return nativePath.replace(/\\/g, "/");
}

/**
 * Repo con upstream real: el guard necesita `@{upstream}` para decidir si hay
 * commits por delante, así que un `git init` suelto no alcanza. El commit
 * base deja sucios (trackeados) los cuatro archivos de ruido más uno de
 * producto, para que los tests solo tengan que decidir cuáles tocar.
 */
async function createFixtureRepo(): Promise<{
  workDir: string;
  originDir: string;
}> {
  const originDir = await mkdtemp(path.join(tmpdir(), "seadragons-origin-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "seadragons-work-"));
  await writeFile(
    path.join(workDir, "factory.json"),
    factoryJson({ lint: ["npx", "eslint", "."], test: ["npm", "test"] }),
  );
  const script = `
    set -e
    git init --bare -q "${toBashPath(originDir)}"
    git init -q .
    git remote add origin "${toBashPath(originDir)}"
    git config user.email test@example.com
    git config user.name Test
    mkdir -p src/lib
    echo '{"include": ["**/*.ts"]}' > tsconfig.json
    echo '{"name": "fixture", "lockfileVersion": 3}' > package-lock.json
    echo '# CLAUDE' > CLAUDE.md
    echo '# AGENTS' > AGENTS.md
    echo 'module.exports = [];' > eslint.config.js
    echo '{"name": "fixture", "scripts": {"test": "true"}}' > package.json
    echo 'export const foo = 1;' > src/lib/foo.ts
    git add -A
    git commit -q -m baseline
    git push -q -u origin HEAD:main
    git branch -q --set-upstream-to=origin/main
  `;
  const { code, stderr } = await runBashScript(workDir, script);
  if (code !== 0) {
    throw new Error(`No se pudo preparar el repo de prueba: ${stderr}`);
  }
  return { workDir, originDir };
}

/**
 * `npm`/`npx` de mentira: registran que corrieron y siempre "pasan". Viven
 * fuera de `workDir` a propósito: si el bin stub estuviera dentro del árbol
 * git, `git status` lo vería como archivo sin seguimiento y el guard tendría
 * razón en no aplicar, invalidando el test.
 */
async function installChecksRanMarkerBin(): Promise<{
  binDir: string;
  markerFile: string;
}> {
  const binDir = await mkdtemp(path.join(tmpdir(), "seadragons-stub-bin-"));
  const markerFile = path.join(binDir, "checks-ran");
  const marker = toBashPath(markerFile);
  for (const name of ["npm", "npx"]) {
    const binPath = path.join(binDir, name);
    await writeFile(
      binPath,
      `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`,
    );
    await chmod(binPath, 0o755);
  }
  return { binDir, markerFile };
}

async function checksRan(markerFile: string): Promise<boolean> {
  try {
    await readFile(markerFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * `npm`/`npx` de mentira que apuntan con qué argumentos los llamaron. Sirve
 * para comprobar qué decidió ejecutar el gate, no sólo que terminara bien.
 */
async function installNpmArgsRecorderBin(): Promise<{
  binDir: string;
  logFile: string;
}> {
  const binDir = await mkdtemp(path.join(tmpdir(), "seadragons-npm-log-"));
  const logFile = path.join(binDir, "npm-args");
  const log = toBashPath(logFile);
  for (const name of ["npm", "npx"]) {
    const binPath = path.join(binDir, name);
    await writeFile(
      binPath,
      ["#!/usr/bin/env bash", `echo "$@" >> "${log}"`, "exit 0", ""].join("\n"),
    );
    await chmod(binPath, 0o755);
  }
  return { binDir, logFile };
}

async function npmCalls(logFile: string): Promise<string> {
  try {
    return await readFile(logFile, "utf8");
  } catch {
    return "";
  }
}

describe("guard de árbol limpio", () => {
  let workDir = "";
  let originDir = "";
  let stubBinDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
    if (originDir) {
      await rm(originDir, REMOVE_TEMP_DIR_OPTIONS);
      originDir = "";
    }
    if (stubBinDir) {
      await rm(stubBinDir, REMOVE_TEMP_DIR_OPTIONS);
      stubBinDir = "";
    }
  });

  it(
    "pasa cuando el árbol está completamente limpio",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each(["tsconfig.json", "package-lock.json", "CLAUDE.md", "AGENTS.md"])(
    "pasa cuando la única suciedad es ruido generado (%s)",
    async (noiseFile) => {
      ({ workDir, originDir } = await createFixtureRepo());
      await writeFile(path.join(workDir, noiseFile), "cambiado por next dev\n");
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "en una rama que solo cambia specs/ y el plan maestro no corre los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      const { code: prepared, stderr } = await runBashScript(
        workDir,
        `set -e
         git checkout -q -b spec-12
         mkdir -p specs/12-favoritos docs
         echo '# Spec' > specs/12-favoritos/spec.md
         echo '# Plan maestro' > docs/plan-maestro.md
         git add -A && git commit -q -m spec
         echo '# Plan' > specs/12-favoritos/plan.md`,
      );
      expect(prepared, stderr).toBe(0);
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "la línea .specify/ que agrega fabrica-setup al .gitignore no hace correr los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b spec-12
         mkdir -p specs/12-favoritos
         echo '# Spec' > specs/12-favoritos/spec.md
         git add -A && git commit -q -m spec
         printf '.specify/\\n' >> .gitignore`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "mover código a specs/ no lo hace pasar por planeación: corre los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b mueve-codigo
         mkdir -p specs
         git mv src/lib/foo.ts specs/foo.ts
         git commit -q -m mueve`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Fase 5: la spec aprobada queda fija mientras se construye (principio III
  // de la constitución). Que un worker no la toque no puede depender solo del
  // texto de las reglas.
  it.each([
    ["commiteado", "git add -A && git commit -q -m toca-spec"],
    ["sin commitear", "true"],
    [
      "ya pusheado",
      "git add -A && git commit -q -m toca-spec && git push -q -u origin impl-7",
    ],
  ])(
    "en una rama impl-N bloquea un cambio en specs/ (%s), sin correr los checks",
    async (_case, after) => {
      ({ workDir, originDir } = await createFixtureRepo());
      const { code: prepared, stderr: prepError } = await runBashScript(
        workDir,
        `set -e
         mkdir -p specs/12-favoritos
         echo '- [ ] T001 algo' > specs/12-favoritos/tasks.md
         git add -A && git commit -q -m spec && git push -q origin HEAD:main
         git checkout -q -b impl-7
         echo 'export const foo = 2;' > src/lib/foo.ts
         echo '- [x] T001 algo' > specs/12-favoritos/tasks.md
         ${after}`,
      );
      expect(prepared, prepError).toBe(0);
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code, stderr } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(2);
      expect(stderr).toContain("specs/12-favoritos/tasks.md");
      expect(stderr).toMatch(/needs-human/);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Los hooks corren los comandos de factory.json sin pasar por los permisos:
  // un worker que lo editara correría lo que quisiera (revisión del
  // 2026-11-23). Cambiarlo es de una persona, como la spec.
  it(
    "en una rama impl-N bloquea un cambio en factory.json, sin correr los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo '{"stack":"node-ts","commands":{"install":null,"lint":null,"typecheck":null,"test":null,"build":null,"e2e":null},"format":[]}' > factory.json
         git commit -qam apaga`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code, stderr } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(2);
      expect(stderr).toContain("factory.json");
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    ["el Stop gate", "stop"],
    ["el hook de formato", "format"],
  ])(
    "en un worker, %s usa el factory.json de la rama base, no el del árbol",
    async (_caso, hook) => {
      ({ workDir, originDir } = await createFixtureRepo());
      const evil = toBashPath(
        path.join(workDir, "..", `${path.basename(workDir)}-evil`),
      );
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b otra
         node -e 'const f=JSON.parse(require("fs").readFileSync("factory.json","utf8")); f.commands.lint=["bash","-c","touch ${evil}"]; f.format=[{"extensions":["ts"],"cmd":["bash","-c","touch ${evil}"]}]; require("fs").writeFileSync("factory.json", JSON.stringify(f))'`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        FABRICA_WORKER: "1",
      };

      if (hook === "stop") {
        await runStopGate(workDir, env);
        expect(await checksRan(markerFile)).toBe(true);
      } else {
        const result = await runBashScript(
          workDir,
          `FABRICA_WORKER=1 bash "${toBashPath(FORMAT_HOOK_SCRIPT)}"`,
          JSON.stringify({
            tool_input: { file_path: path.join(workDir, "src/lib/foo.ts") },
          }),
        );
        expect(result.code).toBe(0);
      }
      expect(existsSync(evil.replace(/\//g, path.sep))).toBe(false);
      await rm(evil, { force: true });
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "en una rama impl-N que no toca specs/ corre los checks como siempre",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo 'export const foo = 2;' > src/lib/foo.ts
         git commit -qam codigo`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // En `claude -p` el Stop solo se dispara al final, cuando el worker ya hizo
  // push: si el gate se salta todo con el árbol limpio y nada por delante de
  // upstream, no verifica nunca el camino normal (revisión del 2026-11-23).
  it(
    "en una rama impl-N ya pusheada corre los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      const { code: prepared, stderr } = await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo 'export const foo = 2;' > src/lib/foo.ts
         git commit -qam codigo
         git push -q -u origin impl-7`,
      );
      expect(prepared, stderr).toBe(0);
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      const { code } = await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  // Una pregunta en un PR (una mención, una sesión que solo lee) no cambia
  // nada: verificar la rama entera la atraparía en los checks de otro.
  it(
    "una sesión que no cambió nada desde que empezó no corre los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo 'export const foo = 2;' > src/lib/foo.ts
         git commit -qam codigo
         git push -q -u origin impl-7`,
      );
      const start = await runBashScript(
        workDir,
        `bash "${toBashPath(SESSION_START_SCRIPT)}"`,
        JSON.stringify({ session_id: "abc-123", cwd: workDir }),
      );
      expect(start.code, start.stderr).toBe(0);
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };

      await runStopGate(workDir, env, {
        session_id: "abc-123",
        cwd: workDir,
      });
      expect(await checksRan(markerFile)).toBe(false);

      await runBashScript(
        workDir,
        "echo 'export const foo = 3;' > src/lib/foo.ts && git commit -qam otro",
      );
      await runStopGate(workDir, env, { session_id: "abc-123", cwd: workDir });
      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "lo que ya pasó no se vuelve a verificar mientras no cambie",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo 'export const foo = 2;' > src/lib/foo.ts
         git commit -qam codigo
         git push -q -u origin impl-7`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      };

      await runStopGate(workDir, env);
      expect(await checksRan(markerFile)).toBe(true);
      await rm(markerFile);
      const { code } = await runStopGate(workDir, env);

      expect(code).toBe(0);
      expect(await checksRan(markerFile)).toBe(false);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each(["tsconfig.json", "package-lock.json"])(
    "una rama que solo cambia %s corre los checks: cambia lo que verifican",
    async (noiseFile) => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b impl-7
         echo '{"compilerOptions": {"strict": true}}' > ${noiseFile}
         git commit -qam ajuste`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "si la rama de planeación también toca código, corre los checks",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `set -e
         git checkout -q -b spec-12
         mkdir -p specs/12-favoritos
         echo '# Spec' > specs/12-favoritos/spec.md
         echo 'export const foo = 2;' > src/lib/foo.ts
         git add -A && git commit -q -m spec`,
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no pasa cuando además hay un archivo de producto",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await writeFile(path.join(workDir, "tsconfig.json"), "cambiado\n");
      await writeFile(
        path.join(workDir, "src/lib/foo.ts"),
        "export const foo = 2;\n",
      );
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no pasa cuando hay commits sobre upstream, aunque la suciedad sea ruido",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await runBashScript(
        workDir,
        `git config user.email test@example.com
       git config user.name Test
       echo 'export const foo = 2;' > src/lib/foo.ts
       git commit -aqm "commit sin pushear"`,
      );
      await writeFile(path.join(workDir, "tsconfig.json"), "cambiado\n");
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no pasa ante un archivo sin seguimiento fuera de la lista",
    async () => {
      ({ workDir, originDir } = await createFixtureRepo());
      await writeFile(path.join(workDir, "src/lib/scratch.ts"), "export {};\n");
      const { binDir, markerFile } = await installChecksRanMarkerBin();
      stubBinDir = binDir;

      await runStopGate(workDir, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      });

      expect(await checksRan(markerFile)).toBe(true);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

describe("workflows", () => {
  // Una mención en la nube tiene permiso de escribir código: con el gate
  // apagado, lo que commiteara no se verificaba. Ahora el gate solo mira lo
  // que cambie la sesión (revisión del 2026-11-23).
  // claude-mentions.yml lo apaga solo en el PR de alguien sin escritura, con
  // lo que decide su paso trust (tests/unit/workflows/claude-mentions-trust).
  it("ningún workflow apaga el Stop gate salvo por el paso trust", async () => {
    const mentionsYml = await readFile(
      pluginFile(".github/workflows/claude-mentions.yml"),
      "utf8",
    );
    const backlogYml = await readFile(
      pluginFile(".github/workflows/claude-backlog.yml"),
      "utf8",
    );

    expect(mentionsYml.match(/FACTORY_GATE.*/g)).toEqual([
      "FACTORY_GATE: ${{ steps.trust.outputs.hooks }}",
    ]);
    expect(backlogYml).not.toMatch(/FACTORY_GATE/);
  });
});

describe("tests del kit", () => {
  let workDir = "";
  let originDir = "";
  let stubBinDir = "";

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, REMOVE_TEMP_DIR_OPTIONS);
      workDir = "";
    }
    if (originDir) {
      await rm(originDir, REMOVE_TEMP_DIR_OPTIONS);
      originDir = "";
    }
    if (stubBinDir) {
      await rm(stubBinDir, REMOVE_TEMP_DIR_OPTIONS);
      stubBinDir = "";
    }
  });

  async function runGateWith(scripts: string): Promise<string> {
    ({ workDir, originDir } = await createFixtureRepo());
    const { binDir, logFile } = await installNpmArgsRecorderBin();
    stubBinDir = binDir;
    // Ensuciar el árbol a propósito: con el repo limpio el gate se salta
    // los checks, que es justo lo que aquí hay que observar.
    await writeFile(
      path.join(workDir, "package.json"),
      `{"name": "fixture", "scripts": ${scripts}}`,
    );

    await runStopGate(workDir, {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    });

    return npmCalls(logFile);
  }

  it(
    "no corre test:kit aunque un proyecto viejo lo tenga: el kit se prueba en el repo del plugin",
    async () => {
      // Un proyecto creado con la plantilla vieja todavía trae `test:kit`.
      // Esos tests vigilan piezas que ya no viven en el proyecto.
      const calls = await runGateWith('{"test": "true", "test:kit": "true"}');

      expect(calls).not.toContain("test:kit");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "no inventa el comando cuando el proyecto no lo tiene",
    async () => {
      const calls = await runGateWith('{"test": "true"}');

      expect(calls).not.toContain("test:kit");
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
