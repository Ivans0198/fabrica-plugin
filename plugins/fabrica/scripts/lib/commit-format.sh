#!/usr/bin/env bash
# Conventional Commits, si factory.json → commitFormat es "conventional". Lo
# usan el Stop gate (los commits que nunca se subieron) y hooks/commit-format.sh
# (los que un git push está por subir): los dos miran solo commits que todavía
# se pueden reescribir sin --force. Se carga con `source`, después de
# lib/factory-config.sh.

COMMIT_FORMAT_TYPES="feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"

commit_format_enabled() {
  [ "$(factory_read_value commitFormat 2>/dev/null)" = conventional ]
}

# Desde dónde mirar: lo que ya tiene la rama remota, o, si la rama no se subió
# nunca, el punto donde salió de la base. Vacío si no hay ninguno.
commit_format_since() {
  local base
  git rev-parse -q --verify '@{upstream}' 2>/dev/null && return 0
  base=$(factory_read_value baseBranch 2>/dev/null)
  git merge-base HEAD "origin/${base:-main}" 2>/dev/null || true
}

# Imprime los encabezados que no cumplen, uno por línea. Los merges son de git.
commit_format_bad() {  # since
  git log --no-merges --format=%s "$1..HEAD" 2>/dev/null | tr -d '\r' \
    | awk -v re="^(${COMMIT_FORMAT_TYPES})(\\\\([a-z0-9._/-]+\\\\))?!?: [^ ]" \
        '!($0 ~ re) || length($0) > 100' \
    | sort -u
}

commit_format_help() {  # since
  cat <<EOF
Write each subject as type(scope): description, in English, at most 100 characters. Types: ${COMMIT_FORMAT_TYPES//|/, }; add ! before the colon for a breaking change. Example: feat(orders): accept an order from its detail.
They are not pushed yet, so rewriting them needs no --force: for the last one, git commit --amend -m "<new subject>"; for several, git reset --soft $1 and commit again.
EOF
}
