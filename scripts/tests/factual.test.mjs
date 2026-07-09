import assert from 'node:assert/strict';
import {
  isHomepage,
  isGenericListingUrl,
  validateArticleSource,
  countIndependentEditorialSources,
  buildSourceRef,
  isTrustedLocalRoutineSource
} from '../lib/source-policy.mjs';
import {
  extractFacts,
  refreshPersistedFacts,
  generateEventKey,
  corroborateEvent,
  validateArticleAgainstFacts,
  buildEventRecord,
  EDITORIAL_LANES
} from '../lib/factual-utils.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    passed++;
  } catch (err) {
    console.error(`  fail ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n--- Factual and Source Policy ---');

test('homepage y categoria generica no son articulos', () => {
  assert.equal(isHomepage('https://www.infobae.com/'), true);
  assert.equal(isGenericListingUrl('https://www.infobae.com/politica/'), true);
});

test('articulo especifico pasa validacion basica de fuente', () => {
  const result = validateArticleSource({
    finalUrl: 'https://www.infobae.com/politica/2026/07/08/una-noticia-real/',
    article: {
      title: 'Argentina anuncia una medida nacional con impacto federal',
      text: 'Argentina anuncia una medida nacional con impacto federal. '.repeat(20),
      finalUrl: 'https://www.infobae.com/politica/2026/07/08/una-noticia-real/'
    }
  });
  assert.equal(result.ok, true);
});

test('title-body mismatch no bloquea articulo con descripcion concordante', () => {
  const result = validateArticleSource({
    finalUrl: 'https://www.actualidadtdf.com.ar/nota-local/',
    article: {
      title: 'El Municipio habilito una nueva obra vial en Rio Grande',
      description: 'El Municipio habilito una nueva obra vial en Rio Grande.',
      text: 'La intervencion mejora la circulacion barrial y forma parte del plan de infraestructura urbana. '.repeat(8),
      finalUrl: 'https://www.actualidadtdf.com.ar/nota-local/'
    }
  });
  assert.equal(result.ok, true);
});

test('extractFacts separa agenda cultural sin convertir palabras genericas en personas', () => {
  const facts = extractFacts({
    article: {
      title: 'Musica, danza y sabores locales: hoy hay Pena de la Independencia en Tolhuin',
      description: 'La actividad se realizara el 9 de julio desde las 20 horas en el Polideportivo Ezequiel Rivero.',
      text: 'La agenda cultural por el Dia de la Independencia Argentina incluye musica, danza y sabores locales en Tolhuin. '.repeat(8),
      date: '2026-07-09T12:00:00.000Z'
    },
    source: { mode: 'discovery-draft', defaultCategory: 'Tolhuin', location: 'Tolhuin' }
  });

  assert.equal(facts.eventType, 'agenda');
  assert.deepEqual(facts.teams, []);
  assert.deepEqual(facts.sportsTeams, []);
  assert(facts.countries.includes('Argentina'));
  assert(facts.places.includes('Tolhuin'));
  assert(!facts.people.some((value) => /musica|pena|independencia|invierno|nacional/i.test(value)));
  assert(facts.dates.includes('9 de julio'));
  assert(!facts.dates.some((value) => /^julio$/i.test(value)));
  assert(facts.times.some((value) => /20/.test(value)));
  assert(!facts.numbers.some((value) => /^(9|20)$/i.test(value)));
});

test('extractFacts usa paises como equipos solo en resultado deportivo', () => {
  const cultural = extractFacts({
    article: {
      title: 'Argentina sera parte de una feria cultural en Tolhuin',
      text: 'Argentina sera mencionada en una actividad cultural abierta a la comunidad. '.repeat(10),
      date: '2026-07-09'
    },
    source: { defaultCategory: 'Tolhuin' }
  });
  assert(cultural.countries.includes('Argentina'));
  assert.deepEqual(cultural.sportsTeams, []);

  const sports = extractFacts({
    article: {
      title: 'Argentina vencio a Egipto 3-2 y paso a cuartos',
      text: 'La Seleccion Argentina derroto a Egipto por 3-2 en julio de 2026. '.repeat(10),
      date: '2026-07-09'
    },
    source: { defaultCategory: 'Deportes' }
  });
  assert.equal(sports.eventType, 'sports-result');
  assert(sports.sportsTeams.includes('Argentina'));
  assert(sports.sportsTeams.includes('Egipto'));
  assert.deepEqual(sports.teams, sports.sportsTeams);
});

test('extractFacts separa dinero porcentajes horarios victimas leyes y numeros semanticos', () => {
  const facts = extractFacts({
    article: {
      title: 'Productores reclaman 600 millones tras un incendio rural',
      description: 'El pedido menciona 80% de danos, sin heridos y una audiencia a las 20:30.',
      text: 'El reclamo por 600 millones de pesos se vincula con 200 hectareas afectadas. No hubo heridos. La resolucion 123/26 fue citada el 10 de julio. '.repeat(6),
      date: '2026-07-10'
    },
    source: { defaultCategory: 'Provincia' }
  });

  assert(facts.money.some((value) => /600 millones/i.test(value)));
  assert(facts.percentages.includes('80%'));
  assert(facts.casualties.some((value) => /sin heridos|no hubo heridos/i.test(value)));
  assert(facts.times.includes('20:30'));
  assert(facts.laws.some((value) => /resolucion 123\/26/i.test(value)));
  assert(facts.numbers.some((value) => /200 hectareas/i.test(value)));
  assert(facts.dates.includes('10 de julio'));
});

test('dos agregadores al mismo publisher cuentan como una fuente editorial', () => {
  const refs = [
    { tier: 'B', publisherDomain: 'clarin.com', url: 'https://www.clarin.com/mundo/nota.html' },
    { tier: 'B', publisherDomain: 'clarin.com', url: 'https://www.clarin.com/mundo/nota.html' }
  ];
  assert.equal(countIndependentEditorialSources(refs), 1);
});

test('Bing News local no cuenta como fuente local rutinaria ni competencia municipal', () => {
  const ref = buildSourceRef({
    source: { id: 'bing-ushuaia', name: 'Bing News - Ushuaia', mode: 'discovery-draft' },
    item: { link: 'https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fwww.eldestapeweb.com%2Fsociedad%2Fnota' },
    article: {
      title: 'Alerta por un sismo en Ushuaia',
      finalUrl: 'https://www.eldestapeweb.com/sociedad/nota',
      date: '2026-07-07'
    }
  });

  assert.equal(isTrustedLocalRoutineSource(ref), false);
  assert.equal(ref.competence.includes('municipal'), false);
});

test('facts persistidos viejos se reevalúan antes de verificar eventos sensibles', () => {
  const refreshed = refreshPersistedFacts(
    {
      title: 'Alerta por un sismo de 5.9 que afecto a Ushuaia',
      riskLevel: 'low',
      editorialLane: EDITORIAL_LANES.FAST,
      eventType: 'general',
      rawSummary: 'Sismo de 5.9 en el Pasaje Drake sentido en Ushuaia. No hubo danos ni alerta de tsunami.'
    },
    {
      sourceId: 'bing-ushuaia',
      sourceName: 'Bing News - Ushuaia',
      sourceMode: 'discovery-draft',
      publishedAt: '2026-07-07T15:25:00.000Z'
    }
  );

  assert.equal(refreshed.eventType, 'weather');
  assert.equal(refreshed.riskLevel, 'high');
  assert.equal(refreshed.editorialLane, EDITORIAL_LANES.STANDARD);
});

test('una Tier B high-risk queda pending-verification', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina|egipto',
    candidates: [{
      sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/nota' },
      facts: { riskLevel: 'high', teams: ['Argentina', 'Egipto'], scores: ['3-2'], dates: ['2026-07-08'] }
    }]
  });
  assert.equal(event.status, 'pending-verification');
});

test('dos Tier B concordantes verifican high-risk', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina|egipto',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/nota' },
        facts: { riskLevel: 'high', teams: ['Argentina', 'Egipto'], scores: ['3-2'], dates: ['2026-07-08'] }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/nota' },
        facts: { riskLevel: 'high', teams: ['Argentina', 'Egipto'], scores: ['3-2'], dates: ['2026-07-08'] }
      }
    ]
  });
  assert.equal(event.verified, true);
});

test('fuente Tier A puede verificar dentro de su competencia', () => {
  const event = corroborateEvent({
    eventKey: 'official|agenda',
    candidates: [{
      sourceRef: { tier: 'A', competence: ['municipal'], publisherDomain: 'riogrande.gob.ar', url: 'https://info.riogrande.gob.ar/nota' },
      facts: { riskLevel: 'high', eventType: 'legal-policy', organizations: ['Municipio de Rio Grande'], dates: ['2026-07-08'] }
    }]
  });
  assert.equal(event.status, 'verified-tier-a');
});

test('fast lane oficial rutinario verifica con una Tier A competente', () => {
  const article = {
    title: 'Rio Grande abre inscripciones para cursos de invierno',
    description: 'El Municipio abre inscripciones para cursos y actividades.',
    text: 'El Municipio de Rio Grande abre inscripciones para cursos y actividades de invierno. '.repeat(10),
    date: '2026-07-09'
  };
  const source = { mode: 'official-auto', defaultCategory: 'Rio Grande' };
  const facts = extractFacts({ article, source });
  assert.equal(facts.editorialLane, EDITORIAL_LANES.FAST);

  const event = corroborateEvent({
    eventKey: 'fast|rio-grande|cursos',
    candidates: [{
      sourceRef: { tier: 'A', competence: ['municipal'], publisherDomain: 'riogrande.gob.ar', url: 'https://riogrande.gob.ar/cursos' },
      facts
    }]
  });
  assert.equal(event.status, 'verified-fast-lane');
  assert.equal(event.verified, true);
});

test('rutina local no sensible puede verificar con fuente local Tier B', () => {
  const article = {
    title: 'Abren inscripciones para cursos de invierno en Rio Grande',
    description: 'La agenda incluye talleres y cursos.',
    text: 'Abren inscripciones para cursos de invierno en Rio Grande. '.repeat(10),
    date: '2026-07-09'
  };
  const facts = extractFacts({ article, source: { mode: 'discovery-draft', defaultCategory: 'Rio Grande' } });
  assert.equal(facts.editorialLane, EDITORIAL_LANES.FAST);

  const event = corroborateEvent({
    eventKey: 'fast|rio-grande|cursos-local',
    candidates: [{
      sourceRef: { tier: 'B', sourceName: 'Actualidad TDF', publisherDomain: 'actualidadtdf.com.ar', url: 'https://actualidadtdf.com.ar/cursos' },
      facts
    }]
  });
  assert.equal(event.status, 'verified-local-routine');
  assert.equal(event.verified, true);
});

test('rutina no local Tier B no se publica sola', () => {
  const article = {
    title: 'Abren inscripciones para cursos de invierno en Rio Grande',
    description: 'La agenda incluye talleres y cursos.',
    text: 'Abren inscripciones para cursos de invierno en Rio Grande. '.repeat(10),
    date: '2026-07-09'
  };
  const facts = extractFacts({ article, source: { mode: 'discovery-draft', defaultCategory: 'Rio Grande' } });

  const event = corroborateEvent({
    eventKey: 'fast|rio-grande|cursos-no-local',
    candidates: [{
      sourceRef: { tier: 'B', sourceName: 'Medio nacional', publisherDomain: 'medio-nacional.com', url: 'https://medio-nacional.com/cursos' },
      facts
    }]
  });
  assert.equal(event.status, 'pending-verification');
});

test('Tier A fuera de competencia no verifica resultados deportivos', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina',
    candidates: [{
      sourceRef: { tier: 'A', competence: ['municipal'], publisherDomain: 'riogrande.gob.ar', url: 'https://info.riogrande.gob.ar/nota' },
      facts: { riskLevel: 'high', eventType: 'sports-result', teams: ['Argentina', 'Egipto'], scores: ['3-2'], dates: ['2026-07-08'] }
    }]
  });
  assert.equal(event.status, 'pending-verification');
});

test('conflictos criticos bloquean', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/nota' },
        facts: { riskLevel: 'high', teams: ['Argentina', 'Egipto'], scores: ['3-2'] }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/nota' },
        facts: { riskLevel: 'high', teams: ['Argentina', 'Ecuador'], scores: ['2-1'] }
      }
    ]
  });
  assert.equal(event.status, 'conflicting-sources');
});

test('Argentina-Egipto 3-2 vs Argentina-Ecuador 3-2 bloquea por rival distinto', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/nota' },
        facts: { riskLevel: 'high', eventType: 'sports-result', teams: ['Argentina', 'Egipto'], scores: ['3-2'] }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/nota' },
        facts: { riskLevel: 'high', eventType: 'sports-result', teams: ['Argentina', 'Ecuador'], scores: ['3-2'] }
      }
    ]
  });
  assert.equal(event.status, 'conflicting-sources');
  assert.equal(event.verified, false);
});

test('mismo partido deportivo con score distinto queda en conflicto', () => {
  const event = corroborateEvent({
    eventKey: 'sports|argentina|egipto',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/score-a' },
        facts: { riskLevel: 'high', eventType: 'sports-result', teams: ['Argentina', 'Egipto'], scores: ['3-2'] }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/score-b' },
        facts: { riskLevel: 'high', eventType: 'sports-result', teams: ['Argentina', 'Egipto'], scores: ['2-1'] }
      }
    ]
  });
  assert.equal(event.status, 'conflicting-sources');
  assert(event.conflictingFacts.some((conflict) => conflict.field === 'scores'));
});

test('diferencias secundarias entre fuentes independientes no bloquean verificacion', () => {
  const event = corroborateEvent({
    eventKey: 'turismo|gol|ushuaia',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'local-a.com', url: 'https://local-a.com/gol' },
        facts: {
          riskLevel: 'high',
          eventType: 'general',
          organizations: ['GOL'],
          places: ['Ushuaia'],
          numbers: ['3 vuelos'],
          dates: ['10 de julio']
        }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'local-b.com', url: 'https://local-b.com/gol' },
        facts: {
          riskLevel: 'high',
          eventType: 'general',
          organizations: ['GOL'],
          places: ['Ushuaia'],
          numbers: ['4 vuelos'],
          dates: ['11 de julio']
        }
      }
    ]
  });
  assert.equal(event.verified, true);
  assert.equal(event.status, 'verified-standard');
  assert.equal(event.conflictingFacts.length, 0);
  assert(event.nonCriticalDifferences.length >= 1);
});

test('fecha central de decision legal sigue siendo conflicto critico', () => {
  const event = corroborateEvent({
    eventKey: 'legal-policy|reforma',
    candidates: [
      {
        sourceRef: { tier: 'B', publisherDomain: 'local-a.com', url: 'https://local-a.com/reforma' },
        facts: {
          riskLevel: 'high',
          eventType: 'legal-policy',
          people: ['Gustavo Melella'],
          dates: ['10 de julio']
        }
      },
      {
        sourceRef: { tier: 'B', publisherDomain: 'local-b.com', url: 'https://local-b.com/reforma' },
        facts: {
          riskLevel: 'high',
          eventType: 'legal-policy',
          people: ['Gustavo Melella'],
          dates: ['11 de julio']
        }
      }
    ]
  });
  assert.equal(event.status, 'conflicting-sources');
  assert(event.conflictingFacts.some((conflict) => conflict.field === 'dates' && conflict.severity === 'critical'));
});

test('Argentina vs Egipto bloquea salida que inventa Ecuador', () => {
  const validation = validateArticleAgainstFacts(
    {
      title: 'Argentina elimino a Ecuador',
      description: 'La seleccion avanzo.',
      body: 'Argentina vencio a Ecuador y avanzo de fase.'
    },
    {
      verifiedFacts: { teams: ['Argentina', 'Egipto'], scores: [], dates: [], places: [], people: [] },
      conflicts: []
    }
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.code, 'BLOCKED_FACTUAL_MISMATCH');
});

test('5 victimas bloquea salida que altera a 50 victimas', () => {
  const validation = validateArticleAgainstFacts(
    {
      title: 'El accidente dejo 50 victimas',
      description: 'El parte oficial informo victimas.',
      body: 'El hecho dejo 50 victimas y movilizo a equipos de emergencia.'
    },
    {
      verifiedFacts: { teams: [], scores: [], dates: [], places: [], people: [], numbers: ['5 victimas'] },
      conflicts: []
    }
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.code, 'BLOCKED_FACTUAL_MISMATCH');
});

test('la validacion no exige hechos secundarios ruidosos en la salida', () => {
  const validation = validateArticleAgainstFacts(
    {
      title: 'La provincia analiza una nueva agenda institucional',
      description: 'La medida fue informada por fuentes oficiales.',
      body: 'El informe describe la agenda provincial y no agrega cifras sensibles.'
    },
    {
      verifiedFacts: {
        teams: [],
        scores: [],
        people: ['Fuego Piden'],
        places: ['Tierra del Fuego AIAS'],
        numbers: ['07', '08'],
        dates: ['2026-07-08']
      },
      conflicts: []
    }
  );
  assert.equal(validation.ok, true);
});

test('dos titulos distintos del mismo evento generan misma clave base', () => {
  const a = extractFacts({
    article: {
      title: 'Argentina vencio a Egipto 3-2 y paso a cuartos',
      text: 'Argentina vencio a Egipto 3-2 y paso a cuartos. '.repeat(15)
    }
  });
  const b = extractFacts({
    article: {
      title: 'La Seleccion derroto a Egipto y clasifico',
      text: 'La Seleccion Argentina derroto a Egipto por 3-2 y clasifico. '.repeat(15)
    }
  });
  const keyA = generateEventKey({ facts: a, title: a.title, sourceRef: { publisherDomain: 'a.com' } });
  const keyB = generateEventKey({ facts: b, title: b.title, sourceRef: { publisherDomain: 'b.com' } });
  assert.equal(keyA, keyB);
});

function fixtureCandidate({ title, text, sourceRef }) {
  const article = {
    title,
    description: text.slice(0, 180),
    text: `${title}. ${text} `.repeat(12),
    date: '2026-07-08'
  };
  const facts = extractFacts({ article, source: { defaultCategory: 'Provincia' } });
  const eventKey = generateEventKey({ facts, title, sourceRef });
  return { title, facts, eventKey, sourceRef, bodyLength: article.text.length, pubDate: new Date(article.date) };
}

function groupAndVerify(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.eventKey)) groups.set(candidate.eventKey, []);
    groups.get(candidate.eventKey).push(candidate);
  }
  return [...groups.entries()].map(([eventKey, group]) => ({
    eventKey,
    group,
    verification: corroborateEvent({ eventKey, candidates: group })
  }));
}

test('integracion A: dos Tier B mismo hecho con titulos distintos verifican un evento', () => {
  const candidates = [
    fixtureCandidate({
      title: 'Argentina vencio a Egipto 3-2 y paso a cuartos',
      text: 'La Seleccion Argentina derroto a Egipto por 3-2 en julio de 2026.',
      sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/a' }
    }),
    fixtureCandidate({
      title: 'La Seleccion derroto a Egipto y clasifico',
      text: 'Argentina vencio a Egipto por 3-2 y avanzo a cuartos en julio de 2026.',
      sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/a' }
    })
  ];
  const groups = groupAndVerify(candidates);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].verification.verified, true);
});

test('integracion B: rival deportivo distinto queda conflictivo y sin publicacion', () => {
  const candidates = [
    fixtureCandidate({
      title: 'Argentina vencio a Egipto 3-2 y paso a cuartos',
      text: 'Argentina vencio a Egipto por 3-2 en julio de 2026.',
      sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/b' }
    }),
    fixtureCandidate({
      title: 'Argentina vencio a Ecuador 3-2 y paso a cuartos',
      text: 'Argentina vencio a Ecuador por 3-2 en julio de 2026.',
      sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/b' }
    })
  ];
  const groups = groupAndVerify(candidates);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].verification.status, 'conflicting-sources');
  assert.equal(groups[0].verification.verified, false);
});

test('integracion C: pending persistido verifica al aparecer segunda fuente concordante', () => {
  const first = fixtureCandidate({
    title: 'Argentina vencio a Egipto 3-2 y paso a cuartos',
    text: 'Argentina vencio a Egipto por 3-2 en julio de 2026.',
    sourceRef: { tier: 'B', publisherDomain: 'infobae.com', url: 'https://infobae.com/c' }
  });
  const firstVerification = corroborateEvent({ eventKey: first.eventKey, candidates: [first] });
  assert.equal(firstVerification.status, 'pending-verification');

  const record = buildEventRecord({ eventKey: first.eventKey, candidates: [first], verification: firstVerification });
  const persisted = {
    sourceRef: { ...record.sources[0], publisherDomain: record.factsBySource[0].publisherDomain, url: record.factsBySource[0].url },
    facts: record.factsBySource[0].facts
  };
  const second = fixtureCandidate({
    title: 'La Seleccion derroto a Egipto y clasifico',
    text: 'Argentina vencio a Egipto por 3-2 en julio de 2026.',
    sourceRef: { tier: 'B', publisherDomain: 'clarin.com', url: 'https://clarin.com/c' }
  });
  const secondVerification = corroborateEvent({ eventKey: first.eventKey, candidates: [persisted, second] });
  assert.equal(secondVerification.verified, true);
});

test('integracion D: dos hechos diferentes en Rio Grande no se agrupan', () => {
  const candidates = [
    fixtureCandidate({
      title: 'Rio Grande inaugura un centro de monitoreo urbano',
      text: 'El Municipio de Rio Grande inaugura un centro de monitoreo urbano el 8 de julio.',
      sourceRef: { tier: 'A', competence: ['municipal'], publisherDomain: 'riogrande.gob.ar', url: 'https://riogrande.gob.ar/d1' }
    }),
    fixtureCandidate({
      title: 'Rio Grande abre inscripciones para carreras del IURP',
      text: 'El Municipio de Rio Grande abre inscripciones para carreras del IURP el 8 de julio.',
      sourceRef: { tier: 'A', competence: ['municipal'], publisherDomain: 'riogrande.gob.ar', url: 'https://riogrande.gob.ar/d2' }
    })
  ];
  assert.notEqual(candidates[0].eventKey, candidates[1].eventKey);
});

test('integracion E: mismo acontecimiento politico con entidades secundarias distintas se asocia', () => {
  const candidates = [
    fixtureCandidate({
      title: 'Melella convoca elecciones para la reforma constitucional',
      text: 'Melella convoca elecciones para la reforma constitucional el 9 de agosto con debate legislativo.',
      sourceRef: { tier: 'B', publisherDomain: 'tn.com.ar', url: 'https://tn.com.ar/e' }
    }),
    fixtureCandidate({
      title: 'Melella reactiva la reforma constitucional fueguina',
      text: 'Melella convoca elecciones para la reforma constitucional el 9 de agosto con cuestionamientos opositores.',
      sourceRef: { tier: 'B', publisherDomain: 'perfil.com', url: 'https://perfil.com/e' }
    })
  ];
  assert.equal(candidates[0].eventKey, candidates[1].eventKey);
  const verification = corroborateEvent({ eventKey: candidates[0].eventKey, candidates });
  assert.equal(verification.verified, true);
  assert(verification.consensusFacts.people.some((value) => value.includes('Melella')));
});

test('eventType nunca queda como high-risk generico', () => {
  const facts = extractFacts({
    article: {
      title: 'Iran lanza misiles y escala el conflicto internacional',
      description: 'El ataque genero alarma internacional.',
      text: 'Iran lanza misiles y escala el conflicto internacional con nuevas advertencias.'
    },
    source: { defaultCategory: 'Mundo' }
  });
  assert.equal(facts.eventType, 'international-conflict');
  assert.notEqual(facts.eventType, 'high-risk');
});

test('fast lane no captura rutina extranjera sin senal fueguina', () => {
  const facts = extractFacts({
    article: {
      title: 'EPM alerta por bloqueos que ponen en riesgo hidroelectricas en Colombia',
      description: 'La empresa informo posibles bloqueos operativos.',
      text: 'EPM alerta por bloqueos que ponen en riesgo cinco hidroelectricas en Colombia.'
    },
    source: { id: 'nacionales-infobae', name: 'Infobae', defaultCategory: 'Nacionales' }
  });
  assert.equal(facts.editorialLane, EDITORIAL_LANES.STANDARD);
  assert.equal(facts.riskLevel, 'high');
});

test('texto lateral de agenda no contamina tipo de evento internacional', () => {
  const facts = extractFacts({
    article: {
      title: 'Equipos rotos y medicos exhaustos: el sistema de salud de Cuba esta al borde del colapso',
      description: 'Hospitales cubanos atraviesan una crisis de recursos.',
      text: `${'La nota describe la crisis sanitaria en Cuba. '.repeat(20)} Agenda cultural cursos actividades servicios municipales`
    },
    source: { id: 'mundo-clarin', name: 'Clarin Mundo', defaultCategory: 'Mundo' }
  });
  assert.equal(facts.eventType, 'service');
  assert.notEqual(facts.editorialLane, EDITORIAL_LANES.FAST);
});

test('refreshPersistedFacts reemplaza evento generico por especifico sin unir basura critica', () => {
  const refreshed = refreshPersistedFacts({
    title: 'Incautan cigarrillos de contrabando en la provincia',
    eventType: 'general',
    editorialLane: EDITORIAL_LANES.FAST,
    riskLevel: 'low',
    rawSummary: 'El operativo detecto contrabando de cigarrillos.',
    numbers: ['3 usuarios'],
    money: ['10 millones de pesos']
  }, {
    sourceId: 'local-a',
    sourceName: 'Local A',
    publisherDomain: 'local-a.com',
    title: 'Incautan cigarrillos de contrabando en la provincia'
  });
  assert.equal(refreshed.eventType, 'crime');
  assert.equal(refreshed.editorialLane, EDITORIAL_LANES.STRICT);
  assert.equal(refreshed.riskLevel, 'high');
  assert.deepEqual(refreshed.money, []);
});

console.log(`\n=== FACTUAL TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
