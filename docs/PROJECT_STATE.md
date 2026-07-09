# Estado actual

Portal estatico Astro con pipeline automatico de noticias activo. La rama de estabilizacion `fix/editorial-agenda-and-autonomy` deja el pipeline con agenda editorial validada, metricas operativas ampliadas y schedule cada 2 horas. El objetivo operativo inmediato es sostener publicacion autonoma sin bajar factualidad.

# Arquitectura actual resumida

- `scripts/collect-news.mjs`: recolecta fuentes, materializa articulos, deduplica, agrupa eventos, corrobora, redacta con modelo, selecciona imagen, publica markdown y persiste metricas.
- `scripts/lib/factual-utils.mjs`: extrae hechos, clasifica riesgo/carril, genera claves de evento, corrobora fuentes y valida redaccion contra hechos verificados.
- `scripts/lib/editorial-agenda.mjs`: puntua historias, clasifica tema/territorio, genera agenda y excluye historias incoherentes del ranking.
- `scripts/lib/source-policy.mjs`: clasifica tier, competencia, independencia editorial y validez de fuentes.
- `data/seen.json`, `data/events.json`, `data/editorial-agenda.json`, `data/news-run-metrics.json`: estado operativo y diagnostico del pipeline.
- `src/content/noticias`: publicaciones finales del portal.

# Ultimos commits criticos

- `7bec01a fix: use site publication dates for auto news`: separa `date` del portal y `sourcePublishedAt`.
- `db8b073 fix: improve news throughput with editorial lanes`: introduce carriles fast/standard/strict.
- `53e9ad9 feat: add editorial agenda scoring`: agrega agenda editorial y scoring.
- `f78706f fix: revalidate persisted facts before publishing`: revalida hechos persistidos antes de publicar.
- `b7e4528 fix: stabilize editorial agenda autonomy`: corrige semantica de agenda, metricas, corroboracion activa limitada y schedule.

# Workflows y horarios

- `news-pipeline.yml`: push a `main` solo cuando cambian `scripts/**`, `config/sources.json`, workflow o paquetes; schedule cada 2 horas (`0 */2 * * *`).
- El bot commitea solo noticias, borradores, imagenes y archivos `data/*` permitidos; esas rutas no estan en el filtro `push.paths` del pipeline de noticias.
- `social-publish.yml`: publicacion social separada; el pipeline de noticias solo la dispara si el commit nuevo agrega `urgent: true`.

# Que funciona

- Publicacion automatica ya funciona en produccion.
- Las notas usan `date` como fecha de publicacion del portal y `sourcePublishedAt` como fecha original.
- Fast lane permite rutinas locales/oficiales sin segunda fuente cuando corresponde.
- Temas sensibles siguen protegidos por standard/strict verification.
- Agenda invalida persiste para diagnostico pero no dirige ranking ni publicacion.
- Metricas muestran descartes por causa, fuente, pending, verificados, ventanas de publicacion y outcome editorial.

# Problemas conocidos

- El volumen diario todavia puede quedar por debajo del objetivo si faltan fuentes frescas o si el modelo/API falla.
- Muchas perdidas vienen de discovery viejo, `stale-*` y URLs de listado.
- Algunos eventos locales rutinarios descubiertos por Bing quedan pending si la fuente real no alcanza competencia/independencia suficiente.
- La observabilidad social todavia no separa bien irregularidades por plataforma.
- No hay recuperacion integral validada para todos los `failed-retryable`.

# P0

- Integrar estabilizacion en `main`.
- Observar una corrida productiva completa con metricas reales.
- Confirmar que schedule cada 2 horas y corroboracion activa limitada estan activos en `main`.
- Confirmar que no hay loops de workflow por commits automaticos de `data/*`.

# P1

- Auditar fuentes con mayor descarte por `stale-*`, `listing-url` y `weak-title`.
- Mejorar match de pending local recuperable sin bajar factualidad.
- Ajustar fuentes locales utiles para subir volumen de rutinas oficiales y servicios.
- Monitorear 24-48 horas de `editorialOutcome`, publicaciones y horas desde ultima publicacion.

# Backlog futuro

- Auditoria de irregularidad Facebook vs Instagram.
- Recuperacion real de failed-retryable.
- Errores 429 en capa social.
- Redirect 301 de www.actualidadfueguina.com.ar al dominio canonico.
- Gestor de banners publicitarios propios.
- Medicion de impresiones/clics/CTR de publicidad.
- Fase B de profundidad editorial.
- Fase C fotografica.
- SEO tecnico.
- Search Console.
- Analitica.
- Contenidos de servicio.
- Periodismo basado en datos/documentos.
- Crecimiento por WhatsApp/newsletter.
- Benchmark competitivo para objetivo top 20 de Tierra del Fuego.
