import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT } from "../../support/plugin-paths";

/**
 * El dev container es para correr los workers con bypassPermissions sin
 * riesgo: un contenedor desechable con la red cerrada salvo lo que hace
 * falta. El plugin trae la base y `fabrica-devcontainer` la escribe en el
 * proyecto con lo de su lenguaje; después los archivos son del proyecto.
 */

const BIN = path.join(PLUGIN_ROOT, "bin/fabrica-devcontainer");
const TIMEOUT = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface DevcontainerJson {
  build: { dockerfile: string };
  runArgs: string[];
  features: Record<string, unknown>;
  containerEnv: Record<string, string>;
  postStartCommand: string;
  mounts: string[];
  remoteUser: string;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fabrica-devcontainer-"));
  temps.push(dir);
  return dir;
}

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [BIN, ...args], {
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

function config(dir: string): DevcontainerJson {
  return JSON.parse(
    readFileSync(path.join(dir, ".devcontainer/devcontainer.json"), "utf8"),
  ) as DevcontainerJson;
}

function domains(dir: string): string[] {
  return readFileSync(
    path.join(dir, ".devcontainer/allowed-domains.txt"),
    "utf8",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("fabrica-devcontainer", () => {
  it(
    "escribe el Dockerfile, el firewall, su lista de dominios y la configuración",
    async () => {
      const dir = project();

      const { code } = await run(dir, []);

      expect(code).toBe(0);
      for (const file of [
        "Dockerfile",
        "init-firewall.sh",
        "allowed-domains.txt",
        "devcontainer.json",
      ]) {
        expect(existsSync(path.join(dir, ".devcontainer", file)), file).toBe(
          true,
        );
      }
      expect(
        statSync(path.join(dir, ".devcontainer/init-firewall.sh")).mode & 0o111,
      ).not.toBe(0);
    },
    TIMEOUT,
  );

  it(
    "el bypass de permisos va solo dentro del contenedor, con el firewall arriba",
    async () => {
      const dir = project();
      await run(dir, []);
      const json = config(dir);

      expect(json.containerEnv.PERMISSION_MODE).toBe("bypassPermissions");
      expect(json.runArgs).toEqual(
        expect.arrayContaining(["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"]),
      );
      expect(json.postStartCommand).toContain("init-firewall.sh");
      expect(json.remoteUser).not.toBe("root");
    },
    TIMEOUT,
  );

  it(
    "guarda la sesión de Claude y de gh en volúmenes, para entrar una sola vez",
    async () => {
      const dir = project();
      await run(dir, []);
      const mounts = config(dir).mounts.join("\n");

      expect(mounts).toMatch(/target=\/home\/node\/\.claude,type=volume/);
      expect(mounts).toMatch(/target=\/home\/node\/\.config\/gh,type=volume/);
    },
    TIMEOUT,
  );

  it(
    "por defecto deja pasar GitHub, Anthropic y npm, y nada más",
    async () => {
      const dir = project();
      await run(dir, []);

      expect(domains(dir)).toEqual(
        expect.arrayContaining(["api.anthropic.com", "registry.npmjs.org"]),
      );
      expect(domains(dir)).not.toContain("pypi.org");
      const firewall = readFileSync(
        path.join(dir, ".devcontainer/init-firewall.sh"),
        "utf8",
      );
      expect(firewall).toContain("api.github.com/meta");
      expect(firewall).toContain("allowed-domains.txt");
    },
    TIMEOUT,
  );

  it(
    "agrega las features y los dominios del lenguaje del proyecto, sin repetir",
    async () => {
      const dir = project();

      const { code } = await run(dir, [
        "--feature",
        "ghcr.io/devcontainers/features/python:1",
        "--domain",
        "pypi.org",
        "--domain",
        "files.pythonhosted.org",
        "--domain",
        "registry.npmjs.org",
      ]);

      expect(code).toBe(0);
      expect(config(dir).features).toHaveProperty(
        ["ghcr.io/devcontainers/features/python:1"],
        {},
      );
      const list = domains(dir);
      expect(list).toEqual(
        expect.arrayContaining(["pypi.org", "files.pythonhosted.org"]),
      );
      expect(list.filter((d) => d === "registry.npmjs.org")).toHaveLength(1);
    },
    TIMEOUT,
  );

  // Debian reinicia el PATH en /etc/profile, y VS Code y el CLI de dev
  // containers abren shells de login: con un prefijo de npm propio, `claude`
  // no aparecía (probado con Docker, 2026-11-23).
  it(
    "instala Claude Code como root, en el PATH de cualquier shell",
    async () => {
      const dir = project();
      await run(dir, []);
      const dockerfile = readFileSync(
        path.join(dir, ".devcontainer/Dockerfile"),
        "utf8",
      );

      const install = dockerfile.indexOf("@anthropic-ai/claude-code");
      expect(install).toBeGreaterThan(-1);
      expect(install).toBeLessThan(dockerfile.indexOf("USER node"));
      expect(dockerfile).not.toContain("NPM_CONFIG_PREFIX");
    },
    TIMEOUT,
  );

  // Sin esto, git no usa la sesión de gh y `claude plugin marketplace add`
  // no puede clonar el plugin privado. En ~/.gitconfig se perdería al
  // reconstruir: solo ~/.config/gh va en un volumen.
  it(
    "git usa la sesión de gh para GitHub, configurado para todo el sistema",
    async () => {
      const dir = project();
      await run(dir, []);
      const dockerfile = readFileSync(
        path.join(dir, ".devcontainer/Dockerfile"),
        "utf8",
      );

      expect(dockerfile).toMatch(
        /git config --system credential\.https:\/\/github\.com\.helper '!gh auth git-credential'/,
      );
    },
    TIMEOUT,
  );

  // Revisión del 2026-11-23: el puerto 53 y el 22 salían a cualquier IP, y
  // IPv6 no tenía reglas.
  it(
    "el firewall solo deja el DNS a los resolvedores del contenedor, cierra el 22 e IPv6, y deja su marca al final",
    async () => {
      const dir = project();
      await run(dir, []);
      const firewall = readFileSync(
        path.join(dir, ".devcontainer/init-firewall.sh"),
        "utf8",
      );

      expect(firewall).not.toMatch(/--dport 22/);
      expect(firewall).not.toMatch(/-p udp --dport 53 -j ACCEPT/);
      expect(firewall).toContain("/etc/resolv.conf");
      expect(firewall).toMatch(/ip6tables -P OUTPUT DROP/);
      expect(
        firewall.indexOf("rm -f /run/fabrica-firewall-ok"),
      ).toBeGreaterThan(-1);
      expect(firewall.trimEnd().split("\n").slice(-2).join("\n")).toContain(
        "/run/fabrica-firewall-ok",
      );
    },
    TIMEOUT,
  );

  // Las capturas del contenedor diferían ~1% de las de la CI en el borde de
  // cada letra: Debian no trae el suavizado por subpíxel que Ubuntu (el runner
  // de la CI) activa con 10-sub-pixel-rgb.conf. Con él, 0 píxeles
  // (refastidioso-web, 2026-11-25).
  it(
    "activa el suavizado por subpíxel de Ubuntu, para que las capturas salgan como en la CI",
    async () => {
      const dir = project();
      await run(dir, []);
      const dockerfile = readFileSync(
        path.join(dir, ".devcontainer/Dockerfile"),
        "utf8",
      );

      expect(dockerfile).toContain(
        "/usr/share/fontconfig/conf.avail/10-sub-pixel-rgb.conf /etc/fonts/conf.d/",
      );
    },
    TIMEOUT,
  );

  // gh run view --log-failed baja el log de productionresultssaN.blob.core.
  // windows.net, que el firewall cortaba: el worker no podía ver qué falló
  // en la CI (refastidioso-web #9, 2026-11-25). Solo esas cuentas de GitHub,
  // nunca *.blob.core.windows.net, que deja salir a cualquier cuenta de Azure.
  it(
    "deja bajar los logs de la CI: las cuentas de Azure de GitHub Actions, una por una",
    async () => {
      const dir = project();
      await run(dir, []);
      const allowed = domains(dir);

      for (let n = 0; n <= 19; n++) {
        expect(allowed).toContain(
          `productionresultssa${n}.blob.core.windows.net`,
        );
      }
      expect(allowed.filter((d) => d.includes("*"))).toEqual([]);
      expect(allowed).not.toContain("blob.core.windows.net");
    },
    TIMEOUT,
  );

  // @devcontainers/cli 0.80.0 se colgaba con Docker 29 después de "Container
  // started" y nunca corría el firewall; npx usaba esa versión de su caché.
  // Con la 0.91.0 el mismo up termina solo (refastidioso-web, 2026-11-25).
  it(
    "el aviso final pide @devcontainers/cli en la versión probada, no la que haya en caché",
    async () => {
      const dir = project();

      const { code, stdout } = await run(dir, []);

      expect(code).toBe(0);
      expect(stdout).toContain(
        "npx -y @devcontainers/cli@0.91.0 up --workspace-folder .",
      );
    },
    TIMEOUT,
  );

  // `devcontainer up` sobre un contenedor que ya corre vuelve a correr el
  // postStartCommand. El script vaciaba las reglas pero no las políticas: con
  // OUTPUT en DROP de la vez anterior, la descarga de los rangos de GitHub se
  // colgaba y el contenedor quedaba sin red y sin marca (refastidioso-web,
  // 2026-11-25).
  it(
    "el firewall se puede correr dos veces: abre las políticas antes de bajar los rangos, con plazo",
    async () => {
      const dir = project();
      await run(dir, []);
      const firewall = readFileSync(
        path.join(dir, ".devcontainer/init-firewall.sh"),
        "utf8",
      );
      const download = firewall.indexOf("api.github.com/meta");

      for (const table of ["iptables", "ip6tables"]) {
        for (const chain of ["INPUT", "FORWARD", "OUTPUT"]) {
          const reset = firewall.indexOf(`${table} -P ${chain} ACCEPT`);
          expect(reset, `${table} -P ${chain} ACCEPT`).toBeGreaterThan(-1);
          expect(reset).toBeLessThan(download);
        }
      }
      expect(firewall).toMatch(
        /curl[^\n]*--max-time \d+[^\n]*api\.github\.com\/meta/,
      );
    },
    TIMEOUT,
  );

  // El gh de Debian bookworm es 2.23.0, de 2023 (visto con Docker el
  // 2026-11-23): se instala del repositorio de GitHub.
  it(
    "instala gh del repositorio de GitHub, no el viejo de Debian",
    async () => {
      const dir = project();
      await run(dir, []);
      const dockerfile = readFileSync(
        path.join(dir, ".devcontainer/Dockerfile"),
        "utf8",
      );

      expect(dockerfile).toContain("https://cli.github.com/packages");
      expect(dockerfile).toContain("githubcli-archive-keyring.gpg");
      const firstInstall = dockerfile.slice(
        0,
        dockerfile.indexOf("cli.github.com"),
      );
      expect(firstInstall).not.toMatch(/^\s+gh \\$/m);
    },
    TIMEOUT,
  );

  // refastidioso-web (2026-11-24): la imagen no traía las librerías de
  // Chromium, y dentro no hay apt. Además cdn.playwright.dev redirige la
  // descarga a storage.googleapis.com, cuyas IP rotan: el firewall, que
  // resuelve una vez al arrancar, la cortaba. Con todo eso, el e2e del Stop
  // gate quedaba rojo y ningún worker podía terminar.
  it(
    "con --playwright, Chromium y sus librerías van en la imagen, en la versión del proyecto",
    async () => {
      const dir = project();
      mkdirSync(path.join(dir, "node_modules/@playwright/test"), {
        recursive: true,
      });
      writeFileSync(
        path.join(dir, "node_modules/@playwright/test/package.json"),
        JSON.stringify({ name: "@playwright/test", version: "1.65.1" }),
      );

      const { code } = await run(dir, ["--playwright"]);

      expect(code).toBe(0);
      const dockerfile = readFileSync(
        path.join(dir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toContain("ARG PLAYWRIGHT_VERSION=1.65.1");
      expect(dockerfile).toContain(
        "ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
      );
      const install = dockerfile.indexOf(
        "playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium",
      );
      expect(install).toBeGreaterThan(-1);
      expect(install).toBeLessThan(dockerfile.indexOf("USER node"));
      // Nada que bajar en tiempo de ejecución: ni dominios de Playwright ni
      // de Google en la lista.
      expect(domains(dir).join(" ")).not.toMatch(/playwright|google/);
    },
    TIMEOUT,
  );

  it(
    "sin --playwright, la imagen no trae Chromium",
    async () => {
      const dir = project();
      await run(dir, []);

      expect(
        readFileSync(path.join(dir, ".devcontainer/Dockerfile"), "utf8"),
      ).not.toContain("playwright");
    },
    TIMEOUT,
  );

  it(
    "--playwright sin @playwright/test instalado falla sin escribir nada",
    async () => {
      const dir = project();

      const { code, stderr } = await run(dir, ["--playwright"]);

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/npm install/);
      expect(existsSync(path.join(dir, ".devcontainer"))).toBe(false);
    },
    TIMEOUT,
  );

  it.each([
    ["un dominio raro", ["--domain", "pypi.org; rm -rf /"]],
    ["una feature rara", ["--feature", "python $(id)"]],
    ["una opción que no existe", ["--lenguaje", "python"]],
  ])(
    "rechaza %s sin escribir nada",
    async (_caso, args) => {
      const dir = project();

      const { code, stderr } = await run(dir, args);

      expect(code).not.toBe(0);
      expect(stderr).not.toBe("");
      expect(existsSync(path.join(dir, ".devcontainer"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "no pisa un .devcontainer que ya existe, salvo con --force",
    async () => {
      const dir = project();
      mkdirSync(path.join(dir, ".devcontainer"));
      writeFileSync(path.join(dir, ".devcontainer/devcontainer.json"), "{}\n");

      const refused = await run(dir, []);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(/--force/);
      expect(
        readFileSync(path.join(dir, ".devcontainer/devcontainer.json"), "utf8"),
      ).toBe("{}\n");

      const forced = await run(dir, ["--force"]);
      expect(forced.code).toBe(0);
      expect(config(dir).containerEnv.PERMISSION_MODE).toBe(
        "bypassPermissions",
      );
    },
    TIMEOUT,
  );
});
