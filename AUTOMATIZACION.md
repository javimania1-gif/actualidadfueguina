# Automatización editorial de Actualidad Fueguina

## Qué hace

- Revisa fuentes oficiales y búsquedas regionales varias veces al día.
- Extrae texto e imagen principal.
- Publica automáticamente solo material oficial o de dominios oficiales, tras reescritura original con GitHub Models.
- Deja otras detecciones como borradores para revisión opcional.
- Evita duplicados mediante `data/seen.json`.
- Genera un resumen diario si hubo al menos tres noticias.
- Evalúa antes de redactar el potencial de servicio, impacto, comunidad, difusión, análisis de datos y contraste entre acontecimientos.
- Genera una agenda de oportunidades con formato y acción recomendados: noticia, Claves AF, cobertura central actualizable, perfil/entrevista o análisis supervisado.
- Los análisis simbólicos o de contraste nunca se publican automáticamente: se guardan como borradores para revisión humana.
- Incorpora fuentes comunitarias especializadas, como FUTSAL 9420, como radar; sus resultados deportivos siguen sujetos a corroboración.
- Limpia borradores de más de 10 días.
- Ejecuta un control técnico diario del build y del sitio publicado.

## Seguridad editorial

La automatización está diseñada para no publicar automáticamente contenido de medios periodísticos de terceros. Esos materiales entran como borradores. Los dominios oficiales se definen en `config/sources.json`.

## Horarios locales aproximados

Recolección: 08:17, 11:47, 15:17, 18:47 y 22:17.
Resumen diario: 21:23.
Control técnico: 07:37.

Los cron de GitHub Actions usan UTC.

## Costos

El repositorio público puede usar runners estándar de GitHub Actions sin costo por minutos. GitHub Models ofrece una capa gratuita con límites y puede cambiar; la automatización limita la cantidad de llamadas por ejecución.

## Ajustes principales

- Modelo: variable `AF_MODEL` del workflow.
- Máximo de llamadas IA: `AF_MAX_AI_PER_RUN`.
- Máximo de borradores: `AF_MAX_DRAFTS_PER_RUN`.
- Antigüedad de borradores: `AF_DRAFT_MAX_AGE_DAYS`.
- Fuentes: `config/sources.json`.
