#!/usr/bin/env bash
# Los plugins que el proyecto suma a la fábrica, de factory.json → extraPlugins.
# En el host los carga .claude/settings.json; la nube y el dev container los
# leen de aquí, porque allá solo se instalaba fabrica.
#
#   "extraPlugins": [
#     { "id": "expo@claude-plugins-official",
#       "marketplace": "https://github.com/anthropics/claude-plugins-official.git",
#       "domains": ["mcp.expo.dev"] }
#   ]
#
# Usage: extra-plugins.sh plugins|marketplaces|domains
#   plugins       un id por línea, para `plugins:` de claude-code-action
#   marketplaces  sus marketplaces, sin repetir, para `plugin_marketplaces:`
#   domains       los dominios que necesitan (un MCP, por ejemplo), para el
#                 firewall del dev container
#
# Todo se valida antes de imprimir: los valores terminan en argumentos de la
# action y en la lista del firewall. El marketplace va por https a GitHub, el
# único sitio de marketplaces que el firewall deja salir.
#
# Requires: jq.

set -euo pipefail

MODE="${1:-}"
FILE="${FACTORY_CONFIG_FILE:-factory.json}"

case "$MODE" in
  plugins | marketplaces | domains) ;;
  *) echo "uso: extra-plugins.sh plugins|marketplaces|domains" >&2; exit 2 ;;
esac

[ -f "$FILE" ] || exit 0

# shellcheck disable=SC2016
jq -r --arg mode "$MODE" '
  def fail(msg): error("factory.json → extraPlugins: " + msg);
  (.extraPlugins // []) as $list
  | if ($list | type) != "array" then fail("tiene que ser una lista") else . end
  | [ $list[] |
      if (.id | type) != "string" or (.id | test("\\A[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\\z") | not)
        then fail("id raro: \(.id | tojson). Va como nombre@marketplace")
      elif (.marketplace | type) != "string"
        or (.marketplace | test("\\Ahttps://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\z") | not)
        then fail("marketplace de \(.id): tiene que ser https://github.com/<dueño>/<repo>")
      elif (.domains // [] | type) != "array"
        then fail("domains de \(.id) tiene que ser una lista")
      elif any(.domains // [] | .[]; type != "string" or (test("\\A[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+\\z") | not))
        then fail("dominio raro en \(.id)")
      else . end ]
  # Sin repetir y en el orden de factory.json.
  | def distinct: reduce .[] as $x ([]; if index([$x]) then . else . + [$x] end);
    if $mode == "plugins" then .[].id
    elif $mode == "marketplaces" then map(.marketplace) | distinct | .[]
    else map(.domains // [] | .[]) | distinct | .[]
    end
' "$FILE" 2> >(sed 's/^jq: error (at [^)]*): /❌ /' >&2)
