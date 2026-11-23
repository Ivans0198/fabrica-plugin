#!/usr/bin/env bash
# Instala y mantiene al día la parte de la fábrica que vive en cada proyecto.
#
#   fabrica-setup init     primera vez: archivos del proyecto y copias administradas
#   fabrica-setup check    ¿el proyecto está en la versión del plugin? (lo corren los workers)
#   fabrica-setup refresh  actualiza las copias administradas a la versión del plugin
#                          y apaga la atribución de los commits en settings.json
#   fabrica-setup speckit  arma .specify/ (Spec Kit y la constitución) en esta máquina
#
# Las copias administradas (.factory/rules/ y las llamadas a los workflows del
# plugin en .github/workflows/) se registran en .factory/manifest.json con el
# hash de cada una. refresh solo pisa una copia que nadie tocó; si alguien la
# editó, deja la versión nueva en <archivo>.fabrica-new y lo informa. El hash
# ignora los \r, para que core.autocrlf no haga parecer editado todo el
# proyecto.
#
# init reconoce un proyecto creado con fabrica-template antes del plugin y lo
# migra: borra la maquinaria copiada (legacy-template-files.txt), mueve los
# perfiles de stack a .factory/rules/stacks/ y deja en CLAUDE.md,
# .claude/settings.json y package.json solo lo del proyecto.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ROOT="${FABRICA_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TEMPLATES="$PLUGIN_ROOT/templates"
VERSION_FILE=".factory/version"
MANIFEST=".factory/manifest.json"
WORKFLOWS="checks claude-backlog claude-mentions labels-cleanup pr-conflicts"
SPECKIT_BUNDLE="$PLUGIN_ROOT/speckit-bundle"
SPECKIT_STAMP=".specify/fabrica-version"

# shellcheck source=lib/factory-config.sh
source "$SCRIPT_DIR/lib/factory-config.sh"

die() { echo "❌ $*" >&2; exit 1; }

plugin_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -n 1
}

plugin_version() { plugin_field version; }

