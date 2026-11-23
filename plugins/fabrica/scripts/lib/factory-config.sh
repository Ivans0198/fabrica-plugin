#!/usr/bin/env bash
# Lee factory.json: el archivo donde cada proyecto declara sus comandos (test,
# lint, typecheck...) y sus reglas de formato. Se carga con `source`.
#
# Los comandos son listas JSON, por ejemplo "test": ["go", "test", "./..."],
# y se ejecutan como lista de argumentos, sin pasar por un shell: un nombre de
# archivo raro no puede convertirse en código.
#
# Lee con jq. Si no hay jq (Git Bash no lo trae), lee con node. Si no hay
# ninguno de los dos, lo dice en vez de dar todo por bueno: un gate que no
# puede leer su configuración no puede dejar pasar nada.
# FACTORY_JSON_READER=jq|node|none fuerza el lector (lo usan los tests).

FACTORY_CONFIG_FILE="${FACTORY_CONFIG_FILE:-factory.json}"

# En un worker (FABRICA_WORKER=1), factory.json se lee de la rama base y no del
# árbol: los hooks y fabrica-cmd corren sus comandos sin pasar por los
# permisos, y el agente podría escribir uno propio (revisión del 2026-11-23).
# La base la pone el orquestador en FABRICA_BASE. Sin origin/<base> se queda
# con el del árbol, igual que el Stop gate, que sin la base no compara nada.
# Se llama después de entrar a la raíz del checkout.
factory_use_base_config() {
  [ "${FABRICA_WORKER:-}" = 1 ] && [ "$FACTORY_CONFIG_FILE" = factory.json ] || return 0
  local base="${FABRICA_BASE:-main}" copy
  copy=$(git rev-parse --git-path fabrica-factory-base.json 2>/dev/null) || return 0
  git show "origin/$base:factory.json" > "$copy" 2>/dev/null || { rm -f "$copy"; return 0; }
  FACTORY_CONFIG_FILE="$copy"
}

# Protocolo de salida de factory_query: la primera línea es el estado
# (@@set@@, @@off@@ o "@@error@@ <motivo>") y las siguientes, los argumentos.
# En las reglas de formato, cada regla empieza con una línea @@rule@@.
FACTORY_JQ_PROGRAM='
def is_cmd: type == "array" and length > 0
  and all(.[]; type == "string" and length > 0 and (test("[\r\n]") | not));
def command_lines:
  if (.commands | type) != "object" then "@@error@@ \($file): falta el objeto commands"
  elif (.commands | has($key) | not) then "@@error@@ \($file): falta commands.\($key); pon el comando o null"
  elif .commands[$key] == null then "@@off@@"
  elif (.commands[$key] | is_cmd) then "@@set@@", .commands[$key][]
  else "@@error@@ \($file): commands.\($key) tiene que ser null o una lista de textos no vacíos, sin saltos de línea"
  end;
