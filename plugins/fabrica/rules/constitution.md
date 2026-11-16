## Core principles

### I. Test-first (NON-NEGOTIABLE)

Tests are written first, from the acceptance scenarios, and confirmed failing
before the code that makes them pass. Every user story MUST have its own
"Tests for User Story N" tasks in `tasks.md`, listed before its implementation
tasks. A story without test tasks is not ready to be planned into issues.
In Setup and Foundational too, a task that writes logic comes after the task
that writes its failing test. Tasks that only configure (create folders,
install dependencies, write config files) need no test.

### II. Independently deliverable stories

Each user story MUST be buildable, testable and mergeable on its own, in its
own pull request. Work that every story needs goes to Setup + Foundational;
work that only makes sense after all of them goes to Polish. A story that
needs another story first says so as a dependency.

### III. The approved spec is fixed while it is being built

The merge of the spec pull request approves the spec, the plan and the tasks.
While the stories are being built, nobody changes them silently: work that
needs a different spec stops and asks a human.

### IV. The stack profile is binding

The stack profile below holds the project's clean code standards. A rule
marked (mandatory) is a gate for the plan: a plan that breaks it MUST justify
it in Complexity Tracking or change.
