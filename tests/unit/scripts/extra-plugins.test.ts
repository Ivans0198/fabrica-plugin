import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Los plugins que el proyecto suma a la fábrica, como el de Expo. En el host
 * los carga .claude/settings.json; la nube y el dev container solo instalaban
 * fabrica (truckconnect-mobile, 2026-11-26). factory.json → extraPlugins los
 * nombra con su marketplace y los dominios que necesitan.
 */

const SCRIPT = pluginFile("scripts/extra-plugins.sh");

const EXPO = {
  id: "expo@claude-plugins-official",
  marketplace: "https://github.com/anthropics/claude-plugins-official.git",
  domains: ["mcp.expo.dev"],
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(factory: object | null, mode: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "extra-plugins-"));
  temps.push(dir);
  if (factory)
    writeFileSync(path.join(dir, "factory.json"), JSON.stringify(factory));
  const result = spawnSync("bash", [SCRIPT, mode], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("extra-plugins.sh", () => {
  it("sin factory.json o sin extraPlugins no imprime nada", () => {
    for (const factory of [null, { commands: {} }, { extraPlugins: [] }]) {
      for (const mode of ["plugins", "marketplaces", "domains"]) {
        const r = run(factory, mode);
        expect(r.code, `${JSON.stringify(factory)} ${mode}`).toBe(0);
        expect(r.out).toBe("");
      }
    }
  });

  it("imprime los plugins, sus marketplaces y sus dominios, sin repetir", () => {
    const other = {
      id: "code-review@claude-plugins-official",
      marketplace: EXPO.marketplace,
    };
    const factory = { extraPlugins: [EXPO, other] };

    expect(run(factory, "plugins").out).toBe(
      "expo@claude-plugins-official\ncode-review@claude-plugins-official\n",
    );
    expect(run(factory, "marketplaces").out).toBe(`${EXPO.marketplace}\n`);
    expect(run(factory, "domains").out).toBe("mcp.expo.dev\n");
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
    ["un dominio raro", { ...EXPO, domains: ["mcp.expo.dev $(id)"] }],
    ["domains que no es lista", { ...EXPO, domains: "mcp.expo.dev" }],
  ])("rechaza %s y nombra extraPlugins", (_caso, plugin) => {
    const r = run({ extraPlugins: [plugin] }, "plugins");

    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("extraPlugins");
  });

  it("rechaza extraPlugins que no es lista", () => {
    const r = run({ extraPlugins: EXPO }, "plugins");

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("extraPlugins");
  });

  it("rechaza un modo desconocido", () => {
    expect(run({ extraPlugins: [EXPO] }, "todo").code).not.toBe(0);
  });
});
