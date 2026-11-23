#!/usr/bin/env bash
# Funciones de la cola de issues: elegibilidad, bloqueos, reclamo, worktree y
# contabilidad. Las usan process-backlog.sh (los workers headless) y los
# comandos de bin/ de la sesión interactiva, para que las garantías no
# dependan de que el modelo se acuerde.
#
# Se carga con `source`, después de factory-config.sh. Espera definidas:
# SCRIPT_DIR (la carpeta scripts/ del plugin), PLUGIN_ROOT, ME, ONLY_LABEL y
# ONLY_MINE.

# Lo que el worker necesita ver en su worktree. El worktree sale de
# origin/<base> (o del último commit, sin remoto), así que un cambio sin
# commitear o sin subir no le llega: por ejemplo, el enabledPlugins que
# `claude plugin install --scope project` escribe en settings.json.
WORKER_SETUP_PATHS=(CLAUDE.md factory.json .claude/settings.json .factory/version .factory/manifest.json .factory/rules)

base_branch() {
  local base
  base=$(factory_read_value baseBranch 2>/dev/null)
  base="${base:-main}"
  [[ "$base" =~ ^[A-Za-z0-9._/-]+$ ]] || base=main
  printf '%s\n' "$base"
}

# La referencia de la que saldrá el worktree: origin/<base> si existe.
worker_base_ref() {
  local base
  base=$(base_branch)
  if git rev-parse --verify -q "origin/$base" > /dev/null; then echo "origin/$base"; else echo HEAD; fi
}

# Un .json con el mismo contenido en otro orden o con otro formato le llega
# igual al worker: no cuenta. `claude plugin install --scope project`
# reescribe settings.json así.
same_json() {  # ref, file
  local base
  base=$(git show "$1:$2" 2>/dev/null | jq -S . 2>/dev/null) || return 1
  [ -n "$base" ] && [ "$base" = "$(jq -S . "$2" 2>/dev/null)" ]
}

uncommitted_setup() {
  local ref file
  ref=$(worker_base_ref)
  {
    { git diff --name-only "$ref" -- "${WORKER_SETUP_PATHS[@]}" 2>/dev/null || true; } | tr -d '\r' \
      | while IFS= read -r file; do
          case "$file" in *.json) [ -f "$file" ] && same_json "$ref" "$file" && continue ;; esac
          printf '%s\n' "$file"
        done
    git ls-files --others --exclude-standard -- "${WORKER_SETUP_PATHS[@]}" 2>/dev/null || true
  } | tr -d '\r' | sort -u
}


# Un worker `claude -p` carga el plugin solo si está instalado y habilitado
# para el proyecto, y si no lo está corre sin Stop gate ni revisores sin
# avisar. Se comprueba antes de lanzar ninguno.
# El worktree de una issue sale de origin/<base>: lo que no esté commiteado
# y subido ahí no le llega. Falla y dice qué hacer si la configuración de la
# fábrica de esta copia no coincide con la base.
check_setup_on_base() {
  local pending ref behind
  if ! git fetch -q origin "$(base_branch)" 2>/dev/null && git remote get-url origin > /dev/null 2>&1; then
    echo "⚠ No pude traer origin/$(base_branch): comparo con la copia que hay en esta máquina, que puede estar vieja." >&2
  fi
  ref=$(worker_base_ref)
  pending=$(uncommitted_setup)
  if [ -n "$pending" ]; then
    behind=0
    if [ "$ref" != HEAD ]; then
      behind=$(git rev-list --count "HEAD..$ref" -- "${WORKER_SETUP_PATHS[@]}" 2>/dev/null || echo 0)
    fi
    {
      echo "❌ Los workers parten de $ref y lo que tienes aquí no coincide:"
      sed 's/^/  /' <<< "$pending"
      if [ "${behind:-0}" -gt 0 ]; then
        echo "$ref tiene cambios que esta copia no tiene. Trae la rama base al día (git pull) y vuelve a correr la fábrica."
      elif [ "$ref" = HEAD ]; then
        echo "Haz commit de esos cambios y vuelve a correr la fábrica."
      else
        echo "Haz commit de esos cambios, súbelos a $ref y vuelve a correr la fábrica."
      fi
    } >&2
    return 1
  fi
}

