# Actualidad Fueguina - Estado tecnico

Actualidad Fueguina es un sitio Astro estatico con contenido Markdown en `src/content/noticias/` y automatizaciones en GitHub Actions.

## Estado actual
- Rama de trabajo: `codex/stabilize-editorial-pipeline`.
- Base auditada: `cba8ea6f1e971ff8bb51c30a71d6d3466dfc1c62`.
- Git local no esta en PATH; se usa el `git.exe` incluido en GitHub Desktop.
- El pipeline separa fuente, hechos, riesgo, eventos, corroboracion, redaccion, validacion factual, imagen local y publicacion.

## Componentes clave
- `scripts/collect-news.mjs`: recoleccion, agrupacion por evento, corroboracion y publicacion.
- `scripts/lib/source-policy.mjs`: tiers de fuentes, home/listing detection y fuente editorial independiente.
- `scripts/lib/factual-utils.mjs`: extraccion deterministica de hechos, risk scoring, eventKey, corroboracion y validacion post-redaccion.
- `scripts/lib/news-utils.mjs`: extraccion HTML, redaccion IA, generacion de placas y normalizacion de imagenes.
- `scripts/lib/ai-provider.mjs`: proveedor IA configurable. Hoy soporta `github`.
- `scripts/social-publisher.mjs`: reserva/preparacion/publicacion social.
- `scripts/lib/social-state.mjs`: estados sociales explicitos.
- `scripts/social-reconcile.mjs`: verificacion segura de posts remotos Meta cuando hay token.

## Estado persistente
- `data/seen.json`: candidatos vistos y retry.
- `data/events.json`: eventos, fuentes, hechos por fuente, conflictos y pending-verification.
- `data/social-posts.json`: estado por slug/plataforma.
- `data/sources-health.json`: diagnostico de fuentes.

## Limitaciones actuales
- No hay credenciales locales `META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID` ni `META_IG_USER_ID`; la verificacion remota de Facebook no puede completarse localmente.
- No hay `GITHUB_TOKEN` local; las llamadas a GitHub Models solo corren en Actions o con token configurado.
- `npm.ps1` esta bloqueado por la policy local de PowerShell; usar `cmd /c npm test` o `node`.
