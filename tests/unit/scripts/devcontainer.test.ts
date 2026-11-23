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