check_plugin_ready() {
  bash "$SCRIPT_DIR/fabrica-setup.sh" check || return 1
  check_setup_on_base || return 1
  local want state
  want=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -n 1)
  state=$(claude plugin list --json 2>/dev/null | jq -r --arg want "$want" '
    [.[] | select(.id | startswith("fabrica@"))] as $p
    | [$p[] | select(.enabled)] as $on
    | if ($p | length) == 0 then "missing"
      elif ($on | length) == 0 then "disabled"
      elif any($on[]; .version == $want) then "ok"
      else "version " + ([$on[].version] | join(", "))
      end' 2>/dev/null | tr -d '\r') || state="missing"
  case "$state" in
    ok) return 0 ;;
    disabled)
      echo "❌ El plugin fabrica está instalado pero deshabilitado. Corre: claude plugin enable fabrica" >&2 ;;
    version*)
      echo "❌ El plugin fabrica instalado es ${state#version } y este proyecto usa $want. Corre: claude plugin update fabrica" >&2 ;;
    *)
      echo "❌ El plugin fabrica no está instalado: los workers correrían sin Stop gate ni revisores. Corre: claude plugin install fabrica@<marketplace> --scope project" >&2 ;;
  esac
  return 1
}

# The human's control surface is the BOARD: any non-epic card sitting in
# "Todo" means "I want this worked". Reconcile that intent into the machine
# queue (labels + issue state) before picking work, so dragging a card to
# Todo genuinely re-queues it, with no manual commands needed.
reconcile_board() {
  [ -f .plan/project.json ] || return 0
  local owner number
  owner=$(jq -r .owner .plan/project.json)
  number=$(jq -r .projectNumber .plan/project.json)
  gh project item-list "$number" --owner "$owner" --format json --limit 500 2>/dev/null \
    | jq -r '.items[] | select(.status=="Todo") | select(.content.number != null) | .content.number' \
    | tr -d '\r' \
    | while read -r n; do
        local err
        err=$(mktemp)
        if ! info=$(gh issue view "$n" --json state,labels 2>"$err"); then
          echo "⚠ reconcile_board: no pude leer el issue #$n con 'gh issue view' ($(cat "$err")), lo salto" >&2
          rm -f "$err"
          continue
        fi
        rm -f "$err"
        echo "$info" | jq -e '.labels[] | select(.name=="epic")' >/dev/null && continue
        state=$(echo "$info" | jq -r .state)
        if [ "$state" = "CLOSED" ]; then
          echo "↻ Board dice Todo para #$n (cerrado): reabriendo y encolando"
          gh issue reopen "$n" 2>/dev/null || true
          gh issue edit "$n" --add-label "pending" --remove-label "in-progress" --remove-label "needs-human" 2>/dev/null || true
        elif echo "$info" | jq -e '.labels[] | select(.name=="needs-human")' >/dev/null; then
          echo "↻ Board dice Todo para #$n (estaba needs-human): reintentando"
          gh issue edit "$n" --add-label "pending" --remove-label "needs-human" --remove-label "in-progress" 2>/dev/null || true
        elif ! echo "$info" | jq -e '.labels[] | select(.name=="pending" or .name=="in-progress")' >/dev/null; then
          echo "↻ Board dice Todo para #$n (sin label de cola): encolando"
          gh issue edit "$n" --add-label "pending" 2>/dev/null || true
        fi
      done
}

# Falla cerrada: si gh no puede leer la issue o sus bloqueos, cuenta como
# bloqueada. Con la red caída, una issue bloqueada no puede parecer libre.
is_blocked() {  # issue number -> 0 if blocked
  local n="$1"
  local labels blockers
  labels=$(gh issue view "$n" --json labels -q '.labels[].name') || return 0
  # POSIX sed (grep -oP is GNU-only: on macOS it would fail and, swallowed by
  # `|| true`, silently make every blocked issue look eligible).
  blockers=$(printf '%s\n' "$labels" | sed -n 's/^blocked-by-\([0-9][0-9]*\)$/\1/p')
  for b in $blockers; do
    state=$(gh issue view "$b" --json state -q .state)
    [ "$state" != "CLOSED" ] && return 0
  done
  return 1
}

# ready-for-dev es el carril de la nube: la persona se la pone a una issue
# para que la trabaje la nube. La nube y el local actúan como la misma
# persona, así que el reclamo por assignee no los separa, y el local llegó a
# tomar la issue de la nube. Para dársela al local, se quita la etiqueta.
# Si no se pueden leer sus etiquetas, la da por de la nube: el local no la toma.
is_cloud_lane() {  # issue number -> 0 if it belongs to the cloud
  local labels
  labels=$(gh issue view "$1" --json labels -q '.labels[].name') || return 0
  printf '%s\n' "$labels" | grep -qx 'ready-for-dev'
}

