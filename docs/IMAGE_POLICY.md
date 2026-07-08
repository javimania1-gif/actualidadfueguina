# Politica de imagenes

Todo asset editorial debe terminar local.

Ruta central:
- `normalizeImageAsset()`
- `normalizeImageBuffer()`
- placas via `generateWebPlate()` o `generateInstagramPlate()`

La normalizacion:
- sigue redirects;
- valida HTTP y Content-Type;
- limita peso;
- decodifica bytes con Sharp;
- valida dimensiones;
- rota segun metadata;
- rasteriza SVG cuando corresponde;
- convierte Web a WebP y Meta a JPEG;
- guarda en `public/uploads/auto/` o `public/uploads/social/`.

No se guarda SVG con extension JPG. No se usa `.jpg` como fallback para bytes desconocidos. Si la imagen externa no es oficial/licenciable o pertinente, se usa placa AF antes que arriesgar una imagen incorrecta.
