#!/usr/bin/env bash
# Avisa en los PRs de la fábrica (ramas impl-N y spec-N) que chocan con la
# rama principal. Un PR choca después de abierto cuando se mergea otro, y
# nadie le hace rebase. Resolverlo solo es arriesgado: un merge a mano con los
# tests en verde puede estar mal igual (fabrica-prueba #19). Así que solo
# avisa: le pone merge-conflict y comenta una vez. Cuando el PR vuelve a poder
# mergearse, le quita la etiqueta.
#
# GitHub calcula si un PR se puede mergear un rato después de que la rama
# principal se mueve: mientras tanto responde UNKNOWN. Se reintenta hasta
# FABRICA_CONFLICT_TRIES veces (6), esperando FABRICA_CONFLICT_WAIT segundos
# (10) entre intentos. Lo que siga en UNKNOWN se deja como está.
#
# Un PR que falla no cancela a los demás: se sale con error al final, para que
# la corrida quede en rojo.
#
# Usage: scripts/flag-conflicts.sh
#
# Requires: gh. Respeta GH_REPO si está definida.

set -euo pipefail

LABEL="merge-conflict"
TRIES="${FABRICA_CONFLICT_TRIES:-6}"
WAIT="${FABRICA_CONFLICT_WAIT:-10}"

BODY="Este PR choca con la rama principal y ya no se puede mergear.

La fábrica no lo resuelve sola: un merge con los tests en verde puede estar mal igual. Resuélvelo a mano y revísalo de nuevo comparándolo con las dos ramas. La etiqueta \`$LABEL\` se quita sola cuando el PR vuelve a poder mergearse."

# Una línea por PR de la fábrica: número, estado y si ya tiene la etiqueta.
# --limit explícito: gh trae 30 por defecto y truncaría en silencio.
list_prs() {
  gh pr list --state open --limit 1000 \
    --json number,headRefName,mergeable,labels \
    --jq ".[] | select(.headRefName | test(\"^(impl|spec)-[0-9]+\$\")) | \"\(.number) \(.mergeable) \(any(.labels[]; .name == \"$LABEL\"))\"" \
    | tr -d '\r'
}

attempt=1
while :; do
  PRS=$(list_prs)
  case "$PRS" in *" UNKNOWN "*) ;; *) break ;; esac
  [ "$attempt" -lt "$TRIES" ] || break
  attempt=$((attempt + 1))
  sleep "$WAIT"
done

failed=0
created=0
while read -r number state labeled; do
  [ -n "$number" ] || continue
  case "$state:$labeled" in
    CONFLICTING:false)
      if [ "$created" -eq 0 ]; then
        gh label create "$LABEL" --color B60205 \
          --description "El PR choca con la rama principal" >/dev/null 2>&1 || true
        created=1
      fi
      if gh pr edit "$number" --add-label "$LABEL" >/dev/null &&
        gh pr comment "$number" --body "$BODY" >/dev/null; then
        echo "✗ #$number: choca con la rama principal, avisado"
      else
        echo "✗ #$number: no se pudo avisar" >&2
        failed=1
      fi
      ;;
    MERGEABLE:true)
      if gh pr edit "$number" --remove-label "$LABEL" >/dev/null; then
        echo "✓ #$number: ya no choca, quitada $LABEL"
      else
        echo "✗ #$number: no se pudo quitar $LABEL" >&2
        failed=1
      fi
      ;;
    UNKNOWN:*)
      echo "? #$number: GitHub no calculó si se puede mergear, queda como está"
      ;;
  esac
done <<<"$PRS"

exit "$failed"
