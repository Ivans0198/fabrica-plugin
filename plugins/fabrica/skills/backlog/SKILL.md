---
name: backlog
description: Procesa la cola de issues de la fábrica con workers, uno por issue (fabrica-backlog). Úsalo solo cuando la persona lo pide con esas palabras ("procesa el backlog", "arranca la fábrica", /fabrica:backlog). Nunca por iniciativa propia.
---

# Procesar el backlog

Esto es un despacho: la persona pidió que la fábrica trabaje la cola. Que
existan issues `pending` no lo es (ver "Autonomy boundary" en las reglas).

1. Comprueba que el proyecto está al día con el plugin: `fabrica-setup check`.
   Si falla, muestra su mensaje y para.
2. Muestra el comando y lo que va a hacer, con las variables que la persona
   haya pedido (`MAX_ISSUES`, `ONLY_LABEL`, `ONLY_MINE`):

   ```bash
   fabrica-backlog
   ```

   Lanza un worker `claude -p` por issue elegible, cada uno en su worktree,
   hasta vaciar la cola o llegar a `MAX_ISSUES` (10 por defecto).

3. Córrelo en segundo plano y avisa dónde queda la salida. Dura lo que tarden
   los tickets: no esperes en la misma llamada.
4. Al terminar, resume por issue: PR abierto, `needs-human` con su motivo, o
   devuelto a `pending`.

Si un worker se detiene pidiendo aprobación para cada comando, la cuenta tiene
una política que no deja trabajar solos a los workers. Dilo así y para: no
cambies permisos ni modos para esquivarla.
