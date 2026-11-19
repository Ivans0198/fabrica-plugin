---
name: bootstrap
description: >
  Guided step-by-step setup of a project with the fabrica plugin, new or
  empty: diagnoses the repo, interviews the user (or reads their SRD),
  proposes a shell project and waits for approval, then installs everything,
  builds a walking skeleton with TDD, writes factory.json with the stack's
  commands, fills the project's {{...}} placeholders, verifies the commands really
  work, and hands off to planning, without ever starting
  to work tickets on its own. Use right after installing the plugin in a
  repo, when the user says "bootstrap", "inicializa el proyecto", "arranca
  el proyecto", "setup del proyecto", or invokes /fabrica:bootstrap.
argument-hint: "[una idea corta, un SRD/brief completo, o nada y te entrevisto]"
---

# Bootstrap: el arranque guiado

You build the **shell** (la cáscara): a walking skeleton plus the tooling the
project genuinely needs. You do NOT build the product, you do NOT plan it, and
you NEVER start working tickets. The "Autonomy boundary" rule of the factory
(`.factory/rules/fabrica.md`, or `rules/fabrica.md` in the plugin before
`fabrica-setup init`) applies here too.

**Language:** respond in the language of the user's request.

## Shape of the run

Five phases, **two hard stops**. Announce each phase as you enter it and report
what it produced as you leave it, because the human must always know where in
the run they are and what just happened. Never merge two phases into one silent
block of work: the whole point of this skill is that the human is walked
through it.

| Fase                        | Qué hace                                                                           | ¿Para?                    |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| 0 · Diagnóstico y propuesta | mira el repo, lee lo que le mandaron, entrevista si hace falta, propone la cáscara | **SÍ: espera el ok**      |
| 1 · Setup mecánico          | fabrica-setup init, dependencias, Playwright, labels                               | no (reporta)              |
| 2 · La cáscara              | walking skeleton con TDD, placeholders                                             | no (reporta)              |
| 3 · Verificación y commit   | corre todo de verdad, commitea, push                                               | no (reporta)              |
| 4 · Handoff                 | qué sigue: plan, tickets, tablero                                                  | **SÍ: pregunta y espera** |

---

## Fase 0: Diagnóstico y propuesta ⟵ PRIMERA PARADA

### 0.1 Dónde estamos (verificar, nunca asumir)

Run these and show the result as one compact block:

- Remoto: `git remote get-url origin` y
  `gh repo view --json nameWithOwner,visibility -q '.nameWithOwner + " (" + .visibility + ")"'`
- `gh auth status`. Si falla, PARA y pide `gh auth login`: sin eso no hay
  labels ni issues y media fábrica no existe.
- ¿Existe `.factory/version`? Entonces la fábrica ya está instalada; si además
  `factory.json` no tiene placeholders, este repo **ya fue bootstrapeado**.
  Dilo y pregunta antes de tocar nada.
- ¿Es un proyecto creado con la plantilla vieja (tiene
  `.claude/hooks/stop-gate.sh` o su propio `process-backlog.sh`)? Eso no es un
  bootstrap, es una migración: dilo y para.

**El repositorio de GitHub ya existe**: lo creó la persona antes de
invocarte. Tu trabajo es _decir a qué repo vas a escribir_, no crearlo.
Solo si NO hay remoto (alguien bajó la plantilla como zip o copió la carpeta)
dilo con claridad y ofrece
`gh repo create <nombre> --source=. --private --push`, esperando confirmación.
Nunca lo crees por tu cuenta.

### 0.2 Qué te mandaron

Solo hay dos casos. Di en voz alta en cuál estás:

- **Te dieron un documento** (un SRD, un brief largo: varias features,
  requisitos, secciones). Léelo entero. Extrae el stack, los servicios que
  hacen falta (auth, BD, pagos, colas) y qué es v1 frente a futuro. Pregunta
  SOLO lo genuinamente ambiguo, máximo una ronda.
