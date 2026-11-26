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

  it("el paso deja los plugins y los marketplaces clonados en su commit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extra-plugins-wf-"));
    temps.push(dir);
    // Un marketplace de mentira; la URL de GitHub apunta a él, como lo haría
    // git en la CI.
    const market = path.join(dir, "market");
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: market, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["init", "-q", market]);
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(path.join(market, "v.txt"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "v1");
    const ref = git("rev-parse", "HEAD");
    const work = path.join(dir, "work");
    spawnSync("mkdir", ["-p", work]);
    const output = path.join(dir, "out");
    writeFileSync(output, "");
    writeFileSync(
      path.join(work, "factory.json"),
      JSON.stringify({
        extraPlugins: [
          {
            id: "expo@claude-plugins-official",
            marketplace: "https://github.com/acme/market.git",
            ref,
          },
        ],
      }),
    );

    const result = spawnSync(
      "bash",
      ["-eo", "pipefail", "-c", all[at].run ?? ""],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          FABRICA: PLUGIN_ROOT,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: dir,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${market}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/acme/market.git",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      [
        "plugins<<FABRICA_EOF",
        "expo@claude-plugins-official",
        "FABRICA_EOF",
        "marketplaces<<FABRICA_EOF",
        `${dir}/extra-marketplaces/marketplace-1`,
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
