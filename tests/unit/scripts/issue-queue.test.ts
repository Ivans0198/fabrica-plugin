import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * Los comandos de la cola que usa la sesión interactiva: fabrica-next-issue,
 * fabrica-claim, fabrica-release y fabrica-check-done. Llevan a comandos las
 * garantías que antes solo daba process-backlog.sh, para que no dependan de
 * que el modelo se acuerde.
 */

const ISSUE_QUEUE = pluginFile("scripts/issue-queue.sh");
const TIMEOUT = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [ISSUE_QUEUE, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function git(cwd: string, script: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Un `gh` de mentira que anota cada llamada y contesta según variables:
 * FAKE_PENDING (números de la cola), FAKE_LABELS_<N> (etiquetas de N),
 * FAKE_STATE_<N> (estado de N), FAKE_OTHERS (assignees ajenos) y
 * FAKE_PR_COUNT (PRs con "Closes #N"). FAKE_FAIL_LIST, FAKE_FAIL_VIEW_<N> y
 * FAKE_FAIL_EDIT hacen fallar esas llamadas, como con la red caída.
 */
async function installFakeGh(dir: string): Promise<string> {
  const binDir = path.join(dir, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const log = path.join(dir, "gh-calls.log");
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1 $2" in
  "issue list") [ -n "\${FAKE_FAIL_LIST:-}" ] && exit 1 ;;
  "issue view") var="FAKE_FAIL_VIEW_$3"; [ -n "\${!var:-}" ] && exit 1 ;;
  "issue edit") [ -n "\${FAKE_FAIL_EDIT:-}" ] && exit 1 ;;
esac
case "$1 $2" in
  "api user") echo "\${FAKE_ME-tester}" ;;
  "issue list") for n in \${FAKE_PENDING:-}; do echo "$n"; done ;;
  "issue view")
    n="$3"; shift 3
    case "$*" in
      *labels*) var="FAKE_LABELS_$n"; for l in \${!var:-}; do echo "$l"; done ;;
      *assignees*) echo "\${FAKE_OTHERS:-0}" ;;
      *state*) var="FAKE_STATE_$n"; echo "\${!var:-OPEN}" ;;
    esac ;;
  "pr list")
    case "$*" in *--head*) echo "\${FAKE_HEAD_PR:-}"; exit 0 ;; esac
    # La búsqueda de GitHub tarda en ver un PR recién abierto: con
    # FAKE_SEARCH_LAG, --search todavía no lo encuentra y la lista sí.
    case "$*" in
      *--search*) if [ -n "\${FAKE_SEARCH_LAG:-}" ]; then echo 0; else echo "\${FAKE_PR_COUNT:-0}"; fi ;;
      *) echo "\${FAKE_PR_COUNT:-0}" ;;
    esac ;;
  "pr merge") [ -n "\${FAKE_FAIL_MERGE:-}" ] && { echo "no se pudo mergear" >&2; exit 1; } ;;
  "pr view") echo "main abc123"; exit 0 ;;
  "pr checks")
    # FAKE_CHECKS: lo que contesta cada llamada, en orden (0 pasa, 1 falla,
    # 8 pendiente, none sin checks, error sin permiso); la última se repite.
    # Con --json, como gh: los checks con su bucket, y el mismo código.
    f="${log}.checks"; i=$(cat "$f" 2>/dev/null || echo 0); echo $((i + 1)) > "$f"
    codes=(\${FAKE_CHECKS:-0}); rc="\${codes[$i]:-\${codes[\${#codes[@]}-1]}}"
    case "$rc" in
      none) echo "no checks reported on the 'impl-5' branch" >&2; exit 1 ;;
      error) echo "GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)" >&2; exit 1 ;;
      0) echo '[{"bucket":"pass"},{"bucket":"skipping"}]' ;;
      1) echo '[{"bucket":"pass"},{"bucket":"fail"}]' ;;
      8) echo '[{"bucket":"pass"},{"bucket":"pending"}]' ;;
    esac
    exit "$rc" ;;
  "api repos/{owner}/{repo}/compare/main...abc123") echo "\${FAKE_BEHIND:-0}"; exit 0 ;;
