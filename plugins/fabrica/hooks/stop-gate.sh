#!/usr/bin/env bash
# Stop gate: Claude cannot finish the session while these checks fail.
# Exit code 2 = block (Claude receives stderr and keeps iterating).
# Exit code 0 = allow finish.
#
# Los comandos salen de factory.json (commands.lint, typecheck, test, build, e2e), así
# que el gate sirve para cualquier stack sin editarlo. Un comando en null está
# apagado a propósito y no se corre. Keep the cheapest checks first so
# failures surface fast.

set -o pipefail

# shellcheck source=../../scripts/lib/factory-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/factory-config.sh"

# Kill switch, for a person who needs to stop the gate by hand. No workflow
# uses it: a session that changes nothing is already skipped below
# (hooks/session-start.sh). Exit before touching the retry counter file, so a
# worker session running in parallel keeps its own count untouched.
if [ "${FACTORY_GATE:-}" = "off" ]; then
  exit 0
fi

# Todo lo de abajo es relativo a la raíz del checkout donde está el trabajo
# (factory.json, .factory/). La sesión puede haber quedado en una subcarpeta,
# o en un worktree .claude/worktrees/impl-N al que entró con EnterWorktree:
# ahí CLAUDE_PROJECT_DIR sigue en la raíz, y solo el cwd de la entrada del
# hook dice dónde está. Ese cwd vale solo si queda dentro del proyecto.
ROOT="${CLAUDE_PROJECT_DIR:-}"
SESSION_ID=""
if [ ! -t 0 ] && command -v jq >/dev/null 2>&1; then
  hook_input=$(cat)
  SESSION_ID=$(printf '%s' "$hook_input" | jq -r '.session_id // empty' 2>/dev/null || true)
  [[ "$SESSION_ID" =~ ^[A-Za-z0-9_-]+$ ]] || SESSION_ID=""
  hook_cwd=$(printf '%s' "$hook_input" | jq -r '.cwd // empty' 2>/dev/null || true)
  if [ -n "$hook_cwd" ] && [ -d "$hook_cwd" ]; then
    hook_top=$(git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null || true)
    # En Windows CLAUDE_PROJECT_DIR viene como C:\... y git contesta C:/...:
    # se comparan con barras normales, sin la del final y, con letra de
    # unidad, sin distinguir mayúsculas.
    norm_path() {
      local p="${1//\\//}"
      p="${p%/}"
      [[ "$p" =~ ^[A-Za-z]:/ ]] && p=$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')
      printf '%s' "$p"
    }
    case "$(norm_path "$hook_top")/" in
      "$(norm_path "${ROOT:-$hook_top}")"/*) ROOT="$hook_top" ;;
    esac
  fi
fi
if [ -n "$ROOT" ]; then
  cd "$ROOT" || { echo "❌ Stop gate: no pude entrar a $ROOT" >&2; exit 2; }
fi
factory_use_base_config

# Anti-infinite-loop guard: after MAX_GATE_RUNS blocked attempts, let Claude
# stop so it can label the issue needs-human instead of looping forever. The
# counter lives in the checkout (.factory/ is gitignored), so each worktree
# keeps its own. MAX_GATE_RUNS is the correction budget in rules/fabrica.md
# ("Budget: N correction cycles"): change both together.
COUNTER_FILE=".factory/state/stop-gate-count"
MAX_GATE_RUNS="${MAX_GATE_RUNS:-5}"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)

# Pre-bootstrap guard: without factory.json the project has no real commands
# yet (the template ships factory.example.json; /bootstrap writes the real
# one), so the gate would be unsatisfiable. Arm it only after bootstrap.
if [ ! -f "$FACTORY_CONFIG_FILE" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

fail() {
  mkdir -p "$(dirname "$COUNTER_FILE")"
  echo "$((COUNT + 1))" > "$COUNTER_FILE"
  if [ "$COUNT" -ge "$MAX_GATE_RUNS" ]; then
    echo "Stop gate has blocked $COUNT times. Giving up." >&2
    echo "MANDATORY before you stop: do NOT open or mark ready any PR; label the issue needs-human and comment what is still red." >&2
    mkdir -p .factory && date > .factory/gate-gave-up   # rastro para el orquestador
    rm -f "$COUNTER_FILE"
    exit 0
  fi
  echo "$1" >&2
  exit 2
}

# Todo lo que cambió desde que la rama salió de la base: commits, ediciones y
# archivos nuevos. Vacío si no hay origin/<base>.
changed_since_base() {
  local base merge_base
  base=$(factory_read_value baseBranch 2>/dev/null)
  base="${base:-main}"
  merge_base=$(git merge-base HEAD "origin/$base" 2>/dev/null) || return 0
  # --no-renames: a file moved from src/ to specs/ must show up as removed
  # from src/, or moving code into specs/ would skip the gate.
  {
    git diff --no-renames --name-only "$merge_base" 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | tr -d '\r' | sort -u
}

# Spec guard: an issue branch (impl-N) never changes specs/. The approved spec
# is fixed while it is being built (constitution, principle III); work that
# needs a different spec goes to a human. It runs before the other guards, so
# a change already committed and pushed is caught too.
if [[ "$(git branch --show-current 2>/dev/null)" =~ ^impl-[0-9]+$ ]]; then
  spec_changes=$(changed_since_base | grep '^specs/' || true)
  if [ -n "$spec_changes" ]; then
    fail "❌ An issue branch must not change the approved spec. Changed under specs/:
$spec_changes
Revert those changes (git checkout origin/<base> -- <file>, then commit). If the work really needs a different spec, stop and release the issue with fabrica-release N --needs-human \"<what the spec is missing>\"."
  fi
  # factory.json says which commands the hooks run, outside the permission
  # system: changing it is a human's call, like the spec.
  if changed_since_base | grep -qx 'factory.json'; then
    fail "❌ An issue branch must not change factory.json: it decides which commands the hooks run. Revert it (git checkout origin/<base> -- factory.json, then commit). If the ticket really needs another command, stop and release the issue with fabrica-release N --needs-human \"<what factory.json needs>\"."
  fi
fi

# Commit format guard: with factory.json → commitFormat "conventional", the
# commits never pushed follow Conventional Commits. The ones about to be
# pushed are checked earlier, by hooks/commit-format.sh: once pushed, fixing
# them would need --force. History from before the factory never blocks.
# shellcheck source=../scripts/lib/commit-format.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/commit-format.sh"
if commit_format_enabled; then
  since=$(commit_format_since)
  if [ -n "$since" ]; then
    bad=$(commit_format_bad "$since")
    if [ -n "$bad" ]; then
      fail "❌ These commits do not follow Conventional Commits (factory.json → commitFormat):
$bad
$(commit_format_help "$since")"
    fi
  fi
fi

# Review-only guard: if the session changed nothing beyond generated noise
# (clean tree modulo GENERATED_NOISE_FILES) and HEAD is already verified,
# there is nothing to verify. Don't run the full suite just to end a Q&A
# session. HEAD counts as verified if the gate already passed on it, if the
# session has not moved it since it started (hooks/session-start.sh), or if it
# has no commits beyond the base. Pushing does not verify anything: a worker
# pushes before its last Stop, so "nothing beyond upstream" would skip the
# checks on the normal path. Some dev servers rewrite
# files on every run (`next dev` does it to tsconfig.json and to the CLAUDE.md
# agent block), and `npm install` rewrites package-lock.json, so without this
# allowance the first gate run in a session dirties the tree and the guard can
# never apply again.
GENERATED_NOISE_FILES=("tsconfig.json" "package-lock.json" "CLAUDE.md" "AGENTS.md")

is_generated_noise_file() {
  local candidate="$1"
  local noise_file
  for noise_file in "${GENERATED_NOISE_FILES[@]}"; do
    if [ "$candidate" = "$noise_file" ]; then
      return 0
    fi
  done
  return 1
}

# `git status --porcelain` lines are "XY path": 2 status chars + 1 space
# before the path.
readonly PORCELAIN_STATUS_PREFIX_LEN=3

only_generated_noise_is_dirty() {
  local status_line
  while IFS= read -r status_line; do
    [ -z "$status_line" ] && continue
    is_generated_noise_file "${status_line:$PORCELAIN_STATUS_PREFIX_LEN}" || return 1
  done <<<"$(git status --porcelain 2>/dev/null)"
  return 0
}

# El sha que pasó el gate vive en el git-dir del worktree: nunca ensucia el
# árbol ni viaja con la rama.
PASSED_FILE=$(git rev-parse --git-path fabrica-gate-passed 2>/dev/null || true)

head_already_verified() {
  local head base ahead start
  head=$(git rev-parse HEAD 2>/dev/null) || return 1
  [ -n "$PASSED_FILE" ] && [ "$(cat "$PASSED_FILE" 2>/dev/null)" = "$head" ] && return 0
  if [ -n "$SESSION_ID" ]; then
    start=$(cat "$(git rev-parse --git-path "fabrica-session-$SESSION_ID" 2>/dev/null)" 2>/dev/null)
    [ "$start" = "$head" ] && return 0
  fi
  base=$(factory_read_value baseBranch 2>/dev/null)
  base="${base:-main}"
  ahead=$(git rev-list --count "origin/$base..HEAD" 2>/dev/null) || return 1
  [ "$ahead" = "0" ]
}

if only_generated_noise_is_dirty && head_already_verified; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# Planning guard: a spec branch (fabrica:spec, plan, tasks) only changes
# specs/ and docs/plan-maestro.md. There is no code to verify, and a red main
# must not block writing a spec. Everything that changed since the branch left
# the base (commits, edits and new files) has to be planning or generated
# noise, with at least one planning file: a branch that only changes
# tsconfig.json or the lockfile changes what the checks verify, so it runs the
# full gate. Without origin/<base> it does not apply.
only_planning_changes() {
  local changed file planning=""
  changed=$(changed_since_base)
  [ -n "$changed" ] || return 1
  while IFS= read -r file; do
    case "$file" in
      specs/* | docs/plan-maestro.md) planning=1 ;;
      # .gitignore: `fabrica-setup speckit` adds .specify/ to it.
      .gitignore) ;;
      *) is_generated_noise_file "$file" || return 1 ;;
    esac
  done <<<"$changed"
  [ -n "$planning" ]
}

if only_planning_changes; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# Corre commands.<name> de factory.json y bloquea si falla. Un comando en null
# no se corre. Si factory.json está mal, eso también bloquea: un gate que no
# puede leer qué verificar no puede dejar pasar nada.
#
# Cada check tiene plazo: lo que queda de GATE_BUDGET, por debajo de los 600 s
# del hook en hooks.json, para que un check colgado bloquee en vez de que el
# hook se corte. Si falla, Claude recibe las últimas OUTPUT_TAIL líneas, y la
# salida entera queda en .factory/state/gate-<check>.log: una suite roja
# grande llenaba el contexto.
GATE_BUDGET=570
OUTPUT_TAIL=150
run_check() {
  local name="$1" label="$2" status out log limit runner=() why=""
  factory_read_command "$name"
  status=$?
  if [ "$status" -eq 3 ]; then
    return 0
  fi
  if [ "$status" -ne 0 ]; then
    fail "❌ $FACTORY_ERROR"
  fi
  limit="${FACTORY_CHECK_TIMEOUT:-$((GATE_BUDGET - SECONDS))}"
  [ "$limit" -gt 0 ] || fail "❌ $label did not run: the Stop gate ran out of time (${GATE_BUDGET}s). Make the checks faster."
  command -v timeout >/dev/null 2>&1 && runner=(timeout --kill-after=5 "$limit")
  out=$(mktemp)
  "${runner[@]}" "${FACTORY_CMD[@]}" > "$out" 2>&1 < /dev/null
  status=$?
  if [ "$status" -ne 0 ]; then
    log=".factory/state/gate-$name.log"
    mkdir -p .factory/state && mv "$out" "$log"
    [ "$status" -eq 124 ] && why=" timed out after ${limit}s (plazo del Stop gate)"
    fail "❌ $label failed (${FACTORY_CMD[*]})$why. Fix before finishing. Last $OUTPUT_TAIL lines (full output in $log):
$(tail -n "$OUTPUT_TAIL" "$log")"
  fi
  rm -f "$out"
}

# 0. The format rules are read by the post-edit hook, which never blocks; a
# broken rule would silently stop formatting, so the gate is where it surfaces.
FORMAT_ERROR=$(factory_format_error)
if [ -n "$FORMAT_ERROR" ]; then
  fail "❌ $FORMAT_ERROR"
fi

# 1. Lint
run_check lint "Lint"

# 2. Types
run_check typecheck "Type check"

# 3. Unit tests
run_check test "Tests"

# 4. Build: la CI lo corre, y un worker no debería enterarse en el PR.
run_check build "Build"

# Los tests del kit no corren aquí: viven y corren en el repo del plugin.

# 5. E2E: accesibilidad, comportamiento y fidelidad, cuando el proyecto los
# tiene. Las capturas propias (tests/ui.spec.ts-snapshots) no se comparan
# aquí: cada historia con UI las cambia y aceptarlas es de una persona, con
# el job visual de la CI y visual-baselines.yml. Compararlas aquí dejaba al
# worker sin salida. playwright.config.ts lee la variable (ignoreSnapshots).
#
# Antes espera a que el dev server de la revisión de UI se apague: ocupa el
# puerto de la app y Playwright chocaría con él. Lo levanta ui-preflight.sh,
# que deja su pid en .factory/ui-server.pid y lo apaga al terminar.
UI_SERVER_PID_FILE=".factory/ui-server.pid"
ui_review_server_alive() {
  [ -f "$UI_SERVER_PID_FILE" ] && kill -0 "$(cat "$UI_SERVER_PID_FILE")" 2>/dev/null
}
port_wait="${FABRICA_GATE_PORT_WAIT:-180}"
waited=0
while ui_review_server_alive; do
  if [ "$waited" -ge "$port_wait" ]; then
    fail "❌ E2E did not run: the ui-reviewer's dev server (pid $(cat "$UI_SERVER_PID_FILE")) still holds the app's port after ${port_wait}s. Wait for the ui-reviewer to finish (it stops its own server), then try again. Never kill it by hand."
  fi
  sleep 1
  waited=$((waited + 1))
done
FABRICA_IGNORE_SNAPSHOTS=1 run_check e2e "E2E (a11y/fidelidad)"

rm -f "$COUNTER_FILE"
# Solo un árbol limpio deja HEAD como verificado: con cambios sin commitear,
# lo que pasó no es lo que está en HEAD.
if [ -n "$PASSED_FILE" ] && only_generated_noise_is_dirty; then
  git rev-parse HEAD > "$PASSED_FILE" 2>/dev/null || true
fi
exit 0