- **No te dieron documento**. Da igual si fue una frase suelta ("una app de
  recetas") o nada en absoluto: en ambos toca la entrevista de una ronda
  (0.3). La única diferencia es cuánto sabes ya: si no sabes ni qué quieren
  construir, esa es la primera pregunta del mismo bloque.

Los dos casos producen material, y en los dos la Fase 2 lo escribe al repo
(ver "El documento de partida"): lo que se habla aquí no se queda solo en la
conversación.

**Aparte de esos dos, te pueden pasar un diseño**: un `.html`, un PDF, un
PNG/JPG, una exportación de Figma. No es un tercer caso: es material _extra_
que puede llegar con un documento o en lugar de él (un diseño sin texto sigue
dejándote sin spec: entrevista igual). Trátalo como ciudadano de primera.
Míralo de verdad (`Read` ve imágenes y PDFs) y en la propuesta de 0.4 di qué
pantallas trae y qué tokens de marca sacaste. Los detalles, en "Si te dan un
diseño" (Fase 2).

**Nunca planees el producto aquí.** Si el SRD te da para épicas y specs, eso no
es tu trabajo: lo ofreces en la Fase 4. `/fabrica:bootstrap` deja el terreno
listo; `/fabrica:spec` decide qué se construye encima.

### 0.3 La entrevista (una sola ronda, cuando no te dieron documento)

Ask all of them together in one block, with `AskUserQuestion` when available.
Only ask what changes the shell; nothing about the product:

0. **¿Qué quieres construir?** SOLO si llegaste sin nada. Va primero y en el
   mismo bloque, en formato abierto; las otras cuatro son de opción. Si ya te
   dieron una frase, esta pregunta ya está contestada: no la repitas.
1. **¿Quién la usa?** solo tú / público en internet / un equipo interno
   → decide si hace falta auth desde el día uno.
2. **¿Dónde corre?** web / móvil / CLI / API sin interfaz
   → decide si hay UI (Playwright, design-system, ui-reviewer) o no.
3. **¿Guarda datos?** no / local (archivo, localStorage) / base de datos real
   → decide si la cáscara trae cliente de BD y migraciones.
4. **¿Stack?** el que prefieran, o "elige tú" → si eligen tú, propón uno con
   una línea de razón.

Si contestan "no sé" a algo, elige tú y márcalo en la propuesta como **decisión
tuya**, para que puedan vetarla.

### 0.4 La propuesta de cáscara ⟵ AQUÍ PARAS

Show ONE block and wait for an explicit OK. In this order:

1. **Repo destino**: a qué `owner/repo` vas a escribir.
2. **Stack y herramientas**: lo que vas a instalar, con una línea de por qué
   para cada pieza no obvia.
3. **Qué construye la cáscara**: el walking skeleton concreto (la ruta o el
   comando que funciona de punta a punta) y cuántos tests.
4. **Qué NO incluye**: la lista explícita de lo que queda para los tickets.
   Esta lista es lo que impide que construyas de más.
5. **Modelos**: los de `factory.example.json` → `models` (worker,
   codeReviewer, uiReviewer, planning) con la regla de dedo en una línea:
   sonnet para el trabajo diario, opus solo donde el error cuesta caro. Que lo
   confirmen o lo cambien aquí mismo; no lo preguntes por separado. Aclara de
   paso, una sola vez y sin repetirlo después, que los tres primeros quedan
   configurados de verdad, mientras que `planning` es un recordatorio para sus
   propias sesiones (se elige con `/model`, no se aplica solo).
6. **Lo que pasa después**: las tres fases restantes, una línea cada una.

> **Regla de la cáscara: solo entra lo inevitable.** Framework, runner de
> tests, linter y typechecker siempre. Un servicio externo (BD, auth) entra
> SOLO si es requisito _Must_ del SRD o si salió de la entrevista, y entra
> como cliente configurado más una operación que camina, no como esquema
> completo. Todo lo demás lo construyen los tickets, revisados. Es el YAGNI
> del `CLAUDE.md` aplicado al arranque.

Si te corrigen, muestra la propuesta corregida y vuelve a esperar. No arranques
con dudas abiertas.

---

## Fase 1: Setup mecánico

Anuncia la fase. Primero `fabrica-setup init`: deja `CLAUDE.md`,
`factory.json`, `.claude/settings.json` (permisos), el `.gitignore` y las
reglas en `.factory/rules/`, sin pisar lo que ya exista. Después corre
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.sh"` (npm install, Playwright
chromium y los 13 labels). En Windows sin `bash`, corre los equivalentes:
`npm install`, `npx playwright install chromium`, y un `gh label create` por
label (pending, in-progress, needs-human, ready-for-dev, auto-merge, ui-review,
priority:high, priority:medium, priority:low, size:S, size:M, size:L, epic),
ignorando los errores de "already exists".