# dueño/nombre del repo del plugin en GitHub, para los `uses:` de los workflows.
plugin_repo() {
  local url
  url=$(plugin_field repository)
  url="${url#https://github.com/}"
  url="${url%.git}"
  [[ "$url" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || die "plugin.json → repository no es un repo de GitHub: '$url'"
  printf '%s\n' "$url"
}

project_version() {
  tr -d '\r\n' < "$VERSION_FILE" 2>/dev/null || true
}

file_hash() {
  tr -d '\r' < "$1" | git hash-object --stdin
}

# Pares "destino<TAB>origen" de las copias administradas.
managed_files() {
  printf '%s\t%s\n' ".factory/rules/fabrica.md" "$PLUGIN_ROOT/rules/fabrica.md"
  local profile
  for profile in "$PLUGIN_ROOT"/rules/stacks/*.md; do
    [ -f "$profile" ] || continue
    printf '%s\t%s\n' ".factory/rules/stacks/$(basename "$profile")" "$profile"
  done
  local name
  for name in $WORKFLOWS; do
    printf '%s\t%s\n' ".github/workflows/$name.yml" "$TEMPLATES/.github/workflows/$name.yml"
  done
  # El workflow visual solo tiene sentido con el módulo visual.
  if [ -f tests/ui.spec.ts ]; then
    printf '%s\t%s\n' ".github/workflows/visual-baselines.yml" "$TEMPLATES/.github/workflows/visual-baselines.yml"
  fi
}

# Copia un archivo del plugin con el repo y el tag del plugin puestos.
render() { # origen, destino, versión
  # Sin marcas se copia tal cual: el sed de Git Bash cambia los finales de
  # línea y la copia ya no sería idéntica al original.
  if ! grep -q '__FABRICA_' "$1"; then
    cp "$1" "$2"
    return 0
  fi
  local repo
  repo=$(plugin_repo)
  sed -e "s#__FABRICA_REPO__#$repo#g" -e "s#__FABRICA_REF__#v$3#g" "$1" > "$2"
}

# Hash guardado para un destino, o vacío.
manifest_hash() {
  [ -f "$MANIFEST" ] || return 0
  tr -d '\r' < "$MANIFEST" | sed -n "s#^    \"$1\": \"\\([0-9a-f]*\\)\",\\{0,1\\}\$#\\1#p"
}

write_manifest() { # versión, luego líneas "destino<TAB>hash" por stdin
  local version="$1" first=1 target hash
  {
    printf '{\n  "version": "%s",\n  "files": {\n' "$version"
    while IFS=$'\t' read -r target hash; do
      [ "$first" = 1 ] || printf ',\n'
      printf '    "%s": "%s"' "$target" "$hash"
      first=0
    done
    printf '\n  }\n}\n'
  } > "$MANIFEST"
}

# Destinos que el manifiesto registra.
manifest_targets() {
  [ -f "$MANIFEST" ] || return 0
  tr -d '\r' < "$MANIFEST" | sed -n 's#^    "\([^"]*\)": "[0-9a-f]*",\{0,1\}$#\1#p'
}

# Copias que el manifiesto registra y el plugin ya no trae: se borran si nadie
# las tocó; si alguien las editó se dejan, pero dejan de ser administradas.
remove_orphans() {
  local managed target
  managed=$(managed_files | cut -f1)
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    if grep -qxF -- "$target" <<< "$managed" || [ ! -f "$target" ]; then continue; fi
    if [ "$(file_hash "$target")" = "$(manifest_hash "$target")" ]; then
      rm -f -- "$target"
      echo "  - $target (el plugin ya no lo trae)"
    else
      echo "  ⚠ $target: el plugin ya no lo trae y fue editado a mano. Lo dejo, pero ya no se actualiza."
    fi
  done < <(manifest_targets)
}

# Aplica la tabla de refresh a cada copia administrada y reescribe el manifiesto.
sync_managed() {
  local version="$1" target source saved current fresh conflicts=0 entries="" rendered
  rendered=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$rendered'" RETURN
  while IFS=$'\t' read -r target source; do
    render "$source" "$rendered" "$version"
    source="$rendered"
    fresh=$(file_hash "$source")
    saved=$(manifest_hash "$target")
    mkdir -p "$(dirname "$target")"
    if [ ! -f "$target" ]; then
      cp "$source" "$target"
      echo "  + $target"
    else
      current=$(file_hash "$target")
      if [ "$current" = "$fresh" ]; then
        :
      elif [ -n "$saved" ] && [ "$current" = "$saved" ]; then
        cp "$source" "$target"
        echo "  ↻ $target"
      else
        cp "$source" "$target.fabrica-new"
        echo "  ⚠ $target fue editado a mano: la versión nueva quedó en $target.fabrica-new"
        conflicts=$((conflicts + 1))
        # El manifiesto guarda la versión del plugin, nunca la del archivo
        # editado: así el próximo refresh lo sigue viendo editado.
      fi
    fi
    entries+="$target"$'\t'"$fresh"$'\n'
  done < <(managed_files)
  remove_orphans
  printf '%s' "$entries" | write_manifest "$version"
  printf '%s\n' "$version" > "$VERSION_FILE"
  if [ "$conflicts" -gt 0 ]; then
    echo "Revisa los $conflicts archivo(s) .fabrica-new: combina lo tuyo con lo nuevo y borra el .fabrica-new."
  fi
}

# Escribe un archivo del proyecto solo si no existe.
seed() { # destino, origen
  if [ -e "$1" ]; then
    echo "  = $1 (ya existía, no lo toco)"
  else
    mkdir -p "$(dirname "$1")"
    cp "$2" "$1"
    echo "  + $1"
  fi
}

# .claude/settings.json: si no existe se copia la plantilla. Si existe (claude
# plugin install --scope project lo crea solo con enabledPlugins) se le suman
# los permisos de la fábrica que falten, sin tocar lo demás.
seed_settings() {
  local file=.claude/settings.json template="$TEMPLATES/.claude/settings.json" result
  if [ ! -e "$file" ]; then
    seed "$file" "$template"
    return 0
  fi
  command -v node > /dev/null 2>&1 \
    || die "$file ya existe y hace falta node para sumarle los permisos de la fábrica. Instala node, o copia a mano los permisos de $template, y vuelve a correr fabrica-setup init."
  result=$(node "$SCRIPT_DIR/lib/merge-settings.mjs" "$file" "$template") \
    || die "No toqué nada. Arregla $file y vuelve a correr fabrica-setup init."
  if [ "$result" = changed ]; then
    echo "  ✎ $file: con los permisos de la fábrica y los commits sin mención a Claude"
  else
    echo "  = $file (ya tenía los permisos de la fábrica)"
  fi
}

# En refresh, de settings.json solo se toca la atribución de los commits y se
# quitan los permisos que la fábrica ya no da.
refresh_attribution() {
  local file=.claude/settings.json result
  [ -f "$file" ] || return 0
  command -v node > /dev/null 2>&1 \
    || die "Hace falta node para revisar la atribución de los commits en $file. Instala node y vuelve a correr fabrica-setup refresh."
  result=$(node "$SCRIPT_DIR/lib/merge-settings.mjs" "$file" "$TEMPLATES/.claude/settings.json" --attribution-only) \
    || die "No actualicé nada. Arregla $file y vuelve a correr fabrica-setup refresh."
  if [ "$result" = changed ]; then
    echo "  ✎ $file: al día con la fábrica (sin la atribución de Claude en los commits ni los permisos que la fábrica ya no da). Commitéalo: los workers lo leen del último commit."
  fi
}

# El plugin ya está activo en el proyecto (enabledPlugins → fabrica@…: true).
plugin_enabled() {
  [ -f .claude/settings.json ] \
    && tr -d '\r\n' < .claude/settings.json \
      | grep -q '"fabrica@[^"]*"[[:space:]]*:[[:space:]]*true'
}

GITIGNORE_BLOCK='# fabrica: de .factory/ se commitean las reglas, la versión y el manifiesto;
# lo demás es estado de las corridas. Los .fabrica-new son para combinar.
# .specify/ (Spec Kit) lo arma fabrica-setup speckit en cada máquina.
# .claude/worktrees/ tiene una copia del repo por cada issue en curso.
.factory/*
!.factory/rules/
!.factory/version
!.factory/manifest.json
*.fabrica-new
.specify/
.specify.tmp.*/
.claude/worktrees/'

ensure_gitignore() {
  local changed=0
  if [ ! -f .gitignore ]; then
    printf '%s\n' "$GITIGNORE_BLOCK" > .gitignore
    changed=1
  elif ! grep -q '^!\.factory/manifest\.json' .gitignore; then
    # `.factory/` ignora la carpeta entera y git no deja volver a incluir nada
    # de adentro: se reemplaza por el bloque.
    local kept
    kept=$(tr -d '\r' < .gitignore \
      | grep -v -x -e '\.factory/' -e '\.factory' -e '/\.factory/' -e '/\.factory' || true)
    printf '%s\n\n%s\n' "$kept" "$GITIGNORE_BLOCK" > .gitignore
    changed=1
  fi
  # Proyectos iniciados antes de que el bloque trajera estas líneas.
  local line
  for line in '*.fabrica-new' '.specify/' '.specify.tmp.*/' '.claude/worktrees/'; do
    if ! tr -d '\r' < .gitignore | grep -qxF -- "$line"; then
      printf '%s\n' "$line" >> .gitignore
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then echo "  ✎ .gitignore"; fi
}

# Un proyecto de fabrica-template trae su propio Stop gate y sus scripts.
is_template_project() {
  [ -f .claude/hooks/stop-gate.sh ] || [ -f scripts/process-backlog.sh ]
}

# Borra un archivo y las carpetas que queden vacías por encima.
remove_legacy() {
  rm -f -- "$1"
  local dir
  dir=$(dirname "$1")
  [ "$dir" = "." ] || rmdir -p --ignore-fail-on-non-empty -- "$dir" 2>/dev/null || true
  echo "  - $1"
}

migrate_template() {
  git rev-parse --verify -q HEAD > /dev/null \
    || die "El repo no tiene commits todavía. La migración borra archivos y tiene que poder deshacerse con git: commitea el proyecto tal como está y vuelve a correr fabrica-setup init."
  # Compara contenido contra HEAD (staged o no). `git status` marca como
  # modificado un archivo que solo cambió de finales de línea.
  git diff --quiet HEAD -- \
    || die "Hay cambios sin commitear. La migración borra archivos y tiene que poder deshacerse con git: commitea o guarda tus cambios y vuelve a correr fabrica-setup init."
  command -v node > /dev/null 2>&1 || die "La migración necesita node para editar CLAUDE.md, settings.json y package.json."
  echo "Proyecto de fabrica-template: la maquinaria copiada pasa a ser la del plugin."

  # Primero lo que puede fallar (leer y reescribir los JSON del proyecto), y
  # recién después los borrados: si node falla, la maquinaria vieja sigue
  # completa y init se puede volver a correr.
  node "$SCRIPT_DIR/lib/migrate-template.mjs" "$TEMPLATES/CLAUDE.md" "$TEMPLATES/.claude/settings.json" \
    || die "La migración no tocó nada. Arregla el archivo que se nombra arriba, commitea y vuelve a correr fabrica-setup init."

  local file
  while IFS= read -r file; do
    case "$file" in '' | '#'*) continue ;; esac
    [ -e "$file" ] && remove_legacy "$file"
  done < <(tr -d '\r' < "$SCRIPT_DIR/legacy-template-files.txt")

  # Los perfiles se mueven: si alguien editó uno, la sincronización de abajo
  # lo conserva y deja la versión del plugin en .fabrica-new.
  local profile target
  for profile in rules/stacks/*.md; do
    [ -f "$profile" ] || continue
    target=".factory/rules/stacks/$(basename "$profile")"
    mkdir -p "$(dirname "$target")"
    [ -e "$target" ] || cp "$profile" "$target"
    remove_legacy "$profile"
    echo "    → $target"
  done
}

cmd_init() {
  [ ! -f "$VERSION_FILE" ] || die "Este proyecto ya tiene la fábrica ($(project_version)). Para actualizarlo: fabrica-setup refresh"
  local version migrated=0
  version=$(plugin_version)
  # Se valida antes de tocar nada, no a mitad de la sincronización.
  plugin_repo > /dev/null
  echo "fabrica $version: iniciando $(pwd)"
  if is_template_project; then
    migrate_template
    migrated=1
  fi
  # Primero settings.json: es lo único que puede fallar, y así falla antes de
  # escribir lo demás.
  seed_settings
  seed CLAUDE.md "$TEMPLATES/CLAUDE.md"
  seed factory.json "$TEMPLATES/factory.example.json"
  ensure_gitignore
  sync_managed "$version"
  if plugin_enabled; then
    echo "Listo."
  else
    echo "Listo. Activa el plugin en este proyecto: claude plugin install fabrica@<marketplace> --scope project"
  fi
  if [ "$migrated" = 1 ]; then
    echo "Revisa la migración con git status y git diff, y commitea todo junto: el commit que activa el plugin es el mismo que quita los hooks viejos, para que no corran dos Stop gates."
    echo "factory.json: revisa que tenga commands.dev, appUrl, factoryEpic y docLang (ver el ejemplo en el plugin, templates/factory.example.json)."
  else
    echo "Después commitea CLAUDE.md, factory.json, .claude/settings.json, .gitignore, .github/workflows/ y .factory/."
  fi
}

# Los .fabrica-new que refresh dejó y nadie combinó todavía.
pending_merges() {
  local target source
  while IFS=$'\t' read -r target source; do
    if [ -f "$target.fabrica-new" ]; then printf '  %s\n' "$target.fabrica-new"; fi
  done < <(managed_files)
}

# Llamadas a los workflows del plugin que apuntan a otra versión: quedan así
# si alguien conservó su copia editada sin combinar la nueva.
stale_pins() { # versión
  local want="v$1" repo target source ref
  repo=$(plugin_repo)
  while IFS=$'\t' read -r target source; do
    case "$target" in .github/workflows/*) ;; *) continue ;; esac
    [ -f "$target" ] || continue
    while IFS= read -r ref; do
      if [ "$ref" != "$want" ]; then
        printf '  %s (%s)\n' "$target" "$ref"
        break
      fi
    done < <(tr -d '\r' < "$target" \
      | sed -n -e "s#^[[:space:]]*uses:[[:space:]]*$repo/\.github/workflows/[^@]*@\([^[:space:]]*\).*#\1#p" \
               -e "s#^[[:space:]]*fabrica_ref:[[:space:]]*\([^[:space:]]*\).*#\1#p")
  done < <(managed_files)
}

cmd_check() {
  local want have pending stale
  want=$(plugin_version)
  [ -f "$VERSION_FILE" ] || die "Este proyecto no tiene la fábrica instalada. Corre: fabrica-setup init"
  have=$(project_version)
  [ "$have" = "$want" ] || die "El proyecto está en fabrica $have y el plugin instalado es $want. Corre: fabrica-setup refresh"
  pending=$(pending_merges)
  [ -z "$pending" ] || die "Hay versiones nuevas sin combinar:
$pending
Pasa lo tuyo a cada .fabrica-new, reemplaza el archivo con él, borra el .fabrica-new y commitea."
  stale=$(stale_pins "$want")
  [ -z "$stale" ] || die "Estas llamadas a workflows no apuntan a v$want:
$stale
Corre fabrica-setup refresh y combina los .fabrica-new que deje."
}

cmd_refresh() {
  [ -f "$VERSION_FILE" ] || die "Este proyecto no tiene la fábrica instalada. Corre: fabrica-setup init"
  local version
  version=$(plugin_version)
  echo "fabrica $(project_version) → $version"
  # Primero, porque puede fallar, y así falla antes de escribir lo demás.
  refresh_attribution
  ensure_gitignore
  sync_managed "$version"
}

# El stack de factory.json, validado: termina en un nombre de archivo.
project_stack() {
  local stack
  stack=$(factory_read_value stack)
  stack="${stack:-node-ts}"
  [[ "$stack" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
    || die "factory.json → stack tiene que ser un nombre de minúsculas, números y guiones (como node-ts), no '$stack'."
  printf '%s\n' "$stack"
}

hash_or_none() { if [ -f "$1" ]; then file_hash "$1"; else echo none; fi; }

# Todo lo que decide el contenido de .specify/: si no cambió, no hay que rehacerlo.
speckit_stamp() { # stack
  printf 'fabrica %s, Spec Kit %s, stack %s, reglas %s, perfil %s, tareas %s\n' \
    "$(plugin_version)" "$(tr -d '[:space:]' < "$SPECKIT_BUNDLE/VERSION")" "$1" \
    "$(file_hash "$PLUGIN_ROOT/rules/constitution.md")" \
    "$(hash_or_none ".factory/rules/stacks/$1.md")" \
    "$(file_hash "$PLUGIN_ROOT/speckit-overrides/tasks-template.md")"
}

write_constitution() { # destino, stack
  local profile=".factory/rules/stacks/$2.md"
  {
    printf '# Constitution\n\n'
    printf 'Written by fabrica %s from the plugin rules and this project'"'"'s stack profile.\n' "$(plugin_version)"
    printf '`fabrica-setup speckit` rewrites it: change the profile in `.factory/rules/stacks/`, not here.\n\n'
    tr -d '\r' < "$PLUGIN_ROOT/rules/constitution.md"
    printf '\n## Stack profile: %s\n\n' "$2"
    if [ -f "$profile" ]; then
      tr -d '\r' < "$profile"
    else
      printf 'No profile exists yet for the stack `%s`. The plan MUST say so, and writing the profile is part of the work.\n' "$2"
    fi
  } > "$1"
}

cmd_speckit() {
  [ -f "$VERSION_FILE" ] || die "Este proyecto no tiene la fábrica instalada. Corre: fabrica-setup init"
  [ -d "$SPECKIT_BUNDLE/.specify" ] || die "El plugin no trae Spec Kit ($SPECKIT_BUNDLE)."
  # Un hook de extensión de Spec Kit crearía ramas por su cuenta y chocaría con spec-<N>.
  tr -d '\r' < "$SPECKIT_BUNDLE/.specify/extensions.yml" | grep -qx 'hooks: {}' \
    || die "El extensions.yml de Spec Kit del plugin trae hooks: la fábrica no los soporta."
  if [ -e .specify ] && [ ! -f "$SPECKIT_STAMP" ]; then
    die ".specify/ ya existe y no lo armó la fábrica (¿otro plugin o la CLI de Spec Kit?). Muévelo o bórralo si no lo usas, y vuelve a correr fabrica-setup speckit."
  fi
  if git ls-files --error-unmatch .specify > /dev/null 2>&1; then
    die ".specify/ está commiteado. La fábrica lo arma en cada máquina: sácalo de git (git rm -r --cached .specify) y vuelve a correr fabrica-setup speckit."
  fi
  local stack want
  stack=$(project_stack)
  ensure_gitignore
  want=$(speckit_stamp "$stack")
  if [ -f "$SPECKIT_STAMP" ] && [ "$(tr -d '\r' < "$SPECKIT_STAMP")" = "$want" ]; then
    echo "Spec Kit al día: $want"
    return 0
  fi
  # Se arma aparte y se cambia al final: así no quedan archivos que el bundle
  # ya no trae, y un fallo a mitad no deja un .specify/ a medias.
  local tmp leftover
  # Restos de una corrida que murió sin limpiar.
  for leftover in .specify.tmp.*; do
    if [ -d "$leftover" ]; then rm -rf -- "$leftover"; fi
  done
  tmp=$(mktemp -d ".specify.tmp.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  cp -R "$SPECKIT_BUNDLE/.specify/." "$tmp/"
  # Los comandos de Spec Kit no son skills del plugin, para que el modelo no
  # los cargue por su cuenta: los pasos fabrica:* los leen de aquí.
  mkdir -p "$tmp/commands" "$tmp/memory" "$tmp/templates/overrides"
  cp "$SPECKIT_BUNDLE"/commands/*.md "$tmp/commands/"
  write_constitution "$tmp/memory/constitution.md" "$stack"
  cp "$PLUGIN_ROOT/speckit-overrides/tasks-template.md" "$tmp/templates/overrides/tasks-template.md"
  chmod +x "$tmp"/scripts/bash/*.sh
  if [ -f .specify/feature.json ]; then cp .specify/feature.json "$tmp/feature.json"; fi
  printf '%s\n' "$want" > "$tmp/fabrica-version"
  rm -rf .specify
  mv "$tmp" .specify
  trap - EXIT
  echo "  ✎ .specify/: $want"
}

main() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || die "No estás dentro de un repo git. Corre esto desde la carpeta del proyecto."
  cd "$root"
  [ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ] || die "No encuentro el plugin en $PLUGIN_ROOT"
  case "${1:-}" in
    init) cmd_init ;;
    check) cmd_check ;;
    refresh) cmd_refresh ;;
    speckit) cmd_speckit ;;
    *) die "Uso: fabrica-setup <init|check|refresh|speckit>" ;;
  esac
}

main "$@"
