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
  validateArticleAgainstFacts
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
      sourceRef: { tier: 'A', publisherDomain: 'riogrande.gob.ar', url: 'https://info.riogrande.gob.ar/nota' },
      facts: { riskLevel: 'high', organizations: ['Municipio de Rio Grande'], dates: ['2026-07-08'] }
    }]
  });
  assert.equal(event.status, 'verified-tier-a');
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

console.log(`\n=== FACTUAL TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
