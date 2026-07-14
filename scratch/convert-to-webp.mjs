import sharp from 'sharp';

async function convert() {
  await sharp('public/uploads/auto/urquiza.jpg')
    .webp({ quality: 80 })
    .toFile('public/uploads/auto/urquiza.webp');
  console.log('Converted to WebP successfully.');
}

convert();
