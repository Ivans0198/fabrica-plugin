// La parte de fabrica-create-issues que valida y lee JSON. Las llamadas a gh
// las hace create-issues.sh; esto nunca ejecuta nada.
//
//   node issues-plan.mjs plan <json> <carpeta>  valida el JSON contra tasks.md,
//       escribe el cuerpo de cada issue en <carpeta>/body-<i>.md e imprime el
//       plan: líneas "@@sha", "@@epic", "@@dir" y una por issue, en orden de
//       dependencias: i<TAB>clave<TAB>título<TAB>prioridad<TAB>tamaño<TAB>dependencias
//   node issues-plan.mjs markers <archivo> <épica> <límite> <cuenta>
//       (el archivo: gh issue list --json number,body,author) imprime
//       "número clave huella" de las issues ya creadas para esa épica; para
//       si una marca está en una issue de otra cuenta
//   node issues-plan.mjs state             (stdin: gh issue view --json state,labels)
//       imprime "ESTADO etiqueta,etiqueta"
//   node issues-plan.mjs parent            (stdin: la consulta graphql del padre)
//   node issues-plan.mjs id                (stdin: gh api repos/.../issues/N)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const TASK = /^T\d{3,}$/;
const PRIORITIES = ["high", "medium", "low"];
const SIZES = ["S", "M"];
const PHASES = ["setup", "story", "polish"];
const CONTROL = /[\u0000-\u001f\u007f]/;
const MARKERS = /fabrica-(key|spec):/;
const MAX_BODY = 60000;
// Una ruta de archivo en el texto de una tarea: al menos una carpeta y una
// extensión, como src/cli.ts.
const PATH = /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g;

