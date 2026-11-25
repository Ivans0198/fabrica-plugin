import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/**
 * Cada proyecto tiene llamadas cortas a los reusable workflows del plugin. Un
 * input mal escrito o un permiso que falta no falla en ningún test de script:
 * falla en GitHub, en el primer PR del proyecto. Esto fija el contrato entre
 * los dos lados sin GitHub.
 */

const CALLERS_DIR = path.join(TEMPLATES_ROOT, ".github/workflows");
const REUSABLE_DIR = path.join(REPO_ROOT, ".github/workflows");
const CALLERS = readdirSync(CALLERS_DIR).filter((f) => f.endsWith(".yml"));

const MARKETPLACE = (
  JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
      "utf8",
    ),
  ) as { name: string }
).name;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: string | Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on: {
    workflow_call?: {
      inputs?: Record<string, { required?: boolean }>;
      secrets?: Record<string, { required?: boolean }>;
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function parse(file: string): Workflow {
  return load(readFileSync(file, "utf8")) as Workflow;
}

function callerJob(caller: string): Job {
  const jobs = Object.values(parse(path.join(CALLERS_DIR, caller)).jobs);
  expect(jobs, `${caller} debería tener un solo job`).toHaveLength(1);
  return jobs[0]!;
}

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

describe.each(CALLERS)("llamada %s", (caller) => {
  const reusablePath = path.join(REUSABLE_DIR, caller);

  it("llama al reusable workflow del mismo nombre, en el repo y el tag que pone fabrica-setup", () => {
    expect(callerJob(caller).uses).toBe(
      `__FABRICA_REPO__/.github/workflows/${caller}@__FABRICA_REF__`,
    );
    expect(existsSync(reusablePath)).toBe(true);
    expect(parse(reusablePath).on.workflow_call).toBeDefined();
  });

  it("le pasa el repo y el tag del plugin, para que traiga los scripts de esa misma versión", () => {
    expect(callerJob(caller).with).toMatchObject({
      fabrica_repo: "__FABRICA_REPO__",
      fabrica_ref: "__FABRICA_REF__",
    });
  });

  it("solo pasa inputs que el reusable declara, y todos los obligatorios", () => {
    const declared = parse(reusablePath).on.workflow_call?.inputs ?? {};
    const passed = Object.keys(callerJob(caller).with ?? {});

    for (const input of passed) {
      expect(Object.keys(declared), `${caller} pasa ${input}`).toContain(input);
    }
    for (const [input, spec] of Object.entries(declared)) {
      if (spec.required)
        expect(passed, `${caller} omite ${input}`).toContain(input);
    }
  });

  it("concede a cada job del reusable los permisos que pide", () => {
    // Un reusable solo puede bajar los permisos del que lo llama, nunca subirlos.
    // Los permisos de un job reemplazan a los del workflow, no se suman.
    const granted = parse(path.join(CALLERS_DIR, caller)).permissions ?? {};
    const reusable = parse(reusablePath);
    for (const [name, job] of Object.entries(reusable.jobs)) {
      const wanted = job.permissions ?? reusable.permissions ?? {};
      for (const [scope, level] of Object.entries(wanted)) {
        expect(
          LEVEL[granted[scope] ?? "none"],
          `${caller}: el job ${name} pide ${scope}: ${level}`,
        ).toBeGreaterThanOrEqual(LEVEL[level]!);
      }
    }
  });
});

describe("reusable workflows", () => {
  const reusables = readdirSync(REUSABLE_DIR).filter((file) =>
    CALLERS.includes(file),
  );

  it.each(reusables)(
    "%s trae el plugin sin dejar credenciales en el disco",
    (file) => {
      const steps = Object.values(
        parse(path.join(REUSABLE_DIR, file)).jobs,
      ).flatMap((job) => job.steps ?? []);
      const pluginCheckouts = steps.filter(
        (s) => s.with?.repository === "${{ inputs.fabrica_repo }}",
      );

      expect(pluginCheckouts.length, file).toBeGreaterThan(0);
      for (const checkout of pluginCheckouts) {
        expect(checkout.with?.ref).toBe("${{ inputs.fabrica_ref }}");
        expect(checkout.with?.["persist-credentials"]).toBe(false);
      }
    },
  );

  it.each(reusables)(
    "%s corre los scripts del plugin solo después de traerlo, en cada job",
    (file) => {
      for (const [name, job] of Object.entries(
        parse(path.join(REUSABLE_DIR, file)).jobs,
      )) {
        const steps = job.steps ?? [];
        const fetched = steps.findIndex(
          (s) => s.with?.repository === "${{ inputs.fabrica_repo }}",
        );
        steps.forEach((step, index) => {
          const usesPlugin =
            /fabrica-cmd|\$FABRICA|\.fabrica-plugin\/plugins/.test(
              step.run ?? "",
            );
          if (usesPlugin) {
            expect(
              fetched,
              `${file} → ${name}: "${step.name ?? step.run}"`,
            ).toBeGreaterThanOrEqual(0);
            expect(index).toBeGreaterThan(fetched);
          }
        });
      }
    },
  );

  it.each(["claude-backlog.yml", "claude-mentions.yml"])(
    "%s instala el plugin de la copia fijada, no de la última versión",
    (file) => {
      const action = Object.values(parse(path.join(REUSABLE_DIR, file)).jobs)
        .flatMap((job) => job.steps ?? [])
        .find((s) => s.uses?.startsWith("anthropics/claude-code-action"));

      expect(action?.with?.plugin_marketplaces).toBe(
        "${{ runner.temp }}/fabrica-plugin",
      );
      expect(action?.with?.plugins).toBe(`fabrica@${MARKETPLACE}`);
    },
  );

  it("checks avisa en vez de pasar callado cuando el proyecto no tiene factory.json", () => {
    const steps = parse(path.join(REUSABLE_DIR, "checks.yml")).jobs.checks!
      .steps!;
    const detect = steps.find((s) => /factory\.json/.test(s.run ?? ""));

    expect(detect?.run).toMatch(/::warning[^\n]*factory\.json/);
  });

  it("los workers buscan el token de cada persona por nombre, sin mapa en el workflow", () => {
    for (const file of ["claude-backlog.yml", "claude-mentions.yml"]) {
      const source = readFileSync(path.join(REUSABLE_DIR, file), "utf8");
      expect(source, file).toContain('KEY="CLAUDE_TOKEN_$A"');
      expect(source, file).not.toMatch(/TOK_[A-Z]/);
    }
  });

  it("solo backlog y menciones reciben todos los secretos del proyecto", () => {
    for (const caller of CALLERS) {
      const { secrets } = callerJob(caller);
      if (["claude-backlog.yml", "claude-mentions.yml"].includes(caller)) {
        expect(secrets, caller).toBe("inherit");
      } else if (caller === "visual-baselines.yml") {
        expect(secrets, caller).toEqual({
          FABRICA_PLUGIN_TOKEN: "${{ secrets.FABRICA_PLUGIN_TOKEN }}",
          FABRICA_PUSH_TOKEN: "${{ secrets.FABRICA_PUSH_TOKEN }}",
        });
      } else {
        expect(secrets, caller).toEqual({
          FABRICA_PLUGIN_TOKEN: "${{ secrets.FABRICA_PLUGIN_TOKEN }}",
        });
      }
    }
  });
});