esac
exit 0
`,
  );
  await chmod(path.join(binDir, "gh"), 0o755);
  await writeFile(log, "");
  return binDir;
}

describe("comandos de la cola", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  /** Un proyecto con la configuración de la fábrica commiteada. */
  async function project(): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
    dir = await mkdtemp(path.join(tmpdir(), "fabrica-cola-"));
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    await writeFile(path.join(repo, "factory.json"), "{}\n");
    await writeFile(path.join(repo, "CLAUDE.md"), "# proyecto\n");
    await git(
      repo,
      "git init -q -b main && git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m inicial",
    );
    const binDir = await installFakeGh(dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    };
    // El CI del plugin corre en GitHub Actions: sin esto, fabrica-claim
    // tomaría el camino de la nube en todos los tests.
    delete env.GITHUB_ACTIONS;
    return { repo, env };
  }

  const calls = () => readFile(path.join(dir, "gh-calls.log"), "utf8");

  it(
    "fabrica-next-issue da la primera issue de la cola que no está bloqueada",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["next"], repo, {
        ...env,
        FAKE_PENDING: "3 4",
        FAKE_LABELS_3: "blocked-by-9",
        FAKE_STATE_9: "OPEN",
      });

      expect(code).toBe(0);
      expect(stdout.trim()).toBe("4");
    },
    TIMEOUT,
  );

  // La nube y el local actúan como la misma persona, así que el reclamo por
  // assignee no los separa: el local tomó la issue que era de la nube
  // (fabrica-prueba #25, 2026-11-22). ready-for-dev es el carril de la nube.
  it(
    "fabrica-next-issue se salta las issues con ready-for-dev, que son de la nube",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["next"], repo, {
        ...env,
        FAKE_PENDING: "3 4",
        FAKE_LABELS_3: "pending ready-for-dev",
      });

      expect(code).toBe(0);
      expect(stdout.trim()).toBe("4");
    },
    TIMEOUT,
  );

  // Revisión del 2026-11-23: con gh caído, una issue bloqueada parecía libre
  // y una cola ilegible se leía como vacía.
  it(
    "fabrica-next-issue sale con 3 si gh no puede listar la cola, en vez de darla por vacía",
    async () => {
      const { repo, env } = await project();

      const { code, stderr } = await run(["next"], repo, {
        ...env,
        FAKE_PENDING: "3",
        FAKE_FAIL_LIST: "1",
      });

      expect(code).toBe(3);
      expect(stderr).toMatch(/no pude/i);
    },
    TIMEOUT,
  );

  it.each([
    [
      "el estado de su bloqueo",
      { FAKE_LABELS_3: "blocked-by-9", FAKE_FAIL_VIEW_9: "1" },
    ],
    ["sus etiquetas", { FAKE_FAIL_VIEW_3: "1" }],
  ])(
    "fabrica-next-issue no da por libre una issue si no puede leer %s",
    async (_caso, fake) => {
      const { repo, env } = await project();

      const { stdout } = await run(["next"], repo, {
        ...env,
        FAKE_PENDING: "3",
        ...fake,
      });

      expect(stdout.trim()).toBe("");
    },
    TIMEOUT,
  );

  // La nube y el local actúan como la misma cuenta: el assignee no los
  // separa, pero in-progress dice que alguien ya la está trabajando.
  it(
    "fabrica-claim no toma una issue que ya está en curso, sin asignársela",
    async () => {
      const { repo, env } = await project();

      const { code, stderr } = await run(["claim", "5"], repo, {
        ...env,
        FAKE_LABELS_5: "in-progress",
      });

      expect(code).toBe(2);
      expect(stderr).toMatch(/en curso/);
      expect(stderr).toMatch(/fabrica-release 5 --pending/);
      expect(await calls()).not.toMatch(/issue edit 5 --add-assignee/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim no sigue si no pudo asignarse la issue",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5"], repo, {
        ...env,
        FAKE_FAIL_EDIT: "1",
      });

      expect(code).not.toBe(0);
      expect(await calls()).not.toMatch(/--add-label in-progress/);
    },
    TIMEOUT,
  );

  // En la nube, el token de la App no puede asignar ("Assigning agents is not
  // supported with GitHub App installation tokens", fabrica-prueba #36,
  // 2026-11-23), y no hace falta: fabrica-eligible ya se la asignó a quien
  // puso la etiqueta.
  it(
    "en la nube, fabrica-claim no depende de poder asignarse la issue",
    async () => {
      const { repo, env } = await project();

      const { code, stderr } = await run(["claim", "5"], repo, {
        ...env,
        GITHUB_ACTIONS: "true",
        FAKE_FAIL_EDIT: "1",
      });

      expect(code, stderr).toBe(0);
      expect(await calls()).not.toMatch(/issue edit 5 --add-assignee/);
    },
    TIMEOUT,
  );

  it(
    "en la nube, fabrica-claim tampoco toma una issue en curso",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5"], repo, {
        ...env,
        GITHUB_ACTIONS: "true",
        FAKE_LABELS_5: "in-progress",
        // El token de la App no puede leer `gh api user`: ME queda vacío.
        FAKE_ME: "",
      });

      expect(code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "fabrica-next-issue sale con 1 si no hay ninguna elegible",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["next"], repo, env);

      expect(code).toBe(1);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim reclama la issue, crea su worktree en impl-N con los .env locales e imprime la ruta",
    async () => {
      const { repo, env } = await project();
      await writeFile(path.join(repo, ".env.local"), "SECRETO=1\n");

      const { code, stdout } = await run(["claim", "5"], repo, env);

      expect(code).toBe(0);
      const worktree = stdout.trim().split("\n").pop()!;
      expect(worktree).toBe(path.join(repo, ".claude/worktrees/impl-5"));
      const branch = await git(worktree, "git branch --show-current");
      expect(branch.stdout.trim()).toBe("impl-5");
      expect(existsSync(path.join(worktree, ".env.local"))).toBe(true);
      const log = await calls();
      expect(log).toMatch(/issue edit 5 --add-assignee @me/);
      expect(log).toMatch(
        /issue edit 5 --add-label in-progress --remove-label pending/,
      );
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim sale con 2 y suelta el reclamo si la issue ya es de otra persona",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5"], repo, {
        ...env,
        FAKE_OTHERS: "1",
      });

      expect(code).toBe(2);
      expect(existsSync(path.join(repo, ".claude/worktrees/impl-5"))).toBe(
        false,
      );
      const log = await calls();
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
      expect(log).not.toMatch(/--add-label in-progress/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim para si la configuración de la fábrica no está commiteada",
    async () => {
      const { repo, env } = await project();
      await writeFile(path.join(repo, "factory.json"), '{"cambio":1}\n');

      const { code, stderr } = await run(["claim", "5"], repo, env);

      expect(code).toBe(1);
      expect(stderr).toMatch(/factory\.json/);
      expect(await calls()).not.toMatch(/--add-assignee/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim al retomar una issue borra el contador y la rendición del Stop gate",
    async () => {
      const { repo, env } = await project();
      await run(["claim", "5"], repo, env);
      const state = path.join(repo, ".claude/worktrees/impl-5/.factory");
      await mkdir(path.join(state, "state"), { recursive: true });
      await writeFile(path.join(state, "state/stop-gate-count"), "5");
      await writeFile(path.join(state, "gate-gave-up"), "x");

      const { code } = await run(["claim", "5"], repo, env);

      expect(code).toBe(0);
      expect(existsSync(path.join(state, "state/stop-gate-count"))).toBe(false);
      expect(existsSync(path.join(state, "gate-gave-up"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "fabrica-claim desde dentro de un worktree crea el nuevo junto a los otros, en la raíz",
    async () => {
      const { repo, env } = await project();
      await run(["claim", "5"], repo, env);

      const { code, stdout } = await run(
        ["claim", "6"],
        path.join(repo, ".claude/worktrees/impl-5"),
        env,
      );

      expect(code).toBe(0);
      expect(stdout.trim().split("\n").pop()).toBe(
        path.join(repo, ".claude/worktrees/impl-6"),
      );
    },
    TIMEOUT,
  );

  // En la nube no hay EnterWorktree (está en las herramientas prohibidas) y
  // el runner es desechable: un worktree dejaría al agente trabajando en la
  // copia equivocada (probado en fabrica-prueba, 2026-11-16).
  it(
    "fabrica-claim en GitHub Actions trabaja en la rama impl-N del mismo checkout, sin worktree",
    async () => {
      const { repo, env } = await project();

      const { code, stdout } = await run(["claim", "5"], repo, {
        ...env,
        GITHUB_ACTIONS: "true",
      });

      expect(code).toBe(0);
      expect(stdout.trim().split("\n").pop()).toBe(repo);
      expect(existsSync(path.join(repo, ".claude/worktrees/impl-5"))).toBe(
        false,
      );
      const branch = await git(repo, "git branch --show-current");
      expect(branch.stdout.trim()).toBe("impl-5");
    },
    TIMEOUT,
  );

  it(
    "fabrica-release --pending devuelve la issue a la cola sin assignee",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["release", "5", "--pending"], repo, env);

      expect(code).toBe(0);
      const log = await calls();
      expect(log).toMatch(
        /issue edit 5 --add-label pending --remove-label in-progress/,
      );
      expect(log).toMatch(/issue edit 5 --remove-assignee @me/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-release --needs-human marca la issue y deja el motivo en un comentario",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(
        ["release", "5", "--needs-human", "falta la clave de la API"],
        repo,
        env,
      );

      expect(code).toBe(0);
      const log = await calls();
      expect(log).toMatch(
        /issue edit 5 --add-label needs-human --remove-label in-progress/,
      );
      expect(log).toMatch(/issue comment 5 --body .*falta la clave de la API/);
    },
    TIMEOUT,
  );

  it(
    "fabrica-check-done falla si la issue no tiene un PR que la cierre",
    async () => {
      const { repo, env } = await project();

      const sinPr = await run(["done", "5"], repo, env);
      const conPr = await run(["done", "5"], repo, {
        ...env,
        FAKE_PR_COUNT: "1",
      });

      expect(sinPr.code).toBe(1);
      expect(sinPr.stderr).toMatch(/Closes #5/);
      expect(conPr.code).toBe(0);
      // Un worker leyó el silencio como "no sé si pasó" (fabrica-prueba, #13).
      expect(conPr.stdout).toMatch(/#5[^\n]*Closes #5/);
    },
    TIMEOUT,
  );

  describe("fabrica-cleanup", () => {
    const worktree = (repo: string, n: number) =>
      path.join(repo, `.claude/worktrees/impl-${n}`);

    it(
      "borra el worktree y la rama de una issue cerrada",
      async () => {
        const { repo, env } = await project();
        await run(["claim", "5"], repo, env);

        const { code, stdout } = await run(["cleanup"], repo, {
          ...env,
          FAKE_STATE_5: "CLOSED",
        });

        expect(code).toBe(0);
        expect(stdout).toMatch(/impl-5/);
        expect(existsSync(worktree(repo, 5))).toBe(false);
        const branches = await git(repo, "git branch --list impl-5");
        expect(branches.stdout.trim()).toBe("");
      },
      TIMEOUT,
    );

    // En fabrica-prueba, el PR #6 se mergeó en GitHub y origin/main local
    // seguía viejo: la rama parecía sin mergear (2026-11-16).
    it(
      "trae la base antes de decidir si la rama ya está mergeada",
      async () => {
        const { repo, env } = await project();
        const origin = path.join(dir, "origin.git");
        const other = path.join(dir, "otra-copia");
        await git(
          dir,
          `git init -q --bare -b main "${origin}" && git -C "${repo}" remote add origin "${origin}" && git -C "${repo}" push -q origin main && git -C "${repo}" fetch -q origin`,
        );
        await run(["claim", "5"], repo, env);
        const wt = worktree(repo, 5);
        await writeFile(path.join(wt, "nuevo.ts"), "export {};\n");
        await git(
          wt,
          "git add nuevo.ts && git -c user.email=t@t.com -c user.name=t commit -q -m trabajo && git push -q origin impl-5",
        );
        // El merge pasa en GitHub, no en esta copia.
        await git(
          dir,
          `git clone -q "${origin}" "${other}" && git -C "${other}" -c user.email=t@t.com -c user.name=t merge -q --no-ff origin/impl-5 -m merge && git -C "${other}" push -q origin main`,
        );

        const { code, stdout } = await run(["cleanup"], repo, {
          ...env,
          FAKE_STATE_5: "CLOSED",
        });

        expect(code).toBe(0);
        expect(stdout).toMatch(/impl-5: worktree y rama borrados/);
      },
      TIMEOUT,
    );

    it(
      "deja el worktree de una issue abierta",
      async () => {
        const { repo, env } = await project();
        await run(["claim", "5"], repo, env);

        const { code } = await run(["cleanup"], repo, env);

        expect(code).toBe(0);
        expect(existsSync(worktree(repo, 5))).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "deja y avisa un worktree con cambios sin commitear aunque la issue esté cerrada",
      async () => {
        const { repo, env } = await project();
        await run(["claim", "5"], repo, env);
        await writeFile(path.join(worktree(repo, 5), "a-medias.ts"), "x\n");

        const { code, stderr } = await run(["cleanup"], repo, {
          ...env,
          FAKE_STATE_5: "CLOSED",
        });

        expect(code).toBe(0);
        expect(existsSync(worktree(repo, 5))).toBe(true);
        expect(stderr).toMatch(/impl-5.*sin commitear/);
      },
      TIMEOUT,
    );

    it(
      "con --dry-run solo lista lo que borraría",
      async () => {
        const { repo, env } = await project();
        await run(["claim", "5"], repo, env);

        const { code, stdout } = await run(["cleanup", "--dry-run"], repo, {
          ...env,
          FAKE_STATE_5: "CLOSED",
        });

        expect(code).toBe(0);
        expect(stdout).toMatch(/impl-5/);
        expect(existsSync(worktree(repo, 5))).toBe(true);
      },
      TIMEOUT,
    );
  });

  // En la nube, fabrica-check-done corrido segundos después de abrir el PR
  // no lo encontró: la búsqueda de GitHub todavía no lo indexaba (#7,
  // 2026-11-16). El paso de seguridad del workflow la habría marcado
  // needs-human con su PR abierto.
  it(
    "fabrica-check-done encuentra un PR recién abierto aunque la búsqueda de GitHub no lo vea todavía",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["done", "5"], repo, {
        ...env,
        FAKE_PR_COUNT: "1",
        FAKE_SEARCH_LAG: "1",
      });

      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  // La nube tomaba una issue con ready-for-dev aunque estuviera bloqueada o
  // asignada a otra persona: el disparo solo miraba el nombre de la etiqueta.
  // Que el agente no mergee es un hook; el auto-merge lo pone el orquestador
  // con este comando, nunca el worker (revisión del 2026-11-23).
  describe("fabrica-automerge", () => {
    /** Sin esperas reales entre consultas. */
    const AUTOMERGE_FAST = {
      FABRICA_AUTOMERGE_INTERVAL: "0",
      FABRICA_AUTOMERGE_WAIT: "2",
    };

    it(
      "con la etiqueta auto-merge, espera los checks del PR de impl-N y lo mergea",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(["automerge", "5"], repo, {
          ...env,
          ...AUTOMERGE_FAST,
          FAKE_LABELS_5: "auto-merge",
          FAKE_HEAD_PR: "12",
          FAKE_CHECKS: "8 8 0",
        });

        expect(code).toBe(0);
        const log = await calls();
        expect(log).toMatch(/pr list --head impl-5/);
        expect(log.match(/pr checks 12/g)).toHaveLength(3);
        expect(log).toMatch(/pr ready 12/);
        expect(log).toMatch(/pr merge 12 --squash/);
        expect(log.indexOf("pr merge")).toBeGreaterThan(
          log.lastIndexOf("pr checks"),
        );
      },
      TIMEOUT,
    );

    // Sin branch protection no hay checks obligatorios, y `gh pr merge
    // --auto` mergeaba al instante, antes de que terminaran (fabrica-prueba
    // #37, 2026-11-23).
    it(
      "nunca usa --auto",
      async () => {
        const { repo, env } = await project();

        await run(["automerge", "5"], repo, {
          ...env,
          ...AUTOMERGE_FAST,
          FAKE_LABELS_5: "auto-merge",
          FAKE_HEAD_PR: "12",
        });

        expect(await calls()).not.toMatch(/--auto/);
      },
      TIMEOUT,
    );

    it.each([
      ["un check falla", { FAKE_CHECKS: "8 1" }, /un check falló/],
      // En la nube, sin `checks: read`, gh no pudo leerlos y eso se contó
      // como un check rojo (fabrica-prueba #39, 2026-11-23).
      [
        "no puede leer los checks",
        { FAKE_CHECKS: "error" },
        /no pude leer sus checks.*Resource not accessible/s,
      ],
      ["el PR no tiene checks", { FAKE_CHECKS: "none" }, /check/],
      ["los checks no terminan a tiempo", { FAKE_CHECKS: "8" }, /check/],
      ["la rama no tiene lo último de la base", { FAKE_BEHIND: "2" }, /main/],
    ])(
      "no mergea si %s, y lo comenta en la issue",
      async (_caso, fake, why) => {
        const { repo, env } = await project();

        const { code } = await run(["automerge", "5"], repo, {
          ...env,
          ...AUTOMERGE_FAST,
          FAKE_LABELS_5: "auto-merge",
          FAKE_HEAD_PR: "12",
          ...fake,
        });

        expect(code).toBe(1);
        const log = await calls();
        expect(log).not.toMatch(/pr merge/);
        expect(log).toMatch(/issue comment 5 /);
        expect(log.slice(log.indexOf("issue comment 5"))).toMatch(why);
      },
      TIMEOUT,
    );

    it(
      "sin la etiqueta no toca el PR",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(["automerge", "5"], repo, {
          ...env,
          FAKE_HEAD_PR: "12",
        });

        expect(code).toBe(2);
        expect(await calls()).not.toMatch(/pr (ready|merge)/);
      },
      TIMEOUT,
    );

    it(
      "un worker no puede ponerlo",
      async () => {
        const { repo, env } = await project();

        const { code, stderr } = await run(["automerge", "5"], repo, {
          ...env,
          FABRICA_WORKER: "1",
          FAKE_LABELS_5: "auto-merge",
          FAKE_HEAD_PR: "12",
        });

        expect(code).not.toBe(0);
        expect(stderr).toMatch(/worker/i);
        expect(await calls()).not.toMatch(/pr (ready|merge)/);
      },
      TIMEOUT,
    );

    it(
      "si GitHub no acepta el auto-merge, lo comenta en la issue y sale con 1",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(["automerge", "5"], repo, {
          ...env,
          ...AUTOMERGE_FAST,
          FAKE_LABELS_5: "auto-merge",
          FAKE_HEAD_PR: "12",
          FAKE_FAIL_MERGE: "1",
        });

        expect(code).toBe(1);
        expect(await calls()).toMatch(/issue comment 5 .*auto-merge/s);
      },
      TIMEOUT,
    );
  });

  describe("fabrica-eligible", () => {
    it(
      "da por elegible una issue libre y se la asigna a quien puso la etiqueta",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(
          ["eligible", "5", "--actor", "ana"],
          repo,
          env,
        );

        expect(code).toBe(0);
        expect(await calls()).toMatch(/issue edit 5 --add-assignee ana/);
      },
      TIMEOUT,
    );

    it(
      "sale con 2 si la issue está asignada a otra persona, sin tocarla",
      async () => {
        const { repo, env } = await project();

        const { code, stderr } = await run(
          ["eligible", "5", "--actor", "ana"],
          repo,
          { ...env, FAKE_OTHERS: "1" },
        );

        expect(code).toBe(2);
        expect(stderr).toMatch(/asignada/);
        expect(await calls()).not.toMatch(/issue edit/);
      },
      TIMEOUT,
    );

    it(
      "sale con 3 y nombra el bloqueo si la issue depende de otra abierta",
      async () => {
        const { repo, env } = await project();

        const { code, stderr } = await run(
          ["eligible", "5", "--actor", "ana"],
          repo,
          { ...env, FAKE_LABELS_5: "blocked-by-9", FAKE_STATE_9: "OPEN" },
        );

        expect(code).toBe(3);
        expect(stderr).toMatch(/#9/);
        expect(await calls()).not.toMatch(/issue edit/);
      },
      TIMEOUT,
    );

    it.each([
      ["cerrada", { FAKE_STATE_5: "CLOSED" }, /cerrada/],
      ["en curso", { FAKE_LABELS_5: "in-progress" }, /en curso/],
    ])(
      "sale con 2 si la issue está %s, sin tocarla",
      async (_caso, fake, why) => {
        const { repo, env } = await project();

        const { code, stderr } = await run(
          ["eligible", "5", "--actor", "ana"],
          repo,
          { ...env, ...fake },
        );

        expect(code).toBe(2);
        expect(stderr).toMatch(why);
        expect(await calls()).not.toMatch(/issue edit/);
      },
      TIMEOUT,
    );

    it(
      "falla sin tocarla si gh no puede leer la issue",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(["eligible", "5", "--actor", "ana"], repo, {
          ...env,
          FAKE_FAIL_VIEW_5: "1",
        });

        expect(code).toBe(1);
        expect(await calls()).not.toMatch(/issue edit/);
      },
      TIMEOUT,
    );

    it(
      "una issue cuyo bloqueo ya se cerró es elegible",
      async () => {
        const { repo, env } = await project();

        const { code } = await run(["eligible", "5", "--actor", "ana"], repo, {
          ...env,
          FAKE_LABELS_5: "blocked-by-9",
          FAKE_STATE_9: "CLOSED",
        });

        expect(code).toBe(0);
      },
      TIMEOUT,
    );
  });

  it(
    "rechaza un número de issue que no es un número",
    async () => {
      const { repo, env } = await project();

      const { code } = await run(["claim", "5; rm -rf /"], repo, env);

      expect(code).not.toBe(0);
      expect(await calls()).not.toMatch(/issue edit/);
    },
    TIMEOUT,
  );
});
