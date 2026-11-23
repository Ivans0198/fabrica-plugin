#!/usr/bin/env bash
# Deterministic clean-up after every Edit/Write: runs the factory.json "format"
# rules whose extensions match the edited file (formatter, lint autofix...),
# with the file as the last argument.
# Non-blocking (exit 0 always): it fixes what it can and stays silent.
# The Stop gate is the blocking enforcement (it also reports broken rules).

# shellcheck source=../../scripts/lib/factory-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/factory-config.sh"

INPUT=$(cat)
factory_use_base_config
[ -f "$FACTORY_CONFIG_FILE" ] || exit 0

FILE=$(printf '%s' "$INPUT" | factory_query - hookpath "" | sed -n '2p')
[ -n "$FILE" ] && [ -f "$FILE" ] || exit 0

to_forward_slashes() { printf '%s' "${1//\\//}" | tr '[:upper:]' '[:lower:]'; }

# Spec Kit's documents (specs/, .specify/) are parsed by its scripts, which
# expect their exact layout: a formatter must not rewrite them.
PROJECT_ROOT=$(to_forward_slashes "${CLAUDE_PROJECT_DIR:-$(pwd -W 2>/dev/null || pwd)}")
RELATIVE=$(to_forward_slashes "$FILE")
RELATIVE="${RELATIVE#"$PROJECT_ROOT"/}"
case "$RELATIVE" in
  specs/* | .specify/*) exit 0 ;;
esac

BASENAME="${FILE##*[/\\]}"
case "$BASENAME" in
  *.*) EXTENSION="${BASENAME##*.}" ;;
  *) exit 0 ;;
esac

RULE=()
run_rule() {
  [ "${#RULE[@]}" -gt 0 ] && "${RULE[@]}" "$FILE" > /dev/null 2>&1 < /dev/null
  RULE=()
}

{
  IFS= read -r STATUS
  [ "$STATUS" = "@@set@@" ] || exit 0
  while IFS= read -r LINE; do
    if [ "$LINE" = "@@rule@@" ]; then
      run_rule
    else
      RULE+=("$LINE")
    fi
  done
  run_rule
} < <(factory_query "$FACTORY_CONFIG_FILE" format "$EXTENSION")

exit 0
