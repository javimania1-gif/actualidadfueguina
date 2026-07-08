# Incidentes

## 2026-07-08 - Argentina/Ecuador en lugar de Argentina/Egipto

### Hecho
Durante un backfill/carga manual se creo una nota falsa que afirmaba que Argentina habia eliminado a Ecuador. El rival correcto era Egipto.

### Estado local auditado
- La nota web falsa fue retirada antes de esta intervencion.
- `data/social-posts.json` registra Facebook como publicado con `remoteId` `583685431494870_122200751534790697`.
- El mismo registro no muestra publicacion efectiva en Instagram; el estado fue cambiado a `cancelled`.
- La Fe de Erratas anterior afirmaba que no habia llegado a redes; eso fue corregido porque contradice el registro de Facebook.

### Acciones realizadas
- Fe de Erratas corregida para indicar que, segun registros tecnicos, la falsedad tambien fue distribuida en Facebook.
- Facebook de la nota falsa marcado `needs-reconciliation`.
- Instagram de la nota falsa marcado `cancelled`.
- Fe de Erratas en Instagram marcada `cancelled`.
- Se agrego `scripts/social-reconcile.mjs` para verificar/remover posts remotos con Meta Graph API cuando haya credenciales.

### Limitacion pendiente
No hay `META_PAGE_ACCESS_TOKEN` local. La verificacion remota devolvio `missing-meta-token`; no se ejecuto ninguna accion destructiva.

## 2026-07-08 - Discord Instagram media type

### Hecho
Facebook quedo publicado para `2026-07-08-discord-ia-baneos-masivos`. Instagram fallo con `Only photo or video can be accepted as media type`.

### Acciones realizadas
- Imagen externa reemplazada por placa local.
- Estado Instagram cambiado a `failed-retryable`.
- El publisher social ya no manda hotlinks externos directos a Meta.
