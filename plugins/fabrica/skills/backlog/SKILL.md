---
name: backlog
description: Trabaja la cola de issues de la fábrica, una issue por vez en su worktree impl-N, en esta sesión o con workers claude -p (fabrica-backlog). Úsalo solo cuando la persona lo pide con esas palabras ("procesa el backlog", "trabaja el #3", "arranca la fábrica", /fabrica:backlog). Nunca por iniciativa propia.
argument-hint: '[número de issue] [o "con workers"]'
---

# Trabajar el backlog

Esto es un despacho: la persona pidió que la fábrica trabaje la cola. Que
existan issues `pending` no lo es (ver "Autonomy boundary" en las reglas).

Cada issue se trabaja en su worktree `.claude/worktrees/impl-N`, en la rama
`impl-N`: así no toca el checkout de la persona, parte de la base al día y
tiene su propio presupuesto del Stop gate.

Primero, en los dos modos: `fabrica-setup check`. Si falla, muestra su
mensaje y para.

## En esta sesión (por defecto)

Una issue por invocación, con la persona mirando.

El código lo escribe esta sesión, con su modelo: `factory.json` →
`models.worker` sólo llega a los workers de abajo. Si esta sesión no corre con
ese modelo, dilo en una línea al empezar, con el comando para la próxima
(`claude --model <models.worker> "/fabrica:backlog"`), y sigue.

1. **La issue.** Si la persona nombró una, es esa. Si no, `fabrica-next-issue`.
   Si sale con 1, no hay nada elegible: dilo y para. Si sale con 3, no pudo
   leer la cola: muestra su mensaje y para.
2. **El reclamo.** `fabrica-claim N`. Si sale con 2, la tiene otra persona o
   ya está en curso: muestra su mensaje; si la persona la nombró, para, y si
   no, vuelve al paso 1. Si sale con 1, muestra su mensaje y para. Si sale bien,
   la última línea es la ruta del worktree.
3. **Entra al worktree** con `EnterWorktree` y esa ruta (`path`). Desde ahí
   corre el Stop gate y trabajan los revisores.
4. **El ciclo.** Sigue "Issue lifecycle" de las reglas desde el paso 2. El
   paso 3 ya está hecho: sigue en `impl-N`.
5. **Antes de terminar**, `fabrica-check-done N`. Si falla, todavía no hay un
   PR que cierre la issue: ábrelo, o ríndete con el paso 6.
6. **Para rendirte**, `fabrica-release N --needs-human "motivo"`. Si la persona
   pide dejarla para después, `fabrica-release N --pending`.
7. **Al terminar**, `ExitWorktree` con `keep` y resume en el idioma de
   `factory.json` → `docLang`: PR, `needs-human` o devuelta a la cola. Para la siguiente issue, sugiere `/clear` y volver a
   llamar `/fabrica:backlog`: cada issue empieza con el contexto limpio.
   Los worktrees de issues ya cerradas se borran con `fabrica-cleanup`.

Si la persona prefiere ver cada issue en otra terminal, después del paso 2
dale el comando y para:

```bash
cd <ruta del worktree> && claude "/fabrica:backlog N"
```

## Con workers (si la persona lo pide)

Para que la cola avance sin nadie mirando, en esta máquina. Muestra el comando
con las variables que la persona haya pedido (`MAX_ISSUES`, `ONLY_LABEL`,
`ONLY_MINE`):

```bash
fabrica-backlog
```

Lanza un worker `claude -p` por issue, de a uno, cada uno en su worktree,
hasta vaciar la cola o llegar a `MAX_ISSUES` (10 por defecto). Usa los mismos
reclamos y worktrees que el modo de arriba.

1. Córrelo en segundo plano y avisa dónde queda la salida. Dura lo que tarden
   los tickets: no esperes en la misma llamada.
2. Al terminar, resume por issue: PR abierto, `needs-human` con su motivo, o
   devuelta a `pending`.

Si un worker se detiene pidiendo aprobación para cada comando, la cuenta tiene
una política que no deja trabajar solos a los workers. Dilo así y para: no
cambies permisos ni modos para esquivarla. El modo de esta sesión sigue
funcionando, y de noche está la nube (la etiqueta `ready-for-dev`).
