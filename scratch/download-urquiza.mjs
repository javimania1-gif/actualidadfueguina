import fs from 'node:fs';

async function run() {
  const urls = [
    'https://www.legislaturasconectadas.gob.ar/img/novedades/35_monica-urquiza-2.jpg',
    'https://www.tierradelfuego.gob.ar/wp-content/uploads/2019/12/vicegobernadora-monica-urquiza.jpg',
    'https://movimientopopularfueguino.com.ar/wp-content/uploads/2023/05/monica_urquiza-1.jpg',
    'https://sur54.com/wp-content/uploads/2023/12/Monica-Urquiza.jpg',
    'https://www.eldiariodelfindelmundo.com/noticias/2023/12/17/urquiza.jpg'
  ];

  for (const url of urls) {
    console.log('Trying', url);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000 && (buf[0] === 0xff || buf[0] === 0x89 || buf[0] === 0x52)) {
        fs.writeFileSync('public/uploads/auto/urquiza.jpg', buf);
        console.log('Success with', url, buf.length, 'bytes');
        return;
      }
    } catch (e) {
      console.log('Error', e.message);
    }
  }
  console.log('All failed');
}

run();
