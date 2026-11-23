#!/usr/bin/env bash
# SessionStart: anota dónde estaba HEAD al empezar la sesión. El Stop gate no
# verifica una sesión que no cambió nada (una pregunta en un PR, una mención
# que solo responde): verificar la rama entera la atraparía en los checks de
# otro. La marca vive en el git-dir del checkout, por sesión, y nunca ensucia
# el árbol. Nunca bloquea.

[ -t 0 ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"
mark=$(git rev-parse --git-path "fabrica-session-$id" 2>/dev/null) || exit 0
git rev-parse HEAD > "$mark" 2>/dev/null || rm -f "$mark"
exit 0