def format_lines:
  (.format // []) as $rules
  | if ($rules | type) != "array" then "@@error@@ \($file): format tiene que ser una lista de reglas"
    elif any($rules[]; (.extensions | type) != "array" or (.cmd | is_cmd | not))
      then "@@error@@ \($file): cada regla de format necesita extensions (lista) y cmd (lista de textos)"
    else "@@set@@", ($rules[] | select(any(.extensions[]; . == $key)) | "@@rule@@", .cmd[])
    end;
def hook_path_lines:
  (.tool_input.file_path // .file_path // "") as $path
  | if ($path | type) == "string" and $path != "" then "@@set@@", $path else "@@off@@" end;
def model_lines:
  ((.models | objects | .[$key]) // null) as $model
  | if $model == null then "@@off@@"
    elif ($model | type) == "string" and ($model | test("\\A[A-Za-z0-9._-]+\\z")) then "@@set@@", $model
    else "@@error@@ \($file): models.\($key) tiene que ser un nombre de modelo (letras, números, punto o guion)"
    end;
def value_lines:
  (if type == "object" then .[$key] else null end) as $value
  | if $value == null then "@@off@@"
    elif ($value | type) == "number" then "@@set@@", ($value | tostring)
    elif ($value | type) == "string" and $value != "" and ($value | test("[\r\n]") | not) then "@@set@@", $value
    else "@@error@@ \($file): \($key) tiene que ser un texto de una línea o un número"
    end;
if $kind == "command" then command_lines
elif $kind == "format" then format_lines
elif $kind == "model" then model_lines
elif $kind == "value" then value_lines
else hook_path_lines end
'

FACTORY_NODE_PROGRAM='
const fs = require("fs");
const [file, kind, key] = process.argv.slice(1);
const out = (lines) => { process.stdout.write(lines.join("\n") + "\n"); process.exit(0); };
const error = (reason) => out(["@@error@@ " + reason]);
const name = file === "-" ? "la entrada del hook" : file;
let data;
try { data = JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8")); }
catch { error(name + " no es JSON válido"); }
const isCmd = (v) => Array.isArray(v) && v.length > 0
  && v.every((s) => typeof s === "string" && s.length > 0 && !/[\r\n]/.test(s));
if (kind === "command") {
  const c = data.commands;
  if (!c || typeof c !== "object" || Array.isArray(c)) error(file + ": falta el objeto commands");
  if (!Object.prototype.hasOwnProperty.call(c, key)) error(file + ": falta commands." + key + "; pon el comando o null");
  if (c[key] === null) out(["@@off@@"]);
  if (!isCmd(c[key])) error(file + ": commands." + key + " tiene que ser null o una lista de textos no vacíos, sin saltos de línea");
  out(["@@set@@", ...c[key]]);
}
if (kind === "format") {
  const rules = data.format ?? [];
  if (!Array.isArray(rules)) error(file + ": format tiene que ser una lista de reglas");
  if (rules.some((r) => !r || !Array.isArray(r.extensions) || !isCmd(r.cmd)))
    error(file + ": cada regla de format necesita extensions (lista) y cmd (lista de textos)");
  out(["@@set@@", ...rules.filter((r) => r.extensions.includes(key)).flatMap((r) => ["@@rule@@", ...r.cmd])]);
}
if (kind === "model") {
  const models = data.models && typeof data.models === "object" && !Array.isArray(data.models) ? data.models : {};
  const m = Object.prototype.hasOwnProperty.call(models, key) ? models[key] : null;
  if (m === null) out(["@@off@@"]);
  if (typeof m === "string" && /^[A-Za-z0-9._-]+$/.test(m)) out(["@@set@@", m]);
  error(file + ": models." + key + " tiene que ser un nombre de modelo (letras, números, punto o guion)");
}
if (kind === "value") {
  const v = data && typeof data === "object" && !Array.isArray(data) ? data[key] : null;
  if (v === null || v === undefined) out(["@@off@@"]);
  if (typeof v === "number") out(["@@set@@", String(v)]);
  if (typeof v === "string" && v !== "" && !/[\r\n]/.test(v)) out(["@@set@@", v]);
  error(file + ": " + key + " tiene que ser un texto de una línea o un número");
}
const p = (data.tool_input && data.tool_input.file_path) || data.file_path || "";
out(typeof p === "string" && p !== "" ? ["@@set@@", p] : ["@@off@@"]);
'

# Qué lector hay: jq, node, o ninguno.
factory_json_reader() {
  case "${FACTORY_JSON_READER:-}" in
    jq | node | none)
      echo "$FACTORY_JSON_READER"
      return
      ;;
  esac
  if command -v jq > /dev/null 2>&1; then
    echo jq
  elif command -v node > /dev/null 2>&1; then
    echo node
  else
    echo none
  fi
}

# factory_query <archivo JSON, o - para stdin> <command|format|model|value|hookpath> <clave>
# Imprime el protocolo descrito arriba. Nunca falla: los errores van como
# "@@error@@ <motivo>" en la primera línea.
factory_query() {
  local file="$1" kind="$2" key="$3" output
  local -a source_args=("$file")
  [ "$file" = "-" ] && source_args=()
  case "$(factory_json_reader)" in
    jq)
      output=$(jq -r --arg file "$file" --arg kind "$kind" --arg key "$key" \
        "$FACTORY_JQ_PROGRAM" "${source_args[@]}" 2> /dev/null) ||
        output="@@error@@ $file no es JSON válido"
      ;;
    node)
      output=$(node -e "$FACTORY_NODE_PROGRAM" "$file" "$kind" "$key" 2> /dev/null) ||
        output="@@error@@ no se pudo leer $file con node"
      ;;
    *)
      output="@@error@@ Para leer $file hace falta jq o node, y no hay ninguno en el PATH. Instala jq."
      ;;
  esac
  printf '%s\n' "$output" | tr -d '\r'
}

