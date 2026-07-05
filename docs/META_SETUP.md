# Configuración de Meta (Facebook e Instagram)

Para que el sistema de publicación automática funcione, es necesario configurar una App en Meta for Developers vinculada a la Página de Facebook y a la Cuenta Profesional de Instagram.

## 1. Requisitos Previos

- Acceso de Administrador al Portfolio Comercial (Meta Business Suite).
- Página de Facebook vinculada a una Cuenta de Instagram Business.
- Cuenta en [Meta for Developers](https://developers.facebook.com/).

## 2. Creación de la App

1. Crear una nueva App de tipo **"Negocios"** (o similar que permita acceso a Graph API).
2. Nombre: `Actualidad Fueguina Social`.
3. Casos de uso requeridos:
   - **Administrar todos los aspectos de tu página** (para Facebook Feed).
   - **Administrar mensajes y contenido en Instagram** (para Content Publishing).
   - **Vincular con el Portfolio Comercial "Actualidad Fueguina"**.

## 3. Permisos y Tokens

### Scopes Necesarios:
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `public_profile`.

### Proceso para Token Permanente:
1. Usar el **Explorador de Graph API** para obtener un Token de Usuario (User Access Token) con los permisos arriba.
2. Intercambiar ese token de corta duración por uno de **larga duración** (60 días).
3. Con el token de usuario de larga duración, consultar `GET /v21.0/me/accounts` para obtener el **Page Access Token**. Los tokens de página obtenidos así generalmente no caducan.

## 4. Identificadores (Secrets)

Configurar en el repositorio (`Settings > Secrets > Actions`):

| Secret | Descripción |
| :--- | :--- |
| `META_PAGE_ID` | ID numérico de la página de Facebook. |
| `META_IG_USER_ID` | ID de la cuenta de Instagram Business (vía `/page-id?fields=instagram_business_account`). |
| `META_PAGE_ACCESS_TOKEN` | Token de Acceso de la Página (long-lived). |
| `META_GRAPH_API_VERSION` | (Opcional) Versión de la API. Por defecto `v21.0`. |

## 5. Funcionamiento del Sistema

- **Frecuencia**: El workflow `social-publish.yml` corre 4 veces al día (1 nota por run).
- **Prioridad**: 1. Urgentes, 2. Resúmenes (solo noche), 3. Importancia (1-10).
- **Assets**: El sistema verifica si una placa generada ya es pública antes de intentar postear en Instagram. Si acaba de generarse, esperará al siguiente ciclo tras el deploy.
- **Idempotencia**: Se mantiene un registro único por noticia y plataforma en `data/social-posts.json`.

## 6. Resolución de Errores
- **Dry Run**: Usar `workflow_dispatch` con `dry_run: true`. Es estrictamente informativo y no modifica el repositorio ni publica nada.
- **Salud**: `social-health.yml` verifica los tokens diariamente.
