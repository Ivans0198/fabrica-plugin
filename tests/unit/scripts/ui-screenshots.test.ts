import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const SCRIPT = pluginFile("scripts/ui-screenshots.sh");
const PREFLIGHT = pluginFile("scripts/ui-preflight.sh");
const TEST_TIMEOUT_MS = 30_000;

// Mismo rango que ui-preflight.test.ts, por debajo de los puertos efímeros.
const PORT_BASE = 30_000 + Math.floor(Math.random() * 2_000);
let nextPortOffset = 0;
function nextPort(): number {
  nextPortOffset += 1;
  return PORT_BASE + nextPortOffset;
}

// Un npx de mentira: anota cada llamada, comprueba que el servidor contesta
// en la URL que le pasan y escribe una "captura" que depende del tema, salvo
// con SAME_THEME=1, que imita un sitio sin tema oscuro.
const FAKE_NPX = `#!/usr/bin/env bash
echo "$*" >> "$CALLS_LOG"
scheme=""; args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[$i]}" = "--color-scheme" ] && scheme="\${args[$((i + 1))]}"
done
url="\${args[-2]}"; file="\${args[-1]}"
curl -sf "$url" >/dev/null || { echo "nadie contesta en $url" >&2; exit 1; }
if [ -n "\${SAME_THEME:-}" ]; then printf 'png' > "$file"; else printf 'png-%s' "$scheme" > "$file"; fi
`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], {
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

async function respondsAt(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

describe("ui-screenshots.sh", () => {
  let workDir = "";
  let env: NodeJS.ProcessEnv = process.env;
  let intruder: ChildProcess | undefined;

  async function setup(
    port: number,
    extra: NodeJS.ProcessEnv = {},
  ): Promise<void> {
    workDir = await mkdtemp(path.join(tmpdir(), "fabrica-ui-screenshots-"));
    const binDir = path.join(workDir, "fake-bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "npx"), FAKE_NPX);
    await chmod(path.join(binDir, "npx"), 0o755);
    await writeFile(
      path.join(workDir, "factory.json"),
      JSON.stringify({
        appUrl: `http://localhost:${port}`,
        commands: {
          dev: [
            "node",
            "-e",
            `require("node:http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(${port})`,
          ],
        },
      }),
    );
    env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CALLS_LOG: path.join(workDir, "calls.log"),
      FABRICA_SERVER_TIMEOUT: "8",
      ...extra,
    };
    delete env.APP_URL;
    delete env.DEV_SERVER_CMD;
  }

  async function calls(): Promise<string[]> {
    try {
      return (await readFile(path.join(workDir, "calls.log"), "utf8"))
        .trim()
        .split("\n");
    } catch {
      return [];
    }
  }

  afterEach(async () => {
    if (workDir) {
      spawn("bash", [PREFLIGHT, "down"], {
        cwd: workDir,
        env,
        stdio: "ignore",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(workDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      workDir = "";
    }
    intruder?.kill();
    intruder = undefined;
  });

  it(
    "levanta el servidor, saca los tres anchos en los dos temas y lo apaga",
    async () => {
      const port = nextPort();
      await setup(port);

      const { code, stdout, stderr } = await run([], workDir, env);

      expect(code, stderr).toBe(0);
      const out = path.join(workDir, ".factory/ui-screenshots");
      expect((await readdir(out)).sort()).toEqual([
        "ui-desktop-dark.png",
        "ui-desktop-light.png",
        "ui-mobile-dark.png",
        "ui-mobile-light.png",
        "ui-tablet-dark.png",
        "ui-tablet-light.png",
      ]);
      expect(await calls()).toContain(
        `playwright screenshot --full-page --viewport-size 1440,900 --color-scheme dark --wait-for-timeout 500 http://localhost:${port}/ ${path.join(out, "ui-desktop-dark.png")}`,
      );
      expect(stdout).toContain("ui-mobile-light.png");
      expect(await respondsAt(`http://localhost:${port}`)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "en un sitio sin tema oscuro deja sólo las claras y lo dice",
    async () => {
      const port = nextPort();
      await setup(port, { SAME_THEME: "1" });

      const { code, stdout, stderr } = await run([], workDir, env);

      expect(code, stderr).toBe(0);
      expect(
        (await readdir(path.join(workDir, ".factory/ui-screenshots"))).sort(),
      ).toEqual([
        "ui-desktop-light.png",
        "ui-mobile-light.png",
        "ui-tablet-light.png",
      ]);
      expect(stdout).toMatch(/sin tema oscuro/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "captura la ruta que le pasan con --path",
    async () => {
      const port = nextPort();
      await setup(port);

      const { code, stderr } = await run(["--path", "contacto"], workDir, env);

      expect(code, stderr).toBe(0);
      expect((await calls())[0]).toContain(
        `http://localhost:${port}/contacto `,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it("una opción desconocida falla sin levantar nada", async () => {
    const port = nextPort();
    await setup(port);

    const { code, stderr } = await run(["--pat", "/x"], workDir, env);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--pat/);
    expect(await calls()).toEqual([]);
  });

  it(
    "si el puerto lo tiene otro servidor, para con el mensaje del preflight y no captura nada",
    async () => {
      const port = nextPort();
      await setup(port);
      intruder = spawn(
        process.execPath,
        [
          "-e",
          `require("node:http").createServer((q,s)=>{s.end("ajeno")}).listen(${port})`,
        ],
        { stdio: "ignore" },
      );
      while (!(await respondsAt(`http://localhost:${port}`))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const { code, stderr } = await run([], workDir, env);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/already answers/);
      expect(await calls()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
