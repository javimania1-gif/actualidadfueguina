import fs from 'node:fs';
import path from 'node:path';

const files = [
  '2026-07-11-tierra-del-fuego-inauguro-la-temporada-de-nieve-con-la-tradicional-bajada-de-ant-ccb00c.md',
  '2026-07-14-el-unico-objetivo-que-tenia-la-intervencion-era-recaudar-y-apropiarse-de-un-puer-aa2498.md',
  '2026-07-14-rio-grande-vuelve-a-alentar-a-la-seleccion-transmitiran-el-partido-entre-argenti-1afcc5.md'
];

files.forEach(f => {
  const p = path.join('src/content/noticias', f);
  let c = fs.readFileSync(p, 'utf8');
  
  c = c.replace(/imageSourceUrl: ".*?"/g, 'imageSourceUrl: "https://actualidadfueguina.com.ar"');
  c = c.replace(/sourceUrl: ".*?"/g, 'sourceUrl: "https://actualidadfueguina.com.ar"');
  
  fs.writeFileSync(p, c);
});
