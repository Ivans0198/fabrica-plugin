import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../support/plugin-paths";

/**
 * La primera corrida real en la nube (fabrica-prueba, 2026-11-16) terminó en
 * verde sin PR y dejó la issue en `in-progress`: el aviso de falla solo
 * corre si el job falla, y la transcripción del agente quedó dentro del
 * runner, sin forma de ver qué hizo.
 */

interface Step {
  name?: string;
  id?: string;
  "timeout-minutes"?: number;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}

const workflow = load(
  readFileSync(
    path.join(REPO_ROOT, ".github/workflows/claude-backlog.yml"),
    "utf8",
  ),
) as {
  jobs: Record<string, { steps: Step[]; "timeout-minutes"?: number }>;
};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const agent = steps.find((s) =>
  s.uses?.startsWith("anthropics/claude-code-action"),
);

describe("claude-backlog.yml después del agente", () => {
  it("el paso del agente tiene id, para leer sus salidas", () => {
    expect(agent?.id).toBe("claude");
  });

  it("si el job quedó en verde sin PR, la issue va a needs-human con un motivo", () => {
    const net = steps.find((s) => s.run?.includes("fabrica-check-done"));

    expect(net?.if).toMatch(/success\(\)/);
    expect(net?.if).toMatch(/github\.event_name == 'issues'/);
    expect(net?.run).toMatch(
      /fabrica-check-done "\$NUM" \|\| fabrica-release "\$NUM" --needs-human/,
    );
  });

  // El gate se rinde dejando `.factory/gate-gave-up`; prohibir el PR es solo
  // texto de las reglas.
  it("si el Stop gate se rindió, la issue va a needs-human aunque haya PR", () => {
    const net = steps.find((s) => s.run?.includes("fabrica-check-done"));

    expect(net?.run).toMatch(
      /if \[ -f \.factory\/gate-gave-up \]; then\s+fabrica-release "\$NUM" --needs-human/,
    );
  });

  // Un job cancelado por su tope no corre ni el paso de success() ni el de
  // failure(): la issue quedaba en in-progress para siempre, sin comentario.
  it("si la corrida falla o se cancela, libera la issue como needs-human", () => {
    const note = steps.find((s) => s.if?.includes("failure()"));

    expect(note?.if).toMatch(/cancelled\(\)/);
    expect(note?.run).toMatch(/fabrica-release "\$NUM" --needs-human/);
    expect(note?.run).toContain("actions/runs/$GITHUB_RUN_ID");
  });

  it("el agente tiene su propio tope, por debajo del del job, para que el aviso alcance a correr", () => {
    const job = Object.values(workflow.jobs)[0];

    expect(agent?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(agent!["timeout-minutes"]!).toBeLessThan(job["timeout-minutes"]!);
  });

  it("sube la transcripción del agente como artefacto, aunque la corrida falle", () => {
    const upload = steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact"),
    );

    expect(upload?.if).toMatch(/always\(\)/);
    expect(String(upload?.with?.path)).toContain(
      "steps.claude.outputs.execution_file",
    );
    expect(Number(upload?.with?.["retention-days"])).toBeLessThanOrEqual(7);
  });
});

describe("los agentes de la nube", () => {
  it.each(["claude-backlog.yml", "claude-mentions.yml"])(
    "%s corre los subagentes en primer plano, o la sesión termina sin la respuesta del revisor",
    (file) => {
      const wf = load(
        readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf8"),
      ) as {
        jobs: Record<
          string,
          { steps: (Step & { env?: Record<string, string> })[] }
        >;
      };
      const step = Object.values(wf.jobs)
        .flatMap((job) => job.steps)
        .find((s) => s.uses?.startsWith("anthropics/claude-code-action"));

      expect(step?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    },
  );
});

// La etiqueta solo miraba su propio nombre: la nube tomaba una issue
// bloqueada o asignada a otra persona, y gastaba la instalación y el agente.
describe("claude-backlog.yml antes del agente", () => {
  const gateIndex = steps.findIndex((s) => s.id === "gate");

  it("revisa si la issue se puede tomar antes de instalar nada", () => {
    const gate = steps[gateIndex];
    const install = steps.findIndex(
      (s) => s.name === "Dependencias del proyecto",
    );

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(install);
    expect(gate?.if).toMatch(/github\.event_name == 'issues'/);
    expect(gate?.run).toContain(
      'fabrica-eligible "$NUM" --actor "$GITHUB_ACTOR"',
    );
  });

  it("si no se puede tomar, ningún paso siguiente corre", () => {
    for (const step of steps.slice(gateIndex + 1)) {
      expect(step.if, step.name ?? step.uses).toContain(
        "steps.gate.outputs.skip != 'true'",
      );
    }
  });
});
