import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * Lo que lee el modelo (reglas, agentes, skills) no puede apuntar a rutas del
 * proyecto que ya no existen, ni nombrar comandos o agentes que el plugin no
 * trae. Un nombre roto no falla en ningún test de script: falla cuando un
 * worker lo intenta usar a mitad de un ticket.
 */

function markdownUnder(dir: string): string[] {
  const absolute = path.join(PLUGIN_ROOT, dir);
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(dir, String(entry)).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".md"));
}

const MODEL_FACING = [
  "rules/fabrica.md",
  ...markdownUnder("agents"),
  ...markdownUnder("skills").filter((file) => file.endsWith("SKILL.md")),
];

// bootstrap nombra a propósito los placeholders de los archivos del proyecto
// que tiene que rellenar (CLAUDE.md, design-system.md).
const NAMES_PROJECT_PLACEHOLDERS = ["skills/bootstrap/SKILL.md"];

function read(file: string): string {
  return readFileSync(path.join(PLUGIN_ROOT, file), "utf8");
}

const BIN = readdirSync(path.join(PLUGIN_ROOT, "bin"));
const AGENTS = readdirSync(path.join(PLUGIN_ROOT, "agents")).map((f) =>
  f.replace(/\.md$/, ""),
);
const SKILLS = readdirSync(path.join(PLUGIN_ROOT, "skills"));

