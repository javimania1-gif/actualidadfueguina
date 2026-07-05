# Configuración de Meta (Facebook e Instagram)

Para que el sistema de publicación automática funcione, es necesario configurar una App en Meta for Developers y vincularla con la Página de Facebook y la Cuenta Profesional de Instagram de Actualidad Fueguina.

## 1. Requisitos Previos

- Tener acceso de Administrador al **Portfolio Comercial** (Business Manager) de Actualidad Fueguina.
- La página de Facebook debe estar vinculada a una **Cuenta Profesional de Instagram**.
- Tener una cuenta en [Meta for Developers](https://developers.facebook.com/).

## 2. Creación de la App en Meta

1. Ir a **Mis apps** y hacer clic en **Crear app**.
2. Seleccionar el tipo de app: **Otro** -> **Siguiente**.
3. Seleccionar el caso de uso: **Publicar contenido en redes sociales** (o similar que incluya Graph API).
4. Nombre de la app: `Actualidad Fueguina Social`.
5. Vincular con el Portfolio Comercial de Actualidad Fueguina.

## 3. Configuración de Permisos y Tokens

### Permisos Necesarios
Para la publicación automática, la app necesita los siguientes permisos (scopes):
- `pages_manage_posts`
- `pages_read_engagement`
- `pages_show_list`
- `instagram_basic`
- `instagram_content_publish`
- `public_profile`

### Obtención del Token de Larga Duración

1. Usar el **Explorador de la Graph API**:
   - Seleccionar la App: `Actualidad Fueguina Social`.
   - Usuario/Página: Seleccionar la **Página de Facebook** de Actualidad Fueguina.
   - Agregar los permisos mencionados arriba.
   - Generar el **Access Token**.
2. Intercambiar por un token de larga duración (60 días o sin vencimiento para páginas):
   - Meta suele otorgar tokens de página que no vencen si se obtienen correctamente a través de un token de usuario de larga duración.
   - Ir a la documentación de Meta sobre [Tokens de acceso](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived) para el paso técnico de intercambio.

## 4. Identificadores (IDs)

Necesitarás obtener tres valores clave:

1.  **META_PAGE_ID**: El ID numérico de la página de Facebook. Se encuentra en la sección "Información" de la página o vía Graph API (`/me`).
2.  **META_IG_USER_ID**: El ID numérico de la cuenta de Instagram Business. Se obtiene vía Graph API consultando los `instagram_business_account` vinculados a la Page ID.
    - Consulta: `GET /v21.0/{page-id}?fields=instagram_business_account`
3.  **META_PAGE_ACCESS_TOKEN**: El token de acceso de la página (long-lived).

## 5. Configuración en GitHub

Cargar los siguientes **Secrets** en el repositorio (`Settings > Secrets and variables > Actions`):

- `META_PAGE_ID`: El ID de la página de Facebook.
- `META_IG_USER_ID`: El ID de la cuenta de Instagram.
- `META_PAGE_ACCESS_TOKEN`: El token de larga duración de la página.

## 6. Verificación y Monitoreo

- El workflow `social-publish.yml` se ejecuta automáticamente 4 veces al día.
- Puedes ejecutarlo manualmente con `workflow_dispatch` activando o desactivando el modo `dry_run`.
- Los errores se registrarán en `data/social-posts.json` y en los logs del Action.

### Errores Comunes
- **Error 100 (Param error)**: Usualmente indica que la URL de la imagen no es pública o accesible por los servidores de Meta. Asegúrate de que el sitio esté desplegado.
- **Error 190 (Invalid OAuth 2.0 Access Token)**: El token ha vencido o fue revocado. Hay que generar uno nuevo.
- **Instagram Container Error**: Instagram requiere que la imagen cumpla ciertos requisitos (aspect ratio, tamaño). El sistema genera placas de 1080x1350 (4:5) que es un formato soportado.

## 7. Renovación de Credenciales
Si el token vence (Meta suele avisar por email), repite el paso 3 y actualiza el secreto `META_PAGE_ACCESS_TOKEN` en GitHub.
