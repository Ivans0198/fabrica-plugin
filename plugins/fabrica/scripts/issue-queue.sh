#!/usr/bin/env bash
# Comandos de la cola para la sesión interactiva. Hacen lo mismo que
# process-backlog.sh antes y después de lanzar un worker, para que esas
# garantías no dependan de que el modelo se acuerde.
#
#   issue-queue.sh next                         la siguiente issue elegible
#   issue-queue.sh claim N                      reclama N y prepara su worktree
#   issue-queue.sh release N --pending          devuelve N a la cola
#   issue-queue.sh release N --needs-human "m"  marca N para una persona
#   issue-queue.sh done N                       ¿N ya tiene un PR que la cierre?
#   issue-queue.sh cleanup [--dry-run]          borra worktrees de issues cerradas
#   issue-queue.sh eligible N --actor U         ¿la nube puede tomar N por pedido de U?
#   issue-queue.sh automerge N                  auto-merge en el PR de N, si tiene la etiqueta
#
# Los llaman fabrica-next-issue, fabrica-claim, fabrica-release,
# fabrica-check-done, fabrica-cleanup, fabrica-eligible y fabrica-automerge. La salida útil va a stdout; los avisos, a stderr.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "❌ $*" >&2; exit 1; }
usage() {
  sed -n '6,12p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 64
}

command -v gh >/dev/null || die "Falta 'gh' (GitHub CLI). Instálalo y corre 'gh auth login'"
command -v jq >/dev/null || die "Falta 'jq'"

# La raíz del checkout principal, aunque se llame desde un worktree: los
# worktrees de las issues viven todos en <raíz>/.claude/worktrees/.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || die "No estás dentro de un repo git. Corre esto desde la carpeta del proyecto"
ROOT=$(dirname "$common")
cd "$ROOT"

PLUGIN_ROOT="${FABRICA_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ONLY_LABEL="${ONLY_LABEL:-}"
ONLY_MINE="${ONLY_MINE:-}"
# shellcheck source=lib/factory-config.sh
source "$SCRIPT_DIR/lib/factory-config.sh"
# shellcheck source=lib/backlog-queue.sh
source "$SCRIPT_DIR/lib/backlog-queue.sh"
ME=$(gh api user --jq .login 2>/dev/null || echo "")

issue_number() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || { echo "❌ '${1:-}' no es un número de issue" >&2; usage; }
  printf '%s' "$1"
}

case "${1:-}" in
  next)
    reconcile_board >&2
    n=$(next_issue) || exit 3
    [ -n "$n" ] || { echo "No hay issues elegibles en la cola." >&2; exit 1; }
    echo "$n"
    ;;
  claim)
    n=$(issue_number "${2:-}")
    check_setup_on_base || exit 1
    rc=0
    claim_issue "$n" || rc=$?
    if [ "$rc" -eq 2 ]; then
      echo "⚔ #$n no se puede tomar: ya la reclamó otra persona o está en curso." >&2
    fi
    [ "$rc" -eq 0 ] || exit "$rc"
    mark_in_progress "$n"
    if [ "${GITHUB_ACTIONS:-}" = true ]; then
      # El runner es desechable y no tiene EnterWorktree: rama en el lugar.
      ensure_branch_in_place "$n" >&2
      rm -f .factory/state/stop-gate-count .factory/gate-gave-up
      echo "$ROOT"
    else
      ensure_worker_worktree "$n" >&2
      copy_env_files "$n"
      reset_gate_state "$n"
      echo "$ROOT/$(worktree_dir_for "$n")"
    fi
    ;;
  release)
    n=$(issue_number "${2:-}")
    case "${3:-}" in
      --pending) release_to_queue "$n" ;;
      --needs-human)
        [ -n "${4:-}" ] || die "Falta el motivo: fabrica-release $n --needs-human \"motivo\""
        flag_needs_human "$n" "🤖 **Necesita a una persona.** $4"
        ;;
      *) usage ;;
    esac
    ;;
  eligible)
    n=$(issue_number "${2:-}")
    [ "${3:-}" = --actor ] && [ -n "${4:-}" ] || usage
    rc=0
    issue_eligible_for "$n" "$4" || rc=$?
    exit "$rc"
    ;;
  cleanup)
    case "${2:-}" in
      "") cleanup_worktrees ;;
      --dry-run) cleanup_worktrees dry-run ;;
      *) usage ;;
    esac
    ;;
  automerge)
    n=$(issue_number "${2:-}")
    rc=0
    automerge_issue "$n" || rc=$?
    exit "$rc"
    ;;
  done)
    n=$(issue_number "${2:-}")
    pr_declares_closes "$n" || { echo "#$n no tiene un PR con \"Closes #$n\" en su descripción." >&2; exit 1; }
    echo "✅ #$n tiene un PR con \"Closes #$n\" en su descripción."
    ;;
  *) usage ;;
esac