# Sale con 1 si gh no puede listar la cola: una cola ilegible no es una vacía.
next_issue() {  # -> first eligible pending issue number, or empty
  # Skips issues already assigned to someone else (their claim is respected)
  # and the ones in the cloud's lane.
  local lane=() list
  [ -n "$ONLY_LABEL" ] && lane=(--label "$ONLY_LABEL")
  for prio in "priority:high" "priority:medium" "priority:low" ""; do
    local pf=()
    [ -n "$prio" ] && pf=(--label "$prio")
    local jqsel=".[] | select((.assignees|length)==0 or ([.assignees[].login]|index(\"$ME\"))) | .number"
    [ -n "$ONLY_MINE" ] && jqsel=".[] | select([.assignees[].login]|index(\"$ME\")) | .number"
    if ! list=$(gh issue list --limit 500 --label pending "${lane[@]}" "${pf[@]}" --state open \
                  --json number,assignees --jq "$jqsel"); then
      echo "❌ No pude leer la cola con gh issue list (red, cuota o sesión de gh)." >&2
      return 1
    fi
    for n in $(printf '%s\n' "$list" | sort -n); do
      is_cloud_lane "$n" && continue
      if ! is_blocked "$n"; then echo "$n"; return; fi
    done
  done
}

# Labels an issue needs-human, unassigns it, moves its board card to Blocked
# and posts a comment. Shared by every path that gives up on a ticket, so the
# bookkeeping (label + assignee + board + comment) never drifts apart between
# them.
flag_needs_human() {  # issue number, comment body
  local n="$1" body="$2"
  gh issue edit "$n" --add-label "needs-human" --remove-label "in-progress" || true
  [ -n "${ME:-}" ] && gh issue edit "$n" --remove-assignee "@me" 2>/dev/null || true
  bash "$SCRIPT_DIR/task-status.sh" "$n" "Blocked" 2>/dev/null || true
  gh issue comment "$n" --body "$body" || true
}

# True if some PR (any state) declares "Closes #N" in its body, OR if `gh`
# itself could not be asked (rate limit, transient network error): a worker
# that already shipped a PR must never be flagged needs-human just because
# the check that would have proven it failed. Deliberately not keyed on
# branch name: `impl-N` and `worktree-impl-N` coexist (#62), so matching by
# head produces false negatives for work that is already sitting in an open
# PR.
pr_declares_closes() {  # issue number
  local n="$1" count
  # La lista de PRs, no la búsqueda: el índice de búsqueda de GitHub tarda
  # unos segundos en ver un PR recién abierto, y justo ahí se pregunta. Los
  # 100 más recientes alcanzan: el PR que importa es el que se acaba de abrir.
  if ! count=$(gh pr list --state all --limit 100 --json body \
      --jq "[.[] | select((.body // \"\") | test(\"(?i)\\\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #$n\\\\b\"))] | length" 2>/dev/null); then
    echo "⚠ no pude comprobar si #$n ya tiene PR (falla de gh); no lo marco needs-human por si acaso" >&2
    return 0
  fi
  [ "${count:-0}" != "0" ]
}

