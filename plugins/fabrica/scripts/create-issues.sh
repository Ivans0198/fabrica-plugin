#!/usr/bin/env bash
# Crea las issues de una feature de Spec Kit, a partir del JSON que arma
# /fabrica:issues y aprueba una persona.
#
#   fabrica-create-issues <json> --approved <sha256 del JSON>
#
# Solo lo corre una persona: exige la huella del JSON que vio en la tabla de
# revisión, y se niega en CI y dentro de un worktree de un worker.
#
# Orden, para que ningún worker tome una historia antes de tiempo:
#   1. valida todo (lib/issues-plan.mjs) antes de tocar GitHub;
#   2. crea cada issue sin `pending`, en orden de dependencias, con sus
#      `blocked-by-N`, colgada de la épica y en Todo del tablero si hay;
#   3. recién al final agrega `pending` a las que no estén ya en curso.
#
# Cada cuerpo lleva <!-- fabrica-key: <épica>/<clave> sha=<huella> -->. Al
# empezar busca esas marcas en el repo: una issue ya creada se salta, y si su
# huella cambió, para. Así una corrida cortada se retoma desde cualquier
# máquina sin duplicar nada.
set -euo pipefail

die() { echo "❌ $*" >&2; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLAN_JS="$SCRIPT_DIR/lib/issues-plan.mjs"
USAGE="Uso: fabrica-create-issues <json> --approved <sha256 del JSON>"

[ "$#" -eq 3 ] && [ "$2" = "--approved" ] || die "$USAGE"
APPROVED="$3"
[[ "$APPROVED" =~ ^[0-9a-f]{64}$ ]] || die "--approved tiene que ser la huella sha256 del JSON, la que se mostró con la tabla."
[ -f "$1" ] || die "No existe $1"
JSON="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  die "fabrica-create-issues no corre en CI: crear issues de planeación necesita a una persona mirando la tabla."
fi
command -v gh > /dev/null 2>&1 || die "Falta gh (GitHub CLI)."
command -v node > /dev/null 2>&1 || die "Falta node."

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "No estás dentro de un repo git."
cd "$ROOT"
if [ "$(git rev-parse --absolute-git-dir)" != "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
  die "Estás dentro de un worktree. Las issues de planeación se crean desde el checkout principal, nunca desde el de un worker."
fi

# shellcheck source=lib/factory-config.sh
source "$SCRIPT_DIR/lib/factory-config.sh"
BASE=$(factory_read_value baseBranch)
BASE="${BASE:-main}"
[[ "$BASE" =~ ^[A-Za-z0-9._/-]+$ ]] || die "factory.json → baseBranch no es un nombre de rama válido."
git rev-parse --verify -q "origin/$BASE" > /dev/null || die "No conozco origin/$BASE. Corre git fetch."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BASE")" ] \
  || die "HEAD no es lo último de origin/$BASE. Las issues salen de la spec mergeada: git fetch, git checkout $BASE y git pull."

WORK=$(mktemp -d)
LOCK=".factory/state/create-issues.lock"
LOCKED=""
# El candado solo se borra si es de esta corrida: si otra lo tiene, es suyo.
cleanup() { rm -rf "$WORK"; if [ -n "$LOCKED" ]; then rmdir "$LOCK" 2>/dev/null || true; fi; }
trap cleanup EXIT

PLAN=$(node "$PLAN_JS" plan "$JSON" "$WORK") || exit 1
PLAN=$(printf '%s\n' "$PLAN" | tr -d '\r')
header() { printf '%s\n' "$PLAN" | sed -n "s/^@@$1 //p"; }
SHA=$(header sha)
EPIC=$(header epic)
DIR=$(header dir)
[ "$SHA" = "$APPROVED" ] || die "La huella del JSON ($SHA) no es la aprobada ($APPROVED). Si el JSON cambió, hay que volver a mostrar la tabla y pedir el OK."
git cat-file -e "origin/$BASE:$DIR/tasks.md" 2>/dev/null || die "$DIR/tasks.md no está en origin/$BASE: mergea primero el PR de la spec."
# Lo validado tiene que ser lo aprobado en el merge, no una copia editada aquí.
if ! git diff --quiet HEAD -- "$DIR" || [ -n "$(git ls-files --others --exclude-standard -- "$DIR")" ]; then
  die "$DIR tiene cambios sin commitear (por ejemplo en tasks.md). Las issues salen de la spec mergeada: descarta esos cambios o pásalos por un PR."
fi

REPO=${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "No sé en qué repo de GitHub estoy ('$REPO')."

EPIC_STATE=$(gh issue view "$EPIC" --json state,labels | node "$PLAN_JS" state | tr -d '\r') \
  || die "No pude leer la épica #$EPIC."
case "$EPIC_STATE" in
  "OPEN "*) ;;
  *) die "La épica #$EPIC no está abierta." ;;
esac
[[ ",${EPIC_STATE#OPEN }," == *",epic,"* ]] || die "La issue #$EPIC no tiene la etiqueta epic: no es una épica."

mkdir -p .factory/state
mkdir "$LOCK" 2>/dev/null || die "Ya hay otra corrida de fabrica-create-issues en esta copia ($LOCK). Si no hay ninguna, borra esa carpeta."
LOCKED=1

