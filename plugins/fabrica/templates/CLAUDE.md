# CLAUDE.md: {{PROJECT_NAME}}

<!-- Reemplaza los placeholders {{...}} al copiar esta plantilla a un repo.
     Replace the {{...}} placeholders when copying this template into a repo. -->

## Project

{{PROJECT_DESCRIPTION}}

Stack: {{STACK}} (default: Node.js + TypeScript). Its stack profile is
`.factory/rules/stacks/<stack>.md`, with `<stack>` taken from `factory.json`
→ `stack`.

## Project skills

| Skill                                   | Load it when…                  |
| --------------------------------------- | ------------------------------ |
| <!-- add project skills here, e.g.: --> |                                |
| <!-- `go-practices` -->                 | <!-- touching any .go file --> |

## Factory rules

The `fabrica` plugin runs this project. Its rules are below; they are a copy
that `fabrica-setup refresh` keeps up to date, so change them in the plugin,
not here.

@.factory/rules/fabrica.md
