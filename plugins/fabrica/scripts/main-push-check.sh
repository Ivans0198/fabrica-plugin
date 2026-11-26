#!/usr/bin/env bash
# Avisa cuando la rama principal recibe commits que no vienen de un PR
# mergeado. Sin branch protection (un repo privado sin GitHub Pro) nada frena
# un `git push origin main`, y worker-guard.sh se salta con comillas
# (revisión del 2026-11-26). Esto no lo frena: abre una issue con la etiqueta
# direct-push, o comenta en la que ya está abierta, para que la persona lo
# revise.
#
# Usage: scripts/main-push-check.sh <before> <after>
#   los SHA de github.event.before y github.event.after
#
# Requires: gh. Respeta GH_REPO si está definida.

set -euo pipefail

LABEL="direct-push"
BEFORE="${1:-}"
AFTER="${2:-}"
sha_re='^[0-9a-f]{40}$'

[[ "$BEFORE" =~ $sha_re ]] && [[ "$AFTER" =~ $sha_re ]] || {
  echo "uso: main-push-check.sh <before> <after> (dos SHA completos)" >&2
  exit 64
}
# Una rama nueva o borrada no tiene con qué comparar.
if [ "$BEFORE" = "$(printf '0%.0s' {1..40})" ] || [ "$AFTER" = "$(printf '0%.0s' {1..40})" ]; then
  echo "Rama nueva o borrada: nada que revisar."
  exit 0
fi

commits=$(gh api "repos/{owner}/{repo}/compare/$BEFORE...$AFTER" \
  --jq '.commits[] | "\(.sha) \(.commit.message | split("\n")[0])"')

loose=""
while read -r sha subject; do
  [ -n "$sha" ] || continue
  merged=$(gh api "repos/{owner}/{repo}/commits/$sha/pulls" \
    --jq '[.[] | select(.merged_at != null)] | length')
  [ "${merged:-0}" != 0 ] || loose+="- \`${sha:0:7}\` $subject"$'\n'
done <<<"$commits"

if [ -z "$loose" ]; then
  echo "✓ Todo lo que entró a la rama principal vino de un PR mergeado."
  exit 0
fi

body="Estos commits entraron a la rama principal sin un PR mergeado (push de \`${GITHUB_ACTOR:-?}\`):

$loose
Sin branch protection nada lo frena: la fábrica solo avisa. Revisa que sea lo que querías. Un worker nunca empuja a la rama principal; si fue uno, revisa qué hizo. Cierra esta issue cuando lo hayas revisado."

echo "⚠ Commits en la rama principal sin PR:"
printf '%s' "$loose"

open_issue=$(gh issue list --state open --label "$LABEL" --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || true)
if [[ "$open_issue" =~ ^[0-9]+$ ]]; then
  gh issue comment "$open_issue" --body "$body" >/dev/null
else
  gh label create "$LABEL" --color D93F0B \
    --description "Commits en la rama principal sin PR" >/dev/null 2>&1 || true
  gh issue create --title "Commits en la rama principal sin PR" --label "$LABEL" --body "$body" >/dev/null
fi
