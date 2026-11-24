import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ROOT } from "../../support/plugin-paths";

/**
 * `fabrica-create-issues` crea las issues de una feature a partir del JSON
 * que arma `fabrica:issues` y aprueba una persona. Lo prueba un `gh` falso
 * con estado en disco, y un `origin` local: nada sale a GitHub.
 */

const SCRIPT = path
  .join(PLUGIN_ROOT, "scripts/create-issues.sh")
  .replace(/\\/g, "/");
const TIMEOUT = 60_000;
const EPIC = 12;
const PLAN = ".factory/state/issues-12.json";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const bash = (p: string) => p.replace(/\\/g, "/");

const TASKS_MD = `# Tasks: Favoritos

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create project structure

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T004 Setup database schema

## Phase 3: User Story 1 - Guardar favoritos (Priority: P1) 🎯 MVP

### Tests for User Story 1 (MANDATORY, write first) ⚠️

- [ ] T010 [P] [US1] Contract test for saving in tests/favoritos.test.ts

### Implementation for User Story 1

- [ ] T012 [US1] Implement save in src/favoritos.ts

## Phase 4: User Story 2 - Listar favoritos (Priority: P2)

### Tests for User Story 2 (MANDATORY, write first) ⚠️

- [ ] T020 [P] [US2] Test the list in tests/listar.test.ts

### Implementation for User Story 2

- [ ] T021 [US2] Implement the list in src/listar.ts

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T030 Update the docs
`;

interface Entry {
  key: string;
  phase: string;
  story?: string;
  title: string;
  body: string;
  priority: string;
  size: string;
  dependsOn: string[];
  tasks: string[];
}

interface Plan {
  epic: number;
  featureDir: string;
  issues: Entry[];
}

function validPlan(): Plan {
  return {
    epic: EPIC,
    featureDir: "specs/12-favoritos",
    issues: [
      {
        key: "setup",
        phase: "setup",
        title: "Favoritos: estructura y esquema",
        body: "Setup y Foundational.",
        priority: "low",
        size: "S",
        dependsOn: [],
        tasks: ["T001", "T004"],
      },
      {
        key: "US1",
        phase: "story",
        story: "US1",
        title: "Favoritos: guardar",
        body: "Como persona quiero guardar un favorito.",
        priority: "high",
        size: "M",
        dependsOn: ["setup"],
        tasks: ["T010", "T012"],
      },
      {
        key: "US2",
        phase: "story",
        story: "US2",
        title: "Favoritos: listar",
        body: "Como persona quiero ver mis favoritos.",
        priority: "medium",
        size: "S",
        dependsOn: ["setup"],
        tasks: ["T020", "T021"],
      },
      {
        key: "polish",
        phase: "polish",
        title: "Favoritos: pulido",
        body: "Documentación.",
        priority: "low",
        size: "S",
        dependsOn: ["US1", "US2"],
        tasks: ["T030"],
      },
    ],
  };
}

