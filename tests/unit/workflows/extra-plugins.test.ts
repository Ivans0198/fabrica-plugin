import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * La nube instalaba solo fabrica: un proyecto que suma el plugin de Expo lo
 * tenía en el host y no en la nube (truckconnect-mobile, 2026-11-26). Los dos
 * workflows que corren a Claude leen factory.json → extraPlugins y se los
 * pasan a la action junto a fabrica.
 */

const STEP = "Lee los plugins extra de factory.json";
const MODEL_STEP = "Lee el modelo del worker de factory.json";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

function steps(file: string): Step[] {
  const wf = load(
    readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf8"),
  ) as { jobs: Record<string, { steps?: Step[] }> };
  return Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe.each(["claude-backlog.yml", "claude-mentions.yml"])("%s", (file) => {
  const all = steps(file);
  const at = all.findIndex((s) => s.name === STEP);
  const action = all.findIndex((s) =>
    s.uses?.startsWith("anthropics/claude-code-action@"),
  );

  it("lee los plugins extra después del modelo, con su misma condición, y antes de la action", () => {
    const model = all.findIndex((s) => s.name === MODEL_STEP);

    expect(at).toBeGreaterThan(model);
    expect(at).toBeLessThan(action);
    expect(all[at].id).toBe("extra");
    expect(all[at].if).toBe(all[model].if);
  });

  it("la action recibe fabrica y los extra, con sus marketplaces", () => {
    const inputs = all[action].with ?? {};

    expect(inputs.plugins.split("\n").map((l) => l.trim())).toEqual([
      "fabrica@fabrica-local",
      "${{ steps.extra.outputs.plugins }}",
      "",
    ]);
    expect(inputs.plugin_marketplaces.split("\n").map((l) => l.trim())).toEqual(
      [
        "${{ runner.temp }}/fabrica-plugin",
        "${{ steps.extra.outputs.marketplaces }}",
        "",
      ],
    );
  });

  it("el paso deja las dos listas en GITHUB_OUTPUT", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-plugins-wf-"));
    temps.push(dir);
    const output = path.join(dir, "out");
    writeFileSync(output, "");
    writeFileSync(
      path.join(dir, "factory.json"),
      JSON.stringify({
        extraPlugins: [
          {
            id: "expo@claude-plugins-official",
            marketplace:
              "https://github.com/anthropics/claude-plugins-official.git",
          },
        ],
      }),
    );

    const result = spawnSync(
      "bash",
      ["-eo", "pipefail", "-c", all[at].run ?? ""],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FABRICA: PLUGIN_ROOT, GITHUB_OUTPUT: output },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      [
        "plugins<<FABRICA_EOF",
        "expo@claude-plugins-official",
        "FABRICA_EOF",
        "marketplaces<<FABRICA_EOF",
        "https://github.com/anthropics/claude-plugins-official.git",
        "FABRICA_EOF",
        "",
      ].join("\n"),
    );
  });

  it("un extraPlugins inválido hace fallar el paso", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-plugins-wf-"));
    temps.push(dir);
    writeFileSync(path.join(dir, "out"), "");
    writeFileSync(
      path.join(dir, "factory.json"),
      JSON.stringify({ extraPlugins: [{ id: "x; rm -rf /" }] }),
    );

    const result = spawnSync(
      "bash",
      ["-eo", "pipefail", "-c", all[at].run ?? ""],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          FABRICA: PLUGIN_ROOT,
          GITHUB_OUTPUT: path.join(dir, "out"),
        },
      },
    );

    expect(result.status).not.toBe(0);
  });
});