# factory_read_command <nombre>: llena el array FACTORY_CMD con el comando
# commands.<nombre> de factory.json. Devuelve 0 si está definido, 3 si está en
# null (apagado a propósito) y 4 si factory.json está mal (FACTORY_ERROR dice
# por qué).
factory_read_command() {
  local first line
  FACTORY_CMD=()
  FACTORY_ERROR=""
  {
    IFS= read -r first
    while IFS= read -r line; do
      FACTORY_CMD+=("$line")
    done
  } < <(factory_query "$FACTORY_CONFIG_FILE" command "$1")
  case "$first" in
    @@set@@) return 0 ;;
    @@off@@) return 3 ;;
    "@@error@@ "*) FACTORY_ERROR="${first#@@error@@ }" ;;
    *) FACTORY_ERROR="respuesta inesperada al leer $FACTORY_CONFIG_FILE" ;;
  esac
  return 4
}

# factory_format_error: imprime el problema de las reglas de formato, o nada
# si están bien.
factory_format_error() {
  local first
  first=$(factory_query "$FACTORY_CONFIG_FILE" format "" | head -n 1)
  case "$first" in
    "@@error@@ "*) echo "${first#@@error@@ }" ;;
  esac
}

# factory_read_model <clave> <por defecto>: imprime el modelo de
# factory.json → models.<clave>. Solo acepta un nombre de modelo (letras,
# números, punto o guion): el valor termina en `--model` y en GITHUB_ENV, y un
# espacio o un salto de línea metería argumentos o variables. Si el valor
# falta o no sirve, imprime el de por defecto y avisa por stderr. Sin
# factory.json (la plantilla antes del bootstrap) usa el de por defecto sin
# avisar.
factory_read_model() {
  local key="$1" fallback="$2" first="" value=""
  if [ -f factory-models.json ]; then
    echo "⚠ factory-models.json ya no se lee: pasa models y review a $FACTORY_CONFIG_FILE y borra ese archivo." >&2
  fi
  if [ ! -f "$FACTORY_CONFIG_FILE" ]; then
    echo "$fallback"
    return 0
  fi
  {
    IFS= read -r first
    IFS= read -r value
  } < <(factory_query "$FACTORY_CONFIG_FILE" model "$key")
  case "$first" in
    @@set@@)
      echo "$value"
      ;;
    @@off@@)
      echo "⚠ $FACTORY_CONFIG_FILE no tiene models.$key: uso $fallback." >&2
      echo "$fallback"
      ;;
    *)
      echo "⚠ ${first#@@error@@ }. Uso $fallback." >&2
      echo "$fallback"
      ;;
  esac
}

# factory_read_value <clave>: imprime factory.json → <clave> (texto o número)
# o nada si falta. Un valor inválido se avisa por stderr y cuenta como falta.
factory_read_value() {
  [ -f "$FACTORY_CONFIG_FILE" ] || return 0
  local state value
  {
    IFS= read -r state || true
    IFS= read -r value || true
  } < <(factory_query "$FACTORY_CONFIG_FILE" value "$1")
  case "$state" in
    @@set@@) printf '%s\n' "$value" ;;
    @@off@@) ;;
    *) echo "⚠ ${state#@@error@@ }" >&2 ;;
  esac
}
