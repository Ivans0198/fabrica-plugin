# 🏭 Guía de la Fábrica, explicada fácil

Esta es tu fábrica de software: tú decides **qué** construir, y ella se encarga
del **cómo**. Tú eres el arquitecto que aprueba los planos y recibe las llaves;
la fábrica pone los obreros, el inspector de calidad y el capataz.

---

## Parte 1: Lo que se hace UNA sola vez por computador

(Si ya usaste la fábrica en este computador, sáltate esta parte.)

1. Instalar las herramientas: **git**, **node**, **gh** (con `gh auth login`),
   **jq** y **claude** (Claude Code). En Windows, la terminal de la fábrica es
   **Git Bash**.
2. Registrar el marketplace donde vive el plugin `fabrica`:

   ```
   claude plugin marketplace add <URL o ruta del repo fabrica-plugin>
   ```

   El plugin trae los revisores, las skills, el Stop gate y los scripts. No
   se copia nada a tu carpeta `C:\Users\TU_USUARIO\.claude\`.

3. **El token de la nube** (para que la fábrica trabaje sin tu PC): corre
   `claude setup-token` en la terminal, autoriza en el navegador, y guarda el
   token que te da en un lugar seguro (un gestor de contraseñas). Es de tu
   cuenta y sirve para todos tus proyectos; se genera UNA vez.

> 💡 Truco: si algo recién instalado "no se reconoce", cierra la terminal y
> abre una nueva. Las terminales viejas no ven los programas nuevos.

---

## Parte 2: Empezar un proyecto NUEVO

**Antes de nada: ¿sirve para tu proyecto?** La fábrica arranca proyectos de
**Node y TypeScript**. Dentro de eso da igual el framework: Next, Vite,
Express, una librería, una CLI. Los comandos de cada proyecto viven en
`factory.json`, pero hoy solo hay perfil de stack para Node y TypeScript
(`node-ts`), y los checks en la nube solo instalan Node. Python o Go todavía
no.

**Comando 1** (en Git Bash, donde guardas tus proyectos):

```
gh repo create mi-app --private --clone
cd mi-app
claude plugin install fabrica@fabrica-local --scope project
```

Crea el repo en GitHub, lo descarga y activa el plugin solo en ese proyecto.

**Comando 2:**

```
claude "/fabrica:bootstrap una app de [lo que quieras] con [el stack de Node que quieras]"
```

Ejemplo real: `claude "/fabrica:bootstrap una app de recetas colombianas con Vite + TypeScript"`

También puedes pasarle un documento entero (un SRD, un brief largo) o **no
pasarle nada**. En ese caso te entrevista.

**¿Tienes diseños?** Pásaselos también: un HTML, un PDF, capturas, lo que
exportes de Figma. No es adorno: los guarda en `docs/mockups/`, saca de ahí
los colores y la tipografía para `design-system.md`, y a partir de ese momento
el revisor visual **compara cada pantalla contra tu diseño** en vez de revisarla
solo con reglas generales. Sin diseño funciona igual, pero con menos filo.

`/fabrica:bootstrap` arranca con `fabrica-setup init`, que escribe en el
proyecto `CLAUDE.md`, `factory.json`, los permisos (`.claude/settings.json`),
las reglas (`.factory/rules/`) y las llamadas a los workflows. Después te lleva
en **5 fases, con 2 paradas** donde espera tu respuesta:

| Fase                | Qué hace                                                                                                                                                                                                      | ¿Te pregunta?        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **0 · Diagnóstico** | Revisa el repo, lee lo que le mandaste (o te hace 4 preguntas si fue poco) y te muestra **la propuesta de cáscara**: a qué repo va a escribir, qué herramientas instala, qué construye y **qué NO**           | **SÍ, aquí decides** |
| 1 · Setup mecánico  | Dependencias, Playwright, las 13 etiquetas, modelos                                                                                                                                                           | no, te reporta       |
| 2 · La cáscara      | El esqueleto mínimo que camina, con sus tests (TDD), y rellena la configuración                                                                                                                               | no, te reporta       |
| 3 · Verificación    | Corre tests, lint, tipos y el servidor de verdad. Commit y push                                                                                                                                               | no, te reporta       |
| **4 · Handoff**     | Te dice qué sigue y te deja el comando listo: planear con `/fabrica:spec` (te sugiere hacerlo en terminal aparte, y te explica por qué, pero si prefieres seguir ahí, se sigue). También te ofrece el tablero | **SÍ, aquí decides** |

Dos cosas importantes de la Fase 0: la **cáscara** es a propósito mínima (el
andamio y las herramientas que tu proyecto sí o sí necesita, nada más). Lo
demás lo construyen los tickets, uno por uno y revisados. Y la lista de
**"qué NO incluye"** es tu red de seguridad: si ves ahí algo que esperabas
tener ya, dilo antes de aprobar.

Lo que hablen en la Fase 0 **queda escrito en el repo**: tu documento en
`docs/srd.md` si le pasaste uno, o `docs/brief.md` con tu idea y las respuestas
de la entrevista si arrancaste con una frase. Por eso el handoff de la Fase 4
te da el comando ya apuntando a ese archivo. Abres la terminal nueva y sigues
donde ibas, sin que nadie te vuelva a preguntar lo mismo.

> 🛑 **`/fabrica:bootstrap` nunca se pone a programar tickets solo.** Termina
> entregándote el terreno listo y el comando del siguiente paso. Arrancar la
> fábrica es siempre una decisión tuya (Paso 3 de la Parte 3).

El repositorio de GitHub ya lo creaste tú con el Comando 1; bootstrap solo
verifica y te dice a qué repo va a escribir. El **tablero** (que es otra cosa)
no se crea solo: te lo ofrece al final, en la Fase 4.

**`factoryEpic`, el único hueco que deja.** Si un merge deja desajustadas las
capturas en `main`, la fábrica abre un incidente y lo cuelga de una épica de
fábrica y herramientas. Esa épica no existe todavía: créala cuando quieras
(`gh issue create --title "[Epic] Fábrica y herramientas" --label epic`) y
pon su número en `factory.json` → `factoryEpic`. Mientras tanto, si pasa,
el workflow te lo dice en vez de colgar el incidente de cualquier issue.

> 💡 **¿Usas `claude -p` en scripts?** En un repo que nunca abriste con
> `claude` en modo interactivo, Claude ignora los permisos del proyecto y
> avisa "Ignoring … this workspace has not been trusted". Abre `claude` una
> vez en la carpeta, acepta la confianza, y desde ahí `claude -p` usa
> `.claude/settings.json`.

**Comando 3: la llave de la nube** (los secretos van por repo; hay que
plantarla en cada uno):

```
gh secret set CLAUDE_TOKEN_TU_USUARIO        # TU token personal (menciones @claude y ready-for-dev)
```

Pega el token que guardaste en la Parte 1. El nombre lleva tu usuario de
GitHub en MAYÚSCULAS (guiones → `_`): ej. `CLAUDE_TOKEN_IVANS0198`.

Todo lo que pide una persona se cobra a SU token, así que en equipo nadie
subsidia a nadie (Parte 8). Verifica con `gh secret list` que esté.

Los workflows buscan `CLAUDE_TOKEN_<TU_USUARIO>` por nombre: no hay que
editarlos para sumarte. Si el repo del plugin es privado, planta además
`FABRICA_PLUGIN_TOKEN`, un token que pueda leer ese repo.

Sin esto, la etiqueta `ready-for-dev` y las menciones @claude no funcionan (el
Claude que corre en GitHub no tiene cómo autenticarse). También necesitas
**una vez por cuenta** la GitHub App de Claude instalada:
github.com/apps/claude → Install → All repositories.

**El tablero visual (opcional):** dile a Claude:

> Crea un GitHub Project para este repo, vincúlalo y corre el project-setup.sh del plugin

Solo hay 2 cosas que Claude no puede hacer por ti (limitaciones de GitHub):

- Correr `gh auth refresh -s project,repo` (te pide autorizar en el navegador).
- Activar 3 interruptores en la página del Project (⚙ → Workflows):
  **Item added → Todo**, **Item closed → Done**, **Pull request merged → Done**.
  Y agrupar la vista por **Parent issue**.

---

## Parte 3: Crear una funcionalidad (el ciclo que repetirás siempre)

### Paso 1: Planear 🧠

La fábrica planea con **Spec Kit**, la herramienta de GitHub para escribir
specs. Viene dentro del plugin: no hay que instalar nada. Abre Claude en el
repo y pídele:

```
/fabrica:spec [descripción de lo que quieres, con tus palabras]
```

Primero te pide el OK para crear la **épica**: la issue que agrupa la
funcionalidad y le da número a su carpeta. Después escribe la **spec**: qué se
construye y para quién, las historias de usuario con sus escenarios de
aceptación y los casos borde. Mientras la escribe te hace hasta 3 preguntas, y
después hasta 5 más para aclarar lo ambiguo (tú eres el dueño del producto,
así que responde lo que quieres). Queda en `specs/<número>-<nombre>/spec.md`,
en un PR en borrador.

**¿Tu documento trae varias funcionalidades?** Entonces, antes de la spec, te
propone un **plan maestro** en `docs/plan-maestro.md`: la tabla de épicas, su
tamaño, sus dependencias y el orden. Lo apruebas y sigue con la spec de la
primera épica; las demás van después, una por una, con `/fabrica:spec`.

Cuando respondes la última pregunta, la spec encadena sola `/fabrica:plan` y
`/fabrica:tasks` en la misma sesión, sin que los escribas. Solo para si queda
una duda sin resolver o si le pides parar; entonces sigues tú:

```
/fabrica:plan [indicaciones técnicas, si tienes]
/fabrica:tasks
```

`/fabrica:plan` escribe el plan técnico y lo revisa contra las reglas del
proyecto (TDD, historias que se prueban solas, el perfil del stack).
`/fabrica:tasks` lo divide en tareas por historia, siempre con los tests
primero. Todo va al mismo PR.

**Léelo con calma.** Este es TU momento de mayor poder: cambiar algo aquí es
gratis; cambiarlo después cuesta. Si algo no te gusta, díselo con tus
palabras y lo reescribe. **Aprobar es mergear ese PR.**

### Paso 2: Crear las issues 🎫

Con el PR mergeado:

```
/fabrica:issues <número de la épica>
```

Arma una issue por historia, una para la preparación común (Setup) y una para
el pulido final (Polish), colgadas de la épica y encadenadas: las historias
esperan a que se cierre Setup, y Polish espera a todas. Antes de crear nada te
muestra la tabla y espera tu confirmación.

**Aquí decides también la confianza:** los tickets mecánicos y de bajo riesgo
(datos, estilos, refactors con buenos tests) pueden llevar la etiqueta
**`auto-merge`**: sus PRs se mergearán solos cuando pasen sus checks, para que la
cadena avance de noche sin ti. Dilo en la confirmación:

> Confirmo. Ponle auto-merge a US1 y a Polish; US2 y US3 los reviso yo.

Los delicados (lógica de negocio, seguridad) déjalos sin etiqueta: te
esperarán.

> 🛑 **Crear las issues NO arranca nada.** Al terminar, Claude te resume qué
> creó y se detiene, aunque el siguiente ticket sea obvio. La fábrica solo se
> pone a programar cuando TÚ la sueltas (Paso 3) o cuando etiquetas un issue
> `ready-for-dev`. Si alguna vez ves que empieza sola,
> es un bug del plugin: la regla está en `.factory/rules/fabrica.md`, sección
> _Autonomy boundary_.

### Paso 3: Soltar la fábrica 🤖

Dentro de Claude, en el repo:

```
/fabrica:backlog
```

Primero comprueba que el proyecto esté en la versión del plugin
(`fabrica-setup check`) y que el plugin esté instalado y activo. Cada obrero
parte de lo último de la rama base en GitHub, así que también se niega si
`CLAUDE.md`, `factory.json`, `.claude/settings.json` o `.factory/` tienen
cambios sin commitear o sin subir. Si algo no cuadra, se detiene y te dice qué lo arregla. Después busca la
siguiente tarea disponible y lanza un Claude que la
trabaja solo (con permisos `auto` puede pedirte confirmación alguna vez; para
cero interrupciones, córrelo en el dev container, más abajo): marca la tarea "en progreso", escribe los tests PRIMERO,
implementa hasta que pasen, se hace revisar por el agente revisor hasta
recibir APPROVED, y abre un **Pull Request en borrador**. Tú no haces nada.

**El dev container: workers sin preguntas.** Con
`PERMISSION_MODE=bypassPermissions`, los workers no piden confirmación para
nada. Eso solo es seguro en un contenedor desechable, así que
`fabrica-backlog` se niega a correr en ese modo fuera de uno.
`fabrica-devcontainer` escribe uno en `.devcontainer/` (el bootstrap te lo
ofrece). Su firewall bloquea toda salida menos GitHub, Anthropic y el registro
de paquetes del stack, en `.devcontainer/allowed-domains.txt`, y dentro ya va
`PERMISSION_MODE=bypassPermissions`. Ábrelo con "Reopen in Container" de VS
Code. La primera vez, dentro:

```bash
gh auth login
claude                                                # entra a tu cuenta
claude plugin marketplace add <owner>/fabrica-plugin  # el plugin, desde GitHub
claude plugin install fabrica@fabrica-local --scope project
```

El código de `gh auth login` vence a los 15 minutos. Si no alcanzas a
autorizarlo, hazlo desde tu terminal, a tu ritmo:
`docker exec -it <contenedor> gh auth login` (el id sale en `docker ps`).

Sin VS Code, levántalo con
`npx -y @devcontainers/cli@0.91.0 up --workspace-folder .`: la 0.80.0 se
quedaba colgada con Docker 29 y no corría el firewall. Las sesiones de `gh` y
de Claude quedan en volúmenes: no se repite al reconstruir. VS Code copia tu identidad de git (`user.name` y `user.email`)
al contenedor; si lo abres de otra forma, configúrala dentro, o los commits
de los workers no tendrán autor. Si cambias `allowed-domains.txt`, reconstruye el contenedor.

**Si tu proyecto tiene e2e con Playwright**, el contenedor trae Chromium dentro
de la imagen, en la versión de `@playwright/test` del proyecto: dentro, el
firewall no deja bajarlo. Si subes Playwright de versión, cambia
`PLAYWRIGHT_VERSION` en `.devcontainer/Dockerfile` y reconstruye. Un
`.devcontainer/` de antes de la 0.5.9 no lo trae: regenéralo con
`fabrica-devcontainer --force --playwright` (con tus `--feature` y `--domain`).
Que los tests no dependan de otros servidores: las fuentes, por ejemplo, van
en el proyecto (`@fontsource`), no de Google Fonts.

`fabrica-backlog` solo acepta `bypassPermissions` si el firewall terminó bien
(deja `/run/fabrica-firewall-ok`) y example.com no responde. `refresh` no
toca `.devcontainer/`: si el tuyo es de antes de la 0.5.0, su firewall no deja
la marca, y `fabrica-setup check` lo avisa. Regenéralo con
`fabrica-devcontainer --force` (con tus `--feature` y `--domain`) y
reconstruye. Lo que el firewall no cubre:

- **GitHub está abierto**, y la sesión de `gh` del contenedor llega a todos
  tus repos. Para un proyecto delicado, entra con un token fine-grained
  limitado a ese repo: `gh auth login --with-token`.
- **La carpeta del proyecto es la de tu computador.** Lo que un worker
  escriba en `.git/hooks/` o `.vscode/` corre después fuera del contenedor.
  Si algo te parece raro, revísalos antes de usar git o VS Code en el host.

### Paso 4. Tu único trabajo: revisar y mergear 👑

Cuando llegue el PR: ábrelo en GitHub, mira los cambios ("Files changed"),
y si te gusta: botón **"Ready for review"** → botón **"Merge pull request"**.
(Los tickets con `auto-merge` se saltan este paso solos: cuando el worker
termina, `fabrica-backlog` o la nube esperan los checks del PR y lo mergean
si pasan y si la rama tiene lo último de `main`. Si no, lo comentan en la
issue y lo mergeas tú. Cuenta la etiqueta que tenía la issue antes de
empezar, así que el worker no puede ponérsela él.)

Al mergear pasa la magia en cadena: la tarea se cierra sola → el tablero la
pasa a Done → la barra del épico avanza → y la siguiente tarea queda
desbloqueada.

### Paso 4.5: Publicar 🌐

Cuando la primera épica esté mergeada y quieras verla en internet, dentro de
Claude:

```
/fabrica:publish
```

Comprueba que el build sale, te da los pasos para conectar el repo al
hosting (Vercel por defecto, gratis en el plan Hobby) y espera a que los
hagas: la cuenta, darle a la app de Vercel acceso solo a este repo, y cargar
los secretos en su panel son cosas tuyas. Con la URL que le pegues, prueba
producción, la guarda en `factory.json` → `prodUrl` y abre un PR con ella.
Se hace una vez: después, cada push a `main` publica solo y cada PR trae su
vista previa.

### Paso 5: Repetir

¿Quedan tareas? Vuelve a correr `/fabrica:backlog` (Paso 3). ¿Se acabaron? Tu
funcionalidad está lista. ¿Quieres otra funcionalidad? Vuelve al Paso 1.

```
PLANEAR → APROBAR → SOLTAR LA FÁBRICA → MERGEAR → REPETIR
```

---

## Parte 4: La fábrica sin tu computador (nube y celular) ☁️📱

Con tu llave configurada (Parte 2, comando 3), la fábrica también corre en
los servidores de GitHub, y tu PC puede estar apagado. Tienes dos gatillos:

1. **Etiqueta `ready-for-dev`:** pónsela a un issue (desde la app de GitHub
   del celular si quieres) → GitHub arranca una máquina y procesa ese issue,
   uno por corrida. Si el issue todavía espera a otro (`blocked-by-N`) o
   está asignado a otra persona, la nube no lo toma y lo dice en el issue.
   Mientras tenga la etiqueta, es de la nube: `/fabrica:backlog` en tu
   computador se lo salta. Para que lo haga tu computador, quítasela.
2. **Menciones `@claude`:** comenta `@claude ...` en cualquier issue y te
   responde en el mismo hilo. Sirve para preguntas y para pedir un cambio
   puntual. Para planear no: la spec, el plan, las tareas y las issues de una
   feature se hacen en una sesión de Claude contigo delante (Parte 3).
   En un PR que abrió la fábrica, Claude puede correr los tests. En el PR de
   un fork o de alguien sin escritura en el repo, no puede correr npm, los
   tests ni los intérpretes, y el gate y el lint de la fábrica no corren:
   solo lee, edita y responde. En cualquier mención, `factory.json` se lee de
   la rama principal y Claude no puede mergear ni empujar a ella.

Todo se observa en la pestaña **Actions** del repo (los logs de cada
corrida). Los PRs se revisan y mergean desde el navegador del celular sin
problema.

---

## Parte 4.5. Los modelos: cuánta potencia usa cada pieza 🎛️

Cada pieza de la fábrica puede usar un modelo distinto de Claude, y eso
controla directamente cuánto consumes. Se configura en `factory.json`, en la
raíz del repo, bajo la clave **`models`**.

| Pieza          | Qué es                               | Recomendado                                     |
| -------------- | ------------------------------------ | ----------------------------------------------- |
| `worker`       | El obrero que implementa cada ticket | `sonnet`                                        |
| `codeReviewer` | El inspector de código               | `sonnet`                                        |
| `uiReviewer`   | El inspector visual                  | `sonnet`                                        |
| `planning`     | Tus sesiones de spec y plan maestro  | `opus` (lo eliges tú con `/model` en la sesión) |

La regla de dedo: **sonnet para el trabajo diario** (rápido y económico, muy
capaz), y **opus solo donde el error cuesta caro** (la spec de pagos, el
epic de permisos, el plan maestro). Subes la perilla para ese epic y la
vuelves a bajar.

Para cambiar: edita `models` en `factory.json` y commitéalo. El worker y los
workflows de la nube leen el archivo cada vez, y el worker lanza a cada
revisor con su modelo. Los valores son nombres de modelo: `sonnet`, `opus`,
`haiku`. `/fabrica:bootstrap` te pregunta esto al crear cada proyecto.

**`/fabrica:backlog` en tu sesión usa el modelo de tu sesión**, no
`models.worker`: ese valor sólo llega a los workers de `fabrica-backlog` y a
la nube. Para que el código lo escriba el modelo de `worker`, abre la sesión
con él: `claude --model sonnet "/fabrica:backlog"`. La fábrica te avisa si no
coinciden.

> 💡 Ojo también con tu modelo personal: si tu `settings.json` usa la
> variante `[1m]` (contexto de 1 millón), cada sesión consume mucho más
> rápido. Para el trabajo de fábrica, la variante estándar sobra.

**Revisión visual: cuándo mira el ui-reviewer.** Los tests de píxeles de
Playwright corren siempre y no gastan tokens. Lo caro es el agente
ui-reviewer _mirando_ screenshots. Eso se controla en el mismo
`factory.json`, clave `review.uiReview`:

- `"label"` (default): solo revisa los tickets que lleven la etiqueta
  **`ui-review`**. La fábrica la sugiere para pantallas nuevas y cambios de
  layout, y tú la ratificas en el gate (igual que auto-merge).
- `"always"`: revisa todo ticket que toque UI (máxima calidad visual).
- `"off"`: nunca (útil al principio de una app, cuando la UI es provisional).

Si falta la clave, vale `"label"`. También puedes ponerle o quitarle la etiqueta `ui-review` a cualquier ticket desde
la app de GitHub, como con auto-merge.

**Las capturas propias pasan por ti.** Cada historia con UI cambia las
capturas de `tests/ui.spec.ts-snapshots/`. El worker no las regenera y el
Stop gate no las compara (corre el e2e con `FABRICA_IGNORE_SNAPSHOTS=1`).
Las compara el job visual del PR: mira su artefacto `visual-diff` y, si está
bien, acéptalas con
`gh workflow run visual-baselines.yml --ref <rama-del-PR> -f reviewed_run_url=<run>`.
El commit con las capturas lo empuja un bot, y GitHub deja sus corridas en
`action_required`: hay que aprobarlas en el PR (**Approve and run**). Para
saltarte ese clic, guarda en el repo el secreto `FABRICA_PUSH_TOKEN`, un
token tuyo con permiso de escritura en ese repo (un fine-grained token con
**Contents: Read and write**); con él las corridas arrancan solas.
Un `playwright.config.ts` de antes de la 0.5.10 no lee la variable: agrégale
`ignoreSnapshots: !!process.env.FABRICA_IGNORE_SNAPSHOTS,` junto a
`globalSetup`.

La captura de página completa no hace scroll: las imágenes con
`loading="lazy"` salen vacías según el momento. Desde la 0.5.11 el
`tests/ui.spec.ts` del plugin las carga todas antes de capturar. Si el tuyo
es anterior, copia ese bloque (`image.loading = "eager"` y `image.decode()`)
antes de `document.fonts.ready`.

## Parte 4.7: El tablero es tu panel de control 🎛️

Arrastrar una tarjeta (no-épica) a la columna **Todo** significa "quiero esto
trabajado". Al inicio de cada corrida, el script lo traduce a la cola real: le
pone `pending` y, si el issue estaba cerrado o marcado `needs-human`, lo
reabre/reintenta. No necesitas comandos.

> ⚠ Por eso: **no arrastres a Todo tarjetas ya terminadas** que no quieras
> rehacer. (Si pasa, la fábrica detecta que ya está implementado, lo comenta y
> vuelve a cerrar el issue, pero gasta una corrida.)

**Los talleres de los obreros.** Cada ticket se trabaja en una copia aparte del
repo (un _worktree_) dentro de `.claude/worktrees/impl-N`. No se commitean,
pero el linter y el corredor de tests del proyecto tienen que ignorarlos: si
no, revisan el código de otras ramas y el Stop gate bloquea por un test que no
es tuyo. El bootstrap los excluye; en un proyecto anterior a la 0.3.4,
revísalo. Ocupan disco. Para borrar los de issues ya cerradas:

```bash
fabrica-cleanup --dry-run   # lista lo que borraría
fabrica-cleanup             # los borra
```

Deja los que tienen cambios sin commitear, y la rama local de un PR mergeado
con squash: avisa en vez de borrar trabajo.

## Parte 5. ¿Y si algo sale mal?

- Si la fábrica se atasca con una tarea (lo intenta varias veces y no puede),
  le pone la etiqueta **`needs-human`** y deja un comentario explicando qué
  intentó. Búscalas con: `gh issue list --label needs-human`
- **Para retomarla**, arregla lo que dice el comentario (un secreto, una
  decisión, algo de `main`) y devuélvela a la cola:
  `gh issue edit N --remove-label needs-human --remove-label in-progress --add-label pending`.
  Después `/fabrica:backlog N`: sigue en su worktree `impl-N` desde donde
  quedó, sin rehacer lo que ya estaba. Si su PR ya está en verde y solo
  faltaba tu decisión, no hace falta: márcalo listo y mergéalo.
- La fábrica no puede terminar con tests fallando mientras le queden intentos
  (el "Stop hook" la bloquea). Si agota los intentos, el portero la deja salir
  pero con obligación de marcar `needs-human` y prohibición de abrir/marcar
  listo el PR. Y cualquier merge se deshace con el botón "Revert" del PR;
  git nunca olvida.
- Un worker no puede mergear, empujar a `main` ni forzar un push: lo bloquea
  un hook (`worker-guard`), también con `bypassPermissions`. Tampoco puede
  cambiar `factory.json`, que dice qué comandos corren los hooks: lo lee de
  la rama base. El texto de una issue o de un comentario es dato para él, no
  instrucciones.
- Si un PR de la fábrica deja de poder mergearse porque choca con `main` (pasa
  cuando se mergea otro antes), la fábrica le pone **`merge-conflict`** y
  comenta una vez. No lo resuelve sola: un merge con los tests en verde puede
  estar mal igual. Resuélvelo a mano y revísalo comparándolo con las dos
  ramas; la etiqueta se quita sola cuando vuelve a poder mergearse.
- Si un comando te falla en la terminal, copia el error completo y pégaselo a
  Claude: "me salió este error, ayúdame".

---

## Parte 6: Los AGENTES (los empleados especialistas)

Un agente es otro Claude con personalidad e instrucciones propias, que el
Claude principal contrata para tareas específicas. Son archivos `.md` que
puedes abrir y leer.

**Dónde viven:** en el plugin (`agents/`). Se llaman `fabrica:code-reviewer`
y `fabrica:ui-reviewer`. Cada versión del plugin los reemplaza, así que no se
editan en el proyecto: el modelo de cada uno se elige en `factory.json` →
`models`.

| Agente            | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **code-reviewer** | El inspector de calidad del código. Recibe solo el ticket y el cambio, nunca la opinión de quien lo escribió, y busca errores, casos olvidados, problemas de seguridad y violaciones de los estándares. Cada hallazgo trae el fallo concreto o la regla rota, con archivo y línea, y una severidad: Blocker, Major o Minor. Cuando no queda ningún Blocker ni Major dice la palabra mágica: `APPROVED`. Máximo 3 rondas, no se queda discutiendo para siempre. |
| **ui-reviewer**   | El inspector visual: tiene "ojos". Toma capturas de pantalla de la app en 3 tamaños (celular, tablet, computador) y las mira de verdad. Si hay un diseño de referencia, compara contra él; si no, revisa contra la lista de reglas de `design-system.md` (alineación, espaciados, contraste, accesibilidad). También dice `APPROVED` cuando aprueba.                                                                                                           |

---

## Parte 7: Las SKILLS (los procedimientos expertos)

Una skill es un manual de instrucciones que Claude carga cuando lo necesita.
Se invocan escribiendo `/nombre` dentro de Claude. También son archivos que
puedes leer y editar.

**Dónde viven:** las de la fábrica, en el plugin (`skills/`), con el prefijo
`fabrica:`. Las propias de cada proyecto, en `.claude/skills/` del repo.

| Skill                     | Qué hace                                                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **/fabrica:bootstrap**    | El arranque guiado, en 5 fases con 2 paradas: diagnostica el repo, te entrevista (o lee tu SRD), te propone la cáscara y **espera tu ok**; luego instala, construye el esqueleto con tests, verifica, commitea, y termina preguntándote qué sigue. Una vez por proyecto. Nunca se pone a trabajar tickets solo. |
| **/fabrica:spec**         | Planea una funcionalidad con Spec Kit: crea la épica (con tu OK), escribe la spec con sus historias, escenarios de aceptación y casos borde, te pregunta lo ambiguo y abre el PR. Si le pasas un documento con varias funcionalidades, primero arma el plan maestro.                                            |
| **/fabrica:plan**         | Escribe el plan técnico de la spec, en el mismo PR, y lo revisa contra las reglas del proyecto.                                                                                                                                                                                                                 |
| **/fabrica:tasks**        | Divide el plan en tareas por historia, con los tests primero, en el mismo PR.                                                                                                                                                                                                                                   |
| **/fabrica:issues**       | Después del merge del PR de la spec, crea las issues encadenadas (Setup, una por historia, Polish), siempre mostrándote la tabla antes de crear nada.                                                                                                                                                           |
| **/fabrica:write-ticket** | El redactor de tareas sueltas, incidentes y bugs: tickets tan completos que un agente puede implementarlos sin preguntar nada (criterios de aceptación, tests esperados, qué queda fuera, etiquetas). También es la plantilla de las issues de `/fabrica:issues`.                                               |
| **/fabrica:backlog**      | Suelta la fábrica sobre la cola: comprueba la versión y lanza un worker por issue elegible. Solo corre cuando se lo pides.                                                                                                                                                                                      |
| **/fabrica:publish**      | Publica el proyecto (Vercel por defecto): comprueba el build, te guía en lo que solo tú puedes hacer, prueba producción y guarda la URL. Una vez por proyecto.                                                                                                                                                  |

### Agregar tus propias skills 🧩

Las skills que trae el plugin no son un límite: puedes escribir las tuyas
para lo que tu proyecto necesite (buenas prácticas de Go, reglas de tu API,
el procedimiento de despliegue, el estilo de tu empresa…).

**Cómo:** una carpeta con un archivo, dentro del repo:

```
.claude/skills/go-practices/SKILL.md
```

```markdown
---
name: go-practices
description: Buenas prácticas de Go de este proyecto. Úsala al escribir o
  revisar cualquier código Go: errores, interfaces, concurrencia, tests.
