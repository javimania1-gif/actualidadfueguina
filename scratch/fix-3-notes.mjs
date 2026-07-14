import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'C:\\Users\\Javi\\Documents\\GitHub\\actualidadfueguina';
const files = [
  {
    name: '2026-07-11-tierra-del-fuego-inauguro-la-temporada-de-nieve-con-la-tradicional-bajada-de-ant-ccb00c.md',
    title: 'Tierra del Fuego inauguró la temporada de nieve con la tradicional bajada de antorchas en Cerro Castor',
    desc: 'Con una multitudinaria participación de familias y turistas, la Provincia dio inicio oficial a la temporada invernal 2026. El evento destacó el impacto turístico y el rol estratégico de Aerolíneas Argentinas en la conectividad fueguina.',
    cat: 'Provincia',
    loc: 'Tierra del Fuego AIAS',
    img: '/uploads/auto/2026-07-14-41ad907dc0a566ff82.webp',
    content: `El Cerro Castor fue el escenario de la tradicional Bajada de Antorchas, el evento que marca el inicio oficial de la temporada de invierno 2026 en Tierra del Fuego. Miles de residentes y turistas se congregaron para disfrutar de un espectáculo único en la nieve.

El Secretario de Turismo, Deporte y Medio Ambiente de la Nación, Daniel Scioli, participó de la jornada y destacó la importancia del evento: "Tenemos las mejores expectativas para esta temporada. El turismo es uno de los principales motores económicos de la provincia y eventos como este consolidan a Tierra del Fuego como un destino invernal de excelencia internacional", afirmó.

Por su parte, el Gobernador Gustavo Melella subrayó la inversión en infraestructura y el trabajo conjunto con el sector privado para seguir potenciando la oferta turística fueguina, haciendo especial hincapié en el rol clave que juega Aerolíneas Argentinas para mantener la conectividad del destino.

La jornada incluyó espectáculos musicales, degustaciones de gastronomía local y culminó con el emotivo descenso de decenas de esquiadores portando antorchas, iluminando la montaña en una postal ya clásica del invierno fueguino.`
  },
  {
    name: '2026-07-14-el-unico-objetivo-que-tenia-la-intervencion-era-recaudar-y-apropiarse-de-un-puer-aa2498.md',
    title: 'Fuerte polémica por el cierre del muelle de catamaranes: "El único objetivo era recaudar y apropiarse de un puerto"',
    desc: 'El presidente de la Dirección Provincial de Puertos (DPP) apuntó duramente contra la AGP por la clausura del muelle turístico en Ushuaia, calificando la medida de extorsiva y carente de fundamentos técnicos.',
    cat: 'Ushuaia',
    loc: 'Ushuaia',
    img: '/uploads/auto/2026-07-14-b10c04ce251b5f1a91.webp',
    content: `La reciente clausura del muelle de catamaranes en el Puerto de Ushuaia, ordenada por la Administración General de Puertos (AGP), desató una fuerte confrontación política e institucional en la provincia. 

El presidente de la Dirección Provincial de Puertos (DPP) salió al cruce de la medida, asegurando que la inhabilitación carece de sustento técnico real y responde a intereses netamente económicos. "El único objetivo que tenía la intervención era recaudar y apropiarse de un puerto que le pertenece a los fueguinos", disparó el funcionario.

Desde el gobierno fueguino argumentan que la AGP busca forzar una recaudación a través de la intervención, afectando directamente la operatividad turística en el momento de mayor afluencia invernal. 

"Es una medida extorsiva. Trasladaron la controversia a los operadores turísticos locales y a los miles de visitantes que llegan a conocer el Fin del Mundo, utilizando la seguridad marítima como una excusa para avanzar sobre la autonomía provincial", concluyeron desde la DPP, advirtiendo que se tomarán medidas legales para revertir la clausura.`
  },
  {
    name: '2026-07-14-rio-grande-vuelve-a-alentar-a-la-seleccion-transmitiran-el-partido-entre-argenti-1afcc5.md',
    title: 'Río Grande vuelve a alentar a la Selección: el partido contra Inglaterra se verá en pantalla gigante',
    desc: 'El Municipio transmitirá en vivo la semifinal del Mundial 2026 entre Argentina e Inglaterra. La convocatoria es libre y gratuita en el Parque de los 100 Años.',
    cat: 'Río Grande',
    loc: 'Río Grande',
    img: '/uploads/auto/2026-07-14-41e2c1765e1ef8ecea.webp',
    content: `La fiebre mundialista se enciende en Tierra del Fuego. Este miércoles, los riograndenses tendrán la oportunidad de vivir juntos la histórica semifinal del Mundial 2026 que enfrentará a la Selección Argentina contra Inglaterra.

El Municipio de Río Grande anunció la instalación de una pantalla gigante de alta definición en el Parque de los 100 Años, invitando a toda la comunidad a sumarse a la transmisión en vivo. La convocatoria, libre y gratuita, comenzará a partir de las 14:30 horas para palpitar la previa del encuentro.

"Queremos que las familias, los jóvenes y todos los vecinos puedan reunirse y compartir la pasión por nuestra selección en este momento tan importante", expresaron desde la organización municipal. 

Se recomienda a los asistentes ir abrigados dadas las bajas temperaturas típicas de esta época, y llevar sus propias sillas y termos para disfrutar de una verdadera fiesta del fútbol en comunidad.`
  }
];

async function run() {
  for (const f of files) {
    const fullPath = path.join(ROOT, 'src/content/noticias', f.name);
    
    const raw = await fs.readFile(fullPath, 'utf8');
    const sourceUrl = raw.match(/^sourceUrl:\s*["'](.*?)["']/m)?.[1] || '';
    const newMarkdown = `---
title: "${f.title}"
description: "${f.desc}"
date: "${new Date().toISOString()}"
category: "${f.cat}"
location: "${f.loc}"
tags: []
image: "${f.img}"
imageAlt: "${f.title}"
imageStrategy: "article-og"
imageSourceUrl: "${sourceUrl}"
imageLicense: "Imagen normalizada desde origen"
author: "Redacción"
featured: true
importance: 9
social:
  enabled: true
  urgent: true
sourceName: "Producción Propia"
sourceUrl: "${sourceUrl}"
detectedAt: "${new Date().toISOString()}"
---

${f.content}
`;

    await fs.writeFile(fullPath, newMarkdown, 'utf8');
    console.log('Fixed', f.name);
  }
}

run().catch(console.error);
