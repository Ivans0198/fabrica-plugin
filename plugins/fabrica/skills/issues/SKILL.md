---
name: issues
description: Crea las issues de una feature ya aprobada (spec mergeada) y las encola encadenadas. Último paso de la planeación (spec → plan → tasks → issues). Solo en una sesión con una persona, y solo con su OK.
argument-hint: "<número de la épica>"
disable-model-invocation: true
---

# Crear las issues de una feature

Va después del merge del PR de la spec. Necesita a una persona en la sesión:
si te llegó por un worker headless o por una mención `@claude`, responde que
crear issues de planeación se hace en una sesión interactiva y para. El
script que las crea también se niega a correr en CI o en un worktree.

## 1. Estar sobre la spec aprobada

```bash
fabrica-setup check
git fetch origin <base>
git switch <base> && git pull --ff-only
fabrica-setup speckit
fabrica-feature <N>
```

`<base>` es `factory.json` → `baseBranch` (`main` si falta) y N, el número de
la épica. Si `fabrica-feature` no encuentra la carpeta, el PR de la spec
todavía no está mergeado: dilo y para.

## 2. Armar el JSON

Lee `spec.md`, `plan.md` y `tasks.md` de la carpeta y escribe
`.factory/state/issues-<N>.json`:

```json
{
  "epic": 12,
  "featureDir": "specs/12-favoritos",
  "issues": [
    {
      "key": "setup",
      "phase": "setup",
      "title": "...",
      "body": "...",
      "priority": "high",
      "size": "S",
      "dependsOn": [],
      "tasks": ["T001", "T004"]
    },
    {
      "key": "US1",
      "phase": "story",
      "story": "US1",
      "title": "...",
      "body": "...",
      "priority": "high",
      "size": "M",
      "dependsOn": ["setup"],
      "tasks": ["T010", "T012"]
    },
    {
      "key": "polish",
      "phase": "polish",
      "title": "...",
      "body": "...",
      "priority": "low",
      "size": "S",
      "dependsOn": ["US1"],
      "tasks": ["T030"]
    }
  ]
}
```

- **Una issue por historia**, con su clave igual a la historia (`US1`). Su
  prioridad sale de P1/P2/P3 (high, medium, low).
- **Setup + Foundational** en una issue si `tasks.md` tiene tareas ahí, o en
  varias (`setup`, `setup-2`, …, todas con `"phase": "setup"`) si pasan de 12
  tareas: ninguna issue lleva más de 12 tareas. Cada una depende de la
  anterior si hace falta, y todas las historias dependen de todas. El script
  les da la prioridad más alta de sus historias.
- **Una issue de Polish**, que depende de todas las historias.
- Una historia que depende de otra lo dice en `dependsOn`. También cuando
  `tasks.md` pone a dos historias en paralelo pero sus tareas nombran el mismo
  archivo: el script rechaza ese plan, porque sus PRs chocarían. Pregúntale a
  la persona cuál va primero.
- `tasks` lleva los IDs de las tareas de esa issue, incluidas sus tareas de
  test.
- Tamaño S (hasta 2 horas) o M (hasta un día). Una L se parte en la spec antes
  de crear nada.
- **El cuerpo** sigue la plantilla de `fabrica:write-ticket`, en el idioma de
  `factory.json` → `docLang`: contexto con la carpeta de la spec, los
  Acceptance Scenarios de la historia como checklist, los tests esperados con
  sus casos borde, lo que queda fuera de alcance, y mockup y pantallas si hay
  interfaz. No escribas las marcas `fabrica-key` ni `fabrica-spec`: las pone el
  script.

## 3. La tabla y el OK

Calcula la huella del JSON (`sha256sum .factory/state/issues-<N>.json`, o
`shasum -a 256` en macOS) y muestra:

| clave | título | fase | prioridad | tamaño | depende de | tareas | etiquetas sugeridas |
| ----- | ------ | ---- | --------- | ------ | ---------- | ------ | ------------------- |

En "etiquetas sugeridas" van `auto-merge` y `ui-review` cuando corresponda,
con una línea de por qué. `auto-merge` solo para trabajo mecánico y bien
cercado por tests: reestructurar datos, estilos cubiertos por líneas base,
refactors sin cambio de comportamiento, documentación. Nunca para
autenticación, permisos, pagos, borrado de datos ni lógica de negocio nueva.
`ui-review` cuando la historia cambia la interfaz.

Debajo de la tabla, la huella completa y las `@menciones` que haya en los
cuerpos, porque notifican a personas reales. Después espera el OK. Si la
persona pide cambios, cambia el JSON, recalcula la huella y vuelve a mostrar
la tabla.

## 4. Crear

Con el OK, y con la huella que viste en la tabla:

```bash
fabrica-create-issues .factory/state/issues-<N>.json --approved <huella>
```

El script valida todo antes de tocar GitHub, crea las issues con sus
`blocked-by-N`, las cuelga de la épica, las pone en el tablero y recién al
final las encola. Si se corta, se vuelve a correr igual y no duplica nada. Si
falla, muestra su mensaje: no crees issues a mano para completar.

El script nunca pone `auto-merge` ni `ui-review`; las pones tú después de
crearlas (`gh issue edit <n> --add-label ui-review`):

- Si la persona aprueba la tabla, pon `ui-review` en las issues donde la tabla
  la sugería, salvo que haya dicho otra cosa. Aprobar la tabla es aprobar lo
  que muestra.
- `auto-merge` solo en las issues que la persona nombró para eso ("ponle
  auto-merge a US1"). Una sugerencia en la tabla no alcanza: es mergear sin
  que nadie mire.

## Dónde paras

> Listo: 4 issues de la épica #12 en la cola (#14 a #17). Setup va primero y
> las historias esperan a que se cierre. **No voy a empezar a trabajarlas.**
> Cuando quieras arrancar la fábrica: `/fabrica:backlog`.