# Mergea el PR abierto de impl-N cuando pasan sus checks, solo si la issue
# tiene la etiqueta auto-merge. Lo llaman fabrica-backlog y la nube después
# del agente, nunca el worker: hooks/worker-guard.sh le bloquea `gh pr merge`.
#
# No usa `gh pr merge --auto`: sin branch protection no hay checks
# obligatorios, y --auto mergeaba al instante, antes de que terminaran
# (fabrica-prueba #37, 2026-11-23). Espera los checks él mismo, hasta
# FABRICA_AUTOMERGE_WAIT segundos, y exige que la rama tenga lo último de la
# base: así lo que entra es justo lo que verificaron.
#
# Sale con 0 si mergeó, 2 sin la etiqueta y 1 si no mergeó (y lo comenta en
# la issue).
automerge_issue() {  # issue number
  local n="$1" labels pr base head behind
  if [ "${FABRICA_WORKER:-}" = 1 ]; then
    echo "❌ Un worker no pone el auto-merge: lo pone fabrica-backlog o la nube al terminar." >&2
    return 1
  fi
  labels=$(gh issue view "$n" --json labels -q '.labels[].name') || { echo "❌ No pude leer #$n con gh." >&2; return 1; }
  printf '%s\n' "$labels" | grep -qx auto-merge || { echo "#$n no tiene la etiqueta auto-merge." >&2; return 2; }
  pr=$(gh pr list --head "impl-$n" --state open --json number -q '.[0].number' 2>/dev/null)
  if [ -z "$pr" ]; then
    echo "❌ #$n no tiene un PR abierto desde impl-$n." >&2
    return 1
  fi
  echo "⏳ Esperando los checks del PR #$pr para mergearlo..." >&2
  automerge_wait_checks "$pr" || { automerge_refuse "$n" "$pr" "$AUTOMERGE_WHY"; return 1; }
  read -r base head < <(gh pr view "$pr" --json baseRefName,headRefOid -q '.baseRefName + " " + .headRefOid')
  behind=$(gh api "repos/{owner}/{repo}/compare/$base...$head" -q .behind_by 2>/dev/null)
  if [ "${behind:-x}" != 0 ]; then
    automerge_refuse "$n" "$pr" "la rama no tiene lo último de $base, así que sus checks no verificaron lo que entraría"
    return 1
  fi
  if ! AUTOMERGE_WHY=$(gh pr ready "$pr" 2>&1 && gh pr merge "$pr" --squash 2>&1); then
    automerge_refuse "$n" "$pr" "$AUTOMERGE_WHY"
    return 1
  fi
  echo "✅ PR #$pr mergeado: sus checks pasaron."
}

# Espera a que terminen los checks del PR. 0 si todos pasan; si no, 1 y el
# motivo en AUTOMERGE_WHY. Un PR recién abierto puede no tener checks todavía:
# eso cuenta como pendiente hasta el plazo.
automerge_wait_checks() {  # PR number
  local pr="$1" out rc deadline=$((SECONDS + ${FABRICA_AUTOMERGE_WAIT:-1800}))
  while :; do
    out=$(gh pr checks "$pr" 2>&1)
    rc=$?
    case "$rc" in
      0) return 0 ;;
      8) AUTOMERGE_WHY="sus checks no terminaron en ${FABRICA_AUTOMERGE_WAIT:-1800} s" ;;
      *)
        if printf '%s' "$out" | grep -q "no checks reported"; then
          AUTOMERGE_WHY="el PR no tiene checks: sin ellos no hay nada que confirme que está en verde"
        else
          AUTOMERGE_WHY="un check falló"
          return 1
        fi
        ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep "${FABRICA_AUTOMERGE_INTERVAL:-20}"
  done
}

automerge_refuse() {  # issue number, PR number, reason
  gh issue comment "$1" --body "🤖 **No mergeé el PR #$2 con auto-merge**: $3. Revísalo y mergéalo a mano si está bien." || true
  echo "❌ No mergeé el PR #$2: $3" >&2
}

# Single source of truth for where a worker's branch/worktree lives, so the
# path template only needs to change in one place if the naming convention
# does (see #62, which is expected to touch it).
worktree_dir_for() {  # issue number
  echo ".claude/worktrees/impl-$1"
}

# Creates (or reuses) the worktree for a ticket, always on branch `impl-N`.
# `claude --worktree NAME` cannot be trusted for this: it prefixes whatever
# name it's given with `worktree-`, which is exactly how #62 happened
# (`impl-N` documented, `worktree-impl-N` pushed). Deciding the branch name
# here, with plain git, means the worker never has to get it right on its
# own. Idempotent: a worktree left over from a previous run of the same
# ticket is reused as-is, never given a second branch.
ensure_worker_worktree() {  # issue number
  local n="$1" wt_dir branch base
  wt_dir=$(worktree_dir_for "$n")
  branch="impl-$n"
  [ -d "$wt_dir" ] && return 0
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git worktree add "$wt_dir" "$branch"
    return
  fi
  # A new branch starts from the latest origin/<base>, not from the local
  # HEAD: a spec merged since the last pull must be in the worker's tree.
  base=$(base_branch)
  git fetch -q origin "$base" 2>/dev/null \
    || echo "⚠ no pude traer origin/$base; el worktree parte de lo que hay en esta copia" >&2
  if git rev-parse --verify -q "origin/$base" > /dev/null; then
    # --no-track: impl-N must not follow origin/<base>, or a bare `git push`
    # could land on the base branch.
    git worktree add --no-track -b "$branch" "$wt_dir" "origin/$base"
  else
    git worktree add -b "$branch" "$wt_dir"
  fi
}

