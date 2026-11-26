import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * El prompt de despacho está en inglés, y las reglas piden contestar en el
 * idioma del pedido cuando dudan: el resumen final de #7 salió en inglés con
 * docLang es (truckconnect-mobile, 2026-11-26). El prompt nombra el idioma.
 */

const SCRIPT = pluginFile("scripts/worker-prompt.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function prompt(factory: object | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-prompt-"));
  temps.push(dir);
  if (factory)
    writeFileSync(path.join(dir, "factory.json"), JSON.stringify(factory));
  const r = spawnSync("bash", [SCRIPT, "one", "7"], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("worker-prompt.sh", () => {
  it("con docLang es pide el resumen final en español", () => {
    const r = prompt({ docLang: "es" });

    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/fabrica-claim 7/);
    expect(r.out).toMatch(/final summary.*in Spanish/);
  });

  it("con docLang en, en inglés", () => {
    expect(prompt({ docLang: "en" }).out).toMatch(/final summary.*in English/);
  });

  it("sin docLang no nombra un idioma", () => {
    for (const factory of [null, {}]) {
      const r = prompt(factory);
      expect(r.code, r.err).toBe(0);
      expect(r.out).not.toMatch(/final summary/);
    }
  });
});
