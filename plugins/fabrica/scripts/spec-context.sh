#!/usr/bin/env bash
# La parte de la spec que le toca a una issue, para el worker y el revisor.
#
#   spec-context.sh N
#
# Lee la marca que fabrica-create-issues deja en el cuerpo de la issue
# (<!-- fabrica-spec: dir=specs/<N>-<nombre> story=US2 phase=story tasks=T010,T011 -->)
# e imprime los archivos de la spec, las tareas de la issue tal como están en
# tasks.md y, si es una historia, su sección de spec.md con los escenarios de
# aceptación. Lee la spec del checkout actual: un worktree impl-N parte de la
# base, donde está la spec aprobada.
#
# Sale con 0 si imprimió el contexto; 1 si la issue no tiene marca (es una
# issue suelta); 2 si la marca no cuadra con la spec de la rama (la spec
# cambió o falta), que es trabajo para una persona; 64 si falta el número.

set -euo pipefail

die() { echo "❌ $1" >&2; exit "${2:-1}"; }
usage() {
  sed -n '4p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 64
}

[[ "${1:-}" =~ ^[0-9]+$ ]] || usage
n="$1"

command -v gh >/dev/null || die "Falta 'gh' (GitHub CLI). Instálalo y corre 'gh auth login'"
top=$(git rev-parse --show-toplevel 2>/dev/null) \
  || die "No estás dentro de un repo git. Corre esto desde la carpeta del proyecto"
cd "$top"

body=$(gh issue view "$n" --json body --jq .body) || die "No pude leer la issue #$n"
mark=$(printf '%s\n' "$body" | sed -n 's/.*<!-- fabrica-spec: \(.*\) -->.*/\1/p' | head -1)
[ -n "$mark" ] || die "La issue #$n no viene de una spec: no tiene la marca fabrica-spec." 1

dir="" story="" phase="" tasks=""
for field in $mark; do
  case "$field" in
    dir=*) dir="${field#dir=}" ;;
    story=*) story="${field#story=}" ;;
    phase=*) phase="${field#phase=}" ;;
    tasks=*) tasks="${field#tasks=}" ;;
  esac
done

# La marca viene del cuerpo de una issue, que cualquiera con acceso puede
# editar: nada de rutas fuera de specs/ ni valores que no sean los esperados.
[[ "$dir" =~ ^specs/[0-9]+-[a-z0-9-]+$ ]] || die "La marca de #$n tiene una carpeta inválida: '$dir'" 2
[[ "$story" =~ ^(US[0-9]+|-)$ ]] || die "La marca de #$n tiene una historia inválida: '$story'" 2
[[ "$phase" =~ ^(setup|story|polish)$ ]] || die "La marca de #$n tiene una fase inválida: '$phase'" 2
[[ "$tasks" =~ ^T[0-9]+(,T[0-9]+)*$ ]] || die "La marca de #$n tiene tareas inválidas: '$tasks'" 2

[ -f "$dir/spec.md" ] && [ -f "$dir/tasks.md" ] \
  || die "La spec $dir de la issue #$n no está en esta rama (falta spec.md o tasks.md). Si se mergeó hace poco: git fetch y vuelve a crear la rama desde la base." 2

task_lines=""
for id in ${tasks//,/ }; do
  line=$(grep -E "^[[:space:]]*-[[:space:]]*\[[ xX]\][[:space:]]+$id\b" "$dir/tasks.md" | head -1 || true)
  [ -n "$line" ] || die "La tarea $id de la issue #$n ya no está en $dir/tasks.md: la spec cambió después de crear la issue." 2
  task_lines+="${line#"${line%%[![:space:]]*}"}"$'\n'
done

story_section=""
if [ "$story" != "-" ]; then
  k="${story#US}"
  # La sección va del título de la historia al siguiente título, sin el
  # separador "---" ni las líneas vacías del final.
  story_section=$(awk -v k="$k" '
    /^### User Story [0-9]+/ { inside = ($4 == k) }
    /^## / || (/^### / && !/^### User Story/) { inside = 0 }
    inside { line[++count] = $0 }
    END {
      while (count > 0 && line[count] ~ /^(---)?[[:space:]]*$/) count--
      for (i = 1; i <= count; i++) print line[i]
    }
  ' "$dir/spec.md")
  [ -n "$story_section" ] || die "La historia $story de la issue #$n no está en $dir/spec.md." 2
fi

echo "Spec: $dir (issue #$n, fase $phase, historia $story)"
echo
echo "Archivos de la spec (léelos; nunca los edites):"
for f in spec.md plan.md research.md data-model.md quickstart.md contracts/; do
  [ -e "$dir/$f" ] && echo "- $dir/$f"
done
echo
echo "Tareas de esta issue, de $dir/tasks.md (son la guía, en orden; no marques las casillas en tasks.md):"
printf '%s' "$task_lines"
if [ -n "$story_section" ]; then
  echo
  echo "La historia, de $dir/spec.md (cada escenario de aceptación es un criterio de la issue):"
  echo
  printf '%s\n' "$story_section"
fi
