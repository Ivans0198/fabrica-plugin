#!/usr/bin/env bash
# Escribe en .devcontainer/ el contenedor desechable para correr los workers
# con bypassPermissions: Dockerfile, firewall, su lista de dominios y la
# configuración. La base viene del plugin; lo del lenguaje del proyecto entra
# por las opciones. Después los archivos son del proyecto: no los administra
# fabrica-setup.
#
# Usage: fabrica-devcontainer [--feature <id>]... [--domain <dominio>]... [--playwright] [--force]
#   --feature     una feature de dev containers, p. ej. ghcr.io/devcontainers/features/python:1
#   --domain      un dominio más al que el contenedor puede salir, p. ej. pypi.org
#   --playwright  Chromium y sus librerías en la imagen, en la versión de @playwright/test del proyecto
#   --force       reemplaza un .devcontainer/ que ya existe
#
# Si el package.json pide pnpm en packageManager, pnpm va en la imagen, en
# esa versión. Los dominios de factory.json → extraPlugins (el MCP de un
# plugin, por ejemplo) van al firewall.
#
# Requires: jq.

set -euo pipefail

TEMPLATES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates/.devcontainer" && pwd)"
DEST=.devcontainer

die() { echo "❌ $*" >&2; exit 1; }
usage() { sed -n 's/^# \{0,1\}//; 9,13p' "${BASH_SOURCE[0]}" >&2; exit 2; }

features=()
domains=()
force=""
playwright=""
while [ $# -gt 0 ]; do
  case "$1" in
    --feature)
      [[ "${2:-}" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]] || die "feature rara: '${2:-}'"
      features+=("$2"); shift 2 ;;
    --domain)
      [[ "${2:-}" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "dominio raro: '${2:-}'"
      domains+=("$2"); shift 2 ;;
    --playwright) playwright=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage ;;
    *) echo "❌ opción desconocida: $1" >&2; usage ;;
  esac
done

command -v jq >/dev/null || die "falta jq"
if [ -e "$DEST" ] && [ -z "$force" ]; then
  die "ya existe $DEST/: no lo piso. Para reemplazarlo, corre de nuevo con --force"
fi

