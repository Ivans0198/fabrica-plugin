# fabrica

Plugin de Claude Code que trabaja la cola de issues de un repo de GitHub:
toma un issue, escribe los tests primero, implementa hasta que pasan, se hace
revisar por un agente revisor y abre un PR en borrador. Una persona aprueba
los planes y mergea.

La guía de uso paso a paso está en
[`plugins/fabrica/docs/GUIA-DE-LA-FABRICA.md`](plugins/fabrica/docs/GUIA-DE-LA-FABRICA.md).
Este README es la referencia técnica.

## Qué trae

| Pieza                     | Dónde                                       | Qué hace                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stop gate                 | `hooks/stop-gate.sh`                        | Al final de cada turno corre los comandos de `factory.json`. Con alguno en rojo, no deja terminar.                                                                                                                       |
| Formato al editar         | `hooks/post-edit-lint.sh`                   | Formatea cada archivo editado según `factory.json` → `format`.                                                                                                                                                           |
| Revisores                 | `agents/code-reviewer.md`, `ui-reviewer.md` | `fabrica:code-reviewer` y `fabrica:ui-reviewer`: contexto limpio, hallazgos Blocker, Major o Minor.                                                                                                                      |
| Skills                    | `skills/`                                   | `fabrica:bootstrap`, `fabrica:spec`, `plan`, `tasks`, `issues`, `fabrica:write-ticket`, `fabrica:backlog`.                                                                                                               |
| Reglas                    | `rules/fabrica.md`, `rules/stacks/`         | Ciclo del issue, Definition of Done y perfiles de stack. `init` las copia a `.factory/rules/`.                                                                                                                           |
| Spec Kit                  | `speckit-bundle/`                           | Spec Kit 1.2.2 de `github/spec-kit` (MIT), con sus comandos en `commands/`. No son skills: solo los siguen `fabrica:spec`, `plan` y `tasks`. Nadie lo instala.                                                           |
| Comandos para el modelo   | `bin/`                                      | `fabrica-cmd`, `fabrica-task-status`, `fabrica-setup`, `fabrica-backlog`, los de la cola (`fabrica-next-issue`, `fabrica-claim`, `fabrica-release`, `fabrica-check-done`, `fabrica-cleanup`) y otros. Quedan en su PATH. |
| Archivos de cada proyecto | `templates/`                                | Lo que `init` escribe en el proyecto: `CLAUDE.md`, `factory.json`, permisos y llamadas a los workflows.                                                                                                                  |
| Reusable workflows        | `.github/workflows/` (raíz de este repo)    | Checks, la fábrica en la nube, menciones a `@claude`, etiquetas y líneas base visuales.                                                                                                                                  |

## Instalar

Una vez por máquina, registra el marketplace:

```bash
claude plugin marketplace add <URL o ruta de este repo>
```

En cada proyecto, desde la raíz del repo:

```bash
claude plugin install fabrica@fabrica-local --scope project
claude "/fabrica:bootstrap una app de ... con ..."
```

`/fabrica:bootstrap` corre `fabrica-setup init`, arma el esqueleto con TDD,
ajusta `factory.json` y verifica que los comandos funcionen. Nunca empieza a
trabajar issues.

## Qué queda en cada proyecto

| Archivo                   | Para qué                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`               | Lo propio del proyecto. Importa las reglas con `@.factory/rules/fabrica.md`.                                                                                                                                        |
| `factory.json`            | Comandos como listas sin shell, formato, modelos, `appUrl`, `commands.dev`, `factoryEpic`, `docLang`.                                                                                                               |
| `.claude/settings.json`   | Permisos: niega los `.env` reales, `git push --force` y `sudo`. `claude plugin install --scope project` le agrega el `enabledPlugins` que activa el plugin, y va commiteado: los workers lo leen del último commit. |
| `.factory/`               | `rules/`, `version` y `manifest.json` se commitean. El resto es estado de las corridas y queda ignorado.                                                                                                            |
| `.github/workflows/*.yml` | Llamadas cortas a los reusable workflows de este repo, con el tag de la versión instalada.                                                                                                                          |
| `specs/<N>-<nombre>/`     | Spec, plan y tareas de cada feature, con N el número de su épica. Se commitean: el merge de su PR es la aprobación.                                                                                                 |
| `.specify/`               | Spec Kit y la constitución, armados en cada máquina por `fabrica-setup speckit`. No se commitea.                                                                                                                    |

## `fabrica-setup`

| Comando   | Qué hace                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | Primera vez. Escribe los archivos del proyecto sin pisar los que existen, y las copias administradas con su hash en el manifiesto.                                                                                                                                                       |
| `check`   | Falla si el proyecto está en otra versión que el plugin, si queda un `.fabrica-new` sin combinar o si una llamada a un workflow apunta a otra versión. Lo corre `process-backlog` antes de lanzar workers, y además exige que la configuración de la fábrica esté subida a la rama base. |
| `refresh` | Lleva las copias administradas a la versión del plugin. Si alguien editó una a mano, deja la nueva en `<archivo>.fabrica-new`.                                                                                                                                                           |
| `speckit` | Arma `.specify/`: Spec Kit, la constitución (TDD y el perfil del stack) y la plantilla de tareas con tests obligatorios. Solo lo rehace si cambió la versión, el stack o el perfil. Lo corren los pasos de planeación.                                                                   |

Otros dos comandos de la planeación: `fabrica-feature` deduce la carpeta de
la feature de la rama `spec-<N>`, y `fabrica-create-issues` crea las issues
de una spec mergeada a partir del JSON que aprobó una persona.

`init` sobre un proyecto creado con `fabrica-template` lo migra. Se niega si
hay cambios sin commitear. Borra la maquinaria copiada (lista exacta en
`scripts/legacy-template-files.txt`), mueve `rules/stacks` a
`.factory/rules/stacks` y deja en `CLAUDE.md`, `settings.json` y
`package.json` solo lo del proyecto. Commitea todo junto: así no corren dos
Stop gates.

## La nube

Cada proyecto pasa sus secretos a los workflows de backlog y menciones con
`secrets: inherit`:

| Secreto                   | Para qué                                                                  |
| ------------------------- | ------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | El cron nocturno.                                                         |
| `CLAUDE_TOKEN_<USUARIO>`  | El token de cada persona, buscado por su usuario de GitHub en mayúsculas. |
| `ANTHROPIC_API_KEY`       | Opcional: API key de equipo, si una persona no tiene token propio.        |
| `FABRICA_PLUGIN_TOKEN`    | Solo si este repo es privado: un token que pueda leerlo.                  |

El reusable trae el plugin en el tag de la llamada y la Action lo instala
desde esa copia. Si este repo es privado, además hay que darle acceso a sus
workflows desde la configuración de Actions del repo.

## Desarrollo

```bash
npm install
npm test
```

Los tests del kit cubren hooks, scripts, reglas, agentes, skills y el
contrato entre las llamadas de los proyectos y los reusable workflows. Corren
en este repo (`kit.yml`), no en cada proyecto. Una versión nueva cambia
`plugins/fabrica/.claude-plugin/plugin.json` → `version` y se publica con el
tag `v<versión>`, que es el que usan las llamadas a los workflows.
