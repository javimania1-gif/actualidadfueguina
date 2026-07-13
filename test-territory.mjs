import { resolvePublicationTerritory } from './scripts/lib/territory-resolver.mjs';

const tests = [
  {
    name: 'Gibraltar se prepara para integrarse al Espacio Schengen',
    title: 'Gibraltar se prepara para integrarse al Espacio Schengen',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Claudia Sheinbaum visita Río Grande, Zacatecas',
    title: 'Claudia Sheinbaum visita Río Grande, Zacatecas',
    description: 'La presidenta de México estuvo hoy en el municipio de Río Grande',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Martín Perez encabezó el aniversario de Río Grande',
    title: 'Martín Perez encabezó el aniversario de Río Grande',
    description: 'El intendente celebró junto a los vecinos',
    source: { defaultCategory: 'Ushuaia', location: 'Ushuaia' } // Even if source is Ushuaia
  },
  {
    name: 'Río Grande habilitó la calle Punta Popper',
    title: 'Río Grande habilitó la calle Punta Popper',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Candela Mollá representó a Río Grande',
    title: 'Candela Mollá representó a Río Grande',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Walter Vuoto anunció una obra en Ushuaia',
    title: 'Walter Vuoto anunció una obra en Ushuaia',
    description: '',
    source: { defaultCategory: 'Rio Grande', location: 'Río Grande' }
  },
  {
    name: 'Cerro Castor inició la temporada',
    title: 'Cerro Castor inició la temporada',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Daniel Harrington presentó una actividad en Tolhuin',
    title: 'Daniel Harrington presentó una actividad en Tolhuin',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Trump anuncia una medida en Estados Unidos',
    title: 'Trump anuncia una medida en Estados Unidos',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'Irán intensifica ataques en el Golfo',
    title: 'Irán intensifica ataques en el Golfo',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  },
  {
    name: 'El Gobierno de Tierra del Fuego anunció una medida para las tres ciudades',
    title: 'El Gobierno de Tierra del Fuego anunció una medida para las tres ciudades',
    description: '',
    source: { defaultCategory: 'Ushuaia', location: 'Ushuaia' }
  },
  {
    name: 'El Congreso argentino debatirá una reforma nacional',
    title: 'El Congreso argentino debatirá una reforma nacional',
    description: '',
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  }
];

for (const t of tests) {
  const result = resolvePublicationTerritory({ title: t.title, description: t.description, source: t.source });
  console.log(`[${t.name}]`);
  console.log(`  -> Category: ${result.category} | Location: ${result.location} | Reason: ${result.reason}`);
}