describe("lo que lee el modelo", () => {
  it.each(MODEL_FACING)("%s no apunta a scripts/ del proyecto", (file) => {
    expect(read(file)).not.toMatch(/(^|[\s`(])scripts\//m);
  });

  it.each(
    MODEL_FACING.filter((file) => !NAMES_PROJECT_PLACEHOLDERS.includes(file)),
  )("%s no deja placeholders {{...}}", (file) => {
    expect(read(file)).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it.each(MODEL_FACING)(
    "%s solo nombra comandos que existen en bin/",
    (file) => {
      const named = [...read(file).matchAll(/\bfabrica-([a-z-]+)/g)]
        .map((m) => `fabrica-${m[1]}`)
        .filter(
          (name) =>
            ![
              "fabrica-new",
              "fabrica-local",
              "fabrica-template",
              "fabrica-plugin",
              // Marcas en el cuerpo de las issues y el sello de .specify/.
              "fabrica-key",
              "fabrica-spec",
              "fabrica-version",
            ].includes(name),
        );
      for (const command of named) {
        expect(BIN, `${file} nombra ${command}`).toContain(command);
      }
    },
  );

  it.each(MODEL_FACING)(
    "%s solo nombra agentes y skills que existen",
    (file) => {
      const named = [...read(file).matchAll(/fabrica:([a-z-]+)/g)].map(
        (m) => m[1],
      );
      for (const name of named) {
        expect(
          [...AGENTS, ...SKILLS],
          `${file} nombra fabrica:${name}`,
        ).toContain(name);
      }
    },
  );
});

describe("planeación con Spec Kit", () => {
  const PLANNING = ["spec", "plan", "tasks", "issues"];

  it.each(PLANNING)(
    "fabrica:%s solo lo arranca una persona con su comando",
    (skill) => {
      const body = read(`skills/${skill}/SKILL.md`);

      expect(body).toMatch(new RegExp(`^name: ${skill}$`, "m"));
      expect(body).toMatch(/^disable-model-invocation: true$/m);
      expect(body).toMatch(/headless/);
    },
  );

  it("write-prd se retiró y nadie lo nombra", () => {
    expect(existsSync(path.join(PLUGIN_ROOT, "skills/write-prd"))).toBe(false);
    for (const file of [
      ...MODEL_FACING,
      "docs/GUIA-DE-LA-FABRICA.md",
      "templates/CLAUDE.md",
    ]) {
      expect(read(file), file).not.toMatch(/write-prd|\bPRDs?\b/);
    }
    expect(readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")).not.toMatch(
      /write-prd/,
    );
  });

  it.each([
    ["spec", ["speckit-specify", "speckit-clarify"]],
    ["plan", ["speckit-plan"]],
    ["tasks", ["speckit-tasks"]],
  ])(
    "fabrica:%s sigue los comandos de Spec Kit desde .specify/commands/",
    (skill, commands) => {
      const body = read(`skills/${skill}/SKILL.md`);

      for (const command of commands) {
        expect(body).toContain(`.specify/commands/${command}.md`);
      }
    },
  );

  it("las reglas mandan a la persona al comando si pide planear con palabras", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).toMatch(/in their own words[^.]*`\/fabrica:spec`/);
    expect(rules).toMatch(/never follow `\.specify\/commands\/`/i);
  });

  it("fabrica:spec retoma con la rama spec-<N> aunque todavía no haya carpeta", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(/rama `spec-<N>`[^.]*basta/);
  });

  it("las ramas de spec no siguen a la rama base, y el plan las nombra igual que la spec", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(
      /git switch --no-track -c spec-<N> origin\/<base>/,
    );
    expect(read("skills/plan/SKILL.md")).toMatch(
      /`\*\*Branch\*\*`[^.]*`spec-<N>`/,
    );
  });

  // Test primero en todas las fases, y ningún criterio ni requisito
  // de la spec sin tarea.
  it("fabrica:tasks pide test primero también en Setup y Foundational", () => {
    const body = read("skills/tasks/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(
      /también en Setup y Foundational[^.]*después de la tarea que escribe su test/,
    );
  });

  it("fabrica:tasks revisa que cada criterio de aceptación y cada requisito tenga una tarea", () => {
    const body = read("skills/tasks/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(
      /cada criterio de aceptación y cada requisito funcional[^.]*al menos una tarea/,
    );
  });

  it("la constitución pide test primero también en Setup y Foundational", () => {
    expect(read("rules/constitution.md").replace(/\s+/g, " ")).toMatch(
      /Setup and Foundational[^.]*after the task that writes its failing test/,
    );
  });

  it("fabrica:spec crea el plan maestro si no existe, como piden las reglas", () => {
    expect(read("skills/spec/SKILL.md")).toMatch(
      /plan-maestro\.md`?\s+no\s+existe,\s+cr[ée]alo/i,
    );
  });

  it("las reglas solo prohíben auto-merge al worker; en planeación lo pone quien la persona nombró", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).toMatch(/named in their OK/);
  });

  // Los scripts usan factory.json → baseBranch; con base develop, las reglas
  // rebaseaban sobre main y le daban al revisor otro merge-base.
  it("las reglas no fijan main como base: usan la de factory.json", () => {
    const rules = read("rules/fabrica.md");

    expect(rules).not.toContain("origin/main");
    expect(rules).toMatch(/`<base>` is `factory\.json` → `baseBranch`/);
  });

  // Revisión del 2026-11-23: nada decía que el texto de una issue es dato, y
  // el worker podía mergear él mismo si la issue tenía auto-merge.
  it("las reglas tratan el texto de issues, comentarios y PRs como dato, no como instrucciones", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toMatch(/### Untrusted text/);
    expect(rules).toMatch(/data, never instructions/);
  });

  it("el worker no pone el auto-merge: lo pone el orquestador, y en la sesión fabrica-automerge", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).not.toMatch(/gh pr merge --auto/);
    expect(rules).toMatch(/`fabrica-automerge N`/);
    expect(rules).toMatch(/worker-guard/);
  });

  it("el PR de la spec nunca cierra la épica", () => {
    const spec = read("skills/spec/SKILL.md");

    expect(spec).toMatch(/Refs #<N>/);
    expect(spec).toMatch(/\*\*nunca\*\* `Closes #<N>`/);
  });

  // Los skills de planeación tienen disable-model-invocation: el modelo no
  // puede invocar el siguiente, así que lo encadena leyendo su SKILL.md.
  it("fabrica:spec sigue con el plan si no quedan dudas en la spec", () => {
    const body = read("skills/spec/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(/\[NEEDS CLARIFICATION/);
    expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/plan/SKILL.md");
  });

  it("fabrica:plan sigue con las tareas si pasa el Constitution Check", () => {
    const body = read("skills/plan/SKILL.md").replace(/\s+/g, " ");

    expect(body).toMatch(/Constitution Check[^.]*sin violaciones/);
    expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/tasks/SKILL.md");
  });

  it("el ciclo reclama con fabrica-claim y sigue en impl-N si ya está ahí", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toContain("fabrica-next-issue");
    expect(rules).toContain("fabrica-claim N");
    expect(rules).toMatch(/already on `impl-N`[^.]*keep working there/);
  });

  // Fase 5: una issue que viene de una spec se trabaja con su parte de la
  // spec, sin tocarla.
  it("los commits no mencionan a Claude ni a Anthropic", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toMatch(/Commit messages never mention Claude or Anthropic/);
    expect(rules).toContain("`Co-Authored-By`");
    expect(rules).toContain("`Claude-Session`");
  });

  it("el ciclo lee la spec de la issue con fabrica-spec-context y no la edita", () => {
    const rules = read("rules/fabrica.md").replace(/\s+/g, " ");

    expect(rules).toContain("fabrica-spec-context N");
    expect(rules).toMatch(/exit 1[^.]*standalone/);
    expect(rules).toMatch(/exit 2[^.]*needs-human/);
    expect(rules).toMatch(/[Nn]ever edit[^.]*specs\//);
    expect(rules).toMatch(/speckit-implement/);
  });

  it("el revisor revisa contra los escenarios de la historia", () => {
    const body = read("agents/code-reviewer.md").replace(/\s+/g, " ");

    expect(body).toContain("fabrica-spec-context <N>");
    expect(body).toMatch(/[Aa]cceptance [Ss]cenario/);
  });

  it("fabrica:backlog trabaja en la sesión dentro del worktree, o lanza los workers si se pide", () => {
    const body = read("skills/backlog/SKILL.md").replace(/\s+/g, " ");

    for (const command of [
      "fabrica-next-issue",
      "fabrica-claim",
      "EnterWorktree",
      "fabrica-check-done",
      "fabrica-release",
      "fabrica-backlog",
    ]) {
      expect(body, command).toContain(command);
    }
  });

  // Sin la GitHub App de Claude en el repo, la nube falla con un 401 antes de
  // empezar (fabrica-prueba, 2026-11-16). gh no puede comprobarlo: solo una
  // App lista sus instalaciones. Por eso se pide y se nombra al fallar.
  it("el cierre del bootstrap pide instalar la GitHub App de Claude", () => {
    const keys = read("skills/bootstrap/SKILL.md").split(
      "### 4.1 Las llaves de la nube",
    )[1]!;
    const section = keys.split("### 4.1.5")[0]!.replace(/\s+/g, " ");

    expect(section).toContain("github.com/apps/claude");
    expect(section).toMatch(/401/);
  });

  // vitest en la raíz de fabrica-prueba corrió también los tests de cada
  // worktree (196 en vez de 62, 2 en rojo de otra rama, 2026-11-22): el Stop
  // gate de la raíz bloqueaba por código que no era de esa sesión.
  it("el bootstrap excluye los worktrees también del corredor de tests", () => {
    const verify = read("skills/bootstrap/SKILL.md")
      .split("## Fase 3: Verificación real y commit")[1]!
      .split("## Fase 4")[0]!
      .replace(/\s+/g, " ");
    const rule = verify
      .split("**")
      .find((part) => part.includes(".claude/worktrees/"));

    expect(rule).toMatch(/corredor de tests/);
  });

  it("el bootstrap ofrece el dev container en la propuesta y lo escribe con fabrica-devcontainer", () => {
    const body = read("skills/bootstrap/SKILL.md");
    const proposal = body
      .split("### 0.4 La propuesta de cáscara")[1]!
      .split("## Fase 1")[0]!;

    expect(proposal).toMatch(/\*\*Dev container\*\*/);
    expect(body).toContain("fabrica-devcontainer --feature");
  });

  // refastidioso-web (2026-11-24): con Google Fonts, el e2e dependía de una
  // red que el firewall del dev container no deja pasar (IP que rotan), y el
  // gate quedó rojo en main sin cambios.
  it("el bootstrap escribe el dev container con --playwright si hay UI, y sirve las fuentes desde el proyecto", () => {
    const body = read("skills/bootstrap/SKILL.md");

    expect(body).toContain("--playwright");
    expect(body).not.toContain("cdn.playwright.dev");
    expect(body).toMatch(/@fontsource/);
  });

  // El Stop gate corre el e2e con FABRICA_IGNORE_SNAPSHOTS=1: sin esta línea
  // en la config, Playwright la ignora y el gate sigue comparando capturas.
  it("el bootstrap pone ignoreSnapshots con FABRICA_IGNORE_SNAPSHOTS en playwright.config.ts", () => {
    const body = read("skills/bootstrap/SKILL.md");

    expect(body).toContain(
      "ignoreSnapshots: !!process.env.FABRICA_IGNORE_SNAPSHOTS",
    );
  });

  // El ui-reviewer pedía `npm run ui:screenshots`, un script que el bootstrap
  // nunca crea: la revisión de UI no podía sacar ni una captura.
  it("el ui-reviewer saca las capturas con fabrica-ui-screenshots", () => {
    const body = read("agents/ui-reviewer.md");

    expect(body).toContain("fabrica-ui-screenshots");
    expect(body).not.toContain("ui:screenshots");
  });

  // La revisión de UI y una corrida de Playwright usan el mismo puerto: si
  // corren a la vez, el preflight ve un servidor ajeno y la revisión se cae.
  it("las reglas lanzan el ui-reviewer sin Playwright corriendo a la vez", () => {
    const body = read("rules/fabrica.md");

    expect(body).toMatch(/ui-reviewer[^\n]*\n?[^\n]*alone|never while/i);
  });

  // Con docLang: es, la mitad de los informes finales del backlog salieron en
  // inglés (refastidioso, turnos 11 a 20): docLang sólo cubría documentos.
  it("las reglas piden hablarle a la persona en docLang, no sólo escribir documentos", () => {
    const body = read("rules/fabrica.md");

    expect(body).toMatch(/replies to the person[\s\S]{0,80}`docLang`/);
  });

  it("el backlog resume la issue en el idioma de docLang", () => {
    const body = read("skills/backlog/SKILL.md");

    expect(body).toMatch(/resume en el idioma de[\s\S]{0,40}`docLang`/);
  });

  // En modo sesión el código lo escribe el modelo de la sesión: models.worker
  // sólo llega a los workers. Con worker: sonnet, todo lo escribió opus.
  it("el backlog en modo sesión avisa si la sesión no corre con models.worker", () => {
    const body = read("skills/backlog/SKILL.md");
    const session = body.split("## Con workers")[0];

    expect(session).toContain("models.worker");
    expect(session).toContain("claude --model");
  });

  // REFASTIDIOSO quedó listo sin que la fábrica dijera cómo publicarlo: el
  // deploy a Vercel se hizo a mano y la guía no lo mencionaba.
  describe("publicar", () => {
    it("fabrica:publish solo lo arranca una persona, en una sesión", () => {
      const body = read("skills/publish/SKILL.md");

      expect(body).toMatch(/^name: publish$/m);
      expect(body).toMatch(/^disable-model-invocation: true$/m);
      expect(body).toMatch(/headless/);
    });

    it("fabrica:publish verifica el build, guarda prodUrl y prueba producción", () => {
      const body = read("skills/publish/SKILL.md");

      expect(body).toContain("fabrica-cmd build");
      expect(body).toContain("prodUrl");
      expect(body).toContain("APP_URL");
      expect(body).toMatch(/Vercel/);
    });

    it("fabrica:publish deja a la persona la cuenta, los permisos y los secretos", () => {
      const body = read("skills/publish/SKILL.md");

      expect(body).toMatch(/nunca (creas|crees) la cuenta/i);
      expect(body).toMatch(/solo (a|al) (este )?repo/i);
      expect(body).toMatch(/secret/i);
    });

    it("la spec no hace de la publicación una épica, la manda a fabrica:publish", () => {
      expect(read("skills/spec/SKILL.md")).toContain("/fabrica:publish");
    });

    it("el handoff del bootstrap nombra fabrica:publish", () => {
      expect(read("skills/bootstrap/SKILL.md")).toContain("/fabrica:publish");
    });

    it("la guía y el manual explican fabrica:publish", () => {
      expect(read("docs/GUIA-DE-LA-FABRICA.md")).toContain("/fabrica:publish");
      expect(read("docs/MANUAL-DE-LA-FABRICA.md")).toContain(
        "/fabrica:publish",
      );
    });
  });

  // Conventional Commits en inglés, en los proyectos y en el plugin
  // (decidido el 2026-11-26).
  describe("formato de commit", () => {
    const CONVENTIONAL =
      /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S/;

    it("las reglas lo piden en inglés y nombran commitFormat", () => {
      expect(read("rules/fabrica.md")).toMatch(
        /Conventional Commits, in English[\s\S]{0,500}commitFormat/,
      );
    });

    it("la plantilla de factory.json lo deja activado", () => {
      const factory = JSON.parse(read("templates/factory.example.json")) as {
        commitFormat?: string;
      };
      expect(factory.commitFormat).toBe("conventional");
    });

    it("los mensajes fijos de los skills y workflows lo cumplen", () => {
      const sources = [
        ...SKILLS.map((s) => read(`skills/${s}/SKILL.md`)),
        readFileSync(
          path.join(REPO_ROOT, ".github/workflows/visual-baselines.yml"),
          "utf8",
        ),
      ];
      const messages = sources.flatMap((text) =>
        [...text.matchAll(/git commit -m "([^"]+)"/g)].map((m) => m[1]),
      );

      expect(messages.length).toBeGreaterThanOrEqual(5);
      for (const message of messages) expect(message).toMatch(CONVENTIONAL);
    });

    // El nombre de la spec sale en docLang: "docs(spec): sesion y navegacion
    // (#3)" (truckconnect-mobile). El mensaje nombra la épica por su número.
    it("los commits de spec, plan y tasks no llevan el nombre de la spec", () => {
      for (const skill of ["spec", "plan", "tasks"]) {
        const messages = [
          ...read(`skills/${skill}/SKILL.md`).matchAll(
            /git commit -m "([^"]+)"/g,
          ),
        ].map((m) => m[1]);
        expect(messages.length, skill).toBeGreaterThan(0);
        for (const message of messages) {
          expect(message, skill).not.toMatch(/<(name|nombre)>/);
          expect(message, skill).toMatch(/#<N>/);
        }
      }
    });

    it("hooks.json corre el hook de commit antes de cada Bash", () => {
      expect(read("hooks/hooks.json")).toContain("hooks/commit-format.sh");
    });

    it("la guía dice cómo activarlo en un proyecto que ya existe", () => {
      expect(read("docs/GUIA-DE-LA-FABRICA.md")).toMatch(
        /Conventional Commits[\s\S]{0,800}"commitFormat": "conventional"/,
      );
    });
  });

  // Lo que faltó en la prueba con truckconnect-mobile (bitácora, 2026-11-26).
  describe("lo que faltó en truckconnect-mobile", () => {
    const guide = () => read("docs/GUIA-DE-LA-FABRICA.md");
    const bootstrap = () => read("skills/bootstrap/SKILL.md");

    // "Apruebo la tabla así" dejó fuera los ui-review que la tabla sugería
    // (turno 13). auto-merge sigue pidiendo que la persona lo nombre.
    it("aprobar la tabla aplica ui-review; auto-merge solo si se nombra", () => {
      const issues = read("skills/issues/SKILL.md");
      expect(issues).toMatch(/aprueba la tabla[\s\S]{0,200}`ui-review`/);
      expect(issues).toMatch(/`auto-merge`[\s\S]{0,200}nombr/);
    });

    it("los skills dicen el máximo de 12 tareas por issue", () => {
      expect(read("skills/issues/SKILL.md")).toMatch(/12 tareas/);
      expect(read("skills/tasks/SKILL.md")).toMatch(/12 tareas/);
    });

    // Los fabrica-* solo están en el PATH de Claude Code; la guía los mandaba
    // a la terminal y daba "command not found" (worker de #5).
    it("la guía dice cómo tener los fabrica-* en una terminal", () => {
      expect(guide()).toMatch(
        /command not found[\s\S]{0,400}claude plugin list --json/,
      );
    });

    it("la guía dice cómo crear FABRICA_PLUGIN_TOKEN", () => {
      expect(guide()).toMatch(
        /FABRICA_PLUGIN_TOKEN[\s\S]{0,900}Fine-grained[\s\S]{0,600}Contents[\s\S]{0,40}Read-only/,
      );
    });

    it("gh auth refresh va en una terminal aparte, con --hostname", () => {
      expect(guide()).toContain(
        "gh auth refresh -h github.com -s project,repo",
      );
      expect(guide()).toMatch(/terminal aparte[\s\S]{0,200}gh auth refresh/);
    });

    it("los workflows del Project se abren con su botón, no con un engranaje", () => {
      expect(guide()).not.toContain("⚙ → Workflows");
      expect(guide()).toMatch(/botón \*\*Workflows\*\*/);
      expect(guide()).toContain("A value is required");
    });

    it("la guía explica extraPlugins, con el commit fijado", () => {
      expect(guide()).toMatch(/extraPlugins[\s\S]{0,600}marketplace/);
      expect(guide()).toMatch(/"ref":[\s\S]{0,600}git ls-remote/);
    });

    // La etiqueta auto-merge no usa el auto-merge de GitHub: fabrica-backlog
    // espera los checks y mergea (lib/backlog-queue.sh, automerge_issue). La
    // 0.5.22 decía que en un repo privado gratis no funcionaba, y era falso.
    it("el bootstrap no pide activar el auto-merge de GitHub", () => {
      expect(bootstrap()).not.toContain("--enable-auto-merge");
      expect(bootstrap()).not.toContain("allow_auto_merge");
    });

    // Un emulador lanzado como hijo de la sesión dejó a claude -p sin
    // terminar (turno 3 del bootstrap).
    it("las reglas piden soltar o apagar los procesos que no terminan", () => {
      expect(read("rules/fabrica.md")).toMatch(
        /emulator[\s\S]{0,600}setsid[\s\S]{0,400}claude -p/,
      );
    });
  });

  // Lo que la guía no explicaba en la prueba con REFASTIDIOSO (bitácora,
  // 2026-11-24 y 25): cada uno costó un paso a ciegas.
  describe("la guía cubre lo que faltó en REFASTIDIOSO", () => {
    const guide = () => read("docs/GUIA-DE-LA-FABRICA.md");

    it("cómo retomar una issue en needs-human", () => {
      expect(guide()).toContain(
        "gh issue edit N --remove-label needs-human --remove-label in-progress --add-label pending",
      );
    });

    it("que claude -p ignora los permisos de un repo que nunca se abrió", () => {
      expect(guide()).toMatch(/claude -p[\s\S]{0,300}not been trusted/);
    });

    it("el plan maestro y que spec encadena plan y tasks", () => {
      expect(guide()).toContain("docs/plan-maestro.md");
      expect(guide()).toMatch(/encadena[\s\S]{0,120}\/fabrica:plan/);
    });

    it("qué es factoryEpic y cuándo llenarlo", () => {
      expect(guide()).toMatch(/`factoryEpic`[\s\S]{0,400}incidente/);
    });

    it("gh auth login en el contenedor sin el apuro del código", () => {
      expect(guide()).toMatch(/docker exec -it[^\n]*gh auth login/);
    });

    it("que Docker es opcional y qué cambia sin él", () => {
      expect(guide()).toMatch(/Sin Docker[\s\S]{0,600}PERMISSION_MODE=auto/);
      expect(read("docs/FLUJO-DE-LA-FABRICA.md")).toMatch(
        /Docker[\s\S]{0,300}opcional/,
      );
    });

    it("cada forma de usarla, cómo se arranca y cómo se combinan", () => {
      const part = guide().match(
        /## Parte 3\.5: Las formas de usar la fábrica[\s\S]*?\n## /,
      );
      expect(part, "falta la Parte 3.5").not.toBeNull();
      for (const form of [
        "En tu sesión",
        "Workers locales",
        "Dev container",
        "La nube",
        "Menciones",
      ]) {
        expect(part![0]).toContain(`### ${form}`);
      }
      expect(part![0]).toContain("### Combinarlas");
      expect(part![0]).toContain("fabrica-release N --pending");
    });

    it("el Paso 3 no dice que /fabrica:backlog lanza un worker", () => {
      expect(guide()).not.toContain("lanza un Claude que la");
    });
  });

  it("fabrica:publish avisa antes de pedir permiso para salir a internet", () => {
    const body = read("skills/publish/SKILL.md");

    expect(body).toMatch(/permiso para salir\s+a internet/);
  });

  it("el aviso de falla de la nube nombra la GitHub App", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/claude-backlog.yml"),
      "utf8",
    );
    const note = workflow
      .split("\n")
      .find((line) => line.includes("La corrida en la nube falló"));

    expect(note).toContain("github.com/apps/claude");
  });

  it("fabrica:tasks no encadena las issues: espera el merge", () => {
    const body = read("skills/tasks/SKILL.md");

    expect(body).not.toContain("skills/issues/SKILL.md");
    expect(body).toMatch(/mergees/);
  });
});

