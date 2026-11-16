#!/usr/bin/env bash
# Corre un comando de factory.json por su nombre:
#
#   fabrica-cmd test
#
# Lo usan checks.yml y cualquiera que quiera correr exactamente lo mismo que
# corre el Stop gate. Sale con el código del comando. Si el comando está en
# null (el stack no tiene ese paso), lo dice y sale 0. Si factory.json falta o
# está mal, sale 4 explicando por qué.

set -o pipefail

# shellcheck source=lib/factory-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/factory-config.sh"

readonly CONFIG_ERROR_EXIT=4
NAME="${1:?uso: factory-cmd.sh <install|lint|typecheck|test|build|e2e>}"

if [ ! -f "$FACTORY_CONFIG_FILE" ]; then
  echo "factory-cmd: no hay $FACTORY_CONFIG_FILE en $(pwd). Corre /bootstrap primero." >&2
  exit "$CONFIG_ERROR_EXIT"
fi

factory_read_command "$NAME"
case $? in
  0)
    exec "${FACTORY_CMD[@]}"
    ;;
  3)
    echo "factory-cmd: commands.$NAME está en null en $FACTORY_CONFIG_FILE, así que no se corre."
    exit 0
    ;;
  *)
    echo "factory-cmd: $FACTORY_ERROR" >&2
    exit "$CONFIG_ERROR_EXIT"
    ;;
esac
