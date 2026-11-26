import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { PLUGIN_ROOT } from "../../support/plugin-paths";

/**
 * El modo auto negó `gh issue create` para la épica de truckconnect-mobile
 * justo después del OK de la persona (2026-11-26), y en refastidioso lo dejó
 * pasar: depende del clasificador. fabrica-epic crea solo épicas, y es lo que
 * permite settings.json.
 */

const BIN = path.join(PLUGIN_ROOT, "bin/fabrica-epic");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "fabrica-epic-"));
  temps.push(dir);
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const log = path.join(dir, "gh.log");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "issue create" ]; then echo "https://github.com/o/r/issues/12"; fi
exit 0
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(dir, "cuerpo.md"), "La spec va en specs/12-x/.\n");
  const r = spawnSync("bash", [BIN, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

describe("fabrica-epic", () => {
  it("crea la épica con la etiqueta epic e imprime su número", () => {
    const r = run(["create", "[Epic] Favoritos", "cuerpo.md"]);

    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe("12");
    expect(r.calls).toContain("label create epic");
    expect(r.calls).toMatch(
      /issue create --title \[Epic\] Favoritos --body-file cuerpo\.md --label epic/,
    );
  });

  it.each([
    ["un título sin [Epic]", ["create", "Favoritos", "cuerpo.md"]],
    ["un cuerpo que no existe", ["create", "[Epic] Favoritos", "no.md"]],
    ["otro subcomando", ["delete", "12"]],
    ["sin argumentos", []],
  ])("rechaza %s sin llamar a gh issue", (_caso, args) => {
    const r = run(args);

    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain("issue create");
  });

  it("la plantilla de settings.json lo permite", () => {
    const settings = JSON.parse(
      readFileSync(
        path.join(PLUGIN_ROOT, "templates/.claude/settings.json"),
        "utf8",
      ),
    ) as { permissions: { allow: string[] } };

    expect(settings.permissions.allow).toContain("Bash(fabrica-epic:*)");
  });

  it("el skill de spec crea la épica con fabrica-epic, no con gh issue create", () => {
    const skill = readFileSync(
      path.join(PLUGIN_ROOT, "skills/spec/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain('fabrica-epic create "[Epic] <nombre>"');
    expect(skill).not.toMatch(/^\s*gh issue create/m);
  });
});
