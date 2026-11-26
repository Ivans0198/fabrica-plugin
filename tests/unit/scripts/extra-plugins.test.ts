import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Los plugins que el proyecto suma a la fábrica, como el de Expo. En el host
 * los carga .claude/settings.json; la nube y el dev container solo instalaban
 * fabrica (truckconnect-mobile, 2026-11-26). factory.json → extraPlugins los
 * nombra con su marketplace, el commit fijado y los dominios que necesitan.
 * Sin el commit fijado, un cambio en el marketplace metía hooks nuevos que
 * corren con los secretos de la nube (revisión del 2026-11-26).
 */

const SCRIPT = pluginFile("scripts/extra-plugins.sh");
const SHA = "a".repeat(40);

const EXPO = {
  id: "expo@claude-plugins-official",
  marketplace: "https://github.com/anthropics/claude-plugins-official.git",
  ref: SHA,
  domains: ["mcp.expo.dev"],
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "extra-plugins-"));
  temps.push(dir);
  return dir;
}

function run(
  factory: object | null,
  args: string[],
  env: Record<string, string> = {},
  dir = tempDir(),
) {
  if (factory)
    writeFileSync(path.join(dir, "factory.json"), JSON.stringify(factory));
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("extra-plugins.sh", () => {
  it("sin factory.json o sin extraPlugins no imprime nada", () => {
    for (const factory of [null, { commands: {} }, { extraPlugins: [] }]) {
      for (const mode of ["plugins", "marketplaces", "domains"]) {
        const r = run(factory, [mode]);
        expect(r.code, `${JSON.stringify(factory)} ${mode}`).toBe(0);
        expect(r.out).toBe("");
      }
    }
  });

  it("imprime los plugins, sus marketplaces y sus dominios, sin repetir", () => {
    const other = {
      id: "code-review@claude-plugins-official",
      marketplace: EXPO.marketplace,
      ref: SHA,
    };
    const factory = { extraPlugins: [EXPO, other] };

    expect(run(factory, ["plugins"]).out).toBe(
      "expo@claude-plugins-official\ncode-review@claude-plugins-official\n",
    );
    expect(run(factory, ["marketplaces"]).out).toBe(
      `${EXPO.marketplace} ${SHA}\n`,
    );
    expect(run(factory, ["domains"]).out).toBe("mcp.expo.dev\n");
  });

  it.each([
    ["un id con caracteres de shell", { ...EXPO, id: "expo@x; rm -rf /" }],
    ["un id sin marketplace", { ...EXPO, id: "expo" }],
    [
      "un marketplace fuera de GitHub",
      { ...EXPO, marketplace: "https://evil.example/m.git" },
    ],
    [
      "un marketplace por http",
      { ...EXPO, marketplace: "http://github.com/a/b.git" },
    ],
    ["sin ref", { ...EXPO, ref: undefined }],
    ["un ref que es una rama", { ...EXPO, ref: "main" }],
    ["un ref corto", { ...EXPO, ref: "abc1234" }],
    ["un dominio raro", { ...EXPO, domains: ["mcp.expo.dev $(id)"] }],
    ["domains que no es lista", { ...EXPO, domains: "mcp.expo.dev" }],
  ])("rechaza %s y nombra extraPlugins", (_caso, plugin) => {
    const r = run({ extraPlugins: [plugin] }, ["plugins"]);

    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("extraPlugins");
  });

  it("rechaza extraPlugins que no es lista", () => {
    const r = run({ extraPlugins: EXPO }, ["plugins"]);

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("extraPlugins");
  });

  it("rechaza un modo desconocido", () => {
    expect(run({ extraPlugins: [EXPO] }, ["todo"]).code).not.toBe(0);
  });

  describe("clone", () => {
    /** Un marketplace de mentira con dos commits; devuelve el primero. */
    function market(): {
      url: string;
      first: string;
      env: Record<string, string>;
    } {
      const root = tempDir();
      const repo = path.join(root, "market");
      mkdirSync(repo);
      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      writeFileSync(path.join(repo, "version.txt"), "1\n");
      git("add", "-A");
      git("commit", "-qm", "v1");
      const first = git("rev-parse", "HEAD");
      writeFileSync(path.join(repo, "version.txt"), "2\n");
      git("commit", "-qam", "v2");
      // La URL de GitHub apunta al repo local, como lo haría git en la CI.
      return {
        url: "https://github.com/acme/market.git",
        first,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/acme/market.git",
        },
      };
    }

    it("clona cada marketplace en su commit fijado e imprime la carpeta", () => {
      const m = market();
      const out = path.join(tempDir(), "markets");
      const factory = {
        extraPlugins: [{ id: "p@market", marketplace: m.url, ref: m.first }],
      };

      const r = run(factory, ["clone", out], m.env);

      expect(r.code, r.err).toBe(0);
      const dir = r.out.trim();
      expect(dir.startsWith(out)).toBe(true);
      expect(readFileSync(path.join(dir, "version.txt"), "utf8")).toBe("1\n");
    });

    // Los marketplaces de anthropics tienen nombres reservados que Claude
    // Code solo acepta desde GitHub: una copia local se rechaza.
    it("un marketplace de anthropics no se clona: imprime su URL", () => {
      const out = path.join(tempDir(), "markets");

      const r = run({ extraPlugins: [EXPO] }, ["clone", out]);

      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe(`${EXPO.marketplace}\n`);
      expect(existsSync(out)).toBe(false);
    });

    it("sin extraPlugins no clona nada", () => {
      const out = path.join(tempDir(), "markets");

      const r = run({}, ["clone", out]);

      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(existsSync(out)).toBe(false);
    });
  });
});
