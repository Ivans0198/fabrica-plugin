#!/usr/bin/env bash
# Crea la épica de una spec: una issue con la etiqueta epic y nada más. Es lo
# que settings.json permite, en vez de `gh issue create` suelto: el modo auto
# negaba ese comando a veces, justo después del OK de la persona
# (truckconnect-mobile, 2026-11-26).
#
# Usage: fabrica-epic create "[Epic] <nombre>" <archivo-del-cuerpo>
# Imprime el número de la épica.

set -euo pipefail

die() { echo "❌ $*" >&2; exit 1; }

[ "${1:-}" = create ] || die "uso: fabrica-epic create \"[Epic] <nombre>\" <archivo-del-cuerpo>"
title="${2:-}"
body="${3:-}"
[[ "$title" == "[Epic] "?* ]] || die "el título empieza con \"[Epic] \": '$title'"
[[ "$title" != *$'\n'* ]] || die "el título va en una línea"
[ -f "$body" ] || die "no existe el archivo del cuerpo: '$body'"

gh label create epic --description "Épica: agrupa las issues de una spec" >/dev/null 2>&1 || true
url=$(gh issue create --title "$title" --body-file "$body" --label epic)
n="${url##*/}"
[[ "$n" =~ ^[0-9]+$ ]] || die "gh no devolvió el número de la issue: '$url'"
echo "$n"
