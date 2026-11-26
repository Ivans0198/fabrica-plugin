# fabrica-plugin

Repo del plugin `fabrica` de Claude Code y su marketplace. El plugin está en
`plugins/fabrica/`; los reusable workflows, en `.github/workflows/`; los
tests del kit, en `tests/`.

## Antes de seguir

El plan es la fuente de verdad: `docs/plan-fabrica-plugin-spec-kit.md`. Es
local: está en `.gitignore` y no se publica. Lee
su sección "Estado" antes de empezar algo, y confirma el siguiente paso con
la persona. Al terminar una tanda, actualiza esa sección y la línea "Estado"
de la fase.

## Commits

- Sin `Co-Authored-By` y sin mencionar a Anthropic ni a Claude.
- Stage por ruta, nunca `git add .` ni `-A`.
- Mensajes con Conventional Commits, en inglés (desde la 0.5.23):
  `feat(hooks): check commit subjects before a push`. La versión va como
  `chore(release): 0.5.x`.

## Publicación

El plugin está en `Ivans0198/fabrica-plugin`, privado. Los proyectos usan sus
workflows por el tag de la versión.

- Claude puede hacer push de ramas de trabajo.
- Push a `main` y tags nuevos, solo con el OK de la persona.
- Nunca `--force`, ni fork, ni cambiar remotos.

## Tests

```bash
npm install
npm test
```

- Los tests de scripts necesitan `jq` y `gh` en el PATH. Sin ellos fallan
  decenas de tests que no tienen que ver con el cambio.
- La suite completa tarda varios minutos.
- TDD: el test nuevo se ve fallar antes del cambio.
- `prettier --write` solo sobre los archivos tocados, nunca sobre una
  carpeta entera.

## Textos

En español y sin rayas largas (`—`). Cortos y concretos: lo que es una cosa
antes de lo que se hace con ella.
