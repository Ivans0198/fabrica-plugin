#!/usr/bin/env bash
# Autonomous backlog processor.
# Picks eligible `pending` issues one by one and runs Claude Code on each,
# in an isolated git worktree, until the backlog is empty or MAX_ISSUES is hit.
#
# Requirements: gh (authenticated), claude, jq. Run from the repo root, as
# `fabrica-backlog` (the /fabrica:backlog skill does it).
# Safety: full-bypass permissions (PERMISSION_MODE=bypassPermissions) only
# run inside a container, such as the one fabrica-devcontainer writes; with
# the default auto mode it is safe to run on your machine but may
# occasionally pause on a dangerous action.

set -euo pipefail

# La carpeta de este script, antes del cd: desde el plugin, los scripts
# hermanos viven ahí y no en el proyecto.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Everything below assumes the repo root (relative paths: factory.json,
# .plan/, .claude/worktrees/). Fail loudly instead of degrading.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$REPO_ROOT" ] || { echo "❌ No estás dentro de un repo git. Corre esto desde la carpeta del proyecto" >&2; exit 1; }
cd "$REPO_ROOT"
command -v gh >/dev/null || { echo "❌ Falta 'gh' (GitHub CLI). Instálalo y corre 'gh auth login'" >&2; exit 1; }
command -v jq >/dev/null || { echo "❌ Falta 'jq'. Instálalo (winget install jqlang.jq / brew install jq)" >&2; exit 1; }

MAX_ISSUES="${MAX_ISSUES:-10}"
# 200, no 80: el tope es un corte seco. Un worker que se queda sin turnos no
# alcanza ni a commitear lo que ya tenía verde, y el ticket se pierde entero.
MAX_TURNS="${MAX_TURNS:-200}"
PERMISSION_MODE="${PERMISSION_MODE:-auto}"   # auto | bypassPermissions (container only!)
# Sin preguntar nada, un worker puede borrar o mandar a la red lo que sea: eso
# solo vale en un contenedor desechable (fabrica-devcontainer escribe uno con
# firewall). Lo detecta por los archivos que dejan Docker y Podman, o por la
# variable que pone el Dockerfile de la fábrica.
if [ "$PERMISSION_MODE" = bypassPermissions ] \
  && [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ] && [ "${DEVCONTAINER:-}" != true ]; then
  echo "❌ PERMISSION_MODE=bypassPermissions solo corre dentro de un contenedor. Ábrelo con el de fabrica-devcontainer, o usa PERMISSION_MODE=auto" >&2
  exit 1
fi
# Dentro del contenedor, el firewall tiene que estar arriba: init-firewall.sh
# deja la marca solo si terminó bien, y la red se prueba en el momento (la
# marca sobrevive a un reinicio sin postStartCommand).
if [ "$PERMISSION_MODE" = bypassPermissions ]; then
  if [ ! -f "${FABRICA_FIREWALL_MARK:-/run/fabrica-firewall-ok}" ]; then
    echo "❌ El firewall del contenedor no está arriba: corre sudo /usr/local/bin/init-firewall.sh, o usa PERMISSION_MODE=auto. Si ya lo corriste, tu .devcontainer/ es de antes de la 0.5.0 y su firewall no deja la marca: regenéralo con fabrica-devcontainer --force y reconstruye el contenedor" >&2
    exit 1
  fi
  if curl --connect-timeout 3 -s -o /dev/null https://example.com 2>/dev/null; then
    echo "❌ La red deja salir a example.com: el firewall no está cerrando. Corre sudo /usr/local/bin/init-firewall.sh, o usa PERMISSION_MODE=auto" >&2
    exit 1
  fi
fi
# shellcheck source=lib/factory-config.sh
source "$SCRIPT_DIR/lib/factory-config.sh"
WORKER_MODEL="${WORKER_MODEL:-$(factory_read_model worker sonnet)}"
# Single source of truth for both this script and claude-backlog.yml (#60):
# tools that only make sense in an interactive session or a self-pacing
# /loop, which a one-ticket headless worker never has. `Agent` must never
# be added here: the lifecycle needs it to launch fabrica:code-reviewer/ui-reviewer.
WORKER_DISALLOWED_TOOLS_FILE="${WORKER_DISALLOWED_TOOLS_FILE:-$SCRIPT_DIR/worker-disallowed-tools.txt}"
[ -f "$WORKER_DISALLOWED_TOOLS_FILE" ] || { echo "❌ Falta $WORKER_DISALLOWED_TOOLS_FILE: no se puede lanzar el worker sin saber qué herramientas negarle" >&2; exit 1; }
WORKER_DISALLOWED_TOOLS=$(grep -v '^[[:space:]]*#' "$WORKER_DISALLOWED_TOOLS_FILE" \
  | grep -v '^[[:space:]]*$' | tr -d ' \t' | tr '\n' ',' | sed 's/,$//' || true)