function stdinJson() {
  return JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Historias, tareas y tareas de test de cada historia, leídas de tasks.md.
 * `owner` dice de qué issue es cada tarea según su fase: "setup" (Setup y
 * Foundational), "US<n>" o "polish". Una tarea fuera de esas fases no tiene
 * dueño y no se exige en ninguna issue. `files` dice qué archivos nombra cada
 * tarea, sin los de specs/, que se leen y no se editan.
 */
export function parseTasks(markdown) {
  const tasks = new Set();
  const stories = new Set();
  const testTasks = new Map();
  const owner = new Map();
  const files = new Map();
  let story = null;
  let phaseOwner = null;
  let inTests = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const phase = line.match(/^##\s+(?!#)(.*)$/);
    if (phase) {
      const us = phase[1].match(/User Story (\d+)/i);
      story = us ? `US${us[1]}` : null;
      if (story) stories.add(story);
      if (story) phaseOwner = story;
      else if (/Setup|Foundational/i.test(phase[1])) phaseOwner = "setup";
      else if (/Polish/i.test(phase[1])) phaseOwner = "polish";
      else phaseOwner = null;
      inTests = false;
      continue;
    }
    const sub = line.match(/^###\s+(.*)$/);
    if (sub) {
      inTests = story !== null && /^Tests for User Story/i.test(sub[1]);
      continue;
    }
    const task = line.match(/^\s*-\s*\[[ xX]\]\s+(T\d+)\b/);
    if (!task) continue;
    tasks.add(task[1]);
    files.set(
      task[1],
      [...line.matchAll(PATH)]
        .map((m) => m[1])
        .filter((f) => !f.startsWith("specs/")),
    );
    if (phaseOwner) owner.set(task[1], phaseOwner);
    if (inTests && story) {
      if (!testTasks.has(story)) testTasks.set(story, new Set());
      testTasks.get(story).add(task[1]);
    }
  }
  return { tasks, stories, testTasks, owner, files };
}

/** De qué dueño de tasks.md puede llevar tareas una entrada del JSON. */
function ownerOf(entry) {
  return entry.phase === "story" ? entry.story : entry.phase;
}

function validate(data, errors) {
  const fail = (message) => errors.push(message);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("el JSON tiene que ser un objeto con epic, featureDir e issues");
    return null;
  }
  const { epic, featureDir, issues } = data;
  if (!Number.isInteger(epic) || epic < 1)
    fail("epic tiene que ser el número de la issue de la épica");
  const dirPattern = new RegExp(`^specs/${epic}-[A-Za-z0-9._-]+$`);
  if (typeof featureDir !== "string" || !dirPattern.test(featureDir)) {
    fail(
      `featureDir tiene que ser specs/${epic}-<nombre>, la carpeta de esta épica`,
    );
    return null;
  }
  const tasksFile = `${featureDir}/tasks.md`;
  if (!existsSync(tasksFile)) {
    fail(
      `no existe ${tasksFile}: corre /fabrica:tasks y mergea el PR de la spec`,
    );
    return null;
  }
  if (!Array.isArray(issues) || issues.length === 0) {
    fail("issues tiene que ser una lista con al menos una issue");
    return null;
  }
  const spec = parseTasks(readFileSync(tasksFile, "utf8"));

  const keys = new Set();
  const storyEntries = new Map();
  for (const [i, entry] of issues.entries()) {
    const where = `issues[${i}]${entry && typeof entry.key === "string" ? ` (${entry.key})` : ""}`;
    if (!entry || typeof entry !== "object") {
      fail(`${where}: no es un objeto`);
      continue;
    }
    if (typeof entry.key !== "string" || !KEY.test(entry.key))
      fail(
        `${where}: key tiene que tener solo letras, números, guion o guion bajo`,
      );
    else if (keys.has(entry.key))
      fail(`${where}: la clave ${entry.key} está repetida`);
    else keys.add(entry.key);
    if (!PHASES.includes(entry.phase))
      fail(`${where}: phase tiene que ser setup, story o polish`);
    if (
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      entry.title.length > 256 ||
      CONTROL.test(entry.title) ||
      entry.title.startsWith("-")
    )
      fail(
        `${where}: el título tiene que ser una línea de hasta 256 caracteres, sin caracteres de control y sin empezar con guion`,
      );
    if (typeof entry.body !== "string" || entry.body.length > MAX_BODY)
      fail(
        `${where}: body tiene que ser un texto de hasta ${MAX_BODY} caracteres`,
      );
    else if (MARKERS.test(entry.body))
      fail(
        `${where}: el cuerpo no puede traer las marcas fabrica-key ni fabrica-spec; las pone el script`,
      );
    if (!PRIORITIES.includes(entry.priority))
      fail(`${where}: priority tiene que ser high, medium o low`);
    if (entry.size === "L")
      fail(`${where}: una issue de tamaño L se parte antes de crearla`);
    else if (!SIZES.includes(entry.size))
      fail(`${where}: size tiene que ser S o M`);
    if (
      !Array.isArray(entry.dependsOn) ||
      entry.dependsOn.some((d) => typeof d !== "string")
    )
      fail(`${where}: dependsOn tiene que ser una lista de claves`);
    if (
      !Array.isArray(entry.tasks) ||
      entry.tasks.some((t) => typeof t !== "string" || !TASK.test(t))
    )
      fail(`${where}: tasks tiene que ser una lista de IDs como T010`);
    else
      for (const t of entry.tasks)
        if (!spec.tasks.has(t))
          fail(`${where}: la tarea ${t} no está en ${tasksFile}`);
    if (entry.phase === "story") {
      if (typeof entry.story !== "string" || !/^US\d+$/.test(entry.story))
        fail(`${where}: una historia necesita story, como US1`);
      else if (storyEntries.has(entry.story))
        fail(`${where}: la historia ${entry.story} tiene dos issues`);
      else {
        storyEntries.set(entry.story, entry);
        const tests = spec.testTasks.get(entry.story) ?? new Set();
        if (tests.size === 0)
          fail(
            `${where}: ${entry.story} no tiene tareas de test en ${tasksFile}`,
          );
        else if (
          Array.isArray(entry.tasks) &&
          !entry.tasks.some((t) => tests.has(t))
        )
          fail(
            `${where}: ${entry.story} no incluye ninguna de sus tareas de test (${[...tests].join(", ")})`,
          );
      }
    }
  }
  if (errors.length) return null;

  for (const story of spec.stories)
    if (!storyEntries.has(story))
      fail(`${story} está en ${tasksFile} y no tiene issue`);
  for (const story of storyEntries.keys())
    if (!spec.stories.has(story)) fail(`${story} no está en ${tasksFile}`);
  const setups = issues.filter((e) => e.phase === "setup");
  const polishes = issues.filter((e) => e.phase === "polish");
  if (setups.length > 1) fail("hay más de una issue de Setup + Foundational");
  if (setups.length === 0 && [...spec.owner.values()].includes("setup"))
    fail(
      `${tasksFile} tiene tareas de Setup o Foundational: hace falta una issue de Setup`,
    );

  // Cada tarea va en la issue de su fase, y en una sola.
  const placedIn = new Map();
  for (const e of issues) {
    for (const t of e.tasks) {
      const taskOwner = spec.owner.get(t);
      if (taskOwner && taskOwner !== ownerOf(e))
        fail(`${e.key} lleva ${t}, que en ${tasksFile} es de ${taskOwner}`);
      if (placedIn.has(t))
        fail(`${t} está en dos issues: ${placedIn.get(t)} y ${e.key}`);
      else placedIn.set(t, e.key);
    }
  }
  for (const [t, taskOwner] of spec.owner)
    if (!placedIn.has(t))
      fail(`${t} (${taskOwner}) está en ${tasksFile} y en ninguna issue`);
  if (polishes.length !== 1)
    fail("tiene que haber exactamente una issue de Polish");
  const storyKeys = [...storyEntries.values()].map((e) => e.key);
  for (const e of issues) {
    for (const d of e.dependsOn) {
      if (d === e.key) fail(`${e.key} depende de sí misma`);
      else if (!keys.has(d)) fail(`${e.key} depende de ${d}, que no existe`);
    }
  }
  if (polishes.length === 1) {
    const missing = storyKeys.filter((k) => !polishes[0].dependsOn.includes(k));
    if (missing.length)
      fail(
        `Polish tiene que depender de todas las historias; le faltan ${missing.join(", ")}`,
      );
  }
  if (setups.length === 1) {
    const missing = [...storyEntries.values()]
      .filter((e) => !e.dependsOn.includes(setups[0].key))
      .map((e) => e.key);
    if (missing.length)
      fail(
        `Las historias dependen de Setup; no lo hacen ${missing.join(", ")}`,
      );
  }
  if (errors.length) return null;

  const order = topological(issues, fail);
  if (!order) return null;
  checkSharedFiles(order, spec.files, fail);
  if (errors.length) return null;

  // Setup bloquea a todas: hereda la prioridad más alta de sus historias.
  if (setups.length === 1 && storyEntries.size) {
    const best = Math.min(
      ...[...storyEntries.values()].map((e) => PRIORITIES.indexOf(e.priority)),
    );
    setups[0].priority = PRIORITIES[best];
  }
  return { epic, featureDir, order };
}

function topological(issues, fail) {
  const byKey = new Map(issues.map((e) => [e.key, e]));
  const done = new Set();
  const order = [];
  while (order.length < issues.length) {
    const next = issues.find(
      (e) => !done.has(e.key) && e.dependsOn.every((d) => done.has(d)),
    );
    if (!next) {
      fail(
        `hay un ciclo de dependencias entre ${issues
          .filter((e) => !done.has(e.key))
          .map((e) => e.key)
          .join(", ")}`,
      );
      return null;
    }
    done.add(next.key);
    order.push(byKey.get(next.key));
  }
  return order;
}

// Dos issues que pueden ir en paralelo no cambian el mismo archivo: cada PR
// se mergea bien solo, pero el segundo choca con el primero y nadie lo
// rebasa. Que una dependa de la otra hace que la segunda arranque desde la
// base con la primera ya mergeada.
function checkSharedFiles(order, taskFiles, fail) {
  const ancestors = new Map();
  for (const e of order) {
    const set = new Set(e.dependsOn);
    for (const d of e.dependsOn) for (const a of ancestors.get(d)) set.add(a);
    ancestors.set(e.key, set);
  }
  const filesOf = (e) =>
    new Set(e.tasks.flatMap((t) => taskFiles.get(t) ?? []));
  for (const [i, a] of order.entries()) {
    for (const b of order.slice(i + 1)) {
      if (ancestors.get(b.key).has(a.key) || ancestors.get(a.key).has(b.key))
        continue;
      const inA = filesOf(a);
      const shared = [...filesOf(b)].filter((f) => inA.has(f)).sort();
      if (shared.length)
        fail(
          `${a.key} y ${b.key} pueden ir en paralelo y las dos cambian ${shared.join(", ")}: sus PRs van a chocar. Haz que una dependa de la otra (dependsOn) o pasa ese cambio a una tarea de Foundational.`,
        );
    }
  }
}

function entrySha(entry) {
  const { key, phase, story, title, body, priority, size, dependsOn, tasks } =
    entry;
  return sha256(
    JSON.stringify({
      key,
      phase,
      story: story ?? null,
      title,
      body,
      priority,
      size,
      dependsOn,
      tasks,
    }),
  ).slice(0, 16);
}

function plan(file, outDir) {
  const raw = readFileSync(file);
  let data;
  try {
    data = JSON.parse(raw.toString("utf8").replace(/^﻿/, ""));
  } catch (error) {
    console.error(`❌ ${file} no es JSON válido: ${error.message}`);
    process.exit(1);
  }
  const errors = [];
  const result = validate(data, errors);
  if (!result) {
    for (const message of errors) console.error(`❌ ${message}`);
    process.exit(1);
  }
  const { epic, featureDir, order } = result;
  const lines = [
    `@@sha ${sha256(raw)}`,
    `@@epic ${epic}`,
    `@@dir ${featureDir}`,
  ];
  order.forEach((entry, i) => {
    const marks = [
      `<!-- fabrica-key: ${epic}/${entry.key} sha=${entrySha(entry)} -->`,
      `<!-- fabrica-spec: dir=${featureDir} story=${entry.story ?? "-"} phase=${entry.phase} tasks=${entry.tasks.join(",")} -->`,
    ];
    writeFileSync(
      `${outDir}/body-${i}.md`,
      `${entry.body.replace(/\s+$/, "")}\n\n${marks.join("\n")}\n`,
    );
    lines.push(
      [
        i,
        entry.key,
        entry.title,
        entry.priority,
        entry.size,
        entry.dependsOn.join(" "),
      ].join("\t"),
    );
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Lee el listado de issues desde un archivo: si gh falló, el archivo está mal
// y esto falla, en vez de dar "ninguna creada" y duplicar todo.
function markers(file, epic, limit, me) {
  if (!/^\d+$/.test(epic) || !/^\d+$/.test(limit)) process.exit(2);
  const issues = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!Array.isArray(issues)) {
    console.error("❌ gh no devolvió una lista de issues");
    process.exit(1);
  }
  if (issues.length >= Number(limit)) {
    console.error(
      `❌ El repo tiene ${limit} issues o más y no puedo ver si alguna ya es de esta épica. Pide ayuda: hay que ampliar la búsqueda.`,
    );
    process.exit(1);
  }
  const pattern = new RegExp(
    `fabrica-key: ${epic}/([A-Za-z0-9_-]+) sha=([0-9a-f]+)`,
  );
  const seen = new Map();
  const lines = [];
  for (const issue of issues) {
    const match = String(issue.body ?? "").match(pattern);
    if (!match || !Number.isInteger(issue.number)) continue;
    const author = String(issue.author?.login ?? "");
    if (author !== me) {
      console.error(
        `❌ La issue #${issue.number} lleva la marca de ${match[1]}, pero la abrió ${author || "otra cuenta"} y no ${me}. No creé nada. Si es legítima, vuelve a correr con la cuenta que la creó; si no, ciérrala y quítale la marca.`,
      );
      process.exit(1);
    }
    if (seen.has(match[1])) {
      console.error(
        `❌ Dos issues llevan la marca de ${match[1]}: #${seen.get(match[1])} y #${issue.number}. Cierra o corrige la que sobra y vuelve a correr.`,
      );
      process.exit(1);
    }
    seen.set(match[1], issue.number);
    lines.push(`${issue.number} ${match[1]} ${match[2]}`);
  }
  if (lines.length) console.log(lines.join("\n"));
}

const [command, ...args] = process.argv.slice(2);
if (command === "plan") plan(args[0], args[1]);
else if (command === "markers") markers(args[0], args[1], args[2], args[3]);
else if (command === "state") {
  const issue = stdinJson();
  console.log(
    `${issue.state} ${(issue.labels ?? []).map((l) => l.name).join(",")}`,
  );
} else if (command === "parent") {
  console.log(stdinJson()?.data?.repository?.issue?.parent?.number ?? "");
} else if (command === "id") {
  const id = stdinJson().id;
  if (!Number.isInteger(id)) process.exit(1);
  console.log(id);
} else {
  console.error("Uso: issues-plan.mjs plan|markers|state|parent|id");
  process.exit(2);
}
