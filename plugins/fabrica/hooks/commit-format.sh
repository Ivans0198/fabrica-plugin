#!/usr/bin/env bash
# PreToolUse (Bash): antes de un git push, los commits que está por subir
# siguen Conventional Commits, si factory.json → commitFormat es
# "conventional". Un worker commitea y sube la rama antes de su último Stop:
# ahí el Stop gate ya no puede pedir que los arregle, porque eso necesitaría
# --force. Corre en cualquier sesión. Exit 2 bloquea el push y Claude recibe
# el motivo.

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.tool_name // empty')" = Bash ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

# Lo que va entre comillas es texto (un mensaje, un echo), no un comando.
bare=$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")
pushes=""
while IFS= read -r segment; do
  read -ra words <<<"$segment"
  i=0
  while [ "$i" -lt "${#words[@]}" ] && [ "${words[$i]}" != git ]; do i=$((i + 1)); done
  while [ "$i" -lt "${#words[@]}" ] && [ "${words[$i]}" != push ]; do i=$((i + 1)); done
  [ "$i" -lt "${#words[@]}" ] && pushes=1
done <<<"$(printf '%s\n' "$bare" | sed -E 's/(\&\&|\|\||;|\||&)/\n/g')"
[ -n "$pushes" ] || exit 0

# shellcheck source=../scripts/lib/factory-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/factory-config.sh"
# shellcheck source=../scripts/lib/commit-format.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/commit-format.sh"
# En un worker, el factory.json de la base: el agente no lo apaga editándolo.
factory_use_base_config
commit_format_enabled || exit 0

since=$(commit_format_since)
[ -n "$since" ] || exit 0
bad=$(commit_format_bad "$since")
[ -n "$bad" ] || exit 0
{
  echo "❌ Not pushed: these commits do not follow Conventional Commits (factory.json → commitFormat):"
  echo "$bad"
  commit_format_help "$since"
  echo "Then push again."
} >&2
exit 2
