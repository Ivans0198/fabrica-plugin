#!/usr/bin/env bash
# Escribe en .devcontainer/ el contenedor desechable para correr los workers
# con bypassPermissions: Dockerfile, firewall, su lista de dominios y la
# configuración. La base viene del plugin; lo del lenguaje del proyecto entra
# por las opciones. Después los archivos son del proyecto: no los administra
# fabrica-setup.
#
# Usage: fabrica-devcontainer [--feature <id>]... [--domain <dominio>]... [--force]
#   --feature  una feature de dev containers, p. ej. ghcr.io/devcontainers/features/python:1
#   --domain   un dominio más al que el contenedor puede salir, p. ej. pypi.org
#   --force    reemplaza un .devcontainer/ que ya existe
#
# Requires: jq.

set -euo pipefail

TEMPLATES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates/.devcontainer" && pwd)"
DEST=.devcontainer

die() { echo "❌ $*" >&2; exit 1; }
usage() { sed -n 's/^# \{0,1\}//; 9,12p' "${BASH_SOURCE[0]}" >&2; exit 2; }

features=()
domains=()
force=""
while [ $# -gt 0 ]; do
  case "$1" in
    --feature)
      [[ "${2:-}" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]] || die "feature rara: '${2:-}'"
      features+=("$2"); shift 2 ;;
    --domain)
      [[ "${2:-}" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "dominio raro: '${2:-}'"
      domains+=("$2"); shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) usage ;;
    *) echo "❌ opción desconocida: $1" >&2; usage ;;
  esac
done

command -v jq >/dev/null || die "falta jq"
if [ -e "$DEST" ] && [ -z "$force" ]; then
  die "ya existe $DEST/: no lo piso. Para reemplazarlo, corre de nuevo con --force"
fi

mkdir -p "$DEST"
cp "$TEMPLATES/Dockerfile" "$DEST/Dockerfile"
cp "$TEMPLATES/init-firewall.sh" "$DEST/init-firewall.sh"
chmod 755 "$DEST/init-firewall.sh"

cp "$TEMPLATES/allowed-domains.txt" "$DEST/allowed-domains.txt"
extra=()
for d in "${domains[@]+"${domains[@]}"}"; do
  grep -qxF "$d" "$DEST/allowed-domains.txt" || extra+=("$d")
done
if [ "${#extra[@]}" -gt 0 ]; then
  printf '\n# Lo del proyecto\n' >> "$DEST/allowed-domains.txt"
  printf '%s\n' "${extra[@]}" | awk '!seen[$0]++' >> "$DEST/allowed-domains.txt"
fi

jq --args '.features += (reduce $ARGS.positional[] as $f ({}; .[$f] = {}))' \
  "${features[@]+"${features[@]}"}" < "$TEMPLATES/devcontainer.json" > "$DEST/devcontainer.json"

echo "✓ $DEST/ escrito: Dockerfile, init-firewall.sh, allowed-domains.txt y devcontainer.json"
echo "  Commitéalo. Para abrirlo: 'Reopen in Container' en VS Code, o 'devcontainer up --workspace-folder .'"
