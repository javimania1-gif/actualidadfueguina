import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const BRAND_DIR = path.resolve('../actualidad-fueguina-brand-kit');
const landscapePath = 'C:\\Users\\Javi\\.gemini\\antigravity\\brain\\a2216711-386c-45b5-83c6-511a15d3c41a\\fuegian_landscape_1783983288010.jpg';

const colors = {
  blueDark: '#0b2447',
  orange: '#ff8400',
  white: '#ffffff'
};

async function generateCover() {
  const width = 1640;
  const height = 624;
  
  // Overlay SVG (Gradient and Text)
  const overlaySVG = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg-grad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${colors.blueDark}" stop-opacity="0.4" />
        <stop offset="100%" stop-color="${colors.blueDark}" stop-opacity="0.8" />
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg-grad)" />
    <!-- Accent Line -->
    <rect x="0" y="${height - 10}" width="${width}" height="10" fill="${colors.orange}" />
    <!-- Text centered in safe zone -->
    <g transform="translate(${width/2}, ${height/2})">
      <text x="0" y="-10" font-family="Arial, sans-serif" font-size="96" font-weight="900" fill="${colors.white}" text-anchor="middle" letter-spacing="2">ACTUALIDAD FUEGUINA</text>
      <text x="0" y="60" font-family="Arial, sans-serif" font-size="32" font-weight="600" fill="${colors.orange}" text-anchor="middle" letter-spacing="4">NOTICIAS DE TIERRA DEL FUEGO AIAS</text>
    </g>
  </svg>
  `;

  // Logo SVG with tweaks
  const profileSVG = `
  <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1080" fill="${colors.blueDark}" />
    <!-- Safe zone guide for Instagram/Facebook circular crop -->
    <circle cx="540" cy="540" r="540" fill="#19376d" />
    <path d="M 540 100 L 540 980" stroke="#576cbc" stroke-width="2" opacity="0.3" />
    <path d="M 100 540 L 980 540" stroke="#576cbc" stroke-width="2" opacity="0.3" />
    <!-- Letters are larger to fit the circle perfectly -->
    <text x="540" y="660" font-family="Arial, sans-serif" font-size="480" font-weight="bold" fill="${colors.white}" text-anchor="middle">A<tspan fill="${colors.orange}">F</tspan></text>
  </svg>
  `;

  try {
    console.log("Composing Facebook Cover...");
    await sharp(landscapePath)
      .resize(width, height, { fit: 'cover', position: 'center' })
      .composite([{
        input: Buffer.from(overlaySVG),
        top: 0,
        left: 0
      }])
      .png()
      .toFile(path.join(BRAND_DIR, 'facebook-cover.png'));
      
    await sharp(landscapePath)
      .resize(width, height, { fit: 'cover', position: 'center' })
      .composite([{
        input: Buffer.from(overlaySVG),
        top: 0,
        left: 0
      }])
      .jpeg({ quality: 95 })
      .toFile(path.join(BRAND_DIR, 'facebook-cover.jpg'));

    console.log("Generating Profile Logo...");
    await sharp(Buffer.from(profileSVG)).resize(1080, 1080).png().toFile(path.join(BRAND_DIR, 'profile-logo-1080.png'));
    await sharp(Buffer.from(profileSVG)).resize(512, 512).png().toFile(path.join(BRAND_DIR, 'profile-logo-512.png'));
    await sharp(Buffer.from(profileSVG)).resize(512, 512).png().toFile(path.join(BRAND_DIR, 'favicon-512.png'));

    console.log("Copying to public dir...");
    await fs.copyFile(path.join(BRAND_DIR, 'profile-logo-512.png'), path.resolve('../public/logo-af.png'));
    await fs.copyFile(path.join(BRAND_DIR, 'favicon-512.png'), path.resolve('../public/favicon.png'));

    console.log("Done!");
  } catch (err) {
    console.error(err);
  }
}

generateCover();
