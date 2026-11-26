import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * copy_env_files copiaba los .env reales a cada worktree. Con
 * bypassPermissions no hay nadie que vea un `cat .env` y la red de GitHub
 * queda abierta: el worker podía sacar los secretos en un comentario
 * (revisión del 2026-11-26). En ese modo no se copian.
 */

const LIB = pluginFile("scripts/lib/backlog-queue.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "copy-env-"));
  temps.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, ".env"), "API_KEY=secreto\n");
  writeFileSync(path.join(dir, ".env.local"), "OTRA=secreta\n");
  mkdirSync(path.join(dir, ".claude/worktrees/impl-5"), { recursive: true });
  const r = spawnSync("bash", ["-c", `source "${LIB}"; copy_env_files 5`], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const wt = path.join(dir, ".claude/worktrees/impl-5");
  return {
    code: r.status,
    err: r.stderr,
    copied: [".env", ".env.local"].filter((f) => existsSync(path.join(wt, f))),
  };
}

describe("copy_env_files", () => {
  it("en modo auto copia los .env al worktree", () => {
    const r = run({ PERMISSION_MODE: "auto" });

    expect(r.code, r.err).toBe(0);
    expect(r.copied).toEqual([".env", ".env.local"]);
  });

  it("con bypassPermissions no copia ninguno y lo dice", () => {
    const r = run({ PERMISSION_MODE: "bypassPermissions" });

    expect(r.code, r.err).toBe(0);
    expect(r.copied).toEqual([]);
    expect(r.err).toMatch(/bypassPermissions/);
    expect(r.err).toMatch(/FABRICA_COPY_ENV=1/);
  });

  it("con bypassPermissions y FABRICA_COPY_ENV=1 los copia", () => {
    const r = run({
      PERMISSION_MODE: "bypassPermissions",
      FABRICA_COPY_ENV: "1",
    });

    expect(r.copied).toEqual([".env", ".env.local"]);
  });
});
