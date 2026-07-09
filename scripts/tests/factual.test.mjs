import assert from 'node:assert/strict';
import {
  isHomepage,
  isGenericListingUrl,
  validateArticleSource,
  countIndependentEditorialSources
} from '../lib/source-policy.mjs';
import {
  extractFacts,
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

test('dos agregadores al mismo publisher cuentan como una fuente editorial', () => {
  const refs = [
    { tier: 'B', publisherDomain: 'clarin.com', url: 'https://www.clarin.com/mundo/nota.html' },
    { tier: 'B', publisherDomain: 'clarin.com', url: 'https://www.clarin.com/mundo/nota.html' }
  ];
  assert.equal(countIndependentEditorialSources(refs), 1);
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

console.log(`\n=== FACTUAL TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
