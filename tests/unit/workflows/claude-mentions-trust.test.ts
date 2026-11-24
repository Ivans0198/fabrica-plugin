import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../support/plugin-paths";

/**
 * claude-code-action niega npm, node, los tests y los intérpretes en un PR
 * cuyo autor no tiene escritura, y un bot nunca la tiene: en los PRs de la
 * fábrica, @claude no podía reproducir lo que el Stop gate sí corre
 * (fabrica-prueba #43, 2026-11-24). Se apaga solo para los PRs que abrió
 * claude[bot] desde una rama del mismo repo.
 */

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

const steps = Object.values(
  (
    load(
      readFileSync(
        path.join(REPO_ROOT, ".github/workflows/claude-mentions.yml"),
        "utf8",
      ),
    ) as { jobs: Record<string, { steps: Step[] }> }
  ).jobs,
).flatMap((job) => job.steps);
const trust = steps.find((s) => s.id === "trust");
const action = steps.find((s) =>
  s.uses?.startsWith("anthropics/claude-code-action"),
);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * Corre el paso con un gh que contesta `info` por el PR (o falla si es null)
 * y `perm` por el permiso de su autor.
 */
function runTrust(
  prNumber: string,
  info: string | null,
  perm = "read",
): { restrict: string; hooks: string; calls: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mentions-trust-"));
  temps.push(dir);
  const gh = path.join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${dir}/calls"`,
      'case "$*" in',
      `  *"/permission"*) printf '%s\\n' '${perm}' ;;`,
      info === null ? "  *) exit 1 ;;" : `  *) printf '%s\\n' '${info}' ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const output = path.join(dir, "output");
  writeFileSync(output, "");
  writeFileSync(path.join(dir, "calls"), "");
  const result = spawnSync("bash", ["-e", "-c", trust?.run ?? "exit 9"], {
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "dueno/proyecto",
      PR_NUMBER: prNumber,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const out = readFileSync(output, "utf8");
  const value = (key: string) =>
    new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1] ?? "<falta>";
  return {
    restrict: value("restrict"),
    hooks: value("hooks"),
    calls: readFileSync(path.join(dir, "calls"), "utf8"),
  };
}

describe("claude-mentions.yml y los PRs de la fábrica", () => {
  it("la action recibe lo que decide el paso trust", () => {
    expect(action?.with?.restrict_untrusted_prs).toBe(
      "${{ steps.trust.outputs.restrict }}",
    );
    expect(steps.indexOf(trust as Step)).toBeLessThan(
      steps.indexOf(action as Step),
    );
  });

  it("quita la restricción en un PR de claude[bot] desde el mismo repo", () => {
    expect(runTrust("43", "claude[bot] Bot dueno/proyecto").restrict).toBe(
      "false",
    );
  });

  it.each([
    ["un PR de claude[bot] desde un fork", "claude[bot] Bot otro/proyecto"],
    ["un PR de una persona", "alguien User dueno/proyecto"],
    ["un usuario que se llama parecido", "claude User dueno/proyecto"],
  ])("la deja en %s", (_name, info) => {
    expect(runTrust("43", info).restrict).toBe("true");
  });

  it("la deja si no pudo preguntar por el PR", () => {
    expect(runTrust("43", null).restrict).toBe("true");
  });

  it("en un issue no pregunta nada y la deja", () => {
    const { restrict, hooks, calls } = runTrust(
      "",
      "claude[bot] Bot dueno/proyecto",
    );

    expect(restrict).toBe("true");
    expect(hooks).toBe("");
    expect(calls).toBe("");
  });
});

// La action repone .claude/ desde la base en un PR, pero no factory.json: los
// hooks de la fábrica correrían los comandos que la rama del PR nombra, con
// las credenciales del job, aunque la action le niegue npm a Claude. En un PR
// que la action tampoco confía, el gate y el lint no corren.
describe("los hooks de la fábrica en las menciones", () => {
  it.each([
    [
      "un PR de claude[bot] del mismo repo",
      "claude[bot] Bot dueno/proyecto",
      "read",
    ],
    [
      "un PR de una persona con escritura",
      "alguien User dueno/proyecto",
      "write",
    ],
    ["un PR de una persona admin", "alguien User dueno/proyecto", "admin"],
  ])("corren en %s", (_name, info, perm) => {
    expect(runTrust("43", info, perm).hooks).toBe("");
  });

  it.each([
    [
      "un PR de claude[bot] desde un fork",
      "claude[bot] Bot otro/proyecto",
      "read",
    ],
    [
      "un PR de una persona sin escritura",
      "alguien User otro/proyecto",
      "read",
    ],
    ["un PR de otro bot", "dependabot[bot] Bot dueno/proyecto", "write"],
  ])("se apagan en %s", (_name, info, perm) => {
    expect(runTrust("43", info, perm).hooks).toBe("off");
  });

  it("se apagan si no pudo preguntar por el PR", () => {
    expect(runTrust("43", null).hooks).toBe("off");
  });

  it("la action recibe el interruptor, la base y la marca de worker", () => {
    const env = action?.env ?? {};

    expect(env.FACTORY_GATE).toBe("${{ steps.trust.outputs.hooks }}");
    expect(env.FACTORY_LINT).toBe("${{ steps.trust.outputs.hooks }}");
    expect(env.FABRICA_WORKER).toBe("1");
    expect(env.FABRICA_BASE).toBe("${{ env.FABRICA_BASE }}");
  });
});
