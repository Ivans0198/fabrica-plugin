#!/usr/bin/env bash
# Los plugins que el proyecto suma a la fábrica, de factory.json → extraPlugins.
# En el host los carga .claude/settings.json; la nube y el dev container los
# leen de aquí, porque allá solo se instalaba fabrica.
#
#   "extraPlugins": [
#     { "id": "expo@claude-plugins-official",
#       "marketplace": "https://github.com/anthropics/claude-plugins-official.git",
#       "ref": "<sha de 40 caracteres>",
#       "domains": ["mcp.expo.dev"] }
#   ]
#
# Usage: extra-plugins.sh plugins|marketplaces|domains|clone <carpeta>
#   plugins       un id por línea, para `plugins:` de claude-code-action
#   marketplaces  "<url> <ref>" por línea, sin repetir
#   domains       los dominios que necesitan (un MCP, por ejemplo), para el
#                 firewall del dev container
#   clone <dir>   clona cada marketplace en su commit dentro de <dir> e imprime
#                 la carpeta de cada uno, para `plugin_marketplaces:`
#
# El ref es un commit, no una rama: un cambio en el marketplace podía meter
# hooks nuevos que corren con los secretos de la nube (revisión del
# 2026-11-26). Todo se valida antes de imprimir: los valores terminan en
# argumentos de la action y en la lista del firewall. El marketplace va por
# https a GitHub, el único sitio de marketplaces que el firewall deja salir.
#
# Requires: jq, git.

set -euo pipefail

MODE="${1:-}"
FILE="${FACTORY_CONFIG_FILE:-factory.json}"

case "$MODE" in
  plugins | marketplaces | domains) ;;
  clone) [ -n "${2:-}" ] || { echo "uso: extra-plugins.sh clone <carpeta>" >&2; exit 2; } ;;
  *) echo "uso: extra-plugins.sh plugins|marketplaces|domains|clone <carpeta>" >&2; exit 2 ;;
esac

[ -f "$FILE" ] || exit 0

read_list() {  # modo
  # shellcheck disable=SC2016
  jq -r --arg mode "$1" '
    def fail(msg): error("factory.json → extraPlugins: " + msg);
    (.extraPlugins // []) as $list
    | if ($list | type) != "array" then fail("tiene que ser una lista") else . end
    | [ $list[] |
        if (.id | type) != "string" or (.id | test("\\A[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\\z") | not)
          then fail("id raro: \(.id | tojson). Va como nombre@marketplace")
        elif (.marketplace | type) != "string"
          or (.marketplace | test("\\Ahttps://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\z") | not)
          then fail("marketplace de \(.id): tiene que ser https://github.com/<dueño>/<repo>")
        elif (.ref | type) != "string" or (.ref | test("\\A[0-9a-f]{40}\\z") | not)
          then fail("ref de \(.id): tiene que ser el SHA completo de un commit del marketplace (git ls-remote <marketplace> HEAD)")
        elif (.domains // [] | type) != "array"
          then fail("domains de \(.id) tiene que ser una lista")
        elif any(.domains // [] | .[]; type != "string" or (test("\\A[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+\\z") | not))
          then fail("dominio raro en \(.id)")
        else . end ]
    # Sin repetir y en el orden de factory.json.
    | def distinct: reduce .[] as $x ([]; if index([$x]) then . else . + [$x] end);
      if $mode == "plugins" then .[].id
      elif $mode == "marketplaces" then map("\(.marketplace) \(.ref)") | distinct | .[]
      else map(.domains // [] | .[]) | distinct | .[]
      end
  ' "$FILE" 2> >(sed 's/^jq: error (at [^)]*): /❌ /' >&2)
}

if [ "$MODE" != clone ]; then
  read_list "$MODE"
  exit 0
fi

# clone: una carpeta por marketplace, en su commit.
list=$(read_list marketplaces)
[ -n "$list" ] || exit 0
mkdir -p "$2"
i=0
while read -r url ref; do
  i=$((i + 1))
  dest="$2/marketplace-$i"
  git clone --quiet "$url" "$dest"
  git -C "$dest" -c advice.detachedHead=false checkout --quiet "$ref"
  echo "$dest"
done <<< "$list"