Los modelos que aprobaron en la propuesta se escriben en `factory.json` →
`models` cuando lo crees (más abajo, en la Fase 2). No hay que propagarlos a
ningún otro archivo: el worker lanza a cada revisor con su modelo.

Si el proyecto lleva UI, la primera corrida de Playwright pedirá permiso para
el MCP, así que avísalo antes de que aparezca, para que no parezca un error.

**Reporta al salir:** fábrica instalada ✓, dependencias ✓, navegador ✓, N labels creados / M ya
existían.

---

## Fase 2: La cáscara

Anuncia la fase. Construye EXACTAMENTE lo aprobado en 0.4, ni más ni menos.

**TDD de verdad:** escribe los tests primero, confírmalos en rojo, implementa
hasta verde. Es la primera demostración del método que la fábrica usará en cada
ticket. No lo saltes por ser "solo el esqueleto". Sigue los tokens de
`design-system.md` para cualquier UI.

### `factory.json`: los comandos del proyecto

`fabrica-setup init` ya dejó `factory.json` con los valores de ejemplo:
ajústalo al stack aprobado. Es
lo que corren el Stop gate y `checks.yml`, así que un comando mal puesto aquí
bloquea cada ticket.

- **`commands`**: cada comando es una lista de argumentos, sin shell
  (`["go", "test", "./..."]`, nunca `"go test ./..."`). Si necesita pipes,
  `&&` o variables de entorno, apunta a un script del proyecto (`npm run x`,
  `make x`) en vez de escribirlo ahí.
- **Las seis claves van siempre** (`install`, `lint`, `typecheck`, `test`,
  `build`, `e2e`). Un paso que el stack no tiene va en `null`, nunca se borra:
  una clave ausente hace fallar el gate, para que "no configurado" no se
  confunda con "no aplica". Sin UI, `e2e` va en `null`.
- **`commands.dev`**: el dev server, como lista, con el puerto fijo (ver
  abajo). Sin UI, en `null`.
- **`appUrl`**: la URL de ese dev server. Sin UI, `null`.
- **`docLang`**: `es` o `en`, el idioma de issues, specs y PRs.
- **`factoryEpic`**: queda en `null`. Ver 4.1.5.
- **`format`**: una regla por herramienta, con las extensiones que toca y el
  comando, al que el hook le agrega el archivo editado al final. Un stack sin
  formateador deja `[]`.
- **`stack`**: el nombre del perfil en `.factory/rules/stacks/` (`node-ts`
  por defecto). Si el stack no tiene perfil, ofrécelo en la Fase 4 (4.3).
- **`models`**: los modelos que aprobaron en la Fase 0 (`worker`,
  `codeReviewer`, `uiReviewer`, `planning`). Solo nombres de modelo:
  `sonnet`, `opus`, `haiku`.
- **`review.uiReview`**: `"label"` salvo que en la Fase 0 hayan pedido
  `"always"` u `"off"`.

El gate y el CI no se editan para cambiar comandos: leen `factory.json`. Los
workflows de `.github/workflows/` son llamadas cortas al plugin y tampoco se
editan. El CI del plugin solo instala Node: si el stack es otro, dilo en el
reporte, porque `checks` va a fallar en la nube hasta que el plugin traiga esa
toolchain.

