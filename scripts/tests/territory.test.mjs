import assert from 'node:assert/strict';
import { resolvePublicationTerritory } from '../lib/territory-resolver.mjs';

function runTests() {
  const tests = [
    {
      name: 'DEBE DAR MUNDO: Gibraltar se prepara para integrarse al Espacio Schengen',
      title: 'Gibraltar se prepara para integrarse al Espacio Schengen',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Mundo'
    },
    {
      name: 'DEBE DAR MUNDO: Claudia Sheinbaum visita Río Grande, Zacatecas',
      title: 'Claudia Sheinbaum visita Río Grande, Zacatecas',
      description: 'La presidenta de México estuvo hoy en el municipio de Río Grande',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Mundo'
    },
    {
      name: 'DEBE DAR RÍO GRANDE: Martín Perez encabezó el aniversario de Río Grande',
      title: 'Martín Perez encabezó el aniversario de Río Grande',
      description: 'El intendente celebró junto a los vecinos',
      source: { defaultCategory: 'Ushuaia', location: 'Ushuaia' }, // source homonym test
      expectedCategory: 'Rio Grande'
    },
    {
      name: 'DEBE DAR PROVINCIA: Feria en Tolhuin y Ushuaia',
      title: 'Emprender TDF tendrá ferias en Tolhuin y Ushuaia',
      description: 'El evento se realizará el fin de semana',
      source: { defaultCategory: 'Ushuaia', location: 'Ushuaia' },
      expectedCategory: 'Provincia'
    },
    {
      name: 'DEBE DAR PROVINCIA: Operativo simultáneo en Río Grande, Tolhuin y Ushuaia',
      title: 'Actividades simultáneas en Río Grande, Tolhuin y Ushuaia',
      description: 'La medida se aplicará en las tres ciudades',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Provincia'
    },
    {
      name: 'DEBE DAR TOLHUIN: Tolhuin participará en la Fiesta Nacional del Invierno en Cerro Castor',
      title: 'Tolhuin participará en la Fiesta Nacional del Invierno en Cerro Castor',
      description: 'El Municipio de Tolhuin estará presente en el evento de Ushuaia',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Tolhuin'
    },
    {
      name: 'DEBE DAR RÍO GRANDE: Martín Perez recibió autoridades de Ushuaia en Río Grande',
      title: 'Martín Perez recibió autoridades de Ushuaia en Río Grande',
      description: 'Se reunieron en el municipio local',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Rio Grande'
    },
    {
      name: 'DEBE DAR RÍO GRANDE: Río Grande habilitó la calle Punta Popper',
      title: 'Río Grande habilitó la calle Punta Popper',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Rio Grande'
    },
    {
      name: 'DEBE DAR RÍO GRANDE: Candela Mollá representó a Río Grande',
      title: 'Candela Mollá representó a Río Grande',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Rio Grande'
    },
    {
      name: 'DEBE DAR USHUAIA: Walter Vuoto anunció una obra en Ushuaia',
      title: 'Walter Vuoto anunció una obra en Ushuaia',
      description: '',
      source: { defaultCategory: 'Rio Grande', location: 'Río Grande' },
      expectedCategory: 'Ushuaia'
    },
    {
      name: 'DEBE DAR USHUAIA: Cerro Castor inició la temporada',
      title: 'Cerro Castor inició la temporada',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Ushuaia'
    },
    {
      name: 'DEBE DAR TOLHUIN: Daniel Harrington presentó una actividad en Tolhuin',
      title: 'Daniel Harrington presentó una actividad en Tolhuin',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Tolhuin'
    },
    {
      name: 'DEBE DAR MUNDO: Trump anuncia una medida en Estados Unidos',
      title: 'Trump anuncia una medida en Estados Unidos',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Mundo'
    },
    {
      name: 'DEBE DAR MUNDO: Irán intensifica ataques en el Golfo',
      title: 'Irán intensifica ataques en el Golfo',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Mundo'
    },
    {
      name: 'DEBE DAR PROVINCIA: El Gobierno de Tierra del Fuego anunció una medida para las tres ciudades',
      title: 'El Gobierno de Tierra del Fuego anunció una medida para las tres ciudades',
      description: '',
      source: { defaultCategory: 'Ushuaia', location: 'Ushuaia' },
      expectedCategory: 'Provincia'
    },
    {
      name: 'DEBE DAR NACIONALES: El Congreso argentino debatirá una reforma nacional',
      title: 'El Congreso argentino debatirá una reforma nacional',
      description: '',
      source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' },
      expectedCategory: 'Nacionales'
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const result = resolvePublicationTerritory({ title: t.title, description: t.description, source: t.source });
    try {
      assert.strictEqual(result.category, t.expectedCategory, `Falla en test: ${t.name}`);
      passed++;
    } catch (err) {
      console.error(err.message);
      console.error(`  Esperado: ${t.expectedCategory}`);
      console.error(`  Recibido: ${result.category} (Razón: ${result.reason})`);
      failed++;
    }
  }

  console.log(`\n--- Territory Resolver Tests ---`);
  if (failed > 0) {
    console.error(`\x1b[31m❌ ${failed} tests fallaron.\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m✅ ${passed} tests pasaron.\x1b[0m`);
}

runTests();