const FAKE_GH = `#!/usr/bin/env bash
S="$FAKE_GH_STATE"
mkdir -p "$S/issues"
printf '%s\\n' "$*" >> "$S/log"
json_issue() { # n
  node -e '
    const fs = require("fs"); const [dir, n] = process.argv.slice(1);
    const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const labels = read(dir + "/" + n + ".labels").split("\\n").filter(Boolean).map((name) => ({ name }));
    const author = { login: read(dir + "/" + n + ".author").trim() || "tester" };
    process.stdout.write(JSON.stringify({ number: Number(n), state: read(dir + "/" + n + ".state").trim() || "OPEN", labels, body: read(dir + "/" + n + ".body"), author }));
  ' "$S/issues" "$1"
}
case "$1 $2" in
  "repo view") echo "acme/repo"; exit 0 ;;
  "label create") exit 0 ;;
  "issue view")
    if [ "$3" = "$FAKE_EPIC" ]; then
      printf '{"number":%s,"state":"%s","labels":[{"name":"%s"}]}\\n' "$3" "\${FAKE_EPIC_STATE:-OPEN}" "\${FAKE_EPIC_LABEL:-epic}"
      exit 0
    fi
    [ -f "$S/issues/$3.title" ] || { echo "no existe #$3" >&2; exit 1; }
    json_issue "$3"; exit 0 ;;
  "issue create")
    shift 2
    count=$(( $(cat "$S/count" 2>/dev/null || echo 0) + 1 ))
    if [ "$count" = "\${FAIL_CREATE_AT:-0}" ]; then echo "HTTP 502" >&2; exit 1; fi
    echo "$count" > "$S/count"
    n=$((100 + count))
    : > "$S/issues/$n.labels"
    while [ $# -gt 0 ]; do
      case "$1" in
        --title=*) printf '%s' "\${1#--title=}" > "$S/issues/$n.title" ;;
        --body-file) cp "$2" "$S/issues/$n.body"; shift ;;
        --label) printf '%s\\n' "$2" >> "$S/issues/$n.labels"; shift ;;
        *) echo "argumento inesperado: $1" >&2; exit 2 ;;
      esac
      shift
    done
    echo "https://github.com/acme/repo/issues/$n"; exit 0 ;;
  "issue edit")
    n="$3"; shift 3
    while [ $# -gt 0 ]; do
      [ "$1" = "--add-label" ] && printf '%s\\n' "$2" >> "$S/issues/$n.labels"
      shift
    done
    exit 0 ;;
  "project item-list") echo '{"items":[]}'; exit 0 ;;
  "project item-add") echo '{"id":"ITEM1"}'; exit 0 ;;
  "project item-edit") exit 0 ;;
  "issue list")
    if [ -n "\${FAIL_LIST:-}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    printf '['
    first=1
    for f in "$S"/issues/*.title; do
      [ -f "$f" ] || continue
      n=$(basename "$f" .title)
      [ "$first" = 1 ] || printf ','
      json_issue "$n"
      first=0
    done
    printf ']\\n'; exit 0 ;;
esac
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  n=""
  for a in "$@"; do case "$a" in number=*) n="\${a#number=}" ;; esac; done
  if [ -f "$S/issues/$n.parent" ]; then
    printf '{"data":{"repository":{"issue":{"parent":{"number":%s}}}}}\\n' "$(cat "$S/issues/$n.parent")"
  else
    printf '{"data":{"repository":{"issue":{"parent":null}}}}\\n'
  fi
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ]; then
  epic=""; id=""
  for a in "$@"; do
    case "$a" in
      repos/*/issues/*/sub_issues) epic=$(echo "$a" | sed 's#.*/issues/\\([0-9]*\\)/sub_issues#\\1#') ;;
      sub_issue_id=*) id="\${a#sub_issue_id=}" ;;
    esac
  done
  echo "$epic" > "$S/issues/$((id - 900000)).parent"
  exit 0
fi
if [ "$1 $2" = "api user" ]; then echo "\${FAKE_ME:-tester}"; exit 0; fi
if [ "$1" = "api" ]; then
  n="\${2##*/}"
  printf '{"id":%s}\\n' "$((900000 + n))"
  exit 0
fi
echo "gh falso: no sé responder a: $*" >&2
exit 3
`;

interface Project {
  dir: string;
  state: string;
  bin: string;
}

function project(tasksMd = TASKS_MD): Project {
  const remote = temp("fabrica-remote-");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  const dir = temp("fabrica-issues-");
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "specs/12-favoritos"), { recursive: true });
  writeFileSync(path.join(dir, "specs/12-favoritos/tasks.md"), tasksMd);
  writeFileSync(path.join(dir, ".gitignore"), ".factory/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "spec");
  git("remote", "add", "origin", bash(remote));
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "origin");

  const state = temp("fabrica-gh-state-");
  const bin = temp("fabrica-gh-bin-");
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  return { dir, state, bin };
}

