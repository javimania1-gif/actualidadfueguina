# Actualidad Fueguina - Brand Kit & Configuración Digital

Este directorio contiene los recursos gráficos oficiales y optimizados para establecer una identidad visual profesional en las distintas plataformas y redes sociales.

## 📁 Archivos incluidos

- \`facebook-cover.jpg\` / \`facebook-cover.png\` (1640x624)
  **Uso:** Foto de portada para la página de Facebook. Los textos están dentro de la zona segura para que no se corten en celulares ni en escritorio.

- \`profile-logo-1080.png\` (1080x1080)
  **Uso:** Foto de perfil principal para Facebook, Instagram, y Meta Business Suite. Su diseño permite que el recorte circular automático de Meta no oculte las letras principales "AF".

- \`profile-logo-512.png\` (512x512)
  **Uso:** Versión reducida del logo para otros usos o web.

- \`favicon-512.png\` (512x512)
  **Uso:** Ícono de pestaña del navegador (Favicon) y acceso directo en móviles (Apple Touch Icon).

- \`og-default-1200x630.png\` (1200x630)
  **Uso:** Imagen predeterminada Open Graph. Se mostrará cuando se comparta un enlace del sitio web en Facebook, WhatsApp o X (Twitter) y la noticia no tenga una imagen propia.

- \`instagram-post-template-1080.png\` (1080x1080)
  **Uso:** Plantilla base para crear placas cuadradas de noticias en Instagram o Facebook.

- \`story-reel-template-1080x1920.png\` (1080x1920)
  **Uso:** Plantilla vertical para Historias (Stories) y portadas de Reels.

---

## 🛠️ Instrucciones de Carga y Configuración

### 1. Facebook (Meta Business Suite)
- **Foto de perfil:** Sube \`profile-logo-1080.png\`.
- **Foto de portada:** Sube \`facebook-cover.png\`.
- **Configuración de Página:**
  - **Nombre:** Actualidad Fueguina
  - **Usuario:** @actualidadfueguina
  - **Categoría:** Sitio web de noticias y medios de comunicación
  - **Presentación (Bio):** "Noticias de Tierra del Fuego AIAS: Río Grande, Ushuaia, Tolhuin, Malvinas y Antártida. Información rápida, confiable e independiente."
  - **Sitio web:** \`https://actualidadfueguina.com.ar/\`
  - **Botón de llamada a la acción:** "Más información" (enlace a web) o "Enviar mensaje".

### 2. Instagram
- Convierte la cuenta a **Profesional / Creador** si no lo está.
- **Categoría:** Noticias / Medio de comunicación.
- **Foto de perfil:** Usa \`profile-logo-1080.png\`.
- **Bio:** 
  "Noticias de Tierra del Fuego AIAS.
  Río Grande | Ushuaia | Tolhuin | Malvinas | Antártida
  Información rápida, confiable e independiente."
- **Enlace:** Agrega \`https://actualidadfueguina.com.ar/\` en la sección de Enlaces.

### 3. Sitio Web (Astro)
Ya he dejado configurado en el código base (en \`BaseLayout.astro\` y \`site.ts\`):
- Open Graph tags correctos (\`og:title\`, \`og:description\`, \`og:image\`, \`og:url\`).
- Twitter/X Cards (\`twitter:card\`, \`twitter:image\`, etc.).
- La imagen por defecto de Open Graph usa ahora \`/og-default.png\`.
- El Favicon y logo del sitio usan las nuevas imágenes optimizadas (\`/favicon.png\`, \`/logo-af.png\`).
- Schema mínimo recomendado y sitemap (Astro requiere \`@astrojs/sitemap\`, si no está instalado se puede agregar más adelante).

### 💡 Criterios de Monetización y Calidad (Meta)
Para que Meta habilite la recomendación de la página y herramientas de monetización en el futuro, es indispensable:
1. **Contenido Original:** Desarrolla notas propias, no subas material ajeno ni plagies.
2. **Textos Legibles y Confiables:** No abuses de IA que deforme texto en las placas.
3. **Imágenes Libres de Derechos:** Usa material propio o con licencia (como Unsplash o bancos locales).
4. **No Clickbait:** Títulos veraces que reflejen la noticia sin engaños.
5. **Frecuencia y Formatos:** Intercala notas web (links) con Reels y placas originales.

¡Con esta identidad, el medio transmitirá confianza, limpieza visual y profesionalismo instantáneo!
