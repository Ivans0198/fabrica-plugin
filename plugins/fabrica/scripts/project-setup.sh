#!/usr/bin/env bash
# One-time per repo: discovers the GitHub Projects v2 IDs (project, Status field,
# status options) and caches them in .plan/project.json so the agent never has
# to touch GraphQL node IDs again.
#
# Las reglas mandan las tarjetas a Blocked, y un Project nuevo solo trae Todo,
# In Progress y Done: si falta, la crea. GitHub reemplaza entonces todas las
# opciones, con IDs nuevos, y los workflows del Project que ya apuntaban a
# una quedan en "A value is required" hasta que alguien la vuelve a elegir.
#
# Usage:
#   bash scripts/project-setup.sh <owner> <project-number>          # user project
#   bash scripts/project-setup.sh <owner> <project-number> --org    # org project
#
# Requires: gh (with the 'project' scope!), jq.

set -euo pipefail

OWNER="${1:?usage: project-setup.sh <owner> <project-number> [--org]}"
NUMBER="${2:?usage: project-setup.sh <owner> <project-number> [--org]}"
SCOPE_TYPE="user"; [ "${3:-}" = "--org" ] && SCOPE_TYPE="organization"

# Classic 403 trap: the 'project' scope is separate and easy to miss.
if ! gh auth status 2>&1 | grep -qE "['\", ]project"; then
  echo "⚠ Tu sesión de gh no tiene el permiso 'project'. En una terminal aparte:" >&2
  echo "    gh auth refresh -h github.com -s project,repo" >&2
  exit 1
fi

QUERY='query($owner:String!,$number:Int!){ '"$SCOPE_TYPE"'(login:$owner){ projectV2(number:$number){ id title fields(first:30){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name color description } } } } } } }'
JSON=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -F number="$NUMBER")

PROJECT_ID=$(echo "$JSON" | jq -r ".data.$SCOPE_TYPE.projectV2.id")
TITLE=$(echo "$JSON" | jq -r ".data.$SCOPE_TYPE.projectV2.title")
STATUS_FIELD=$(echo "$JSON" | jq ".data.$SCOPE_TYPE.projectV2.fields.nodes[] | select(.name==\"Status\")")

[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || { echo "Project #$NUMBER not found for $SCOPE_TYPE '$OWNER'." >&2; exit 1; }
[ -n "$STATUS_FIELD" ] || { echo "No 'Status' single-select field found on the project." >&2; exit 1; }

added_blocked=""
if ! echo "$STATUS_FIELD" | jq -e '.options | any(.name == "Blocked")' >/dev/null; then
  # La lista entera, porque la mutación reemplaza todas las opciones. Los
  # textos van con tojson: un nombre con comillas no rompe la consulta.
  OPTIONS=$(echo "$STATUS_FIELD" | jq -r '
    [ (.options[] | {name, color, description: (.description // "")}),
      {name: "Blocked", color: "RED", description: "needs-human o blocked-by-N"} ]
    | map("{name:\(.name | tojson),color:\(.color),description:\(.description | tojson)}")
    | join(",")')
  gh api graphql -f query="mutation(\$f:ID!){ updateProjectV2Field(input:{fieldId:\$f, singleSelectOptions:[$OPTIONS]}){ projectV2Field{ ... on ProjectV2SingleSelectField { id } } } }" \
    -f f="$(echo "$STATUS_FIELD" | jq -r .id)" >/dev/null
  JSON=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -F number="$NUMBER")
  STATUS_FIELD=$(echo "$JSON" | jq ".data.$SCOPE_TYPE.projectV2.fields.nodes[] | select(.name==\"Status\")")
  added_blocked=1
fi

mkdir -p .plan
jq -n \
  --arg owner "$OWNER" \
  --argjson number "$NUMBER" \
  --arg projectId "$PROJECT_ID" \
  --arg statusFieldId "$(echo "$STATUS_FIELD" | jq -r .id)" \
  --argjson statusOptions "$(echo "$STATUS_FIELD" | jq '[.options[] | {(.name): .id}] | add')" \
  '{owner:$owner, projectNumber:$number, projectId:$projectId, statusFieldId:$statusFieldId, statusOptions:$statusOptions}' \
  > .plan/project.json

echo "✓ Cached .plan/project.json for \"$TITLE\" (#$NUMBER, $OWNER)"
echo "  Statuses: $(jq -r '.statusOptions | keys | join(", ")' .plan/project.json)"
[ -z "$added_blocked" ] || echo "  + Blocked, la columna de needs-human y blocked-by-N"
echo ""
echo "Ahora, una sola vez, en la página del Project: botón Workflows (arriba a la"
echo "derecha, junto a Insights). En cada uno: Edit, elige el valor y"
echo "'Save and turn on workflow':"
echo "  • Item added to project  → Todo"
echo "  • Item closed            → Done"
echo "  • Pull request merged    → Done"
if [ -n "$added_blocked" ]; then
  echo "Al crear Blocked, GitHub cambió los IDs de todas las opciones: un workflow"
  echo "que dice 'A value is required' solo necesita que elijas el valor de nuevo."
fi
echo "Después agrupa la vista por 'Parent issue' para ver cada épica con su avance."
echo "Con eso el agente solo escribe 'In Progress' y 'Blocked'; el resto lo hace GitHub."
