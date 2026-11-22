// Migra los archivos que un proyecto de fabrica-template comparte con la
// fábrica: CLAUDE.md, .claude/settings.json y package.json. Corre desde la raíz
// del proyecto, llamado por `fabrica-setup init`.
//
//   node migrate-template.mjs <CLAUDE.md del plugin> <settings.json del plugin>
//
// Cada función deja intacto lo que es del proyecto y quita o reemplaza solo lo
// que trajo la plantilla. Imprime una línea por archivo que cambió.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeSettings } from "./merge-settings.mjs";

const FACTORY_SKILLS = ["write-prd", "write-ticket", "bootstrap"];

// El encabezado puede llevar una aclaración entre paréntesis:
// "## Project skills (load them, don't improvise)".
function section(text, heading) {
  const start = text.search(
    new RegExp(`^## ${heading}(?:[ \\t]+\\(.*\\))?[ \\t]*$`, "m"),
  );
  if (start < 0) return null;
  const bodyStart = text.indexOf("\n", start) + 1;
  const rest = text.slice(bodyStart);
  const next = rest.search(/^## /m);
  const end = next < 0 ? text.length : bodyStart + next;
  return { start, bodyStart, end, body: text.slice(bodyStart, end) };
}

export function migrateClaudeMd(old, template) {
  if (old.includes("@.factory/rules/fabrica.md")) return null;
  let next = template;

  const oldTitle = old.match(/^# .*$/m);
  if (oldTitle) next = next.replace(/^# .*$/m, oldTitle[0]);

  const oldProject = section(old, "Project");
  const newProject = section(next, "Project");
  if (oldProject && newProject) {
    const body = oldProject.body.replace(
      /(^|[^./])rules\/stacks\//g,
      "$1.factory/rules/stacks/",
    );
    next =
      next.slice(0, newProject.bodyStart) + body + next.slice(newProject.end);
  }

  const oldSkills = section(old, "Project skills");
  if (oldSkills) {
    const rows = oldSkills.body
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .filter((line) => !line.includes("<!--"))
      .filter((line) => !FACTORY_SKILLS.some((s) => line.includes(`\`${s}\``)));
    const newSkills = section(next, "Project skills");
    if (rows.length && newSkills) {
      const lines = newSkills.body.split("\n");
      const separator = lines.findIndex((line) => /^\|\s*-/.test(line));
      lines.splice(separator + 1, 0, ...rows);
      next =
        next.slice(0, newSkills.bodyStart) +
        lines.join("\n") +
        next.slice(newSkills.end);
    }
  }

  // El aviso de rellenar placeholders sobra si el proyecto ya los rellenó.
  const withoutNotice = next.replace(
    /\n<!-- Reemplaza los placeholders[\s\S]*?-->\n/,
    "\n",
  );
  return withoutNotice.includes("{{") ? next : withoutNotice;
}

export function migrateSettings(old, template) {
  const next = mergeSettings(old, template, ".claude/settings.json");
  if (next.hooks) {
    for (const [event, groups] of Object.entries(next.hooks)) {
      const kept = groups
        .map((group) => ({
          ...group,
          hooks: (group.hooks ?? []).filter(
            (hook) => !String(hook.command ?? "").includes(".claude/hooks/"),
          ),
        }))
        .filter((group) => group.hooks.length > 0);
      if (kept.length) next.hooks[event] = kept;
      else delete next.hooks[event];
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  return next;
}

const KIT_SCRIPTS = {
  "test:kit": "vitest.kit.config",
  "ui:screenshots": "scripts/capture-ui.ts",
};

export function migratePackageJson(old) {
  const next = structuredClone(old);
  const removed = [];
  for (const [name, marker] of Object.entries(KIT_SCRIPTS)) {
    if (String(next.scripts?.[name] ?? "").includes(marker)) {
      delete next.scripts[name];
      removed.push(name);
    }
  }
  return { next, removed };
}

function readText(file) {
  return readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    throw new Error(`${file} no es JSON válido: ${error.message}`);
  }
}

// Calcula los tres archivos antes de escribir ninguno: si uno falla, el
// proyecto queda como estaba.
function main([claudeTemplate, settingsTemplate]) {
  const writes = [];

  if (existsSync("CLAUDE.md")) {
    const migrated = migrateClaudeMd(
      readText("CLAUDE.md"),
      readText(claudeTemplate),
    );
    if (migrated !== null) {
      writes.push({
        file: "CLAUDE.md",
        body: migrated,
        note: "conserva Project y las skills del proyecto; las reglas pasan a .factory/rules/",
      });
    }
  }

  if (existsSync(".claude/settings.json")) {
    const old = readJson(".claude/settings.json");
    const next = migrateSettings(old, readJson(settingsTemplate));
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      writes.push({
        file: ".claude/settings.json",
        body: `${JSON.stringify(next, null, 2)}\n`,
        note: "sin los hooks de .claude/hooks/, con los permisos de la fábrica",
      });
    }
  }

  if (existsSync("package.json")) {
    const { next, removed } = migratePackageJson(readJson("package.json"));
    if (removed.length) {
      writes.push({
        file: "package.json",
        body: `${JSON.stringify(next, null, 2)}\n`,
        note: `sin ${removed.join(", ")}`,
      });
    }
  }

  for (const { file, body, note } of writes) {
    writeFileSync(file, body);
    console.log(`  ✎ ${file}: ${note}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