function writePlan(p: Project, plan: Plan | string): string {
  const file = path.join(p.dir, PLAN);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof plan === "string" ? plan : JSON.stringify(plan, null, 2),
  );
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function create(
  p: Project,
  approved: string,
  env: Record<string, string> = {},
  cwd = p.dir,
) {
  const base = { ...process.env };
  delete base.CI;
  delete base.GITHUB_ACTIONS;
  const result = spawnSync(
    "bash",
    [SCRIPT, bash(path.join(p.dir, PLAN)), "--approved", approved],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...base,
        PATH: `${p.bin}${path.delimiter}${process.env.PATH}`,
        GH_REPO: "acme/repo",
        FAKE_GH_STATE: bash(p.state),
        FAKE_EPIC: String(EPIC),
        ...env,
      },
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function created(p: Project) {
  const dir = path.join(p.state, "issues");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".title"))
    .map((f) => {
      const n = Number(f.replace(".title", ""));
      const read = (ext: string) => {
        const file = path.join(dir, `${n}.${ext}`);
        return existsSync(file) ? readFileSync(file, "utf8") : "";
      };
      return {
        n,
        title: read("title"),
        body: read("body"),
        labels: read("labels").split("\n").filter(Boolean),
        parent: read("parent").trim(),
      };
    })
    .sort((a, b) => a.n - b.n);
}

const byKey = (p: Project, key: string) =>
  created(p).find((i) => i.body.includes(`fabrica-key: ${EPIC}/${key} `))!;

