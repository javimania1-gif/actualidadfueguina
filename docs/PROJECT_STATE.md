# Actualidad Fueguina — Estado del Proyecto (Segunda Etapa)

*Documento de referencia para el desarrollo y mantenimiento del proyecto. No modificar las decisiones aquí documentadas sin discusión previa.*

## 1. Arquitectura Actual
- **Framework**: Astro (Generación de sitios estáticos).
- **Contenido**: Markdown con Frontmatter, alojado en `src/content/noticias/`.
- **Pipeline de Noticias**: Arquitectura de 3 fases implementada en Node.js puro (`collect-news.mjs`):
  1. *Fase A (Recolección)*: Extrae feeds RSS y HTML en paralelo.
  2. *Fase B (Ranking y Deduplicación)*: Materializa el texto, puntúa y descarta duplicados/genéricos.
  3. *Fase C (Redacción y Publicación)*: Genera notas usando IA Gemini, preservando cuotas (MAX_AI_PER_RUN) y balanceando fuentes oficiales vs. descubrimiento.
- **Pipeline Social**: `social-publisher.mjs` lee los archivos generados y los publica en Facebook e Instagram en base a una cola cronológica, con manejo de fallos y *pending-asset recovery* para Instagram.

## 2. Decisiones Editoriales Vigentes
- **Enfoque Local**: Las noticias de Río Grande, Ushuaia, Tolhuin y Provincia deben tener un fuerte enfoque fueguino.
- **Nacionales**: Cobertura de hechos relevantes para Argentina, evaluados por su impacto nacional.
- **Mundo**: Cobertura de acontecimientos de alto impacto global o regional. **No se debe forzar una consecuencia local fueguina** para noticias nacionales o mundiales si no existe respaldo fáctico.
- **Redacción Periodística**: No plagio, no copiar estructura del original, sin citas directas inyectadas por la IA, descripciones concisas (<180 caracteres para Astro), sin placeholders.
- **Deduplicación Estricta**: No se publican notas distintas sobre el mismo acontecimiento en un mismo run.

## 3. Categorías y Secciones
El portal cuenta con 8 categorías editoriales base, que siempre están disponibles en el menú y no deben arrojar error 404:
- `Río Grande`
- `Ushuaia`
- `Tolhuin`
- `Provincia`
- `Malvinas`
- `Antártida`
- `Nacionales`
- `Mundo`

(Malvinas y Antártida se combinan visualmente en una sola página `malvinas-antartica` pero mantienen sus categorías internas independientes).

## 4. Fuentes Activas (`config/sources.json`)
- **Oficiales**: Gobiernos de Tierra del Fuego, Río Grande, Ushuaia y Tolhuin.
- **Nacionales (filtradas TdF)**: Infobae, Perfil, Clarín (solo si mencionan keywords locales).
- **Descubrimiento Local**: Bing News (búsquedas segmentadas por ciudad y Malvinas/Antártida).
- **Nacionales (puras)**: Infobae, Perfil (umbral `minImportance >= 7`).
- **Mundo**: Google News Mundo, Clarín Mundo, Bing Mundo (umbral `minImportance >= 8`).

## 5. Automatizaciones (GitHub Actions)
- **News Pipeline (`news-pipeline.yml`)**: Ejecuta `npm run news:collect`, limpieza de borradores y build. 
- **Social Publish (`social-publish.yml`)**: Ejecuta la publicación en redes en intervalos separados para no saturar las APIs de Meta.
- **Backoff Reintentos**: Si una noticia falla (ej. texto corto) o no entra por presupuesto, el borrador en `seen.json` recibe un `nextRetryAt` con backoff exponencial (3h, 6h, 12h) antes de ser descartado (`stale`).

## 6. Tests Existentes
- `npm run test` ejecuta la suite completa.
- **Tests Sociales (`social.test.mjs`)**: Verifica prioridades, escaping de XML, exclusión de estados y durabilidad de contenedores de Instagram.
- **Tests News (`news.test.mjs`)**: Verifica presupuesto IA, scoring editorial, deduplicación transversal (Fingerprints por acontecimiento), thresholds editoriales y retries con backoff.
- **Source Health (`sources-health.mjs`)**: Prueba la conectividad y calidad de extracción de cada fuente antes de que `collect-news` inicie.

## 7. Estado Actual (Fin de Segunda Etapa)
- La **Segunda Etapa está completada**, consolidando la arquitectura de 3 fases, las nuevas secciones Nacionales y Mundo, la navegación combinada de Malvinas/Antártida y un set robusto de pruebas.
- Backfill realizado: Tolhuin, Malvinas, Antártida, Nacionales tienen noticias iniciales publicadas.

## 8. Pendientes Reales / Problemas Conocidos
- **Instagram**: Las APIs de Meta a veces demoran en procesar las imágenes. El mecanismo de `pending-asset recovery` mitigó esto, pero requiere monitoreo a largo plazo.
- **Scraping**: Algunos sitios de noticias cambian sus estructuras DOM. El fallback de Turndown mitigó esto, pero el script `news:sources-health` es la principal línea de defensa.
- **Mundo**: Se han configurado 3 fuentes. Queda pendiente monitorear si el volumen y calidad que extraen es el deseado, ya que el umbral de `minImportance: 8` es intencionalmente restrictivo.
