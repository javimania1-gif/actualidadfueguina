# Operaciones

## Local
- Tests: `cmd /c npm test` o suites individuales con `node scripts/tests/*.mjs`.
- Build: `cmd /c npm run build` o `node_modules/.bin/astro build`.
- Corridas locales de `collect-news` y `social-publisher` no persisten estado salvo `AF_WRITE_STATE=true` o `--write-state`.

## GitHub Actions
`news-pipeline.yml` ejecuta:
1. checkout
2. setup node
3. `npm ci`
4. `npm test`
5. `news:sources-health` como preflight no fatal
6. `news:collect`
7. cleanup
8. build
9. commit/push de noticias, assets, `seen`, `events` y salud de fuentes

## Meta
Verificar un post:
`node scripts/social-reconcile.mjs --key=slug|facebook`

Eliminar remotamente requiere doble confirmacion por flags:
`node scripts/social-reconcile.mjs --key=slug|facebook --delete --apply`