const log = (p: Project) => {
  const file = path.join(p.state, "log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
};

describe("fabrica-create-issues", () => {
  it(
    "crea Setup, las historias bloqueadas por Setup y Polish bloqueada por todas, colgadas de la épica",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      const { code, out } = create(p, sha);

      expect(code, out).toBe(0);
      expect(created(p)).toHaveLength(4);
      const setup = byKey(p, "setup");
      const us1 = byKey(p, "US1");
      const us2 = byKey(p, "US2");
      const polish = byKey(p, "polish");
      expect(us1.labels).toContain(`blocked-by-${setup.n}`);
      expect(us2.labels).toContain(`blocked-by-${setup.n}`);
      expect(polish.labels).toEqual(
        expect.arrayContaining([`blocked-by-${us1.n}`, `blocked-by-${us2.n}`]),
      );
      expect(setup.labels.some((l) => l.startsWith("blocked-by-"))).toBe(false);
      for (const issue of created(p)) {
        expect(issue.labels, issue.title).toContain("pending");
        expect(issue.parent, issue.title).toBe(String(EPIC));
      }
      expect(us1.labels).toContain("priority:high");
      expect(us1.labels).toContain("size:M");
    },
    TIMEOUT,
  );

  it(
    "Setup hereda la prioridad más alta de sus historias",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      create(p, sha);

      expect(byKey(p, "setup").labels).toContain("priority:high");
    },
    TIMEOUT,
  );

  it(
    "encola al final, cuando todo quedó enlazado: ninguna se crea con pending",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      create(p, sha);

      const lines = log(p);
      const creates = lines.filter((l) => l.startsWith("issue create"));
      expect(creates).toHaveLength(4);
      for (const line of creates) expect(line).not.toMatch(/pending/);
      const lastCreate = lines.findLastIndex((l) =>
        l.startsWith("issue create"),
      );
      const firstPending = lines.findIndex((l) =>
        /issue edit \d+ --add-label pending/.test(l),
      );
      expect(firstPending).toBeGreaterThan(lastCreate);
    },
    TIMEOUT,
  );

  it(
    "cada cuerpo lleva su clave y le dice al worker qué historia y qué tareas le tocan",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      create(p, sha);

      const body = byKey(p, "US1").body;
      expect(body).toContain("Como persona quiero guardar un favorito.");
      expect(body).toMatch(/<!-- fabrica-key: 12\/US1 sha=[0-9a-f]+ -->/);
      expect(body).toContain(
        "<!-- fabrica-spec: dir=specs/12-favoritos story=US1 phase=story tasks=T010,T012 -->",
      );
      expect(byKey(p, "setup").body).toContain("story=- phase=setup");
    },
    TIMEOUT,
  );

  it(
    "sin la huella que aprobó la persona no crea nada",
    () => {
      const p = project();
      writePlan(p, validPlan());

      const { code, out } = create(p, "0".repeat(64));

      expect(code).not.toBe(0);
      expect(out).toMatch(/huella/);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it.each([
    ["CI", { CI: "true" }],
    ["GitHub Actions", { GITHUB_ACTIONS: "true" }],
  ])(
    "no corre en %s: ahí no hay nadie que vea la tabla",
    (_name, env) => {
      const p = project();
      const sha = writePlan(p, validPlan());

      const { code } = create(p, sha, env);

      expect(code).not.toBe(0);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "no corre dentro de un worktree de un worker",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());
      const worktree = path.join(p.dir, ".claude/worktrees/impl-5");
      spawnSync("git", ["worktree", "add", "-q", bash(worktree)], {
        cwd: p.dir,
      });

      const { code, out } = create(p, sha, {}, worktree);

      expect(code).not.toBe(0);
      expect(out).toMatch(/worktree/);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  const invalid: Array<[string, (plan: Plan) => void]> = [
    ["una clave repetida", (pl) => (pl.issues[2]!.key = "US1")],
    [
      "una dependencia que no existe",
      (pl) => pl.issues[1]!.dependsOn.push("US9"),
    ],
    [
      "un ciclo",
      (pl) => {
        pl.issues[1]!.dependsOn.push("US2");
        pl.issues[2]!.dependsOn.push("US1");
      },
    ],
    ["un título con salto de línea", (pl) => (pl.issues[1]!.title = "a\nb")],
    [
      "un título que empieza con guion",
      (pl) => (pl.issues[1]!.title = "--label=auto-merge"),
    ],
    [
      "una prioridad que mete otra etiqueta",
      (pl) => (pl.issues[1]!.priority = "high,auto-merge"),
    ],
    ["una historia de tamaño L", (pl) => (pl.issues[1]!.size = "L")],
    [
      "una historia sin tareas de test",
      (pl) => (pl.issues[1]!.tasks = ["T012"]),
    ],
    [
      "una tarea que no está en tasks.md",
      (pl) => pl.issues[1]!.tasks.push("T999"),
    ],
    ["una historia de tasks.md sin issue", (pl) => pl.issues.splice(2, 1)],
    [
      "Polish sin depender de todas las historias",
      (pl) => (pl.issues[3]!.dependsOn = ["US1"]),
    ],
    ["sin Polish", (pl) => pl.issues.pop()],
    [
      "un cuerpo con una marca reservada",
      (pl) => (pl.issues[1]!.body = "<!-- fabrica-key: 12/x -->"),
    ],
    [
      "una carpeta de otra épica",
      (pl) => (pl.featureDir = "specs/13-favoritos"),
    ],
    ["una clave con espacios", (pl) => (pl.issues[0]!.key = "set up")],
    [
      "una historia que se lleva una tarea de otra",
      (pl) => pl.issues[1]!.tasks.push("T021"),
    ],
    ["una tarea en dos issues", (pl) => pl.issues[3]!.tasks.push("T001")],
    [
      "una tarea de tasks.md que no está en ninguna issue",
      (pl) => (pl.issues[0]!.tasks = ["T001"]),
    ],
    [
      "sin Setup aunque tasks.md tiene tareas de Setup",
      (pl) => {
        pl.issues.shift();
        for (const issue of pl.issues)
          issue.dependsOn = issue.dependsOn.filter((d) => d !== "setup");
      },
    ],
  ];

  it.each(invalid)(
    "con %s no crea nada y lo dice",
    (_name, mutate) => {
      const p = project();
      const plan = validPlan();
      mutate(plan);
      const sha = writePlan(p, plan);

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toMatch(/❌/);
      expect(log(p).some((l) => l.startsWith("issue create"))).toBe(false);
    },
    TIMEOUT,
  );

  // Las dos historias conectan su cambio en src/cli.ts y suman tests a
  // tests/cli.test.ts. Setup y Polish también tocan src/cli.ts, y las dos
  // historias leen la misma spec: nada de eso cuenta, porque Setup va antes y
  // Polish después, y specs/ no se edita.
  const SHARED_TASKS_MD = TASKS_MD.replace(
    "T004 Setup database schema",
    "T004 Usar el esquema en src/cli.ts",
  )
    .replace(
      "T010 [P] [US1] Contract test for saving in tests/favoritos.test.ts",
      "T010 [P] [US1] Tests en tests/cli.test.ts, según specs/12-favoritos/contracts/cli.md",
    )
    .replace(
      "T012 [US1] Implement save in src/favoritos.ts",
      "T012 [US1] Implement save in src/favoritos.ts y conectarlo en `src/cli.ts`",
    )
    .replace(
      "T020 [P] [US2] Test the list in tests/listar.test.ts",
      "T020 [P] [US2] Tests en tests/cli.test.ts, según specs/12-favoritos/contracts/cli.md",
    )
    .replace(
      "T021 [US2] Implement the list in src/listar.ts",
      "T021 [US2] Implement the list in src/listar.ts (conectarlo en src/cli.ts)",
    )
    .replace("T030 Update the docs", "T030 Ayuda en src/cli.ts");

  it(
    "si dos historias en paralelo tocan el mismo archivo, no crea nada y nombra los archivos",
    () => {
      const p = project(SHARED_TASKS_MD);
      const sha = writePlan(p, validPlan());

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toContain(
        "❌ US1 y US2 pueden ir en paralelo y las dos cambian src/cli.ts, tests/cli.test.ts",
      );
      expect(out).toMatch(/dependsOn/);
      expect(out).toMatch(/Foundational/);
      expect(out).not.toMatch(
        /setup y|y polish|specs\/12-favoritos\/contracts/,
      );
      expect(log(p).some((l) => l.startsWith("issue create"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "si una de esas historias depende de la otra, las crea en orden",
    () => {
      const p = project(SHARED_TASKS_MD);
      const plan = validPlan();
      plan.issues[2]!.dependsOn.push("US1");
      const sha = writePlan(p, plan);

      const { code, out } = create(p, sha);

      expect(code, out).toBe(0);
      expect(byKey(p, "US2").labels).toContain(
        `blocked-by-${byKey(p, "US1").n}`,
      );
    },
    TIMEOUT,
  );

  it(
    "con un JSON que no es JSON no crea nada",
    () => {
      const p = project();
      const sha = writePlan(p, "{ no es json");

      const { code } = create(p, sha);

      expect(code).not.toBe(0);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "si falla a mitad, la segunda corrida termina sin duplicar",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      const first = create(p, sha, { FAIL_CREATE_AT: "3" });
      expect(first.code).not.toBe(0);
      expect(created(p)).toHaveLength(2);

      const second = create(p, sha);

      expect(second.code, second.out).toBe(0);
      const keys = created(p).map(
        (i) => i.body.match(/fabrica-key: 12\/(\S+) /)![1],
      );
      expect(keys.sort()).toEqual(["US1", "US2", "polish", "setup"]);
      for (const issue of created(p)) {
        expect(issue.labels).toContain("pending");
        expect(issue.parent).toBe(String(EPIC));
      }
    },
    TIMEOUT,
  );

  // Cualquiera que pueda abrir issues podía copiar una marca: create-issues
  // tomaba su issue como ya creada y al final le ponía pending.
  it(
    "para sin tocar nada si una marca está en una issue que abrió otra cuenta",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());
      create(p, sha);
      const us1 = byKey(p, "US1");
      writeFileSync(
        path.join(p.state, "issues", `${us1.n}.author`),
        "intruso\n",
      );
      const before = log(p).length;

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toContain(`#${us1.n}`);
      expect(out).toContain("intruso");
      expect(
        log(p)
          .slice(before)
          .filter((l) => /^issue (create|edit)/.test(l)),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "para y nombra la issue si una ya creada cambió en el JSON",
    () => {
      const p = project();
      create(p, writePlan(p, validPlan()));
      const changed = validPlan();
      changed.issues[1]!.title = "Favoritos: guardar y borrar";

      const { code, out } = create(p, writePlan(p, changed));

      expect(code).not.toBe(0);
      expect(out).toContain("US1");
      expect(created(p)).toHaveLength(4);
    },
    TIMEOUT,
  );

  it(
    "al repetir no vuelve a encolar una issue que ya está en progreso",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());
      create(p, sha);
      const us1 = byKey(p, "US1");
      const labelsFile = path.join(p.state, "issues", `${us1.n}.labels`);
      writeFileSync(
        labelsFile,
        us1.labels
          .filter((l) => l !== "pending")
          .concat("in-progress")
          .join("\n") + "\n",
      );

      const { code, out } = create(p, sha);

      expect(code, out).toBe(0);
      expect(byKey(p, "US1").labels).not.toContain("pending");
    },
    TIMEOUT,
  );

  it.each([
    ["cerrada", { FAKE_EPIC_STATE: "CLOSED" }],
    ["sin la etiqueta epic", { FAKE_EPIC_LABEL: "bug" }],
  ])(
    "no crea nada si la épica está %s",
    (_name, env) => {
      const p = project();
      const sha = writePlan(p, validPlan());

      const { code, out } = create(p, sha, env);

      expect(code).not.toBe(0);
      expect(out).toMatch(/épica/);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "si falla el listado de las issues ya creadas, no crea nada",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());

      const { code } = create(p, sha, { FAIL_LIST: "1" });

      expect(code).not.toBe(0);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "si una issue ya creada cambió en el JSON, para antes de crear ninguna nueva",
    () => {
      const p = project();
      const first = create(p, writePlan(p, validPlan()), {
        FAIL_CREATE_AT: "3",
      });
      expect(first.code).not.toBe(0);
      expect(created(p)).toHaveLength(2);
      const changed = validPlan();
      const [setup, us1, us2, polish] = changed.issues;
      us1!.title = "Favoritos: guardar y borrar";
      changed.issues = [setup!, us2!, us1!, polish!];

      const { code, out } = create(p, writePlan(p, changed));

      expect(code).not.toBe(0);
      expect(out).toContain("US1");
      expect(created(p)).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    "si dos issues llevan la misma marca, para y las nombra",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());
      create(p, sha);
      const us1 = byKey(p, "US1");
      const issues = path.join(p.state, "issues");
      for (const ext of ["title", "body", "labels"]) {
        writeFileSync(
          path.join(issues, `999.${ext}`),
          readFileSync(path.join(issues, `${us1.n}.${ext}`)),
        );
      }

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toContain("US1");
      expect(out).toContain("#999");
    },
    TIMEOUT,
  );

  it(
    "al repetir, solo pone en el tablero las issues que crea, no las que ya existían",
    () => {
      const p = project();
      mkdirSync(path.join(p.dir, ".plan"), { recursive: true });
      writeFileSync(
        path.join(p.dir, ".plan/project.json"),
        JSON.stringify({
          owner: "acme",
          projectNumber: 1,
          projectId: "P1",
          statusFieldId: "F1",
          statusOptions: { Todo: "O1", Blocked: "O2" },
        }),
      );
      const sha = writePlan(p, validPlan());
      const boardEdits = () =>
        log(p).filter((l) => l.startsWith("project item-edit")).length;

      create(p, sha);
      const afterFirst = boardEdits();
      const { code, out } = create(p, sha);

      expect(afterFirst, "la primera corrida tiene que usar el tablero").toBe(
        4,
      );
      expect(code, out).toBe(0);
      expect(boardEdits()).toBe(afterFirst);
    },
    TIMEOUT,
  );

  it(
    "si hay otra corrida en curso no hace nada y no le borra su candado",
    () => {
      const p = project();
      const sha = writePlan(p, validPlan());
      const lock = path.join(p.dir, ".factory/state/create-issues.lock");
      mkdirSync(lock, { recursive: true });

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toMatch(/otra corrida/);
      expect(existsSync(lock)).toBe(true);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "con tasks.md cambiado sin commitear no crea nada: se valida lo aprobado",
    () => {
      const p = project();
      const tasks = path.join(p.dir, "specs/12-favoritos/tasks.md");
      writeFileSync(
        tasks,
        `${readFileSync(tasks, "utf8")}\n<!-- nota local, sin commitear -->\n`,
      );
      const sha = writePlan(p, validPlan());

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toMatch(/tasks\.md/);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "no crea nada si HEAD no es lo último de origin/main",
    () => {
      const p = project();
      writeFileSync(path.join(p.dir, "local.txt"), "sin pushear\n");
      spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "add", "local.txt"],
        { cwd: p.dir },
      );
      spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-q",
          "-m",
          "local",
        ],
        { cwd: p.dir },
      );
      const sha = writePlan(p, validPlan());

      const { code, out } = create(p, sha);

      expect(code).not.toBe(0);
      expect(out).toMatch(/origin\/main/);
      expect(created(p)).toHaveLength(0);
    },
    TIMEOUT,
  );
});
