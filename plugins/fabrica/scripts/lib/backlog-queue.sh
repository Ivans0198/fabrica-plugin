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

uncommitted_setup() {
  local ref
  ref=$(worker_base_ref)
  {
    git diff --name-only "$ref" -- "${WORKER_SETUP_PATHS[@]}" 2>/dev/null || true
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

is_blocked() {  # issue number -> 0 if blocked
  local n="$1"
  local blockers
  # POSIX sed (grep -oP is GNU-only: on macOS it would fail and, swallowed by
  # `|| true`, silently make every blocked issue look eligible).
  blockers=$(gh issue view "$n" --json labels -q '.labels[].name' \
             | sed -n 's/^blocked-by-\([0-9][0-9]*\)$/\1/p')
  for b in $blockers; do
    state=$(gh issue view "$b" --json state -q .state)
    [ "$state" != "CLOSED" ] && return 0
  done
  return 1
}

next_issue() {  # -> first eligible pending issue number, or empty
  # Skips issues already assigned to someone else (their claim is respected).
  local lane=()
  [ -n "$ONLY_LABEL" ] && lane=(--label "$ONLY_LABEL")
  for prio in "priority:high" "priority:medium" "priority:low" ""; do
    local pf=()
    [ -n "$prio" ] && pf=(--label "$prio")
    local jqsel=".[] | select((.assignees|length)==0 or ([.assignees[].login]|index(\"$ME\"))) | .number"
    [ -n "$ONLY_MINE" ] && jqsel=".[] | select([.assignees[].login]|index(\"$ME\")) | .number"
    for n in $(gh issue list --limit 500 --label pending "${lane[@]}" "${pf[@]}" --state open \
                 --json number,assignees \
                 --jq "$jqsel" \
               | sort -n); do
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
  if ! count=$(gh pr list --state all --search "Closes #$n in:body" --json number --jq length 2>/dev/null); then
    echo "⚠ no pude comprobar si #$n ya tiene PR (falla de gh); no lo marco needs-human por si acaso" >&2
    return 0
  fi
  [ "${count:-0}" != "0" ]
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
# compañero, el cron de la nube) ganó la carrera, suelta el reclamo.
# Devuelve 0 si la issue es nuestra y 2 si es de otro. Sin usuario de gh (ME
# vacío) no hay reclamo posible y la da por nuestra.
claim_issue() {  # issue number
  local n="$1" others
  [ -n "${ME:-}" ] || return 0
  gh issue edit "$n" --add-assignee "@me" 2>/dev/null || true
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
