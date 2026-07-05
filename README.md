# Actualidad Fueguina — sitio estático gratuito

Base inicial para publicar Actualidad Fueguina sin hosting tradicional.

## Stack

- Astro como generador de sitio estático.
- Contenido en Markdown dentro de `src/content/noticias`.
- Imágenes en `public/uploads`.
- Edición posible desde GitHub o Pages CMS.
- Deploy recomendado: Cloudflare Pages.

## Instalación local

```bash
npm install
npm run dev
```

## Build para producción

```bash
npm run build
```

La carpeta generada será `dist/`.

## Cloudflare Pages

Configuración sugerida:

- Framework preset: Astro
- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: 20 o superior

## Dominio

Cambiar el dominio principal en:

- `astro.config.mjs`
- `src/data/site.ts`

Actualmente está configurado como `https://actualidadfueguina.com.ar`.

## Cómo cargar noticias

Crear un archivo `.md` en `src/content/noticias/` con este formato:

```md
---
title: "Título de la noticia"
description: "Bajada breve de 120 a 160 caracteres para SEO y redes sociales."
date: "2026-07-03T09:00:00-03:00"
category: "Provincia"
tags: ["Etiqueta 1", "Etiqueta 2"]
image: "/uploads/imagen.jpg"
imageAlt: "Descripción de la imagen"
author: "Actualidad Fueguina"
featured: false
location: "Río Grande"
---

Cuerpo de la noticia.
```

## Pages CMS

El archivo `.pages.yml` permite conectar el repositorio con Pages CMS para editar noticias desde una interfaz visual.
