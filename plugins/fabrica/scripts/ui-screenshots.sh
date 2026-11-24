#!/usr/bin/env bash
# Capturas para el ui-reviewer: levanta el dev server con fabrica-ui-preflight,
# saca la página en los tres anchos de tests/ui.spec.ts y en los dos temas, y
# apaga el servidor aunque una captura falle. Todo en un solo proceso: un
# servidor que el agente levanta en una llamada no sobrevive a la siguiente.
#
# Usage:
#   fabrica-ui-screenshots                # la portada
#   fabrica-ui-screenshots --path /ruta   # otra pantalla
#
# Deja ui-<ancho>-<light|dark>.png en .factory/ui-screenshots/. Si las dos
# versiones de un ancho salen idénticas, el sitio no tiene tema oscuro: deja
# sólo la clara y lo dice. Usa el Playwright del proyecto (npx).

set -euo pipefail

PREFLIGHT="$(dirname "${BASH_SOURCE[0]}")/ui-preflight.sh"
OUT_DIR=".factory/ui-screenshots"
VIEWPORTS=("mobile 375,812" "tablet 768,1024" "desktop 1440,900")

die() { echo "ui-screenshots: $1" >&2; exit 1; }

capture_path="/"
if [ "$#" -gt 0 ]; then
  [ "$1" = "--path" ] || die "opción desconocida: $1. La única es --path <ruta>."
  [ "$#" -eq 2 ] || die "--path necesita una ruta y nada más, por ejemplo --path /contacto."
  capture_path="$2"
  [[ "$capture_path" == /* ]] || capture_path="/$capture_path"
fi

url=$(bash "$PREFLIGHT" up) || exit 1
trap 'bash "$PREFLIGHT" down >/dev/null 2>&1 || true' EXIT
page="${url%/}$capture_path"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.png

written=()
single_theme=""
for entry in "${VIEWPORTS[@]}"; do
  name="${entry%% *}"
  size="${entry#* }"
  for theme in light dark; do
    npx playwright screenshot --full-page --viewport-size "$size" \
      --color-scheme "$theme" --wait-for-timeout 500 \
      "$page" "$PWD/$OUT_DIR/ui-$name-$theme.png" >/dev/null
  done
  if cmp -s "$OUT_DIR/ui-$name-light.png" "$OUT_DIR/ui-$name-dark.png"; then
    rm "$OUT_DIR/ui-$name-dark.png"
    single_theme=1
    written+=("ui-$name-light.png")
  else
    written+=("ui-$name-light.png" "ui-$name-dark.png")
  fi
done

echo "${#written[@]} capturas de $page en $OUT_DIR:"
printf '  %s\n' "${written[@]}"
if [ -n "$single_theme" ]; then
  echo "Sitio sin tema oscuro: el claro y el oscuro salen idénticos, quedan sólo las claras."
fi
