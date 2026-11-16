// Suma a un .claude/settings.json que ya existe los permisos de la fábrica que
// le falten, sin quitar ni cambiar nada más. `fabrica-setup init` lo llama
// cuando el archivo ya está, por ejemplo porque `claude plugin install
// --scope project` lo creó solo con enabledPlugins.
//
//   node merge-settings.mjs <settings.json del proyecto> <settings.json del plugin>
//
// Imprime "changed" si reescribió el archivo y "same" si ya tenía todo. Si el
// archivo no es JSON o sus permisos no son listas, no escribe nada y sale con 1.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = ["allow", "deny"];

function rules(settings, kind, file) {
  const list = settings.permissions?.[kind];
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((rule) => typeof rule !== "string")) {
    throw new Error(
      `${file}: permissions.${kind} tiene que ser una lista de textos`,
    );
  }
  return list;
}

// Une las listas allow y deny: primero las del proyecto, después las de la
// plantilla que falten.
export function mergePermissions(old, template, file = "settings.json") {
  const next = structuredClone(old);
  for (const kind of KINDS) {
    const merged = [
      ...new Set([
        ...rules(old, kind, file),
        ...rules(template, kind, "la plantilla"),
      ]),
    ];
    if (merged.length) (next.permissions ??= {})[kind] = merged;
  }
  return next;
}

function readJson(file) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} no es JSON válido: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} tiene que ser un objeto JSON`);
  }
  return value;
}

function main([projectFile, templateFile]) {
  const old = readJson(projectFile);
  const next = mergePermissions(old, readJson(templateFile), projectFile);
  if (JSON.stringify(old) === JSON.stringify(next)) {
    console.log("same");
    return;
  }
  writeFileSync(projectFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log("changed");
}

// Solo corre como comando; migrate-template.mjs lo importa por mergePermissions.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
