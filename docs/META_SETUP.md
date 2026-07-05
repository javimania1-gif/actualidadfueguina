# Configuración de Meta (Facebook e Instagram)

Para que el sistema de publicación automática funcione, es necesario configurar una App en Meta for Developers vinculada a la Página de Facebook y a la Cuenta Profesional de Instagram.

## 1. Requisitos Previos

- Acceso de Administrador al Portfolio Comercial (Meta Business Suite).
- Página de Facebook vinculada a una Cuenta de Instagram Business.
- Cuenta en [Meta for Developers](https://developers.facebook.com/).

## 2. Creación de la App

1. Crear una nueva App tipo **"Negocios"**.
2. Nombre: `Actualidad Fueguina Social`.
3. Casos de uso: **Facebook Login** e **Instagram Graph API**.

## 3. Permisos y Tokens

### Scopes Necesarios:
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `public_profile`.

### Proceso para Token Permanente:
1. Usar el **Explorador de Graph API** para obtener un Token de Usuario (User Access Token) con los permisos arriba.
2. Intercambiar ese token de corta duración por uno de **larga duración** (60 días) usando el endpoint `oauth/access_token?grant_type=fb_exchange_token`.
3. Con el token de usuario de larga duración, consultar `GET /v21.0/me/accounts` para obtener el **Page Access Token**. Los tokens de página obtenidos así generalmente no caducan.

## 4. Identificadores (Secrets)

Configurar en el repositorio (`Settings > Secrets > Actions`):

| Secret | Descripción |
| :--- | :--- |
| `META_PAGE_ID` | El ID numérico de la página de Facebook. |
| `META_IG_USER_ID` | El ID de la cuenta de Instagram Business. Se obtiene con `GET /v21.0/{page-id}?fields=instagram_business_account`. |
| `META_PAGE_ACCESS_TOKEN` | El Token de Acceso de la Página (long-lived). |

## 5. Funcionamiento del Sistema

- **Frecuencia**: El workflow `social-publish.yml` corre 4 veces al día.
- **Prioridad**: 1. Urgentes, 2. Resúmenes (solo noche), 3. Importancia (1-10).
- **Assets**: Si una noticia requiere placa (Instagram), se genera en el primer run y se publica en el segundo (una vez que la URL sea pública tras el commit).
- **Salud**: El workflow `social-health.yml` verifica diariamente que el token siga activo.

## 6. Resolución de Errores
- **Error 100**: La imagen no es accesible públicamente. Revisar que el deploy haya terminado.
- **Error 190**: Token vencido. Repetir paso 3.
- **Dry Run**: Se puede probar manualmente con `workflow_dispatch` -> `dry_run: true`. No genera commits ni posts reales.