describe("piezas del plugin", () => {
  it("el marketplace apunta al plugin y el plugin declara versión", () => {
    const marketplace = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string; source: string }> };
    const entry = marketplace.plugins.find((p) => p.name === "fabrica");

    expect(entry).toBeDefined();
    expect(path.resolve(REPO_ROOT, entry!.source)).toBe(PLUGIN_ROOT);

    const manifest = JSON.parse(
      readFileSync(
        path.join(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as { name: string; version: string };
    expect(manifest.name).toBe("fabrica");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Los comandos de bin/ quedan en el PATH del modelo y se ejecutan directo:
  // sin el bit de ejecución en git, fallan con "Permission denied" en la
  // nube y en cualquier copia nueva del plugin.
  it("todos los comandos de bin/ son ejecutables en git", () => {
    const listing = execFileSync(
      "git",
      ["ls-files", "-s", "--", "plugins/fabrica/bin"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const notExecutable = listing
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("100755"))
      .map((line) => line.split("\t")[1]);

    expect(notExecutable).toEqual([]);
  });

  it("hooks.json solo llama scripts que existen", () => {
    const hooks = readFileSync(
      path.join(PLUGIN_ROOT, "hooks/hooks.json"),
      "utf8",
    );
    const scripts = [
      ...hooks.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)/g),
    ].map((m) => m[1]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(path.join(PLUGIN_ROOT, script)), script).toBe(true);
    }
  });

  it("ningún texto para personas manda a correr un script por su ruta en el proyecto", () => {
    // Los comentarios de los issues, el devcontainer y los mensajes de uso
    // los lee una persona en un proyecto que ya no tiene scripts/.
    const files = [
      "scripts/process-backlog.sh",
      "templates/.devcontainer/devcontainer.json",
      ...readdirSync(path.join(PLUGIN_ROOT, "scripts"))
        .filter((f) => f.endsWith(".sh"))
        .map((f) => `scripts/${f}`),
    ];
    const BIN_TARGETS = BIN.map((command) => {
      const body = readFileSync(path.join(PLUGIN_ROOT, "bin", command), "utf8");
      return body.match(/\/\.\.\/scripts\/([^"]+)"/)![1];
    });
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/bash scripts\/process-backlog\.sh/);
      for (const target of BIN_TARGETS) {
        expect(text, `${file} nombra scripts/${target}`).not.toMatch(
          new RegExp(`(bash |Usage: )scripts/${target.replace(".", "\\.")}`),
        );
      }
    }
  });

  it("todo script que infiere el repo con gh repo view respeta antes GH_REPO", () => {
    const scripts = readdirSync(path.join(PLUGIN_ROOT, "scripts"))
      .filter((f) => f.endsWith(".sh"))
      .map((f) => `scripts/${f}`);
    for (const file of scripts) {
      for (const line of read(file).split("\n")) {
        if (!/gh repo view/.test(line) || /^\s*#/.test(line)) continue;
        expect(line, file).toMatch(/\$\{GH_REPO:-\$\(gh repo view/);
      }
    }
  });

  it("el uso de fabrica-ui-preflight nombra los subcomandos del script", () => {
    const usage = read("bin/fabrica-ui-preflight");
    const script = read("scripts/ui-preflight.sh");

    for (const sub of ["up", "down", "check"]) {
      expect(usage).toMatch(new RegExp(`\\b${sub}\\b`));
      expect(script).toMatch(new RegExp(`^\\s*${sub}\\)`, "m"));
    }
    expect(usage).not.toMatch(/\bstatus\b/);
  });

  it.each(BIN)("bin/%s llama un script que existe", (command) => {
    const body = readFileSync(path.join(PLUGIN_ROOT, "bin", command), "utf8");
    const target = body.match(/\/\.\.\/(scripts\/[^"]+)"/);

    expect(target, `${command} no llama ../scripts/...`).not.toBeNull();
    expect(existsSync(path.join(PLUGIN_ROOT, target![1]))).toBe(true);
  });
});
