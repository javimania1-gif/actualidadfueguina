# Actualidad Fueguina - Guia para agentes

## Antes de tocar codigo
- Confirmar repo: `C:\Users\Javi\Documents\GitHub\actualidadfueguina`.
- Git puede no estar en PATH. Usar GitHub Desktop si existe:
  `C:\Users\Javi\AppData\Local\GitHubDesktop\app-3.6.2\resources\app\git\cmd\git.exe`.
- Ejecutar `fetch`, comparar `HEAD` con `origin/main`, crear rama de trabajo y no editar `main` a ciegas.
- No usar `reset --hard`, `clean`, force push ni cambios destructivos sin pedido explicito.

## Pruebas
- Gate local/CI: `npm test`.
- En PowerShell local puede fallar `npm.ps1`; usar `cmd /c npm test` o ejecutar las suites con `node`.
- Las pruebas deben importar modulos reales de `scripts/lib/`; no copiar logica de produccion dentro de tests.

## Reglas editoriales duras
- No usar una homepage, portada, buscador o categoria generica como fuente de una noticia concreta.
- Google News y Bing News son descubrimiento; no cuentan como fuentes editoriales independientes.
- High-risk con una sola fuente Tier B queda `pending-verification`, no se descarta ni se publica.
- Dos fuentes Tier B independientes y concordantes pueden verificar high-risk.
- Tier A puede bastar solo dentro de su competencia.
- Conflictos criticos bloquean publicacion.
- La redaccion se valida contra `verifiedFacts`; si cambia rival, cifra, fecha u otro dato critico, se bloquea.

## Imagenes y social
- No hotlinkear como asset final. Usar `normalizeImageAsset()` o placa local.
- Meta no debe recibir hotlinks externos directos.
- `unknown` no es estado valido para cancelar. Usar `cancelled`, `needs-reconciliation`, `failed-retryable` o `failed-final`.
- Corridas locales de diagnostico no deben persistir estado salvo `AF_WRITE_STATE=true` o `--write-state`.

## Validacion E2E
- `npm test`
- `npm run build`
- Revisar `data/events.json`, `data/seen.json`, `data/social-posts.json`.
- Para Meta, usar `node scripts/social-reconcile.mjs --key=slug|facebook`; operaciones destructivas requieren `--delete --apply`.
