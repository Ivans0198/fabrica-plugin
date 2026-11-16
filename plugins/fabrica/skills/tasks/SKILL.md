---
name: tasks
description: Divide el plan de una feature en tareas con Spec Kit, con tests obligatorios en cada historia. Tercer paso de la planeación (spec → plan → tasks → issues). Solo en una sesión con una persona.
argument-hint: "[indicaciones para las tareas]"
disable-model-invocation: true
---

# Dividir una feature en tareas

Tercer paso, en la misma rama `spec-<N>`. Necesita a una persona en la sesión:
si te llegó por un worker headless o por una mención `@claude`, responde que la
planeación se hace en una sesión interactiva y para.

1. `fabrica-setup check`, `fabrica-setup speckit` y `fabrica-feature`, como en
   `/fabrica:plan`.
2. Lee `.specify/commands/speckit-tasks.md` y sigue sus instrucciones, con las
   indicaciones de la persona como `$ARGUMENTS`. En este proyecto los tests
   son obligatorios (principio I de la constitución), aunque su texto diga que
   son opcionales: cada historia lleva su sección "Tests for User Story N" con
   al menos una tarea, antes de las de implementación. La plantilla de tareas
   de la fábrica ya lo pide así.
3. **Revisa el resultado antes de commitear:**
   - cada `## Phase N: User Story K` tiene su `### Tests for User Story K` con
     al menos una tarea;
   - test primero también en Setup y Foundational: una tarea que escribe
     lógica va después de la tarea que escribe su test. Las que solo
     configuran (carpetas, dependencias, archivos de configuración) no
     necesitan test. Si la lista pone lógica antes que su test, reordénala o
     agrega la tarea de test que falta, y dile a la persona qué cambiaste;
   - cada criterio de aceptación y cada requisito funcional de la spec tiene
     al menos una tarea. Muéstrale a la persona los que no tienen, y agrega
     sus tareas con su OK;
   - cada historia se puede construir y probar sola; lo que todas necesitan
     está en Setup o Foundational, y lo que va después de todas, en Polish;
   - ninguna historia es tan grande que su issue sería de tamaño L. Si lo es,
     pártela en la spec y vuelve a generar las tareas.

   Si algo falla, corrígelo con la persona. No commitees un `tasks.md` que no
   lo cumpla: `fabrica-create-issues` lo va a rechazar después.

4. Commit y push a la misma rama (`git commit -m "Tareas de <nombre> (#<N>)"`,
   `git push`).
5. Saca el PR de borrador si la persona lo pide (`gh pr ready`).

Termina así:

> Listo: spec, plan y tareas en el PR #13. Cuando lo revises y lo mergees,
> eso aprueba la feature. Después, desde la rama base: `/fabrica:issues 12`.
