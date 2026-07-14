import fs from 'node:fs';
import https from 'node:https';

// A known official image URL of Monica Urquiza
const url = 'https://movimientopopularfueguino.com.ar/wp-content/uploads/2023/05/monica_urquiza-1.jpg';
// Let's try another one if this fails
const url2 = 'https://www.tierradelfuego.gob.ar/wp-content/uploads/2019/12/vicegobernadora-monica-urquiza.jpg';

async function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 200) {
        const file = fs.createWriteStream('public/uploads/auto/urquiza.jpg');
        res.pipe(file);
        file.on('finish', () => resolve(true));
      } else {
        resolve(false);
      }
    }).on('error', reject);
  });
}

async function run() {
  let ok = await download(url);
  if (!ok) {
    console.log('Failed first url, trying second...');
    ok = await download(url2);
  }
  if (!ok) {
    console.log('Failed second url. Trying a third one...');
    const url3 = 'https://www.legislaturasconectadas.gob.ar/img/novedades/35_monica-urquiza-2.jpg';
    ok = await download(url3);
  }
  console.log('Download success:', ok);
}

run();
