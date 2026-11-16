#!/usr/bin/env bash
# Dice en qué feature de Spec Kit se trabaja y se lo deja anotado a Spec Kit.
#
#   fabrica-feature        en la rama spec-<N>: la feature de la épica N
#   fabrica-feature <N>    la feature de la épica N, desde cualquier rama
#
# La carpeta es specs/<N>-<nombre>/, con N el número de la issue de la épica.
# Spec Kit no la deduce de la rama: la busca en .specify/feature.json, que es
# local de cada máquina. Este script la busca y la escribe ahí, e imprime la
# ruta. Los pasos fabrica:plan y fabrica:tasks lo corren antes de Spec Kit.
set -euo pipefail

die() { echo "❌ $*" >&2; exit 1; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "No estás dentro de un repo git."
cd "$root"

epic="${1:-}"
if [ -z "$epic" ]; then
  branch=$(git branch --show-current 2>/dev/null || true)
  [[ "$branch" =~ ^spec-([0-9]+)$ ]] \
    || die "No estás en una rama spec-<N> (estás en '${branch:-ninguna}'). Pasa el número de la épica: fabrica-feature <N>"
  epic="${BASH_REMATCH[1]}"
fi
[[ "$epic" =~ ^[1-9][0-9]*$ ]] || die "'$epic' no es un número de épica."

[ -d .specify ] || die "Falta .specify/ en esta máquina. Corre: fabrica-setup speckit"

found=()
for dir in specs/"$epic"-*/; do
  [ -d "$dir" ] || continue
  dir="${dir%/}"
  [[ "$dir" =~ ^specs/[0-9]+-[A-Za-z0-9._-]+$ ]] || die "La carpeta '$dir' tiene un nombre que Spec Kit no maneja bien: usa letras, números, punto, guion o guion bajo."
  found+=("$dir")
done

case "${#found[@]}" in
  0) die "No hay ninguna carpeta specs/$epic-*. La crea /fabrica:spec." ;;
  1) ;;
  *) die "Hay más de una carpeta para la épica $epic: ${found[*]}. Deja una sola." ;;
esac

printf '{\n  "feature_directory": "%s"\n}\n' "${found[0]}" > .specify/feature.json
printf '%s\n' "${found[0]}"
