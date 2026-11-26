---
name: plan
description: Escribe el plan técnico de una feature con Spec Kit, en la rama de su spec. Segundo paso de la planeación (spec → plan → tasks → issues). Solo en una sesión con una persona.
argument-hint: "[indicaciones técnicas para el plan]"
disable-model-invocation: true
---

# Escribir el plan de una feature

Segundo paso, después de `/fabrica:spec` y en su misma rama `spec-<N>`.
Necesita a una persona en la sesión: si te llegó por un worker headless o por
una mención `@claude`, responde que la planeación se hace en una sesión
interactiva y para.

1. `fabrica-setup check` y `fabrica-setup speckit`. Si alguno falla, muestra
   su mensaje y para.
2. `fabrica-feature`. Si dice que no estás en una rama `spec-<N>`, pide el
   número de la épica y cámbiate a esa rama; no sigas en otra.
3. Lee `.specify/commands/speckit-plan.md` y sigue sus instrucciones, con las
   indicaciones técnicas de la persona como `$ARGUMENTS`. Su "Constitution
   Check" usa la constitución de la fábrica: TDD, historias independientes y el
   perfil del stack. Una regla que el plan rompe se justifica en "Complexity
   Tracking" o el plan cambia; no la saques.
4. En `plan.md`, `**Branch**` dice `spec-<N>`, igual que en `spec.md`: Spec
   Kit pone ahí el nombre de la carpeta, corrígelo. Debajo de esa línea agrega
   `**Generated with**:` y la primera parte de `.specify/fabrica-version` (las
   versiones de la fábrica y de Spec Kit). La constitución no está en git, y
   así queda constancia de con qué reglas se planeó.
5. Commit y push a la misma rama (`git commit -m "docs(plan): plan epic #<N>"`,
   `git push`). El PR se actualiza solo.

## Sigues o paras

**Sigues con las tareas** si se cumple todo esto:

- el Constitution Check quedó sin violaciones, o cada una está justificada en
  "Complexity Tracking";
- `plan.md` y `research.md` no tienen ningún `[NEEDS CLARIFICATION`;
- la persona no pidió parar después del plan.

Entonces dilo en una línea y sigue en la misma sesión y la misma rama: lee
`${CLAUDE_PLUGIN_ROOT}/skills/tasks/SKILL.md` y síguelo.

**Si no, paras**, dices qué falta y que lo siguiente es `/fabrica:tasks` en
esta misma rama.