# Mapas clave → valor en archivos: las claves ya están validadas (letras,
# números, guion, guion bajo) y bash 3.2, el de macOS, no tiene arrays asociativos.
put() { printf '%s\n' "$3" > "$WORK/$1.$2"; }
get() { cat "$WORK/$1.$2" 2>/dev/null || true; }

# Las issues que ya creó una corrida anterior. Cada paso va a un archivo, para
# que un fallo de gh corte aquí: un listado vacío por error duplicaría todo.
LIST_LIMIT=1000
gh issue list --state all --limit "$LIST_LIMIT" --json number,body > "$WORK/list.json" \
  || die "No pude listar las issues del repo para saber cuáles ya existen. No creé nada; vuelve a intentarlo."
node "$PLAN_JS" markers "$WORK/list.json" "$EPIC" "$LIST_LIMIT" > "$WORK/markers" || exit 1
while read -r n key sha; do
  [ -n "${n:-}" ] || continue
  put found "$key" "$n"
  put found_sha "$key" "$sha"
done < <(tr -d '\r' < "$WORK/markers")

# Antes de tocar GitHub: una issue ya creada cuyo contenido cambió en el JSON
# para todo, también las que vendrían antes en el orden.
while IFS=$'\t' read -r i key _rest; do
  [[ "$i" =~ ^[0-9]+$ ]] || continue
  n=$(get found "$key")
  [ -n "$n" ] || continue
  want=$(sed -n 's/.*fabrica-key: [0-9]*\/[A-Za-z0-9_-]* sha=\([0-9a-f]*\).*/\1/p' "$WORK/body-$i.md")
  [ "$(get found_sha "$key")" = "$want" ] \
    || die "La issue #$n ($key) ya existe con otro contenido. No creé nada. Corrígela a mano en GitHub o deja la entrada $key como estaba en el JSON."
done <<< "$PLAN"

for label in pending priority:high priority:medium priority:low size:S size:M; do
  gh label create "$label" > /dev/null 2>&1 || true
done

parent_of() { # número
  gh api graphql -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { parent { number } } }
    }' -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F number="$1" \
    | node "$PLAN_JS" parent | tr -d '\r'
}

ORDER=()
# El plan entra por el descriptor 3: así ningún comando del bucle que lea la
# entrada estándar se come las líneas que faltan.
while IFS=$'\t' read -r i key title priority size deps <&3; do
  [[ "$i" =~ ^[0-9]+$ ]] || continue
  ORDER+=("$key")
  body="$WORK/body-$i.md"

  n=$(get found "$key")
  if [ -n "$n" ]; then
    # Nació con sus etiquetas y ya pasó por el tablero: no se toca. Volver a
    # ponerla en Todo la reabriría o la sacaría de needs-human.
    echo "  = $key: #$n (ya existía)"
  else
    labels=(--label "priority:$priority" --label "size:$size")
    for dep in $deps; do
      dep_n=$(get num "$dep")
      gh label create "blocked-by-$dep_n" --description "Bloqueada hasta que se cierre #$dep_n" > /dev/null 2>&1 < /dev/null || true
      labels+=(--label "blocked-by-$dep_n")
    done
    url=$(gh issue create --title="$title" --body-file "$body" "${labels[@]}" < /dev/null)
    n="${url##*/}"
    [[ "$n" =~ ^[0-9]+$ ]] || die "gh no devolvió el número de la issue creada para $key ($url)."
    echo "  + $key: #$n"
    put new "$key" 1
  fi
  put num "$key" "$n"

  if [ "$(parent_of "$n" < /dev/null)" != "$EPIC" ]; then
    id=$(gh api "repos/$REPO/issues/$n" < /dev/null | node "$PLAN_JS" id | tr -d '\r')
    gh api --method POST "repos/$REPO/issues/$EPIC/sub_issues" -F "sub_issue_id=$id" > /dev/null < /dev/null
  fi
  if [ -n "$(get new "$key")" ]; then
    bash "$SCRIPT_DIR/task-status.sh" "$n" "Todo" > /dev/null 2>&1 < /dev/null \
      || echo "  ⚠ no pude poner #$n en Todo del tablero (¿token sin permiso 'project'?)" >&2
  fi
done 3<<< "$PLAN"

# Recién ahora, con todo enlazado, entran a la cola. Una que ya está en curso,
# esperando a una persona o cerrada no se vuelve a encolar.
for key in "${ORDER[@]}"; do
  n=$(get num "$key")
  state=$(gh issue view "$n" --json state,labels | node "$PLAN_JS" state | tr -d '\r')
  labels=",${state#* },"
  case "$state" in "OPEN "*) ;; *) continue ;; esac
  [[ "$labels" == *",pending,"* || "$labels" == *",in-progress,"* || "$labels" == *",needs-human,"* ]] && continue
  gh issue edit "$n" --add-label pending > /dev/null
done

echo "Listo: ${#ORDER[@]} issues de la épica #$EPIC en la cola."
for key in "${ORDER[@]}"; do echo "  $key → #$(get num "$key")"; done