[ -n "$WORKER_DISALLOWED_TOOLS" ] || { echo "❌ $WORKER_DISALLOWED_TOOLS_FILE no lista ninguna herramienta" >&2; exit 1; }
ONLY_LABEL="${ONLY_LABEL:-}"   # opcional: partir el backlog por carril (ej. ONLY_LABEL=area:billing)
ONLY_MINE="${ONLY_MINE:-}"     # opcional: ONLY_MINE=1 → SOLO tickets asignados a mí (ignora el pozo común)
ME=$(gh api user --jq .login 2>/dev/null || echo "")
PROCESSED=0
# PID del worker que lanzó run_worker. Nunca se hereda: Claude Code exporta
# CLAUDE_PID con su propio PID, y cleanup() mata este.
WORKER_PID=""

echo "🏭 Worker model: $WORKER_MODEL (configurable en factory.json → models.worker)"
[ -n "$ONLY_LABEL" ] && echo "🔀 Carril: solo issues con label '$ONLY_LABEL'"
[ -n "$ONLY_MINE" ] && echo "🎯 Modo estricto: solo tickets asignados a mí"
[ -n "$ME" ] && echo "👤 Corriendo como: $ME (reclamo por assignee activo)"

PLUGIN_ROOT="${FABRICA_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Elegibilidad, reclamo, worktree y contabilidad de la cola. Los comparten
# este script y los comandos de bin/ que usa la sesión interactiva.
# shellcheck source=lib/backlog-queue.sh
source "$SCRIPT_DIR/lib/backlog-queue.sh"

# Leave no ghost state if the operator hits Ctrl+C mid-ticket.
cleanup() {
  [ -n "${WORKER_PID:-}" ] && kill "$WORKER_PID" 2>/dev/null || true
  if [ -n "${N:-}" ]; then
    echo "" >&2
    echo "⏹ Interrumpido en #$N: devolviéndolo a la cola" >&2
    gh issue edit "$N" --add-label pending --remove-label in-progress 2>/dev/null || true
    [ -n "${ME:-}" ] && gh issue edit "$N" --remove-assignee "@me" 2>/dev/null || true
    # A board that rejects the status (no Blocked option yet) must not stop
    # the rest of the cleanup: the label/assignee bookkeeping above already
    # returned the ticket to the queue.
    bash "$SCRIPT_DIR/task-status.sh" "$N" "Blocked" 2>/dev/null || true
  fi
  # Already handled above; the EXIT trap's safety_net must not also fire.
  TICKET_OUTCOME_RECORDED=1
  exit 130
}