# Chromium va en la imagen, que se construye con la red abierta: dentro, el
# firewall no deja usar apt, y la descarga de Chromium sale por IP de Google
# que rotan y el firewall no puede fijar. Tiene que ser la misma versión que
# usa el proyecto, porque cada versión de Playwright busca su propio Chromium.
pw_version=""
if [ -n "$playwright" ]; then
  pw_version=$(jq -r '.version // empty' node_modules/@playwright/test/package.json 2>/dev/null || true)
  [[ "$pw_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "--playwright necesita @playwright/test instalado: corre npm install (o pnpm install) antes"
fi

# pnpm también va en la imagen: dentro, el firewall no deja instalarlo. La
# versión es la de packageManager, sin el hash que agrega corepack.
pnpm_version=""
pm=$(jq -r '.packageManager // empty' package.json 2>/dev/null || true)
if [[ "$pm" == pnpm@* ]]; then
  pnpm_version=${pm#pnpm@}
  pnpm_version=${pnpm_version%%+*}
  [[ "$pnpm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "packageManager raro en package.json: '$pm'. Usa pnpm@<mayor.menor.parche>"
fi

# Los plugins extra del proyecto: se validan antes de escribir nada.
EXTRA="$(dirname "${BASH_SOURCE[0]}")/extra-plugins.sh"
extra_plugins=$(bash "$EXTRA" plugins) || exit 1
extra_marketplaces=$(bash "$EXTRA" marketplaces)
while IFS= read -r d; do
  [ -n "$d" ] && domains+=("$d")
done < <(bash "$EXTRA" domains)

mkdir -p "$DEST"
cp "$TEMPLATES/Dockerfile" "$DEST/Dockerfile"
if [ -n "$pnpm_version" ]; then
  block=$(cat <<EOF2
# pnpm, el de packageManager en package.json. Si cambias esa versión, cambia
# PNPM_VERSION y reconstruye.
ARG PNPM_VERSION=$pnpm_version
RUN npm install -g pnpm@\${PNPM_VERSION}
# Su caché va en un volumen (devcontainer.json): el proyecto está en otro
# sistema de archivos, y pnpm la dejaba dentro de la carpeta del proyecto.
RUN mkdir -p /home/node/.local/share/pnpm-store \\
  && chown -R node:node /home/node/.local

EOF2
)
  awk -v block="$block" '/^ENV DEVCONTAINER=true$/ { print block; print "" } { print }' \
    "$DEST/Dockerfile" > "$DEST/Dockerfile.tmp"
  mv "$DEST/Dockerfile.tmp" "$DEST/Dockerfile"
fi
if [ -n "$pw_version" ]; then
  block=$(cat <<EOF2
# Playwright: Chromium y sus librerías de sistema van en la imagen, que se
# construye con la red abierta. Dentro, el firewall no deja usar apt ni bajar
# Chromium. Si el proyecto cambia de versión de @playwright/test, cambia
# PLAYWRIGHT_VERSION y reconstruye: cada versión busca su propio Chromium.
ARG PLAYWRIGHT_VERSION=$pw_version
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@\${PLAYWRIGHT_VERSION} install --with-deps chromium \\
  && chmod -R a+rX /ms-playwright \\
  && rm -rf /var/lib/apt/lists/*

EOF2
)
  awk -v block="$block" '/^ENV DEVCONTAINER=true$/ { print block; print "" } { print }' \
    "$DEST/Dockerfile" > "$DEST/Dockerfile.tmp"
  mv "$DEST/Dockerfile.tmp" "$DEST/Dockerfile"
fi
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

# shellcheck disable=SC2016
jq --arg pnpm "$pnpm_version" --args '
  .features += (reduce $ARGS.positional[] as $f ({}; .[$f] = {}))
  | if $pnpm == "" then . else
      .mounts += ["source=fabrica-pnpm-${devcontainerId},target=/home/node/.local/share/pnpm-store,type=volume"]
      | .containerEnv.pnpm_config_store_dir = "/home/node/.local/share/pnpm-store"
    end' \
  "${features[@]+"${features[@]}"}" < "$TEMPLATES/devcontainer.json" > "$DEST/devcontainer.json"

echo "✓ $DEST/ escrito: Dockerfile, init-firewall.sh, allowed-domains.txt y devcontainer.json"
# La 0.80.0 de @devcontainers/cli se colgaba con Docker 29 después de
# "Container started", sin correr el firewall; npx usa la que tenga en caché.
echo "  Commitéalo. Para abrirlo: 'Reopen in Container' en VS Code, o"
echo "  npx -y @devcontainers/cli@0.91.0 up --workspace-folder ."
echo "  Fuera de VS Code, git no tiene tu identidad: fabrica-backlog la toma de gh, y a mano, fabrica-git-identity."
if [ -n "$extra_plugins" ]; then
  echo "  La primera vez dentro, además del plugin fabrica, instala los de extraPlugins:"
  i=0
  while read -r url ref; do
    case "$url" in
      https://github.com/anthropics/*)
        # Nombre reservado: Claude Code lo acepta solo desde GitHub, y `#ref`
        # no lleva un SHA. Se agrega y se deja en el commit antes de instalar;
        # la instalación copia esa versión a la caché.
        repo=${url#https://github.com/}
        repo=${repo%.git}
        mdir="~/.claude/plugins/marketplaces/${repo#*/}"
        echo "    claude plugin marketplace add $repo"
        echo "    git -C $mdir fetch -q origin $ref && git -C $mdir -c advice.detachedHead=false checkout -q $ref"
        ;;
      *)
        i=$((i + 1))
        echo "    git clone $url ~/.fabrica-marketplaces/$i && git -C ~/.fabrica-marketplaces/$i checkout $ref"
        echo "    claude plugin marketplace add ~/.fabrica-marketplaces/$i"
        ;;
    esac
  done <<< "$extra_marketplaces"
  while IFS= read -r p; do echo "    claude plugin install $p --scope project"; done <<< "$extra_plugins"
fi
