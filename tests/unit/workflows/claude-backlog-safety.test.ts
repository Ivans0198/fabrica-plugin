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

  // El agente no mergea (hooks/worker-guard.sh). Las etiquetas del evento son
  // las de cuando se disparó la corrida: si el agente se pusiera auto-merge,
  // no contaría.
  it("el auto-merge lo pone el workflow después del agente, con las etiquetas del evento", () => {
    const merge = steps.find((s) => s.run?.includes("fabrica-automerge"));
    const net = steps.findIndex((s) => s.run?.includes("fabrica-check-done"));

    expect(merge?.if).toContain(
      "contains(github.event.issue.labels.*.name, 'auto-merge')",
    );
    expect(merge?.if).toMatch(/success\(\)/);
    expect(merge?.run).toMatch(/\.factory\/gate-gave-up/);
    expect(steps.indexOf(merge!)).toBeGreaterThan(net);
  });

  // Mergeado con github.token, GitHub no dispara workflows: no se cerraba la
  // issue ni corría labels-cleanup (fabrica-prueba #36, 2026-11-23).
  it("después de un auto-merge, cierra la issue y hace la limpieza de labels-cleanup", () => {
    const merge = steps.find((s) => s.run?.includes("fabrica-automerge"));

    expect(merge?.run).toMatch(/if fabrica-automerge "\$NUM"; then/);
    expect(merge?.run).toMatch(/gh issue close "\$NUM"/);
    expect(merge?.run).toContain('scripts/clear-blockers.sh" "$NUM"');
    expect(merge?.run).toContain('scripts/sync-epic-status.sh" "$NUM"');
  });

  it("el job puede leer los checks del PR, para esperarlos", () => {
    const job = Object.values(workflow.jobs)[0] as {
      permissions?: Record<string, string>;
    };

    expect(job.permissions?.checks).toBe("read");
    expect(job.permissions?.statuses).toBe("read");
  });

  it("la espera del auto-merge tiene su plazo y cabe en el del job", () => {
    const job = Object.values(workflow.jobs)[0];
    const merge = steps.find((s) => s.run?.includes("fabrica-automerge"));

    expect(merge?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(
      agent!["timeout-minutes"]! + merge!["timeout-minutes"]!,
    ).toBeLessThan(job["timeout-minutes"]!);
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
// En un re-run, GITHUB_ACTOR sigue siendo quien disparó la corrida: otra
// persona gastaba su suscripción (revisión del 2026-11-23).
describe("la credencial en un re-run", () => {
  it.each(["claude-backlog.yml", "claude-mentions.yml"])(
    "%s no usa el token de otra persona si la re-ejecuta alguien distinto",
    (file) => {
      const text = readFileSync(
        path.join(REPO_ROOT, ".github/workflows", file),
        "utf8",
      );

      expect(text).toMatch(
        /"\$\{GITHUB_TRIGGERING_ACTOR:-\$GITHUB_ACTOR\}" != "\$GITHUB_ACTOR"/,
      );
    },
  );
});

// actions/checkout v7 guarda su credencial con includeIf.gitdir, y
// claude-code-action solo la quita de include.path: git empujaba con
// github.token, y esos pushes quedan en action_required sin correr los checks
// (fabrica-prueba #39, 2026-11-23). Sin credencial guardada, git usa la de la
// App que configura la action.
describe("el checkout del proyecto en la nube", () => {
  it.each(["claude-backlog.yml", "claude-mentions.yml"])(
    "%s no guarda la credencial del workflow",
    (file) => {
      const wf = load(
        readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf8"),
      ) as { jobs: Record<string, { steps: Step[] }> };
      const checkout = Object.values(wf.jobs)
        .flatMap((job) => job.steps)
        .find(
          (s) => s.uses?.startsWith("actions/checkout") && !s.with?.repository,
        );

      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    },
  );

  // Sin credencial, la action no pudo traer la rama de un PR: hace ese fetch
  // antes de poner su token (fabrica-prueba #43, 2026-11-24). Un extraheader
  // en .git/config sí lo quita la action antes de que corra Claude.
  it("claude-mentions.yml deja una credencial de lectura que la action quita", () => {
    const wf = load(
      readFileSync(
        path.join(REPO_ROOT, ".github/workflows/claude-mentions.yml"),
        "utf8",
      ),
    ) as { jobs: Record<string, { steps: Step[] }> };
    const all = Object.values(wf.jobs).flatMap((job) => job.steps);
    const header = all.findIndex((s) =>
      s.run?.includes(
        "git config --local http.${GITHUB_SERVER_URL}/.extraheader",
      ),
    );
    const action = all.findIndex((s) =>
      s.uses?.startsWith("anthropics/claude-code-action"),
    );

    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(action);
  });
});

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

// En refastidioso-web (PR #12, 2026-11-24) la mención tuvo que instalar
// Chromium a mano para correr el e2e: claude-backlog.yml lo traía y
// claude-mentions.yml no.
describe("el navegador de los tests de UI en la nube", () => {
  it.each(["claude-backlog.yml", "claude-mentions.yml"])(
    "%s instala Chromium si el proyecto tiene playwright.config, antes del agente",
    (file) => {
      const wf = load(
        readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf8"),
      ) as { jobs: Record<string, { steps: Step[] }> };
      const all = Object.values(wf.jobs).flatMap((job) => job.steps);
      const install = all.findIndex((s) =>
        s.run?.includes("npx playwright install --with-deps chromium"),
      );
      const agentAt = all.findIndex((s) =>
        s.uses?.startsWith("anthropics/claude-code-action"),
      );

      expect(install, file).toBeGreaterThan(-1);
      expect(all[install]?.if).toContain("hashFiles('playwright.config.*')");
      expect(install).toBeLessThan(agentAt);
    },
  );
});
