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
import { pluginFile } from "../../support/plugin-paths";

/**
 * Sin branch protection (un repo privado sin GitHub Pro) nada frena un push
 * a main, y worker-guard.sh se salta con comillas (revisión del 2026-11-26).
 * La persona decidió no pagar Pro todavía: la fábrica no lo frena, avisa.
 * Cada push a main se mira commit por commit, y lo que no vino de un PR
 * mergeado abre una issue (o comenta la que ya está abierta).
 */

const SCRIPT = pluginFile("scripts/main-push-check.sh");
const BEFORE = "b".repeat(40);
const AFTER = "a".repeat(40);
const LOOSE = "c".repeat(40);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  env: Record<string, string> = {},
): { code: number | null; out: string; err: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "main-push-"));
  temps.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
jqexpr=""; prev=""
for a in "$@"; do [ "$prev" = --jq ] && jqexpr="$a"; prev="$a"; done
answer() { if [ -n "$jqexpr" ]; then jq -r "$jqexpr" <<<"$1"; else echo "$1"; fi; }
case "$1 $2" in
  "api repos/{owner}/{repo}/compare/"*) answer "\${FAKE_COMPARE:-{\\"commits\\":[]\\}}" ;;
  "api repos/{owner}/{repo}/commits/"*)
    sha=$(sed -E 's#.*/commits/([0-9a-f]+)/pulls#\\1#' <<<"$2")
    var="FAKE_PULLS_$sha"; answer "\${!var:-[]}" ;;
  "issue list") echo "\${FAKE_OPEN_ISSUE:-}" ;;
  "issue create") echo "https://github.com/acme/app/issues/99" ;;
esac
exit 0
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTOR: "ivan",
    },
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    log: readFileSync(log, "utf8"),
  };
}

const compare = (...shas: string[]) =>
  JSON.stringify({
    commits: shas.map((sha) => ({
      sha,
      commit: { message: `feat: commit ${sha.slice(0, 3)}\n\ncuerpo` },
    })),
  });
const merged = JSON.stringify([
  { number: 17, merged_at: "2026-11-26T06:30:00Z" },
]);
const open = JSON.stringify([{ number: 18, merged_at: null }]);

describe("main-push-check.sh", () => {
  it("un push que es el merge de un PR no avisa", () => {
    const r = run([BEFORE, AFTER], {
      FAKE_COMPARE: compare(AFTER),
      [`FAKE_PULLS_${AFTER}`]: merged,
    });

    expect(r.code, r.err).toBe(0);
    expect(r.log).not.toMatch(/issue (create|comment)/);
  });

  it("un commit sin PR mergeado abre una issue con el commit y quién empujó", () => {
    const r = run([BEFORE, AFTER], {
      FAKE_COMPARE: compare(LOOSE, AFTER),
      [`FAKE_PULLS_${LOOSE}`]: open,
      [`FAKE_PULLS_${AFTER}`]: merged,
    });

    expect(r.code, r.err).toBe(0);
    expect(r.log).toMatch(/label create direct-push/);
    expect(r.log).toMatch(/issue create .*--label direct-push/s);
    expect(r.log).toContain("`ccccccc`");
    expect(r.log).toContain("feat: commit ccc");
    expect(r.log).not.toContain("`aaaaaaa`");
    expect(r.log).toContain("ivan");
    expect(r.out).toMatch(/⚠/);
  });

  it("si ya hay una issue abierta, comenta en ella en vez de abrir otra", () => {
    const r = run([BEFORE, AFTER], {
      FAKE_COMPARE: compare(AFTER),
      FAKE_OPEN_ISSUE: "42",
    });

    expect(r.log).toMatch(/issue comment 42/);
    expect(r.log).not.toMatch(/issue create/);
  });

  it("una rama nueva (before en ceros) no tiene con qué comparar", () => {
    const r = run(["0".repeat(40), AFTER]);

    expect(r.code).toBe(0);
    expect(r.log).toBe("");
  });

  it("rechaza argumentos que no son SHA", () => {
    expect(run(["main", AFTER]).code).not.toBe(0);
    expect(run([BEFORE, "$(id)"]).code).not.toBe(0);
  });
});