# Reclama la issue por assignee y la vuelve a leer: si otra persona (un
# compañero, la nube) ganó la carrera, suelta el reclamo.
# Devuelve 0 si la issue es nuestra y 2 si es de otro. Sin usuario de gh (ME
# vacío, como con el token de la App en la nube) no hay reclamo por assignee
# posible y la da por nuestra, salvo que ya esté en curso.
#
# La nube y el local actúan como la misma cuenta, y dos corridas locales
# también: el assignee no las separa. Una issue en in-progress ya la está
# trabajando alguien, así que tampoco se toma (2). Si no se puede leer o
# asignar, sale con 1.
claim_issue() {  # issue number
  local n="$1" others labels
  if ! labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null); then
    echo "❌ No pude leer #$n con gh." >&2
    return 1
  fi
  if printf '%s\n' "$labels" | grep -qx in-progress; then
    echo "#$n ya está en curso. Si nadie la está trabajando, devuélvela a la cola con fabrica-release $n --pending." >&2
    return 2
  fi
  [ -n "${ME:-}" ] || return 0
  # En la nube, el token de la App no puede asignar, y no hace falta:
  # fabrica-eligible ya se la asignó a quien puso ready-for-dev.
  [ "${GITHUB_ACTIONS:-}" = true ] && return 0
  if ! gh issue edit "$n" --add-assignee "@me" 2>/dev/null; then
    echo "❌ No pude asignarme #$n con gh." >&2
    return 1
  fi
  others=$(gh issue view "$n" --json assignees --jq "[.assignees[].login] | map(select(. != \"$ME\")) | length" 2>/dev/null || echo 0)
  if [ "${others:-0}" -gt 0 ]; then
    gh issue edit "$n" --remove-assignee "@me" 2>/dev/null || true
    return 2
  fi
  return 0
}

# Contabilidad determinista al empezar una issue: no depende de que el modelo
# se acuerde.
mark_in_progress() {  # issue number
  gh issue edit "$1" --add-label "in-progress" --remove-label "pending" 2>/dev/null || true
  bash "$SCRIPT_DIR/task-status.sh" "$1" "In Progress" 2>/dev/null || true
}

# Los archivos sin seguimiento no viajan a los worktrees: se copian los .env
# locales (ignorados por git, se quedan en esta máquina) para que los tests de
# integración y las migraciones corran contra los servicios de verdad. Los que
# git sigue, como .env.example, ya viajan solos.
copy_env_files() {  # issue number
  local wt_dir envf
  wt_dir=$(worktree_dir_for "$1")
  [ -d "$wt_dir" ] || return 0
  for envf in .env .env.*; do
    [ -f "$envf" ] || continue
    git ls-files --error-unmatch "$envf" >/dev/null 2>&1 && continue
    if [ ! -f "$wt_dir/$envf" ]; then
      cp "$envf" "$wt_dir/$envf"
      echo "  🔑 $envf copiado al worktree de #$1" >&2
    fi
  done
}

# Una issue que se retoma no hereda los intentos del Stop gate de la corrida
# anterior: el contador y el rastro de rendición viven en el worktree.
reset_gate_state() {  # issue number
  local wt_dir
  wt_dir=$(worktree_dir_for "$1")
  rm -f "$wt_dir/.factory/state/stop-gate-count" "$wt_dir/.factory/gate-gave-up"
}

# Devuelve la issue a la cola: pending, sin assignee y la tarjeta en Todo.
release_to_queue() {  # issue number
  gh issue edit "$1" --add-label pending --remove-label in-progress 2>/dev/null || true
  [ -n "${ME:-}" ] && gh issue edit "$1" --remove-assignee "@me" 2>/dev/null || true
  bash "$SCRIPT_DIR/task-status.sh" "$1" "Todo" 2>/dev/null || true
}

# En un checkout desechable (el runner de GitHub Actions) la issue se trabaja
# en la rama impl-N del mismo checkout, sin worktree: allá no hay
# EnterWorktree y nadie más usa esa copia. Retoma la rama si ya existe, local o
# en origin; si no, la crea desde origin/<base> sin seguirla, igual que
# ensure_worker_worktree.
ensure_branch_in_place() {  # issue number
  local branch="impl-$1" base
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout -q "$branch"
    return
  fi
  if git fetch -q origin "$branch" 2>/dev/null; then
    git checkout -q -b "$branch" "origin/$branch"
    return
  fi
  base=$(base_branch)
  git fetch -q origin "$base" 2>/dev/null || true
  if git rev-parse --verify -q "origin/$base" > /dev/null; then
    git checkout -q --no-track -b "$branch" "origin/$base"
  else
    git checkout -q -b "$branch"
  fi
}