### Placeholders

Reemplaza los `{{...}}` de los archivos del proyecto: `CLAUDE.md` y, si hay
UI, `design-system.md` y `tests/ui.spec.ts`. Los scripts y agentes de la
fábrica no tienen placeholders: leen `factory.json`.

**El puerto: uno propio, nunca 3000.** La URL aparece en `factory.json` →
`appUrl`, en `commands.dev`, en `playwright.config.ts` y en
`tests/ui.spec.ts`, y todos tienen que decir lo mismo. Elige un puerto libre y poco disputado
(3300-3999 va bien) y verifica que nadie lo tenga tomado antes de fijarlo:

```bash
PUERTO=3xxx  # pon aquí el candidato
curl -sS -o /dev/null --max-time 2 "http://localhost:$PUERTO"
case $? in
  0)    echo "OCUPADO, elige otro" ;;
  7|28) echo "libre" ;;
  *)    echo "no se pudo comprobar: revisa el valor de PUERTO" ;;
esac
```

3000 es el default de medio mundo. Si dos proyectos de la fábrica lo comparten,
el segundo termina sacándole capturas y corriéndole los tests visuales a la app
del primero, y nada falla: las capturas salen perfectas, solo son de otra app.
Fija el puerto en el comando del dev server **con la bandera estricta** del
framework (`vite --strictPort --port $PUERTO`, `next dev -p $PUERTO`), porque los
que se corren solos al siguiente puerto libre reintroducen justo el problema.

Rellena los placeholders mirando qué hace cada línea, nunca con un buscar y
reemplazar a ciegas.