# Last-resort net (#83): every ordinary exit path already marks the ticket
# one way or another (cleanup() on Ctrl+C, handle_worker_exit() once the
# worker's outcome is known), but ALL of that machinery depends on the
# script staying alive long enough to run it, and #83 is exactly a case
# where it didn't: the script died between the heartbeat loop and its own
# epilogue, printing nothing, leaving the ticket in-progress and assigned
# with real work stranded on its branch. This trap fires on every exit,
# whatever the cause (a bug here, an environment quirk, one we haven't hit
# yet), and is a no-op once WORKER_LAUNCHED is unset (no worker running yet)
# or TICKET_OUTCOME_RECORDED is set (some path already handled this ticket).
safety_net() {
  local exit_code=$?
  if [ -n "${N:-}" ] && [ -n "${WORKER_LAUNCHED:-}" ] && [ -z "${TICKET_OUTCOME_RECORDED:-}" ]; then
    echo "" >&2
    echo "🚨 process-backlog.sh terminó de forma inesperada (código $exit_code) procesando #$N: red de seguridad activada" >&2
    flag_needs_human "$N" "🤖 **El propio \`process-backlog.sh\` terminó de forma inesperada** (código de salida $exit_code) mientras procesaba este ticket, antes de poder decidir si el worker tuvo éxito.

**Qué pasó:** el proceso que orquesta al worker murió por su cuenta; el worker puede haber terminado bien, mal, o seguir corriendo huérfano. Ninguna de las rutas normales de cierre llegó a ejecutarse, así que esta es la red de seguridad de último recurso.

**Trabajo parcial:** revisa el worktree \`impl-$N\` antes de decidir cómo retomarlo.

**Para retomar:**
\`\`\`
gh issue edit $N --remove-label needs-human --remove-label in-progress --add-label pending
\`\`\`
y después, en Claude, \`/fabrica:backlog\`."
  fi
}

# Best-effort heartbeat helpers (#83): every command here can legitimately
# fail on a live run (no session started yet, a log file rotated between the
# `ls` that found it and the `tail` that reads it, a file renamed mid-`find`
# scan) and must never take the whole script down with it. Under `set -euo
# pipefail`, `VAR=$(cmd1 | cmd2)` aborts the script the instant ANY stage of
# the pipeline fails, even if the assignment is otherwise harmless and the
# failure is expected; the `|| true` at the end of each pipeline is what
# neutralizes that (`LINES` a few lines below already relied on the same
# trick with `|| echo 0`, these below just didn't have it).
latest_session_file() {  # issue number -> path or empty
  local n="$1" sess_dir
  # Anchor the end: without it, issue #1 matches ...impl-19 / ...impl-100.
  sess_dir=$(ls -dt "$HOME/.claude/projects/"*worktrees-impl-"$n" 2>/dev/null | head -1 || true)
  [ -n "$sess_dir" ] || return 0
  ls -t "$sess_dir"/*.jsonl 2>/dev/null | head -1 || true
}

latest_worker_activity() {  # session file path -> text or empty
  local sess_file="$1"
  [ -n "$sess_file" ] || return 0
  tail -c 200000 "$sess_file" 2>/dev/null \
    | jq -Rr 'fromjson? | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
              | "🔧 " + .name + ((.input.command // .input.file_path // "") | tostring | if . == "" then "" else ": " + .[0:55] end)' 2>/dev/null \
    | tail -1 || true
}

worker_tool_error_count() {  # session file path -> integer (0 if unavailable)
  local sess_file="$1" count
  [ -n "$sess_file" ] || { echo 0; return 0; }
  # `wc`/`tr` can legitimately succeed on empty input (printing "0") even
  # when `tail` failed earlier in the pipe; under `pipefail` the pipeline as
  # a whole still counts as failed, so the `|| true` fallback must not be a
  # second `echo 0` (that would print "0\n0", not "0") but a plain default
  # applied to whatever `count` ended up holding.
  count=$(tail -c 200000 "$sess_file" 2>/dev/null \
    | jq -Rr 'fromjson? | select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true) | 1' 2>/dev/null \
    | wc -l | tr -d ' ') || true
  echo "${count:-0}"
}

dirty_file_count() {  # worktree dir -> integer (0 if unavailable)
  local wt_dir="$1" count
  # Same shape as worker_tool_error_count above: `wc -l | tr -d ' '` can
  # print a legitimate "0" even when `git status` itself failed (e.g. WT_DIR
  # doesn't exist yet), so the `pipefail`-driven failure must be neutralized
  # on the captured variable, not with a second unconditional `echo 0`.
  count=$(git -C "$wt_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ') || true
  echo "${count:-0}"
}

latest_touched_file() {  # worktree dir -> "epoch path" or empty
  local wt_dir="$1"
  find "$wt_dir" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" \
    -printf '%T@ %P\n' 2>/dev/null | sort -nr | head -1 || true
}

# A worker that exits 0 without finishing the lifecycle (asks something and
# waits, commits and stops, loses a tool mid-session...) leaves no visible
# signal: the issue stays in-progress, assigned, with real work stranded on
# its branch. Detect that silent case instead of trusting exit 0 as success.
check_worker_left_no_pr() {  # issue number
  local n="$1" info state labels wt_dir last_commit dirty_count
  info=$(gh issue view "$n" --json state,labels 2>/dev/null) || return 0
  state=$(echo "$info" | jq -r .state)
  [ "$state" = "CLOSED" ] && return 0   # closed by idempotency: no PR is correct
  labels=$(echo "$info" | jq -r '.labels[].name')
  echo "$labels" | grep -qx "in-progress" || return 0
  wt_dir=$(worktree_dir_for "$n")
  # Las reglas prohíben el PR cuando el Stop gate se rinde, pero eso es texto:
  # si el worker lo abrió igual, no cuenta como éxito.
  if [ -f "$wt_dir/.factory/gate-gave-up" ]; then
    echo "⚠ El Stop gate se rindió en #$n: needs-human aunque haya PR"
    flag_needs_human "$n" "🤖 **El Stop gate se rindió** después de agotar los ciclos de corrección: lint, tipos o tests siguen en rojo en la rama \`impl-$n\`. Si hay un PR, no lo mergees así.

Revisa el worktree \`impl-$n\`, arregla lo que falla o ajusta la issue, y retómala con \`/fabrica:backlog $n\`."
    return 0
  fi
  pr_declares_closes "$n" && return 0

  last_commit=$(git -C "$wt_dir" log --oneline -1 2>/dev/null || echo "sin commits")
  dirty_count=$(dirty_file_count "$wt_dir")

  echo "⚠ Claude salió 0 en #$n pero no dejó PR: labeling needs-human + comentario"
  flag_needs_human "$n" "🤖 **El worker terminó (código 0) sin completar el lifecycle**: no encontré ningún PR, abierto o cerrado, que declare \`Closes #$n\` en su cuerpo.

**Último commit en la rama**: \`$last_commit\`.
**Archivos sin commitear**: $dirty_count.

Revisa el worktree \`impl-$n\` antes de decidir cómo retomarlo: puede que el trabajo esté casi terminado y solo falte abrir el PR, o que se haya detenido a mitad de camino."
}

# Lo que el worker escribió, junto a su worktree: .claude/worktrees/ está
# fuera de git y la carpeta impl-N es de la rama.
worker_output_file() {  # issue number
  printf '%s.log\n' "$(worktree_dir_for "$1")"
}

# La línea del aviso de límite de uso de la cuenta, o nada. Solo cuenta al
# principio de una línea: un resumen que lo cita no es el aviso.
usage_limit_line() {  # issue number
  grep -m1 -E "^(You've hit your [^·]*limit|Claude AI usage limit reached)" \
    "$(worker_output_file "$1")" 2>/dev/null || true
}

# Single decision point for what happens after the worker process ends, so a
# crash (exit != 0) and a silent success (exit 0, no PR) share the same
# needs-human path and never both fire for the same run.
handle_worker_exit() {  # issue number, wait's exit status
  local n="$1" exit_code="$2" limit
  # Un límite de uso no lo resuelve una persona: la issue vuelve a la cola
  # con su rama, y main() para el lote (truckconnect-mobile #6, 2026-11-26).
  limit=$(usage_limit_line "$n")
  if [ -n "$limit" ]; then
    echo "⏸ Límite de uso de la cuenta en #$n: la devuelvo a la cola"
    release_to_queue "$n"
    gh issue comment "$n" --body "🤖 **El worker se cortó por el límite de uso de la cuenta** (\`$limit\`). No es una falla: la issue volvió a la cola y su trabajo sigue en la rama \`impl-$n\` (último commit: \`$(git -C "$(worktree_dir_for "$n")" log --oneline -1 2>/dev/null || echo "sin commits")\`). El próximo \`fabrica-backlog\` la retoma desde ahí." || true
    USAGE_LIMIT_HIT="$limit"
    return 0
  fi
  if [ "$exit_code" -ne 0 ]; then
    echo "⚠ Claude exited non-zero on issue #$n: labeling needs-human + explanatory comment"
    local last_work
    last_work=$(git -C "$(worktree_dir_for "$n")" log --oneline -1 2>/dev/null || echo "sin commits")
    flag_needs_human "$n" "🤖 **El worker terminó de forma anormal** (salida ≠ 0). Causas probables: límite de cuota del plan, interrupción manual (Ctrl+C), o tope de turnos alcanzado.

**Trabajo parcial conservado** en el worktree \`impl-$n\`, último commit: \`$last_work\`. Nada se perdió.

**Para retomar** (cuando la causa esté resuelta, p. ej. la cuota repuesta):
\`\`\`
gh issue edit $n --remove-label needs-human --remove-label in-progress --add-label pending
\`\`\`
y después, en Claude, \`/fabrica:backlog\`. El nuevo worker puede continuar desde la rama existente."
  else
    check_worker_left_no_pr "$n"
  fi
}

# El auto-merge lo pone el orquestador, no el worker. Cuenta la etiqueta que
# tenía la issue antes de lanzarlo: si el agente se la pusiera él mismo, no
# vale. Tampoco si el Stop gate se rindió o la issue terminó en needs-human.
maybe_automerge() {  # issue number, labels at start (one per line)
  local n="$1" now
  printf '%s\n' "$2" | grep -qx auto-merge || return 0
  [ -f "$(worktree_dir_for "$n")/.factory/gate-gave-up" ] && return 0
  now=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null) || return 0
  printf '%s\n' "$now" | grep -qx needs-human && return 0
  automerge_issue "$n" || true
}

# Launches the worker for issue $1 in the background and sets WORKER_PID.
# Pulled out of main() so tests can drive it directly against a fake `claude`.
run_worker() {
  local n="$1" wt_dir fresh="" out
  wt_dir=$(worktree_dir_for "$n")
  [ -d "$wt_dir" ] || fresh=1
  ensure_worker_worktree "$n"
  copy_env_files "$n"
  [ -z "$fresh" ] || install_worktree_deps "$n"
  reset_gate_state "$n"
  # En un archivo y no en la terminal: el aviso de límite de uso sale ahí.
  # main() lo muestra cuando el worker termina; claude -p no escribe antes.
  out="$REPO_ROOT/$(worker_output_file "$n")"
  : > "$out"
  # Runs from inside the worktree instead of passing `--worktree` to claude,
  # so the branch name stays the one `ensure_worker_worktree` decided. `exec`
  # keeps $WORKER_PID pointing at the actual claude process, not the subshell.
  (
    cd "$wt_dir"
    # Los subagentes en primer plano: en segundo plano, el worker lanza al
    # revisor, termina su turno esperando la notificación y `claude -p` se
    # cierra sin la respuesta (probado el 2026-11-16).
    export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
    # hooks/worker-guard.sh: un worker no mergea ni empuja a la rama base.
    export FABRICA_WORKER=1
    # La base de la que se lee factory.json (lib/factory-config.sh).
    export FABRICA_BASE="$(base_branch)"
    # Ya reclamada y con su worktree: fabrica-claim no la vuelve a reclamar.
    export FABRICA_CLAIMED="$n"
    exec claude -p "$(bash "$SCRIPT_DIR/worker-prompt.sh" one "$n")" \
      --permission-mode "$PERMISSION_MODE" \
      --max-turns "$MAX_TURNS" \
      --model "$WORKER_MODEL" \
      --disallowedTools "$WORKER_DISALLOWED_TOOLS" \
      > "$out" 2>&1
  ) &
  WORKER_PID=$!
}

main() {
  check_plugin_ready || exit 1
  reconcile_board   # (must run after the function definitions above)

  trap cleanup INT TERM
  trap safety_net EXIT

  while [ "$PROCESSED" -lt "$MAX_ISSUES" ]; do
    WORKER_LAUNCHED=""
    TICKET_OUTCOME_RECORDED=""
    if ! N=$(next_issue); then
      echo "❌ No pude leer la cola. Processed: $PROCESSED"
      exit 1
    fi
    if [ -z "${N:-}" ]; then
      echo "✅ Backlog empty (no eligible pending issues). Processed: $PROCESSED"
      exit 0
    fi

    echo "▶ Processing issue #$N (attempt $((PROCESSED + 1))/$MAX_ISSUES)"

    # Claim-and-verify: grab the issue by assignee, re-read, and back off if
    # someone else (a teammate, the cloud) won the race.
    if ! claim_issue "$N"; then
      echo "⚔ #$N no se puede tomar (reclamada por otra persona, en curso o gh sin respuesta), la salto"
      SKIPPED="${SKIPPED:-} $N"
      PROCESSED=$((PROCESSED + 1))        # cuenta como intento: nunca bucle infinito
      sleep $((RANDOM % 8 + 3))           # jitter: rompe el ping-pong entre dos corredores
      continue
    fi

    # Deterministic bookkeeping: don't rely on the worker remembering to do it.
    START_LABELS=$(gh issue view "$N" --json labels -q '.labels[].name' 2>/dev/null || true)
    mark_in_progress "$N"

    run_worker "$N"
    WORKER_LAUNCHED=1

    # Heartbeat: while the worker runs, print elapsed time + latest commit on its
    # branch every 60s, so a quiet terminal never looks like a hung one.
    START_TS=$(date +%s)
    LAST_COMMIT=""
    LAST_ERR=0
    WT_DIR=$(worktree_dir_for "$N")
    while kill -0 "$WORKER_PID" 2>/dev/null; do
      sleep 60
      kill -0 "$WORKER_PID" 2>/dev/null || break
      ELAPSED_MIN=$(( ($(date +%s) - START_TS) / 60 ))
      if [ -d "$WT_DIR" ]; then
        copy_env_files "$N"
        # Read the worktree by its PATH, because workers name their branches freely.
        COMMIT=$(git -C "$WT_DIR" log --oneline -1 2>/dev/null || echo "(worktree sin commits aún)")
      else
        COMMIT="(worktree aún no creado)"
        if [ "$ELAPSED_MIN" -ge 5 ]; then
          COMMIT="$COMMIT ⚠ sin señales de arranque: posible límite de cuota o bloqueo. Considera Ctrl+C y procesar en modo interactivo"
        fi
      fi
      if [ "$COMMIT" != "$LAST_COMMIT" ]; then
        echo "  ⏱ ${ELAPSED_MIN}m · NUEVO: $COMMIT"
        LAST_COMMIT="$COMMIT"
      else
        # No new commit: mine every live signal available:
        # (a) what tool the worker is using right now (Claude Code session log)
        # (b) the most recently touched file and how long ago
        # (c) uncommitted work volume, and tool errors it is fighting through
        ACT=""; ERR=0
        SESS_FILE=$(latest_session_file "$N")
        if [ -n "$SESS_FILE" ]; then
          ACT=$(latest_worker_activity "$SESS_FILE")
          ERR=$(worker_tool_error_count "$SESS_FILE")
        fi
        AGO=""; AGOTXT=""
        TOUCH=$(latest_touched_file "$WT_DIR")
        if [ -n "$TOUCH" ]; then
          TSEC=${TOUCH%% *}; TFILE=${TOUCH#* }
          AGO=$(( $(date +%s) - ${TSEC%.*} ))
          AGOTXT="· ✍ ${TFILE:0:45} (hace ${AGO}s)"
        fi
        FILES=$(dirty_file_count "$WT_DIR")
        LINES=$(git -C "$WT_DIR" diff --shortstat 2>/dev/null | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
        LINE="  ⏱ ${ELAPSED_MIN}m · ${ACT:-trabajando} · $FILES arch, +$LINES líneas $AGOTXT"
        if [ "${ERR:-0}" -gt "$LAST_ERR" ]; then
          LINE="$LINE · ⚠ $((ERR - LAST_ERR)) errores nuevos de herramienta (iterando contra fallos)"
        fi
        LAST_ERR=${ERR:-0}
        echo "$LINE"
        if [ -n "${AGO:-}" ] && [ "$AGO" -gt 240 ]; then
          echo "  ⚠ sin actividad de archivos hace $((AGO / 60))m. Si persiste otros 5m, considera Ctrl+C y procesar en modo interactivo"
        fi
      fi
    done

    # `set -e` would otherwise abort the whole script on a non-zero wait, so
    # the exit status is captured through the if/else instead of `!`.
    if wait "$WORKER_PID"; then
      WORKER_EXIT_CODE=0
    else
      WORKER_EXIT_CODE=$?
    fi
    cat "$(worker_output_file "$N")" 2>/dev/null || true
    handle_worker_exit "$N" "$WORKER_EXIT_CODE"
    TICKET_OUTCOME_RECORDED=1
    if [ -n "${USAGE_LIMIT_HIT:-}" ]; then
      echo "⏸ Paro el lote por el límite de uso de la cuenta: $USAGE_LIMIT_HIT. Vuelve a correr fabrica-backlog después. Processed: $((PROCESSED + 1))"
      exit 0
    fi
    [ "$WORKER_EXIT_CODE" -eq 0 ] && maybe_automerge "$N" "$START_LABELS"

    PROCESSED=$((PROCESSED + 1))
  done

  echo "⏸ Reached MAX_ISSUES=$MAX_ISSUES. Remaining backlog stays for the next run."
}

# Sourced (e.g. from tests, to exercise cleanup()/reconcile_board() in
# isolation) vs executed directly: only the latter runs the backlog loop.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