# Borra los worktrees de las issues ya cerradas. Uno con cambios sin
# commitear se deja y se avisa: `git worktree remove` sin --force se niega
# solo, y los archivos ignorados (node_modules, los .env copiados) no cuentan.
# La rama local se borra solo si ya está en la base; un PR mergeado con
# squash la deja afuera, y entonces se avisa en vez de borrar trabajo.
# Con "dry-run" como argumento solo lista. Imprime en stdout lo que borra.
cleanup_worktrees() {  # [dry-run]
  local dry="${1:-}" dir n state base_ref
  # El merge pasa en GitHub: sin traer la base, una rama ya mergeada parece
  # pendiente.
  git fetch -q origin "$(base_branch)" 2>/dev/null || true
  base_ref=$(worker_base_ref)
  for dir in .claude/worktrees/impl-*; do
    [ -d "$dir" ] || continue
    n="${dir##*impl-}"
    [[ "$n" =~ ^[0-9]+$ ]] || continue
    state=$(gh issue view "$n" --json state -q .state 2>/dev/null || echo "")
    [ "$state" = CLOSED ] || continue
    if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
      echo "⚠ impl-$n: la issue está cerrada, pero tiene cambios sin commitear. Lo dejo." >&2
      continue
    fi
    if [ "$dry" = dry-run ]; then
      echo "impl-$n (la issue #$n está cerrada)"
      continue
    fi
    if ! git worktree remove "$dir" 2>/dev/null; then
      echo "⚠ impl-$n: git no pudo borrar el worktree. Lo dejo." >&2
      continue
    fi
    if git merge-base --is-ancestor "impl-$n" "$base_ref" 2>/dev/null; then
      git branch -q -D "impl-$n" 2>/dev/null || true
      echo "impl-$n: worktree y rama borrados"
    else
      echo "impl-$n: worktree borrado; la rama queda porque no está en $base_ref (¿merge con squash?)"
    fi
  done
  git worktree prune 2>/dev/null || true
}

# Los números de las issues que bloquean a N y siguen abiertas, uno por línea,
# leídos de sus etiquetas. Un bloqueo cuyo estado no se puede leer cuenta como
# abierto.
open_blockers() {  # labels of the issue, one per line
  local b
  for b in $(printf '%s\n' "$1" | sed -n 's/^blocked-by-\([0-9][0-9]*\)$/\1/p'); do
    [ "$(gh issue view "$b" --json state -q .state 2>/dev/null)" != CLOSED ] && echo "$b"
  done
  return 0
}

# ¿Se puede tomar N por pedido de `actor` (quien puso ready-for-dev)? 0 si sí,
# y se la asigna, para que la nube y las sesiones locales respeten el
# reclamo; 2 si está asignada a otra persona; 3 si la bloquea una issue
# abierta. La misma regla que la cola local. También 2 si está cerrada o ya en
# curso (in-progress: la trabaja alguien, quizá la misma cuenta en local), y 1
# si gh no puede leerla.
issue_eligible_for() {  # issue number, actor
  local n="$1" actor="$2" state labels blockers others
  if ! state=$(gh issue view "$n" --json state -q .state) \
    || ! labels=$(gh issue view "$n" --json labels -q '.labels[].name'); then
    echo "❌ No pude leer #$n con gh." >&2
    return 1
  fi
  if [ "$state" = CLOSED ]; then
    echo "#$n está cerrada." >&2
    return 2
  fi
  if printf '%s\n' "$labels" | grep -qx in-progress; then
    echo "#$n ya está en curso: alguien la está trabajando." >&2
    return 2
  fi
  blockers=$(open_blockers "$labels" | sed 's/^/#/' | tr '\n' ' ')
  if [ -n "$blockers" ]; then
    echo "#$n está bloqueada por ${blockers% }: se toma cuando se cierre." >&2
    return 3
  fi
  others=$(gh issue view "$n" --json assignees --jq "[.assignees[].login] | map(select(. != \"$actor\")) | length" 2>/dev/null || echo 0)
  if [ "${others:-0}" -gt 0 ]; then
    echo "#$n está asignada a otra persona: es su reclamo." >&2
    return 2
  fi
  gh issue edit "$n" --add-assignee "$actor" >/dev/null 2>&1 || true
  return 0
}
