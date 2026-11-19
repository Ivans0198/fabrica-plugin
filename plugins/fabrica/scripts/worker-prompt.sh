#!/usr/bin/env bash
# El prompt con el que se despacha un worker sin supervisión: el de
# process-backlog.sh y el de claude-backlog.yml.
#
#   worker-prompt.sh one N      una issue
#
# Solo despacha. El ciclo entero vive en las reglas ("Issue lifecycle" de
# .factory/rules/fabrica.md, importado desde CLAUDE.md): un prompt que lo
# vuelve a contar termina diciendo otra cosa. Cada uno empieza como lo citan
# las reglas en "Autonomy boundary", para que el modelo lo reconozca como un
# despacho.

set -euo pipefail

number() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || { echo "❌ '${1:-}' no es un número" >&2; exit 64; }
  printf '%s' "$1"
}

case "${1:-}" in
  one)
    n=$(number "${2:-}")
    cat <<EOF
Process GitHub issue #$n following the issue lifecycle in CLAUDE.md, every step in order. Claim it with \`fabrica-claim $n\` and work in the path it prints. The reviewer models and the UI-review policy are in factory.json. Finish with a draft PR whose body says "Closes #$n", and check it with \`fabrica-check-done $n\`. If you are blocked, or a reviewer still has open Blocker or Major findings after round 3, give up with \`fabrica-release $n --needs-human "<why>"\`.
EOF
    ;;
  *)
    sed -n '5p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
    exit 64
    ;;
esac
