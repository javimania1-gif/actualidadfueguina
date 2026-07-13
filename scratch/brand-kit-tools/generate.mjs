import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const BRAND_DIR = path.resolve('../actualidad-fueguina-brand-kit');

// Colors
const colors = {
  blueDark: '#0b2447',
  blueLight: '#19376d',
  bluePale: '#576cbc',
  orange: '#ff8400',
  white: '#ffffff',
  gray: '#f3f4f6'
};

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {}
}

async function renderSVG(svgString, outputPath, width, height, isJpg = false) {
  try {
    const s = sharp(Buffer.from(svgString)).resize(width, height);
    if (isJpg) {
      await s.jpeg({ quality: 90 }).toFile(outputPath);
    } else {
      await s.png().toFile(outputPath);
    }
    console.log(`Generated: ${outputPath}`);
  } catch (err) {
    console.error(`Error generating ${outputPath}:`, err);
  }
}

async function generate() {
  await ensureDir(BRAND_DIR);

  // 1. Facebook Cover (1640x624)
  const coverSVG = `
  <svg width="1640" height="624" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.blueDark}" />
        <stop offset="100%" stop-color="${colors.blueLight}" />
      </linearGradient>
      <linearGradient id="mountain-grad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${colors.bluePale}" stop-opacity="0.5" />
        <stop offset="100%" stop-color="${colors.blueDark}" stop-opacity="0.8" />
      </linearGradient>
    </defs>
    <rect width="1640" height="624" fill="url(#bg-grad)" />
    <!-- Mountains / Landscape feel -->
    <path d="M0,624 L0,400 L200,300 L400,450 L600,250 L900,500 L1200,300 L1500,450 L1640,350 L1640,624 Z" fill="url(#mountain-grad)" />
    <!-- Accent Line -->
    <rect x="0" y="614" width="1640" height="10" fill="${colors.orange}" />
    <!-- Text centered in safe zone -->
    <g transform="translate(820, 312)">
      <text x="0" y="-10" font-family="Arial, sans-serif" font-size="96" font-weight="900" fill="${colors.white}" text-anchor="middle" letter-spacing="2">ACTUALIDAD FUEGUINA</text>
      <text x="0" y="60" font-family="Arial, sans-serif" font-size="32" font-weight="600" fill="${colors.orange}" text-anchor="middle" letter-spacing="4">NOTICIAS DE TIERRA DEL FUEGO AIAS</text>
    </g>
  </svg>
  `;
  await renderSVG(coverSVG, path.join(BRAND_DIR, 'facebook-cover.png'), 1640, 624);
  await renderSVG(coverSVG, path.join(BRAND_DIR, 'facebook-cover.jpg'), 1640, 624, true);

  // 2. Profile Logo
  const profileSVG = `
  <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1080" fill="${colors.blueDark}" />
    <circle cx="540" cy="540" r="480" fill="${colors.blueLight}" />
    <path d="M 540 200 L 540 880" stroke="${colors.bluePale}" stroke-width="4" opacity="0.5" />
    <path d="M 200 540 L 880 540" stroke="${colors.bluePale}" stroke-width="4" opacity="0.5" />
    
    <text x="540" y="640" font-family="Arial, sans-serif" font-size="400" font-weight="bold" fill="${colors.white}" text-anchor="middle">A<tspan fill="${colors.orange}">F</tspan></text>
  </svg>
  `;
  await renderSVG(profileSVG, path.join(BRAND_DIR, 'profile-logo-1080.png'), 1080, 1080);
  await renderSVG(profileSVG, path.join(BRAND_DIR, 'profile-logo-512.png'), 512, 512);
  await renderSVG(profileSVG, path.join(BRAND_DIR, 'favicon-512.png'), 512, 512);

  // 3. OG Default (1200x630)
  const ogSVG = `
  <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="630" fill="${colors.blueDark}" />
    <rect x="0" y="610" width="1200" height="20" fill="${colors.orange}" />
    
    <g transform="translate(600, 315)">
      <circle cx="0" cy="-60" r="100" fill="${colors.blueLight}" />
      <text x="0" y="-25" font-family="Arial, sans-serif" font-size="100" font-weight="bold" fill="${colors.white}" text-anchor="middle">A<tspan fill="${colors.orange}">F</tspan></text>
      
      <text x="0" y="110" font-family="Arial, sans-serif" font-size="64" font-weight="900" fill="${colors.white}" text-anchor="middle" letter-spacing="1">ACTUALIDAD FUEGUINA</text>
      <text x="0" y="170" font-family="Arial, sans-serif" font-size="28" font-weight="600" fill="${colors.orange}" text-anchor="middle" letter-spacing="2">NOTICIAS DE TIERRA DEL FUEGO AIAS</text>
    </g>
  </svg>
  `;
  await renderSVG(ogSVG, path.join(BRAND_DIR, 'og-default-1200x630.png'), 1200, 630);

  // 4. Instagram Post Template (1080x1080)
  const postTemplateSVG = `
  <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1080" fill="${colors.gray}" />
    
    <!-- Header -->
    <rect width="1080" height="150" fill="${colors.blueDark}" />
    <text x="50" y="95" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="${colors.white}">ACTUALIDAD FUEGUINA</text>
    <rect x="1030" y="0" width="50" height="150" fill="${colors.orange}" />
    
    <!-- Image placeholder -->
    <rect x="0" y="150" width="1080" height="600" fill="#e5e7eb" />
    <text x="540" y="470" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#9ca3af" text-anchor="middle">IMAGEN DE LA NOTICIA</text>
    
    <!-- Text area placeholder -->
    <rect x="0" y="750" width="1080" height="330" fill="${colors.white}" />
    <text x="50" y="850" font-family="Arial, sans-serif" font-size="56" font-weight="bold" fill="${colors.blueDark}">TÍTULO DE LA NOTICIA</text>
    
    <!-- Footer -->
    <rect x="0" y="1000" width="1080" height="80" fill="${colors.blueLight}" />
    <text x="540" y="1050" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="${colors.white}" text-anchor="middle" letter-spacing="2">ACTUALIDADFUEGUINA.COM</text>
  </svg>
  `;
  await renderSVG(postTemplateSVG, path.join(BRAND_DIR, 'instagram-post-template-1080.png'), 1080, 1080);

  // 5. Story/Reel Template (1080x1920)
  const storyTemplateSVG = `
  <svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1920" fill="${colors.gray}" />
    
    <!-- Header -->
    <rect width="1080" height="200" fill="${colors.blueDark}" />
    <text x="540" y="125" font-family="Arial, sans-serif" font-size="56" font-weight="bold" fill="${colors.white}" text-anchor="middle">ACTUALIDAD FUEGUINA</text>
    
    <!-- Image placeholder -->
    <rect x="50" y="250" width="980" height="980" fill="#e5e7eb" rx="20" ry="20" />
    <text x="540" y="760" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="#9ca3af" text-anchor="middle">FOTO / VIDEO</text>
    
    <!-- Text area placeholder -->
    <rect x="50" y="1300" width="980" height="400" fill="${colors.white}" rx="20" ry="20" />
    <text x="100" y="1420" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="${colors.blueDark}">TÍTULO</text>
    <text x="100" y="1520" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="${colors.blueDark}">DESTACADO</text>
    <rect x="100" y="1580" width="150" height="10" fill="${colors.orange}" />
    
    <!-- Footer -->
    <rect x="0" y="1800" width="1080" height="120" fill="${colors.blueLight}" />
    <text x="540" y="1870" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="${colors.white}" text-anchor="middle" letter-spacing="3">ACTUALIDADFUEGUINA.COM</text>
  </svg>
  `;
  await renderSVG(storyTemplateSVG, path.join(BRAND_DIR, 'story-reel-template-1080x1920.png'), 1080, 1920);

  console.log("All assets generated!");
}

generate();