---

# Go: reglas del proyecto

- Envuelve errores con contexto: `fmt.Errorf("cargando usuario %s: %w", id, err)`
- Las interfaces se definen donde se CONSUMEN, no donde se implementan
- Todo lo que pueda tardar recibe `context.Context` como primer parámetro
- Tests table-driven con subtests nombrados
  ...
```

Con eso queda disponible al instante para ti (`/go-practices`) y para **todos
los obreros**, incluidos los de la nube, porque viaja con el repo.

**El paso que no debes olvidar:** agrega su fila a la tabla "Project skills"
del `CLAUDE.md`, diciendo cuándo cargarla. Esa tabla es lo que convierte la
skill de "sugerencia que Claude quizá active" en "regla que el obrero debe
seguir". Si no la agregas, funcionará a veces; si la agregas, siempre.

> 💡 ¿No sabes escribirla? Pídeselo a Claude: _"crea una skill
> `.claude/skills/go-practices/SKILL.md` con las buenas prácticas de Go que
> deba seguir la fábrica en este proyecto, y agrégala a la tabla de skills del
> CLAUDE.md"_. Y `/fabrica:bootstrap` te la ofrece al crear proyectos nuevos.

---

## Otras piezas que trabajan solas (no las llamas, pero existen)

| Pieza                      | Qué hace                                                                                                                                                                                  | Dónde vive                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **CLAUDE.md**              | Lo propio del proyecto (descripción, stack, skills del proyecto). Importa las reglas de la fábrica desde `.factory/rules/fabrica.md`: qué significa "terminado" y el ciclo de las tareas. | Raíz del repo                         |
| **factory.json**           | Los comandos del proyecto (tests, lint, tipos, build, dev), el formato, los modelos, la URL de la app y el idioma de los documentos.                                                      | Raíz del repo                         |
| **design-system.md**       | La verdad visual: colores, espaciados, tipografía y la checklist que usa el ui-reviewer.                                                                                                  | Raíz del repo                         |
| **Stop hook**              | Cada vez que Claude intenta terminar, corre los comandos de `factory.json`. Si algo falla, no lo deja terminar y le muestra el error para que siga corrigiendo.                           | Plugin (`hooks/`)                     |
| **fabrica-setup**          | Instala y actualiza la parte de la fábrica que vive en el proyecto: `init`, `check` y `refresh` (Parte 9).                                                                                | Plugin (`bin/`)                       |
| **process-backlog**        | Lo que corre `/fabrica:backlog`: busca la siguiente tarea sin bloqueos y lanza un Claude a trabajarla.                                                                                    | Plugin (`scripts/`)                   |
| **fabrica-ui-preflight**   | Levanta el servidor de ESTA app y le prohíbe al ui-reviewer fotografiar cualquier otro que ya esté respondiendo. Sin él, otro proyecto en el mismo puerto se revisa en silencio.          | Plugin (`bin/`)                       |
| **fabrica-ui-screenshots** | Saca las capturas del ui-reviewer: levanta el servidor con el preflight, fotografía los tres anchos en tema claro y oscuro, y lo apaga.                                                   | Plugin (`bin/`)                       |
| **fabrica-task-status**    | Mueve las tarjetas del tablero ("In Progress", "Blocked"). Done lo pone GitHub solo al mergear.                                                                                           | Plugin (`bin/`)                       |
| **claude-backlog.yml**     | La fábrica en la nube: trabaja una issue cuando le pones `ready-for-dev`, una por corrida.                                                                                                | `.github/workflows/`, llama al plugin |
| **claude-mentions.yml**    | Responde a `@claude` en issues y comentarios: tu línea directa desde el celular.                                                                                                          | `.github/workflows/`, llama al plugin |

---

## Parte 8: Trabajar en equipo 👥

La fábrica soporta varias personas en el mismo repo. Lo que ya hace sola, y
lo que le toca configurar al equipo:

**Automático: el reclamo por assignee.** Cuando alguien toma un ticket, se lo asigna en GitHub y verifica que nadie más lo
haya reclamado; si otro llegó primero, lo salta. Dos personas corriendo el
script a la vez no duplican trabajo. La nube también respeta los reclamos:
no toma un issue asignado a otra persona.

**Repartir por asignación (la forma más simple).** Asigna los tickets a
cada persona desde GitHub (o pídelo en el gate: "asigna el 2 y el 4 a
ana-lopez"). El script respeta las asignaciones solo con eso: los tickets de
otros son invisibles, los tuyos y los libres se procesan. Los tickets **sin
asignar son pozo común**: cualquiera los toma. Si
quieres el modo estricto que ignora el pozo, pídelo al soltar la fábrica:

```
/fabrica:backlog solo lo asignado a mí
```

(por dentro corre `fabrica-backlog` con `ONLY_MINE=1`)

> Regla mental del sistema: **asignar = reservar**. Un ticket asignado solo
> lo trabaja su dueño, y lo respetan los compañeros, la nube y el reclamo
> automático. Lo sin asignar es de quien lo tome primero.

**Carriles con `ONLY_LABEL`.** Para repartir el trabajo por áreas en vez de
competir por la misma cola: creen labels de área (`gh label create
area:billing`, `area:deportivo`, …), pídanle a write-ticket que los ponga al
crear tickets, y cada quien corre su carril:

```
/fabrica:backlog solo el carril area:billing
```

(por dentro corre `fabrica-backlog` con `ONLY_LABEL=area:billing`, solo en
esa corrida; sin carril, toma de toda la cola, como siempre)

**Dos PRs verdes contra mains distintos:** el auto-merge de la fábrica solo
mergea una rama que tiene lo último de `main`, así que sus checks probaron lo
que entra. Para los merges a mano, si tu plan tiene branch protection
(público, Pro o Team): GitHub → Settings → Branches → regla para `main` →
**"Require branches to be up to date before merging"**.

**Los tokens, cada quien paga lo suyo:**

- **Local:** automático, el script usa la sesión de Claude de quien lo
  corre; cada persona gasta su propia suscripción sin configurar nada.
- **Nube:** los workflows resuelven la credencial **según quién pidió el
  trabajo** (quien comentó `@claude` o puso la etiqueta), con esta cadena:

  1. **Token personal del actor**, buscado como secreto
     `CLAUDE_TOKEN_SU_USUARIO` (el usuario de GitHub en mayúsculas, guiones
     → `_`). Cada integrante planta el suyo una vez:

     ```bash
     claude setup-token
     gh secret set CLAUDE_TOKEN_MI_USUARIO
     ```

     Los workflows lo encuentran por el nombre; no hay mapa que editar.

  2. **API key de equipo** (`ANTHROPIC_API_KEY`): el ÚNICO fallback para
     humanos, porque es bolsa común por definición (créditos que paga el
     proyecto). Opcional: si no existe, no hay fallback.
  3. **Sin token personal y sin API key de equipo → no corre.** La fábrica
     responde en el issue con las instrucciones exactas para que esa persona
     se plante su token. Nadie trabaja con la cuenta de otro.

- **Letra pequeña de confianza:** los workflows de backlog y menciones
  reciben todos los secretos del repo (`secrets: inherit`), para poder
  buscar el token de cada persona por nombre. Cualquiera con permiso de push
  podría escribir un workflow en su propia rama y leerlos: corre con los
  secretos aunque nunca llegue a `main`, así que la branch protection no lo
  evita. Es el modelo de todo secreto de repo, pero con tokens personales
  pesa más: den permiso de push solo a gente de confianza. Con GitHub Pro o
  Team, un environment con revisores limitado a `main` cierra ese hueco.
  Una re-ejecución hecha por otra persona no corre: pediría el token de
  quien la disparó.

**Reglas de convivencia:** el label `auto-merge` es una decisión de confianza
COMPARTIDA: acuerden en equipo qué tipo de tickets lo merecen, porque
cualquiera puede etiquetar código que tocan todos; y cada persona registra el
marketplace en su máquina (Parte 1), instala el plugin en el proyecto
(`claude plugin install fabrica@fabrica-local --scope project`) y mantiene su
propio `.env.local` (los secretos no se comparten por git, así que pásense
los valores por un gestor de contraseñas de equipo).

## Parte 9: Actualizar la fábrica y migrar proyectos viejos 🔄

**Qué versión tiene cada proyecto.** `.factory/version` dice con qué versión
del plugin se instaló el proyecto. Las reglas (`.factory/rules/`) y las
llamadas a los workflows (`.github/workflows/`) son copias del plugin, y
`.factory/manifest.json` guarda una huella de cada una.

**Cuando sale una versión nueva del plugin:**

```
claude plugin update fabrica@fabrica-local
```

y dentro de Claude, en el repo: _"corre fabrica-setup refresh"_. Reemplaza
las copias que nadie tocó. Si alguien editó una a mano, no la pisa: deja la
nueva al lado como `<archivo>.fabrica-new` para que combines las dos: pasa
lo tuyo al `.fabrica-new`, reemplaza el archivo con él y borra el
`.fabrica-new`. Después commitea. Mientras falte el `refresh` o quede un
`.fabrica-new` sin combinar, `/fabrica:backlog` se niega a arrancar: un
obrero con reglas de otra versión trabajaría distinto de lo que esperas.

**Un proyecto creado con la plantilla vieja (`fabrica-template`).** Commitea o
guarda lo que tengas a medias, instala el plugin en el proyecto y pídele a
Claude _"corre fabrica-setup init"_. Reconoce la plantilla y la migra:

- borra lo que ahora trae el plugin: los scripts de la fábrica,
  `.claude/hooks/`, los revisores, las skills de la fábrica, los tests del
  kit y `user-level/`. Solo esos archivos, uno por uno;
- deja lo tuyo: `factory.json`, tus scripts, tus skills, tus tests, tus
  workflows propios;
- deja en `CLAUDE.md` la parte de tu proyecto e importa las reglas del plugin;
- quita de `.claude/settings.json` los hooks viejos, suma los permisos y
  apaga la mención a Claude en los commits (`attribution`).

Revisa el resultado con `git status` y `git diff` y commitea todo junto: si
el plugin queda activo con los hooks viejos todavía puestos, corren dos
Stop gates.

## Chuleta de comandos

```bash
# Una vez por máquina
claude plugin marketplace add <URL o ruta del repo fabrica-plugin>
claude setup-token                        # token de la nube

