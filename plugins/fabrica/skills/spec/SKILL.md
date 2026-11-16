---
name: spec
description: Escribe la spec de una feature con Spec Kit, crea su épica y abre el PR de la spec. Primer paso de la planeación (spec → plan → tasks → issues). Solo en una sesión con una persona.
argument-hint: "[descripción de la feature, o el número de una épica para retomar]"
disable-model-invocation: true
---

# Escribir la spec de una feature

La planeación son cuatro pasos: `/fabrica:spec`, `/fabrica:plan`, `/fabrica:tasks`
y, después del merge, `/fabrica:issues`. Los tres primeros trabajan en la rama
`spec-<N>` y en un solo PR en borrador, con N el número de la issue de la
épica. El merge de ese PR es la aprobación de la spec, el plan y las tareas.

Necesita a una persona en la sesión: hace preguntas y crea la épica. Si te
llegó por un worker headless o por una mención `@claude`, responde que la
planeación se hace en una sesión interactiva y para.

## Antes de empezar

1. `fabrica-setup check` y después `fabrica-setup speckit`. Si alguno falla,
   muestra su mensaje y para.
2. **¿Es un producto entero o una feature?** Un SRD o un brief con varias
   features no va a una sola spec. Primero escribe `docs/plan-maestro.md`: la
   tabla de épicas (alcance, tamaño, dependencias), los carriles en paralelo y
   el porqué del orden. Que la persona lo apruebe, y recién después haz una
   spec por épica, empezando por la primera. Prefiere pocas épicas con varias
   historias a muchas épicas chicas.
3. **¿Se retoma?** Si existe la rama `spec-<N>` (local o en `origin`), con eso
   basta para retomar, aunque todavía no haya carpeta: no crees otra épica,
   cámbiate a esa rama y sigue desde el paso que falte. Si la persona dice que
   ya había empezado y no hay rama, busca épicas abiertas sin carpeta en
   `specs/` (`gh issue list --label epic --state open`) y pregúntale cuál es.

## Pasos

1. **Nombre corto** para la carpeta: 2 a 4 palabras en minúsculas, separadas
   por guion, solo letras sin tildes, números y guiones (`favoritos`,
   `exportar-reportes`).
2. **La épica.** Muestra lo que vas a crear y espera el OK. Crear una issue
   no se deshace limpio, así que este OK nunca es una formalidad:

   > Voy a crear la épica **[Epic] Favoritos** (etiqueta `epic`, sin
   > `pending`) para numerar la spec. ¿Sigo?

   Con el OK:

   ```bash
   gh label create epic 2>/dev/null || true
   gh issue create --title "[Epic] <nombre>" --body-file <archivo> --label epic
   ```

   El cuerpo dice en dos o tres frases qué es la feature y que la spec va en
   `specs/<N>-<nombre>/`. N es el número que devuelve `gh`.

3. **La rama**, desde lo último de la base (`factory.json` → `baseBranch`,
   `main` si falta):

   ```bash
   git fetch origin <base>
   git switch --no-track -c spec-<N> origin/<base>
   ```

   `--no-track`: la rama no sigue a la base, así un `git push` a secas nunca
   va a parar a ella.

4. **La spec.** Lee `.specify/commands/speckit-specify.md` y sigue sus
   instrucciones, con la descripción de la persona como `$ARGUMENTS`. Dale
   `SPECIFY_FEATURE_DIRECTORY=specs/<N>-<nombre>` como valor provisto: es la
   carpeta, no parte de la descripción, y no va dentro de la spec. Sin ese
   valor, Spec Kit numera la carpeta por su cuenta. Después corre
   `fabrica-feature`: tiene que imprimir `specs/<N>-<nombre>`. Si Spec Kit
   creó otra carpeta (como `specs/001-favoritos`), renómbrala a
   `specs/<N>-<nombre>` y vuelve a correr `fabrica-feature`.
5. **Aclaraciones.** Lee `.specify/commands/speckit-clarify.md` y síguelo. Sus
   preguntas van de a una y las responde la persona; no las contestes tú.
6. En `spec.md`, `**Feature Branch**` dice `spec-<N>`.
7. **Plan maestro.** Agrega o actualiza en `docs/plan-maestro.md` la fila de
   esta épica, apuntando a `specs/<N>-<nombre>/`. Si `docs/plan-maestro.md` no
   existe, créalo con una tabla mínima (épica, alcance, tamaño, dependencias,
   carpeta de la spec) y esta fila. Si se agrega después del plan original,
   márcala como agregada después.
8. **Commit y PR.** Si `fabrica-setup speckit` agregó líneas al `.gitignore`,
   van en el mismo commit.

   ```bash
   git add specs/<N>-<nombre> docs/plan-maestro.md .gitignore
   git commit -m "Spec de <nombre> (#<N>)"
   git push -u origin spec-<N>
   gh pr create --draft --title "Spec: <nombre>" --body-file <archivo>
   ```

   El cuerpo dice `Refs #<N>`, **nunca** `Closes #<N>`: con `Closes`, el merge
   cerraría la épica antes de que tenga historias. Explica que el merge aprueba
   spec, plan y tareas, y que faltan `/fabrica:plan` y `/fabrica:tasks`.

## Dónde paras

> Listo: la spec de favoritos está en `specs/12-favoritos/`, en el PR #13
> (épica #12). Lo siguiente es `/fabrica:plan` en esta misma rama.

Si la persona decide no seguir con la feature y cierra el PR sin merge,
recuérdale cerrar también la épica como "not planned"
(`gh issue close <N> --reason "not planned"`), o queda huérfana.
