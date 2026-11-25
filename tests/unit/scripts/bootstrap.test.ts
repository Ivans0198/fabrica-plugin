import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT } from "../../support/plugin-paths";

/**
 * bootstrap.sh instalaba siempre con `npm install`, también en un proyecto
 * que pide pnpm en `packageManager` (truckconnect-mobile, 2026-11-26).
 */

const SCRIPT = path.join(PLUGIN_ROOT, "scripts/bootstrap.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(
  packageJson: object,
  commands = ["gh", "npm", "npx", "pnpm"],
): { code: number | null; calls: string[]; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fabrica-bootstrap-"));
  temps.push(dir);
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  for (const cmd of commands) {
    const file = path.join(bin, cmd);
    writeFileSync(file, `#!/bin/sh\necho "${cmd} $*" >> "${log}"\n`);
    chmodSync(file, 0o755);
  }
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson));
  // Solo lo del sistema y los comandos falsos: un pnpm o npm de verdad no
  // se cuela desde el PATH de quien corre los tests.
  const system = ["/usr/bin", "/bin"].join(":");
  const result = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { HOME: dir, PATH: `${bin}:${system}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return { code: result.status, calls, stderr: result.stderr };
}

describe("bootstrap.sh instala con el gestor del proyecto", () => {
  it("sin packageManager, con npm", () => {
    const { code, calls } = run({});

    expect(code).toBe(0);
    expect(calls).toContain("npm install");
    expect(calls.some((c) => c.startsWith("pnpm"))).toBe(false);
  });

  it("con packageManager pnpm@, con pnpm", () => {
    const { code, calls } = run({ packageManager: "pnpm@10.4.1" });

    expect(code).toBe(0);
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("npm install");
  });

  it("pide pnpm sin tenerlo: falla antes de instalar y dice cómo conseguirlo", () => {
    const { code, calls, stderr } = run({ packageManager: "pnpm@10.4.1" }, [
      "gh",
      "npm",
      "npx",
    ]);

    expect(code).not.toBe(0);
    expect(calls.filter((c) => !c.startsWith("gh "))).toEqual([]);
    expect(stderr).toContain("npm install -g pnpm@10.4.1");
  });
});
