import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Un worker commitea, sube la rama y después abre el PR: cuando llega el Stop
 * gate, sus commits ya están subidos y arreglarlos pediría --force. Este hook
 * los revisa antes del git push, en cualquier sesión, si factory.json →
 * commitFormat es "conventional" (decidido el 2026-11-26).
 */

const HOOK = pluginFile(".claude/hooks/commit-format.sh");
const TIMEOUT = 20_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, script: string): void {
  const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** Un repo con origin, main subido y la rama impl-7 con un commit sin subir. */
function repo(format: string | null, subject: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "commit-format-"));
  temps.push(root);
  const work = path.join(root, "work");
  sh(
    root,
    `git init -q --bare origin.git && git init -q work && cd work
     git remote add origin ../origin.git
     git config user.email t@example.com && git config user.name T`,
  );
  writeFileSync(
    path.join(work, "factory.json"),
    JSON.stringify(format ? { commitFormat: format } : {}),
  );
  sh(
    work,
    `git add -A && git commit -qm "chore: init" && git push -q -u origin HEAD:main
     git checkout -q -b impl-7
     echo x > a.txt && git add a.txt && git commit -qm "${subject}"`,
  );
  return work;
}

function hook(cwd: string, command: string) {
  const r = spawnSync("bash", [HOOK], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
  });
  return { code: r.status, err: r.stderr };
}

describe("commit-format.sh", () => {
  it(
    "bloquea un git push con un commit que no cumple, y dice cómo arreglarlo",
    () => {
      const work = repo("conventional", "cambia a");

      const r = hook(work, "git push -u origin impl-7");

      expect(r.code).toBe(2);
      expect(r.err).toContain("cambia a");
      expect(r.err).toContain("git commit --amend");
    },
    TIMEOUT,
  );

  it(
    "lo ve también encadenado a otros comandos",
    () => {
      const work = repo("conventional", "cambia a");

      expect(hook(work, "npm test && git push origin impl-7").code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "deja pasar el push si todos cumplen",
    () => {
      const work = repo("conventional", "feat(a): add a");

      expect(hook(work, "git push -u origin impl-7").code).toBe(0);
    },
    TIMEOUT,
  );

  it.each([
    ["un comando que no es push", "git status"],
    ["un push escrito dentro de un texto", 'echo "git push origin impl-7"'],
  ])(
    "no se mete con %s",
    (_caso, command) => {
      const work = repo("conventional", "cambia a");

      expect(hook(work, command).code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "sin commitFormat no exige nada",
    () => {
      const work = repo(null, "cambia a");

      expect(hook(work, "git push -u origin impl-7").code).toBe(0);
    },
    TIMEOUT,
  );
});
