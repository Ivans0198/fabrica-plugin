#!/usr/bin/env bash
# El e2e nativo de la CI, dentro del emulador que levanta android-e2e.yml.
# En truckconnect-mobile #16 la app se caía al arrancar en Hermes y nada del
# gate lo veía: jest corre en Node y `expo export` compila sin correr el
# bundle (2026-11-26).
#
# La app ya viene compilada (commands.androidBuild, antes del emulador: las
# dos cosas juntas dejaron al runner sin recursos). Aquí, con fabrica-cmd:
#   instala el APK de factory.json → androidApk
#   androidServe   el servidor de desarrollo, en primer plano (p. ej. Metro)
#   androidE2e     los flows (p. ej. Maestro)
#
# Entre el servidor y los flows espera a que responda en
# http://localhost:<puerto>/status. Deja en <carpeta de logs> el log del
# servidor y el logcat del emulador.
#
# Usage: scripts/android-e2e.sh <apk> <carpeta de logs>
#   FABRICA_ANDROID_PORT          puerto del servidor (8081)
#   FABRICA_ANDROID_SERVER_WAIT   segundos de espera al servidor (180)
#
# Requires: fabrica-cmd, curl y adb en el PATH.

set -euo pipefail

APK="${1:?uso: android-e2e.sh <apk> <carpeta de logs>}"
LOGS="${2:?uso: android-e2e.sh <apk> <carpeta de logs>}"
PORT="${FABRICA_ANDROID_PORT:-8081}"
WAIT="${FABRICA_ANDROID_SERVER_WAIT:-180}"
POLL="${FABRICA_ANDROID_POLL:-2}"
mkdir -p "$LOGS"

server=""
finish() {
  # El servidor en su propio grupo: matarlo a él solo dejaba vivo a node.
  [ -z "$server" ] || kill -TERM -- "-$server" 2>/dev/null || kill -TERM "$server" 2>/dev/null || true
  adb logcat -d > "$LOGS/logcat.txt" 2>/dev/null || true
}
trap finish EXIT

if [ ! -f "$APK" ]; then
  echo "❌ No está el APK en $APK. commands.androidBuild tiene que dejarlo ahí, o factory.json → androidApk tiene que decir dónde queda." >&2
  exit 1
fi
adb install -r "$APK"

setsid fabrica-cmd androidServe > "$LOGS/server.log" 2>&1 < /dev/null &
server=$!

start=$SECONDS
until curl -fs "http://localhost:$PORT/status" 2>/dev/null | grep -q running; do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "❌ El servidor de desarrollo (commands.androidServe) se cerró antes de responder:" >&2
    tail -20 "$LOGS/server.log" >&2
    exit 1
  fi
  if [ $((SECONDS - start)) -ge "$WAIT" ]; then
    echo "❌ El servidor de desarrollo no respondió en http://localhost:$PORT/status en ${WAIT}s. Su log:" >&2
    tail -20 "$LOGS/server.log" >&2
    exit 1
  fi
  sleep "$POLL"
done
echo "✓ Servidor de desarrollo arriba en el puerto $PORT"

# El bundle se arma antes de los flows, con el emulador quieto. Armarlo
# cuando la app lo pedía, con 2 núcleos, dejó al emulador sin CPU y los tres
# flows en rojo (PR #21 de truckconnect-mobile, 2026-11-26). La URL sale del
# manifiesto de Expo; con otro servidor, se salta.
bundle=$(curl -fs -m 30 -H "expo-platform: android" -H "accept: application/expo+json" \
  "http://localhost:$PORT/" 2>/dev/null | jq -r '.launchAsset.url // empty' 2>/dev/null || true)
if [ -z "$bundle" ]; then
  echo "⚠ El servidor no dio el manifiesto de Expo: no armo el bundle antes de los flows." >&2
else
  echo "::group::Arma el bundle"
  started=$SECONDS
  if curl -fs -m "${FABRICA_ANDROID_BUNDLE_WAIT:-900}" -o /dev/null "$bundle"; then
    echo "✓ Bundle armado en $((SECONDS - started))s"
  else
    echo "⚠ No pude armar el bundle antes de los flows; la app lo pedirá al arrancar." >&2
  fi
  echo "::endgroup::"
fi

fabrica-cmd androidE2e