Los placeholders de marca de `design-system.md` (`{{COLOR_PRIMARY}}`,
`{{FONT_FAMILY}}`, `{{RADIUS}}`) no se deducen de un stack. **Sí se deducen de
un diseño**: si te dieron uno, sácalos de ahí (ver abajo). Si no hay diseño,
deja los defaults documentados y dilo explícitamente en el reporte ("usé el
azul por defecto #2563EB, cámbialo en design-system.md cuando tengas
identidad").

### Si te dan un diseño (HTML, PDF, imagen, export de Figma)

Un diseño no es decoración: es la referencia contra la que el `ui-reviewer`
juzgará cada pantalla, en su **Modo A** (comparar contra el mockup), que es
bastante mejor que el Modo B (heurístico). Sin estos tres pasos, ese modo
nunca se activa y el diseño se desperdicia.

1. **Guárdalo en `docs/mockups/`** con nombre descriptivo de la pantalla
   (`home.png`, `login.png`, `checkout-paso-2.pdf`). Esa carpeta es la
   convención que buscan `write-ticket` (campo `Mockup:` de su plantilla) y el
   `ui-reviewer`. Un mockup fuera de ahí es un mockup que nadie encuentra.
2. **Extrae los tokens a `design-system.md`**: color primario, tipografía,
   radios, escala de espaciado. De un HTML/CSS los valores son exactos: léelos,
   no los estimes. De un PDF o una imagen, mírala y anota junto a cada token
   que fue leído a ojo, para que el humano lo pueda corregir.
3. **Si el diseño es HTML**, además tómale una captura y guárdala junto al
   original: el Modo A del ui-reviewer compara imágenes, y un `.html` no le
   sirve tal cual.

```bash
npx playwright screenshot --viewport-size=1440,900 file://<ruta-absoluta>.html docs/mockups/<pantalla>.png
```

**Lo que NO haces:** implementar todas las pantallas del diseño. La cáscara
sigue siendo un esqueleto que camina. El diseño te da los _tokens_ y la
_referencia_, no la licencia para construir el producto entero. Las pantallas
salen de sus tickets, cada una revisada contra su mockup. En la propuesta de
0.4, lista las pantallas que viste bajo "qué NO incluye".

### El documento de partida (siempre, venga como venga)

La Fase 0 siempre produce material: o el documento que te dieron, o las
respuestas de la entrevista. **Ese material se escribe al repo**, nunca se
queda solo en la conversación, porque es el origen de la cadena de
trazabilidad de las reglas de la fábrica (source → `plan-maestro.md` → `specs/` → issues →
código), y sin él la sesión de planeación arranca de cero y te vuelve a
preguntar lo mismo.

- **Te dieron un SRD / brief largo:** guárdalo tal cual en `docs/srd.md` (o
  déjalo donde esté si ya vive en el repo). No lo reescribas: es de ellos.
- **Salió de la entrevista** (una frase corta, o nada + entrevista): escribe
  `docs/brief.md` con lo que sí sabes, la idea en las palabras del usuario,
  las respuestas a las 4 preguntas, el stack elegido y las decisiones que
  tomaste tú (marcadas como tuyas), y lo que quedó explícitamente fuera de la
  cáscara. Corto y honesto: es un punto de partida, no una spec.

### Si hay UI

Copia el módulo visual del plugin, sin pisar lo que exista:
`design-system.md`, `tests/ui.spec.ts` y `tests/support/`, desde
`${CLAUDE_PLUGIN_ROOT}/templates/`. Después corre `fabrica-setup refresh`.
Con `tests/ui.spec.ts` presente, agrega la llamada al workflow visual del
plugin.

`playwright.config.ts` DEBE traer dos cosas.

La primera, `globalSetup`, que avisa de qué vale y qué no en cada plataforma:

```ts
// Sólo Linux tiene línea base visual versionada: en cualquier otra
// plataforma esto avisa que la comparación es informativa, y que la primera
// corrida de un checkout limpio crea las capturas que falten sin fallar por
// ello.
globalSetup: "./tests/support/visual-baseline-global-setup.ts",
```

Sin eso, quien clone el proyecto y corra Playwright por primera vez ve un
error por cada captura que se acaba de crear, con `git status` limpio, y lo
lee como una regresión visual.

La segunda, un bloque `webServer`, para que la suite levante y baje su propio
dev server:

```ts
webServer: {
  // Los mismos valores que factory.json → commands.dev y appUrl.
  command: 'npm run dev -- --port 3xxx',
  url: 'http://localhost:3xxx',
  // Off a propósito: si algo ya responde en esa URL, Playwright falla en vez
  // de adoptarlo. Un servidor ajeno en el puerto haría que la suite compare
  // baselines contra otra app. Para reusar el tuyo: FABRICA_REUSE_SERVER=1.
  reuseExistingServer: !!process.env.FABRICA_REUSE_SERVER,
  timeout: 120_000,
},
```

Sin eso, el Stop hook corre `npx playwright test` por su cuenta y cada test
falla con ERR_CONNECTION_REFUSED apenas no haya un servidor arriba, bloqueando
la sesión por algo que no tiene nada que ver con el código.

El `ui-reviewer` no usa este bloque (saca sus capturas por fuera de la suite),
así que tiene su propia protección: `fabrica-ui-preflight`, que levanta el
dev server él mismo y se niega a fotografiar cualquier servidor que no haya
arrancado. Comprueba que funciona antes de cerrar la fase:
`fabrica-ui-preflight up && fabrica-ui-preflight down`.

Genera las líneas base visuales (`npx playwright test --update-snapshots`) y
commitéalas: si no, el Stop gate del primer ticket falla por baselines
faltantes.

### Si NO hay UI

No copies el módulo visual ni crees `playwright.config.ts`. En
`factory.json`, `commands.e2e`, `commands.dev` y `appUrl` van en `null`, y
`review.uiReview` en `"off"`.

**Reporta al salir:** archivos creados, cuántos tests y qué cubren, y qué
placeholders quedaron con valor por defecto.

---

## Fase 3: Verificación real y commit

Anuncia la fase. Corre y confirma en verde, mostrando la salida real: **cada
comando que acabas de escribir en `factory.json`**, con
`fabrica-cmd <nombre>` (install, lint, typecheck, test, build
y e2e si hay UI), y el dev server sirviendo de verdad (levántalo, comprueba
HTTP 200, bájalo). Son exactamente los que correrán el Stop gate y el CI: si
uno no corre aquí, el gate del primer ticket fallará por lo mismo. Arregla lo
rojo antes de seguir. **No reportes éxito por suposición.**

**Excluye `.claude/worktrees/` y `.factory/` de la configuración del linter**
(y del typechecker si también recorre el árbol). La fábrica deja ahí un
checkout completo por cada ticket que trabaja, así que un `lint .` los recorre
y reporta el repo entero tantas veces como worktrees haya. El gate de lint deja
de servir a partir de la primera corrida, y lo que ves son cientos de errores
de código que ya está mergeado.

```bash
git add -A
git commit -m "Bootstrap: cáscara del proyecto + kit de fábrica configurado"
git push
```

Habilita auto-merge en el repo para que el label pueda funcionar (esto no
mergea nada por sí solo: solo permite que un PR que TÚ etiquetaste `auto-merge`
se mergee al quedar verde):

```bash
gh repo edit --enable-auto-merge 2>/dev/null || echo "⚠ actívalo a mano en Settings → General"
```

**Reporta al salir:** los cuatro checks con su resultado real y el commit
pusheado.

---

## Fase 4: Handoff ⟵ SEGUNDA PARADA

Anuncia la fase con un resumen del arranque completo (cáscara, verificación,
commit). Y entonces lo importante: **no empiezas a trabajar nada.**

### 4.1 Las llaves de la nube (informativo)

Primero, la GitHub App de Claude: sin ella, cada corrida en la nube falla
antes de empezar con `401 ... Claude Code is not installed on this
repository`. Se instala una vez por cuenta, en github.com/apps/claude →
Install, eligiendo este repo o todos. No se puede comprobar con `gh`: solo
una App lista sus instalaciones. Pídele que confirme que la instaló.

Después, corre `gh secret list`. Si falta `CLAUDE_TOKEN_<USUARIO_EN_MAYUSCULAS>`
(el token personal, para menciones y `ready-for-dev`), recuérdale el comando
exacto:

```bash
gh secret set CLAUDE_TOKEN_SU_USUARIO
```

`gh secret set` pide el valor sin mostrarlo, así que tiene que correrse en una
terminal normal: desde Claude, con `!`, no hay dónde pegarlo y el secreto
queda vacío. Los workflows buscan `CLAUDE_TOKEN_<USUARIO>` por nombre, así que
no hay que editarlos para sumar a una persona. Si el repo del plugin es privado, falta
además `FABRICA_PLUGIN_TOKEN`: un token que pueda leer ese repo.

### 4.1.5 El placeholder que no puedes rellenar tú (informativo)

El workflow de líneas base visuales abre un incidente cuando algo aterriza en
`main` y deja desajustada la línea base, y necesita saber de qué épica colgar
ese incidente. Ese número va en `factory.json` → `factoryEpic` y **no lo
rellenas aquí**: en el
bootstrap todavía no hay épicas, porque planear no es tu trabajo.

No lo dejes callado. Dilo en el handoff, junto a las épicas:

> Cuando crees la épica de fábrica y tooling, pon su número en
> `factory.json` → `factoryEpic`, o exporta `FACTORY_EPIC` en el entorno del
> workflow. Hasta entonces, si el gate visual
> se rompe en `main`, el script falla diciéndolo en vez de colgar el incidente
> de un issue que no tiene nada que ver.

### 4.2 Qué sigue: sugiere, explica el porqué, y deja elegir

Tu trabajo aquí es que sepan cuál es el siguiente paso y **por qué conviene
darlo así**, no imponerles un camino. Sugieres, explicas, y si prefieren otra
cosa, se hace lo que digan sin insistir.

**El mensaje es el mismo los tres casos** (SRD, frase corta, o nada), porque el
documento de partida siempre existe: `docs/srd.md` si te lo dieron,
`docs/brief.md` si salió de la entrevista. Nombra el que corresponda y di qué
tiene dentro, para que sepan que no van a repetir lo ya conversado:

> La cáscara está lista, y lo que hablamos quedó en `docs/brief.md`
> (tu idea, las respuestas de la entrevista y el stack que elegimos).
>
> El siguiente paso es planear: la spec de la primera feature (o el plan
> maestro, si el documento trae varias). Te sugiero hacerlo en una terminal
> nueva:
>
> ```
> claude                          # en la carpeta del repo
> /fabrica:spec usa docs/brief.md
> ```
>
> ¿Por qué aparte? Planear es la decisión más cara de deshacer: un error
> aquí se multiplica en cada ticket. Y esta sesión ya gastó buena parte de su
> contexto instalando y verificando, así que la spec rinde más con la ventana
> limpia.
>
> Después siguen `/fabrica:plan` y `/fabrica:tasks` en la misma rama. Cuando
> mergees ese PR, `/fabrica:issues` crea las issues (ves la tabla antes de que
> cree nada), y `/fabrica:backlog` suelta la fábrica.
>
> Si prefieres seguir aquí, escribe tú `/fabrica:spec usa docs/brief.md` en
> esta misma sesión.

Los pasos de planeación solo los arranca la persona con su comando: no los
cargues tú. Si deciden seguir en esta sesión, espera a que escriban el
comando, sin repetir la sugerencia ni hacerlos sentir que eligieron mal.

Dos cosas que NO haces en este mensaje: mencionar cambiar de modelo
(los modelos de `factory.json` ya se decidieron en la Fase 0, volver al tema
estorba), y proponer tú el contenido del plan. Decidir qué se construye es de
`/fabrica:spec`, con el humano delante.

Crear issues conserva su propia confirmación (Autonomy boundary de las
reglas): la tabla de revisión de `fabrica:issues` no se salta nunca.

**En ambos casos, ofrece el tablero** (opcional, nunca por defecto):

> ¿Quieres el tablero visual de GitHub (Projects v2)? Son 2 minutos, pero hay
> 2 cosas que solo puedes hacer tú: `gh auth refresh -s project,repo` (te abre
> el navegador) y activar 3 interruptores en la UI del Project.

Si aceptan: `gh project create --owner @me --title "<repo>"`, `gh project link`,
y `bash "${CLAUDE_PLUGIN_ROOT}/scripts/project-setup.sh" <owner> <número>`. Luego recuérdales los tres
workflows a activar (**Item added → Todo**, **Item closed → Done**, **PR merged
→ Done**) y agrupar la vista por **Parent issue**.

### 4.3 Perfil del stack (ofrécelo si falta)

Si `.factory/rules/stacks/<stack>.md` no existe para el stack elegido, ofrece
escribirlo ahí, con el mismo formato que `.factory/rules/stacks/node-ts.md`: las reglas
idiomáticas del stack (Go: envolver errores, interfaces donde se consumen,
propagar context, tests table-driven; Python: typing, ruff, fixtures de
pytest; Rails: fat models thin controllers…). Reglas que un agente pueda
APLICAR y un revisor pueda VERIFICAR, no un tutorial. Es lo que el
`code-reviewer` usa como estándar de clean code.

Si aceptan: escríbelo, pon su nombre en `factory.json` → `stack` y sugiere
subirlo al plugin para que lo usen los demás proyectos. Si no,
anota en el reporte que el revisor trabajará sin perfil hasta que exista.

---

## La regla que no se rompe

Terminas el bootstrap **sin haber trabajado un solo ticket**, pase lo que pase:
aunque existan issues `pending`, aunque los acabes de crear tú, aunque el SRD
sea clarísimo y el siguiente paso obvio. Arrancar la fábrica es una decisión
del humano y tiene su propio comando.