# Proyecto nuevo (Git Bash)
gh repo create mi-app --private --clone && cd mi-app
claude plugin install fabrica@fabrica-local --scope project
claude "/fabrica:bootstrap descripción de la app y stack"
gh secret set CLAUDE_TOKEN_TU_USUARIO     # tu token personal (pegar token guardado)

# Nueva funcionalidad (dentro de claude)
/fabrica:spec lo que quiero construir      # crea la épica (con tu OK), la spec y el PR
/fabrica:plan                               # solo si la spec paró: plan técnico, en el mismo PR
/fabrica:tasks                              # solo si el plan paró: tareas con tests primero
# ... revisar y mergear el PR de la spec ...
/fabrica:issues <número de la épica>        # issues encadenadas, con tu OK

# Soltar la fábrica (dentro de claude)
/fabrica:backlog
/fabrica:backlog solo el carril area:billing   # equipos: un carril por área
/fabrica:backlog solo lo asignado a mí

# Actualizar la fábrica
claude plugin update fabrica@fabrica-local    # y luego, dentro de claude: "corre fabrica-setup refresh"

# Ver el estado de las tareas
gh issue list --label pending        # las que faltan
gh issue list --label in-progress    # en las que trabaja
gh issue list --label needs-human    # las que piden tu ayuda

# Confiar una tarea a la noche
gh issue edit N --add-label "auto-merge"     # que se mergee sola al quedar verde
gh issue edit N --add-label "ready-for-dev"  # que la nube la procese ya

# Cambiar los modelos de la fábrica
# (editar factory.json → models y commitear: no hay que correr nada más)

# Dentro de claude
Shift+Tab   # cambiar de modo (auto ↔ plan)
/model      # cambiar el modelo de TU sesión (para planear: opus)
/exit       # salir
claude --continue   # volver a la conversación anterior
```

---

_Regla de oro: gasta tus opiniones temprano (en la spec) y tu ojo crítico al
final (en el PR). Todo lo del medio, déjaselo a la fábrica._
