#!/usr/bin/env bash
# PreToolUse (Bash), solo en los workers (FABRICA_WORKER=1, lo ponen
# fabrica-backlog y la nube): un worker no mergea, no empuja a la rama base y
# no fuerza ni borra ramas. Eso decía solo el texto de las reglas, y un repo
# privado gratis no tiene branch protection: bastaba un texto escondido en
# una issue. Los hooks corren también con bypassPermissions. Exit 2 bloquea
# el comando y Claude recibe el motivo. Fuera de un worker no hace nada: ahí
# pregunta Claude Code.

[ "${FABRICA_WORKER:-}" = 1 ] || exit 0

block() {
  echo "❌ Un worker no puede $1. Lo hace una persona; si la issue tiene auto-merge, fabrica-backlog lo pone al terminar. Sigue sin ese comando." >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || block "correr comandos sin jq: el guardia no puede revisarlos"
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.tool_name // empty')" = Bash ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

# shellcheck source=../scripts/lib/factory-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/factory-config.sh"
# La base la fija el orquestador en FABRICA_BASE; el factory.json del árbol lo
# puede editar el agente. main y master quedan cerradas siempre.
factory_use_base_config
base="${FABRICA_BASE:-$(factory_read_value baseBranch 2>/dev/null)}"
base="${base:-main}"

# Lo que va entre comillas es texto (un mensaje, un echo), no un comando.
bare=$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

while IFS= read -r segment; do
  read -ra words <<<"$segment"
  [ "${#words[@]}" -gt 0 ] || continue
  if [[ " $segment " =~ [[:space:]]gh[[:space:]]+pr[[:space:]]+merge[[:space:]] ]]; then
    block "mergear un PR"
  fi
  if [[ " $segment " =~ [[:space:]]gh[[:space:]]+api[[:space:]] ]] && [[ "$segment " =~ /merge[[:space:]] ]]; then
    block "mergear un PR"
  fi
  # git [opciones] push [opciones] <remoto> <refspec>...
  i=0
  while [ "$i" -lt "${#words[@]}" ] && [ "${words[$i]}" != git ]; do i=$((i + 1)); done
  while [ "$i" -lt "${#words[@]}" ] && [ "${words[$i]}" != push ]; do i=$((i + 1)); done
  [ "$i" -lt "${#words[@]}" ] || continue
  remote=""
  for w in "${words[@]:$((i + 1))}"; do
    case "$w" in
      -f | --force | --force-with-lease* | --force-if-includes | --mirror | --all | -d | --delete | --prune)
        block "forzar, borrar ni empujar ramas en bloque ($w)" ;;
      -*) continue ;;
    esac
    if [ -z "$remote" ]; then remote="$w"; continue; fi
    case "$w" in
      +* | :*) block "forzar ni borrar una rama ($w)" ;;
    esac
    dest="${w##*:}"
    dest="${dest#refs/heads/}"
    case "$dest" in
      "$base" | main | master) block "empujar a la rama base ($dest)" ;;
    esac
  done
done <<<"$(printf '%s\n' "$bare" | sed -E 's/(\&\&|\|\||;|\||&)/\n/g')"
exit 0
