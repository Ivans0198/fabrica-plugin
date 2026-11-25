---
name: publish
description: Publica el proyecto en un hosting (Vercel por defecto) y lo deja verificado. Guía a la persona en lo que solo ella puede hacer (la cuenta, los permisos), comprueba el build, guarda la URL en factory.json → prodUrl y prueba producción. Solo en una sesión con una persona, y solo cuando lo pide.
argument-hint: "[vercel | netlify | cloudflare]"
disable-model-invocation: true
---

# Publicar el proyecto

Publicar es una decisión de la persona y pasa por cuentas suyas, así que esto
se hace en una sesión interactiva. Si te llegó por un worker headless o por
una mención `@claude`, responde que publicar se hace en una sesión con la
persona y para.

No es una épica ni una issue: no hay código que un worker escriba. Se corre
cuando hay algo que mostrar (lo normal, después de mergear la primera épica)
y una sola vez por proyecto. Lo que venga después lo publica el hosting solo,
con cada push a la rama base.

## Lo que no haces

- Nunca creas la cuenta del hosting, ni aceptas sus términos, ni autorizas su
  app en GitHub: lo hace la persona en su navegador.
- Nunca pides ni escribes secretos en el chat. Si el proyecto necesita
  variables de entorno con secretos, la persona las carga en el panel del
  hosting; tú solo le dices cuáles.
- Nunca haces push a la rama base ni mergeas sin su OK.

## Pasos

1. **Chequeo.** `fabrica-setup check`. Si falla, muestra su mensaje y para.
2. **El build.** `fabrica-cmd build`. Si falla, para: no se publica algo que
   no compila. Anota dónde deja el resultado (Vite: `dist/`; Next.js: lo
   maneja el hosting) y qué variables de entorno lee el código
   (`import.meta.env`, `process.env`): las que sean secretos van al panel del
   hosting, nunca al repo.
3. **El hosting.** El que diga el argumento, o el que diga
   `docs/plan-maestro.md`, `docs/brief.md` o `docs/srd.md`. Si nadie lo dice,
   recomienda Vercel: el plan Hobby es gratis, detecta Vite y Next.js solo, y
   da una vista previa por PR. Para Netlify o Cloudflare Pages los pasos son
   los mismos con otros nombres.
4. **Lo que hace la persona.** Dale los pasos exactos y espera a que termine:
   1. Crear la cuenta en vercel.com con GitHub.
   2. **Import Git Repository** e instalar la app de Vercel en GitHub dando
      acceso **solo a este repo**, no a todos.
   3. Importar el repo y revisar lo que Vercel detecta: el framework, el
      comando de build (el de `factory.json` → `commands.build`) y la
      carpeta de salida del paso 2.
   4. Cargar las variables de entorno del paso 2, si hay.
   5. **Deploy**, y pegarte la URL de producción.
5. **Verifica producción.** Antes, avísale que vas a pedir permiso para salir
   a internet (el `curl` y las pruebas contra la URL): en modo automático
   puede negarse. Si se niega, no lo rodees: pídele que abra la URL en
   escritorio y en el celular, y anota en el PR lo que no verificaste.
   - `curl -sI <url>` responde 200.
   - Si las pruebas del proyecto leen `APP_URL` (búscalo en `tests/`),
     córrelas contra producción:
     `APP_URL=<url> FABRICA_IGNORE_SNAPSHOTS=1 fabrica-cmd e2e`. Una prueba
     que solo vale en el servidor de desarrollo (un script `/src/...`, el
     cliente de Vite) falla aquí sin que sea un problema: dilo así y no la
     cuentes como fallo.
   - Si algo falla de verdad, para y explica qué.
6. **Guarda la URL.** En una rama `publicar`, `factory.json` → `prodUrl` con
   la URL, y una línea con ella en el `README.md` del proyecto. Commit y PR;
   el merge es de la persona. Si `docs/plan-maestro.md` tiene una fila de
   publicación, márcala hecha en el mismo PR y cierra su issue, si la hay.
7. **Resume:** la URL, que cada push a la rama base publica solo, que cada PR
   trae su vista previa, y lo que quedó sin verificar.
