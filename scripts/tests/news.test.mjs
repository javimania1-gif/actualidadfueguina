import assert from 'node:assert/strict';
import {
  editorialScore,
  isRetryEligible,
  getNextRetryAt,
  extractFingerprint,
  isEventAlreadyPublished,
  canPublishWithinRunLimit,
  isStaleRoutineWeatherForecast,
  isStaleDatedDiscoveryCandidate,
  classifyCandidateFreshness
} from '../lib/pipeline-utils.mjs';
import {
  extractFacts,
  generateEventKey,
  isOrdinaryWeatherForecastText
} from '../lib/factual-utils.mjs';
import {
  makeNewsMarkdown
} from '../lib/news-utils.mjs';
import {
  buildEditorialAgenda,
  inferAgendaTerritory,
  inferAgendaTopic,
  validateAgendaStoryCoherence,
  scoreCandidateNewsworthiness
} from '../lib/editorial-agenda.mjs';
import {
  buildCorroborationQuery,
  compactEquivalentPendingEvents,
  findMatchingPendingEventKeyInRecords,
  scoreCorroborationPriority
} from '../lib/corroboration-utils.mjs';
import { summarizeEditorialLatency } from '../lib/latency-utils.mjs';

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

console.log('\n--- News Pipeline Utils ---');

test('fuente oficial reciente supera fuente discovery antigua', () => {
  const now = new Date();
  const official = {
    pubDate: new Date(now - 30 * 60 * 1000),
    bodyLength: 1200,
    source: { mode: 'official-auto', id: 'rio-grande-oficial', defaultCategory: 'Rio Grande' }
  };
  const oldDiscovery = {
    pubDate: new Date(now - 36 * 60 * 60 * 1000),
    bodyLength: 800,
    source: { mode: 'discovery-draft', id: 'nacionales-infobae', defaultCategory: 'Nacionales' }
  };
  assert(editorialScore(official) > editorialScore(oldDiscovery));
});

test('published y duplicate no son reintentables', () => {
  assert.equal(isRetryEligible({ status: 'published', seenAt: new Date().toISOString() }), false);
  assert.equal(isRetryEligible({ status: 'duplicate', seenAt: new Date().toISOString() }), false);
});

test('pending-verification respeta nextRetryAt', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(isRetryEligible({ status: 'pending-verification', nextRetryAt: future }), false);
  assert.equal(isRetryEligible({ status: 'pending-verification', nextRetryAt: past }), true);
});

test('getNextRetryAt avanza con backoff inicial de 3 horas', () => {
  const next = new Date(getNextRetryAt(0)).getTime();
  const diff = next - Date.now();
  assert(diff > 2.9 * 60 * 60 * 1000 && diff < 3.1 * 60 * 60 * 1000);
});

test('deduplicacion editorial solo compara contra eventos publicados', () => {
  const published = new Set([
    extractFingerprint('ONU exige al Reino Unido negociar soberania de Malvinas con Argentina')
  ]);
  assert.equal(
    isEventAlreadyPublished('Argentina reclama soberania de Malvinas ante Reino Unido en la ONU', published),
    true
  );
  assert.equal(
    isEventAlreadyPublished('Productores locales reciben una nueva capacitacion alimentaria', published),
    false
  );
});

test('pronosticos ordinarios de distintas ciudades agrupan en una nota provincial diaria', () => {
  const rioGrande = extractFacts({
    article: {
      title: 'Clima hoy en Rio Grande, Tierra del Fuego: pronostico para el 8 julio de 2026',
      description: 'Temperaturas entre -2 y 4 grados.',
      text: 'El SMN anticipa cielo parcialmente nublado para Rio Grande.',
      date: '2026-07-08T03:20:46.000Z'
    },
    source: { location: 'Rio Grande', defaultCategory: 'Rio Grande' }
  });
  const ushuaia = extractFacts({
    article: {
      title: 'Clima hoy en Ushuaia, Tierra del Fuego: pronostico para el 8 julio de 2026',
      description: 'Temperaturas entre -4 y 3 grados.',
      text: 'El SMN anticipa cielo parcialmente nublado para Ushuaia.',
      date: '2026-07-08T03:07:09.000Z'
    },
    source: { location: 'Ushuaia', defaultCategory: 'Ushuaia' }
  });
  assert.equal(rioGrande.eventType, 'weather-forecast');
  assert.equal(ushuaia.eventType, 'weather-forecast');
  assert.equal(
    generateEventKey({ facts: rioGrande, title: rioGrande.title }),
    generateEventKey({ facts: ushuaia, title: ushuaia.title })
  );
});

test('alerta meteorologica no se trata como pronostico ordinario', () => {
  assert.equal(isOrdinaryWeatherForecastText('Alerta meteorologica severa por temporal en Ushuaia'), false);
});

test('pronostico rutinario viejo se descarta antes de publicar', () => {
  const now = new Date('2026-07-08T12:00:00Z').getTime();
  assert.equal(
    isStaleRoutineWeatherForecast({
      eventType: 'weather-forecast',
      weatherForecastDateKey: '2026-01-05'
    }, now),
    true
  );
  assert.equal(
    isStaleRoutineWeatherForecast({
      eventType: 'weather-forecast',
      weatherForecastDateKey: '2026-07-08'
    }, now),
    false
  );
  assert.equal(isStaleRoutineWeatherForecast({ eventType: 'weather' }, now), false);
});

test('descubrimiento con fecha vieja explicita no consume presupuesto editorial', () => {
  const now = new Date('2026-07-08T12:00:00Z').getTime();
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'discovery-draft' },
      title: 'Turismo Carretera en la Antartida Argentina: calendario 2023',
      description: 'Presentacion historica sin novedad vigente',
      now
    }),
    true
  );
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'official-auto' },
      title: 'Balance de gestion 2025',
      now
    }),
    false
  );
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'discovery-draft' },
      title: 'Argentina anuncia medidas nacionales para julio de 2026',
      pubDate: '2026-07-08T10:00:00Z',
      now
    }),
    false
  );
});

test('cupo editorial permite dos normales, tercer cupo importante y urgentes aparte', () => {
  assert.deepEqual(
    canPublishWithinRunLimit({ importance: 6, normalPublished: 1, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }),
    { ok: true, urgent: false, reason: 'within-normal-cap' }
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 6, normalPublished: 2, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).ok,
    false
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 8, normalPublished: 2, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).ok,
    true
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 9, normalPublished: 3, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).urgent,
    true
  );
});

test('cupo editorial respeta maximo diario sin bloquear urgentes', () => {
  assert.equal(
    canPublishWithinRunLimit({ importance: 4, normalPublished: 0, target: 4, maxNormal: 5, dailyPublished: 16, dailyTargetMax: 16 }).reason,
    'daily-target-max'
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 9, normalPublished: 5, target: 4, maxNormal: 5, dailyPublished: 16, dailyTargetMax: 16 }).urgent,
    true
  );
});

test('frescura separa hard news, institucional y evergreen', () => {
  const now = new Date('2026-07-09T14:00:00Z').getTime();
  assert.equal(
    classifyCandidateFreshness({
      source: { mode: 'discovery-draft' },
      facts: { editorialLane: 'standard' },
      pubDate: new Date('2026-07-08T08:30:00Z'),
      sourceHasDate: true,
      now
    }).ok,
    true
  );
  assert.equal(
    classifyCandidateFreshness({
      source: { mode: 'discovery-draft' },
      facts: { editorialLane: 'standard' },
      pubDate: new Date('2026-07-06T12:00:00Z'),
      sourceHasDate: true,
      now
    }).reason,
    'evergreen-or-stale-outside-news-window'
  );
  assert.equal(
    classifyCandidateFreshness({
      source: { mode: 'official-auto' },
      facts: { editorialLane: 'fast' },
      pubDate: new Date('2026-07-07T08:00:00Z'),
      sourceHasDate: true,
      now
    }).ok,
    true
  );
  assert.equal(
    classifyCandidateFreshness({
      source: { mode: 'discovery-draft' },
      facts: { editorialLane: 'standard' },
      pubDate: new Date('2026-07-09T14:00:00Z'),
      sourceHasDate: false,
      now
    }).reason,
    'undated-discovery'
  );
});

test('markdown separa fecha de publicacion y fecha original de fuente', () => {
  const md = makeNewsMarkdown({
    ai: {
      title: 'Nueva actividad cultural en Rio Grande',
      description: 'El municipio anuncio una actividad cultural abierta a la comunidad durante esta semana.',
      category: 'Rio Grande',
      location: 'Rio Grande',
      tags: ['cultura', 'Rio Grande'],
      imageAlt: 'Actividad cultural',
      body: 'El municipio informo una nueva actividad cultural abierta a la comunidad.',
      importance: 4
    },
    date: new Date('2026-07-09T13:47:08.000Z'),
    sourcePublishedAt: new Date('2026-06-30T12:00:00.000Z'),
    image: '/uploads/auto/prueba.webp',
    sourceName: 'Fuente local',
    sourceUrl: 'https://example.com/nota'
  });

  assert.match(md, /date: "2026-07-09T13:47:08\.000Z"/);
  assert.match(md, /sourcePublishedAt: "2026-06-30T12:00:00\.000Z"/);
});

test('newsworthiness prioriza historia local util frente a nacional menor', () => {
  const local = scoreCandidateNewsworthiness({
    title: 'Tolhuin abre inscripciones para cursos de invierno',
    facts: {
      eventType: 'agenda',
      editorialLane: 'fast',
      places: ['Tolhuin'],
      dates: ['10 de julio'],
      times: ['20 horas'],
      rawSummary: 'Inscripciones abiertas para cursos y actividades.'
    },
    source: { mode: 'official-auto', defaultCategory: 'Tolhuin', location: 'Tolhuin' },
    sourceRef: { tier: 'A', publisherDomain: 'tolhuin.gob.ar' },
    pubDate: new Date()
  });
  const nationalMinor = scoreCandidateNewsworthiness({
    title: 'Una celebridad internacional compartio una foto viral',
    facts: {
      eventType: 'general',
      countries: ['Estados Unidos'],
      rawSummary: 'Contenido liviano sin impacto provincial directo.'
    },
    source: { mode: 'discovery-draft', defaultCategory: 'Mundo' },
    sourceRef: { tier: 'B', publisherDomain: 'example.com' },
    pubDate: new Date()
  });

  assert.equal(local.topic, 'agenda');
  assert.equal(local.territory, 'Tolhuin');
  assert(local.newsworthinessScore > nationalMinor.newsworthinessScore);
});

test('agenda editorial registra historias con tema territorio y score', () => {
  const events = {
    events: {
      'agenda|tolhuin|cursos': {
        eventKey: 'agenda|tolhuin|cursos',
        firstDetectedAt: '2026-07-09T12:00:00.000Z',
        lastSeenAt: '2026-07-09T13:00:00.000Z',
        editorialLane: 'fast',
        status: 'verified-fast-lane',
        sources: [{ tier: 'A', publisherDomain: 'tolhuin.gob.ar', sourceMode: 'official-auto' }],
        verifiedFacts: {
          eventType: 'agenda',
          places: ['Tolhuin'],
          dates: ['10 de julio'],
          rawSummary: 'Inscripciones abiertas para cursos de invierno.'
        },
        factsBySource: [{
          facts: {
            title: 'Tolhuin abre inscripciones para cursos de invierno',
            eventType: 'agenda',
            places: ['Tolhuin'],
            rawSummary: 'Inscripciones abiertas para cursos de invierno.'
          }
        }]
      }
    }
  };
  const agenda = buildEditorialAgenda(events, { now: new Date('2026-07-09T14:00:00.000Z') });
  assert.equal(agenda.summary.totalStories, 1);
  assert.equal(agenda.stories[0].topic, 'agenda');
  assert.equal(agenda.stories[0].territory, 'Tolhuin');
  assert(agenda.stories[0].newsworthinessScore > 0);
});

test('agenda territorial no cae a Provincia para noticias externas', () => {
  assert.equal(inferAgendaTerritory({
    title: 'Sismo en CDMX deja demoras en servicios',
    facts: { countries: ['Mexico'], places: ['CDMX'] },
    category: 'Mundo'
  }), 'Mundo');
  assert.equal(inferAgendaTerritory({
    title: 'Milei y el FMI revisan metas del acuerdo',
    facts: { people: ['Javier Milei'], organizations: ['FMI'] },
    category: 'Nacionales'
  }), 'Nacionales');
  assert.equal(inferAgendaTerritory({
    title: 'Villa Allende y Chaco definen nuevas medidas',
    facts: { places: ['Villa Allende', 'Chaco'] },
    category: 'Nacionales'
  }), 'Nacionales');
});

test('agenda territorial prioriza localidad explicita del titulo sobre lugares ruidosos', () => {
  assert.equal(inferAgendaTerritory({
    title: 'Gobierno llevo a cabo una jornada de competencias en la Casa del Deporte de Tolhuin',
    facts: {
      rawSummary: 'En la Casa del Deporte de Tolhuin se disputaron dos torneos internos.',
      places: ['Rio Grande', 'Ushuaia', 'Tolhuin', 'Tierra del Fuego']
    },
    category: 'Rio Grande'
  }), 'Tolhuin');
});

test('agenda clasifica contrabando como policiales y defensa internacional como politica', () => {
  assert.equal(inferAgendaTopic({
    facts: { eventType: 'crime', rawSummary: 'Contrabando de cigarrillos detectado en un operativo.' },
    title: 'Incautan cigarrillos de contrabando'
  }), 'policiales');
  assert.equal(inferAgendaTopic({
    facts: { eventType: 'territorial-sovereignty', rawSummary: 'Buque britanico cerca de Malvinas.' },
    title: 'Advierten por buque britanico en el Atlantico Sur'
  }), 'politica');
});

test('agenda invalida historias incoherentes y las excluye del top', () => {
  const story = {
    storyId: 'weather-forecast|2026-07-10|tierra-del-fuego',
    headlineSeed: 'Buque britanico vuelve a operar cerca de Malvinas',
    topic: 'servicios',
    territory: 'Provincia',
    primaryEntities: ['Malvinas', 'Reino Unido'],
    eventType: 'territorial-sovereignty',
    newsworthinessScore: 95
  };
  const validation = validateAgendaStoryCoherence(story);
  assert.equal(validation.ok, false);
  assert(validation.reasons.includes('story-headline-mismatch'));
  assert(validation.reasons.includes('topic-event-mismatch'));

  const agenda = buildEditorialAgenda({
    events: {
      'weather-forecast|2026-07-10|tierra-del-fuego': {
        eventKey: 'weather-forecast|2026-07-10|tierra-del-fuego',
        status: 'pending-verification',
        lastSeenAt: '2026-07-09T13:00:00.000Z',
        verifiedFacts: {
          eventType: 'territorial-sovereignty',
          places: ['Malvinas'],
          countries: ['Reino Unido'],
          rawSummary: 'Buque britanico vuelve a operar cerca de Malvinas.'
        },
        factsBySource: [{
          facts: {
            title: 'Buque britanico vuelve a operar cerca de Malvinas',
            eventType: 'territorial-sovereignty',
            places: ['Malvinas'],
            countries: ['Reino Unido']
          }
        }]
      }
    }
  }, { now: new Date('2026-07-09T14:00:00.000Z') });
  assert.equal(agenda.summary.invalidStories, 1);
  assert.equal(agenda.summary.topStories.length, 0);
});

test('agenda usa fecha de fuente para frescura de eventos persistidos', () => {
  const agenda = buildEditorialAgenda({
    events: {
      'general|salud|abril-de-2023': {
        eventKey: 'general|salud|abril-de-2023',
        status: 'verified',
        firstDetectedAt: '2026-07-09T10:00:00.000Z',
        lastSeenAt: '2026-07-09T23:00:00.000Z',
        sources: [{
          tier: 'A',
          publisherDomain: 'info.riogrande.gob.ar',
          sourceMode: 'official-auto',
          publishedAt: '2023-04-12T12:00:00.000Z'
        }],
        verifiedFacts: {
          eventType: 'general',
          places: ['Rio Grande'],
          dates: ['abril de 2023'],
          rawSummary: 'En abril de 2023 se incorporo equipamiento.'
        },
        factsBySource: [{
          facts: {
            title: 'El Centro Municipal de Salud suma equipamiento historico',
            eventType: 'general',
            places: ['Rio Grande'],
            dates: ['abril de 2023']
          }
        }]
      }
    }
  }, { now: new Date('2026-07-09T23:30:00.000Z') });

  assert.equal(agenda.stories[0].freshness, 'stale-or-evergreen');
  assert.equal(agenda.stories[0].scoreBreakdown.recency, 1);
});

test('query de corroboracion no agrega Tierra del Fuego fuera de historias provinciales', () => {
  const provincial = buildCorroborationQuery({
    title: 'Melella reactiva la reforma constitucional fueguina',
    facts: {
      eventType: 'legal-policy',
      people: ['Gustavo Melella'],
      places: ['Tierra del Fuego']
    },
    source: { defaultCategory: 'Provincia', location: 'Tierra del Fuego AIAS' }
  }, { territory: 'Provincia' });
  assert.match(provincial, /Tierra del Fuego/);

  const national = buildCorroborationQuery({
    title: 'Milei se reune con el FMI por el Banco Central',
    facts: {
      eventType: 'legal-policy',
      people: ['Javier Milei'],
      organizations: ['FMI', 'Banco Central']
    },
    source: { defaultCategory: 'Nacionales' }
  }, { territory: 'Nacionales' });
  assert.match(national, /Milei|Javier Milei/);
  assert.doesNotMatch(national, /Tierra del Fuego/);

  const world = buildCorroborationQuery({
    title: 'Iran lanza misiles y Khamenei advierte por el conflicto',
    facts: {
      eventType: 'international-conflict',
      people: ['Khamenei'],
      countries: ['Iran']
    },
    source: { defaultCategory: 'Mundo' }
  }, { territory: 'Mundo' });
  assert.doesNotMatch(world, /Tierra del Fuego/);

  const sports = buildCorroborationQuery({
    title: 'Argentina vencio a Egipto en el Mundial',
    facts: {
      eventType: 'sports-result',
      sportsTeams: ['Argentina', 'Egipto'],
      countries: ['Argentina', 'Egipto']
    },
    source: { defaultCategory: 'Deportes' }
  }, { territory: 'Nacionales' });
  assert.match(sports, /resultado/);
  assert.doesNotMatch(sports, /Tierra del Fuego/);
});

test('prioridad de corroboracion favorece pendiente provincial fresco e importante', () => {
  const provincial = scoreCorroborationPriority({
    base: {
      title: 'Tolhuin anuncia cortes de ruta por obras',
      pubDate: new Date('2026-07-09T13:00:00Z'),
      facts: { places: ['Tolhuin'], eventType: 'service' },
      source: { defaultCategory: 'Tolhuin' }
    },
    newsworthiness: { territory: 'Tolhuin', newsworthinessScore: 90, publicInterestScore: 18, serviceValueScore: 20 },
    existingEvent: { firstDetectedAt: '2026-07-09T12:00:00Z' },
    now: new Date('2026-07-09T14:00:00Z')
  });
  const marginalWorld = scoreCorroborationPriority({
    base: {
      title: 'Celebridad comparte una foto viral',
      pubDate: new Date('2026-07-08T12:00:00Z'),
      facts: { countries: ['Estados Unidos'], eventType: 'general' },
      source: { defaultCategory: 'Mundo' }
    },
    newsworthiness: { territory: 'Mundo', newsworthinessScore: 45, publicInterestScore: 6, serviceValueScore: 0 },
    existingEvent: { firstDetectedAt: '2026-07-08T12:00:00Z' },
    now: new Date('2026-07-09T14:00:00Z')
  });
  assert(provincial.score > marginalWorld.score);
});

test('pending historico matchea misma historia con titulos distintos', () => {
  const records = {
    'legal-policy|melella|reforma': {
      status: 'pending-verification',
      publisherDomains: ['tn.com.ar'],
      factsBySource: [{
        facts: {
          title: 'Melella convoca elecciones por la reforma constitucional',
          eventType: 'legal-policy',
          people: ['Gustavo Melella'],
          organizations: ['Legislatura'],
          places: ['Tierra del Fuego']
        }
      }]
    }
  };
  const match = findMatchingPendingEventKeyInRecords({
    records,
    eventKey: 'generated-new-key',
    title: 'Melella reactiva la reforma constitucional fueguina',
    facts: {
      eventType: 'legal-policy',
      people: ['Gustavo Melella'],
      organizations: ['Legislatura'],
      places: ['Tierra del Fuego']
    },
    sourceRef: { publisherDomain: 'perfil.com' }
  });
  assert.equal(match, 'legal-policy|melella|reforma');
});

test('pending historico no une hechos distintos con misma persona o municipio', () => {
  const records = {
    'rio-grande|obra': {
      status: 'pending-verification',
      publisherDomains: ['local-a.com'],
      factsBySource: [{
        facts: {
          title: 'Rio Grande inaugura un centro de monitoreo',
          eventType: 'general',
          people: ['Martin Perez'],
          places: ['Rio Grande']
        }
      }]
    }
  };
  const samePersonDifferentStory = findMatchingPendingEventKeyInRecords({
    records,
    eventKey: 'new-person-story',
    title: 'Martin Perez presenta el presupuesto municipal',
    facts: { eventType: 'general', people: ['Martin Perez'], places: ['Rio Grande'] },
    sourceRef: { publisherDomain: 'local-b.com' }
  });
  assert.equal(samePersonDifferentStory, 'new-person-story');

  const sameMunicipalityDifferentEvent = findMatchingPendingEventKeyInRecords({
    records,
    eventKey: 'new-municipality-story',
    title: 'Rio Grande abre inscripciones para talleres culturales',
    facts: { eventType: 'agenda', places: ['Rio Grande'] },
    sourceRef: { publisherDomain: 'local-b.com' }
  });
  assert.equal(sameMunicipalityDifferentEvent, 'new-municipality-story');
});

test('pending historico une el mismo sismo solo con hechos centrales concordantes', () => {
  const records = {
    'weather|fragmented|sismo|tn': {
      status: 'pending-verification',
      publisherDomains: ['tn.com.ar'],
      sources: [{ publisherDomain: 'tn.com.ar', publishedAt: '2026-07-07T15:48:14.028Z' }],
      factsBySource: [{
        facts: {
          title: 'Un sismo de magnitud 5,9 sacudio a varias ciudades de Tierra del Fuego',
          eventType: 'weather',
          places: ['Pasaje Drake', 'Ushuaia', 'Tierra del Fuego'],
          numbers: ['5,9', '303', '10'],
          dates: ['07 de julio', '2026-07-07'],
          rawSummary: 'El movimiento ocurrio en Pasaje Drake, a mas de 300 kilometros de Ushuaia y a 10 kilometros de profundidad.'
        }
      }]
    }
  };
  const match = findMatchingPendingEventKeyInRecords({
    records,
    eventKey: 'weather|sismo|5-9|2026-07-07|pasaje-drake',
    title: 'Un sismo de magnitud 5,9 se registro cerca de Tierra del Fuego, a mas de 300 kilometros de Ushuaia',
    facts: {
      eventType: 'weather',
      places: ['Pasaje Drake', 'Ushuaia', 'Tierra del Fuego'],
      numbers: ['5,9', '300', '10'],
      dates: ['07/07/2026'],
      rawSummary: 'El movimiento ocurrio en el Pasaje Drake y no se emitieron alertas de tsunami.'
    },
    sourceRef: { publisherDomain: 'elchubut.com.ar', publishedAt: '2026-07-07T15:25:00.000Z' }
  });
  assert.equal(match, 'weather|fragmented|sismo|tn');

  const different = findMatchingPendingEventKeyInRecords({
    records,
    eventKey: 'weather|sismo|6-1|2026-07-08|pasaje-drake',
    title: 'Un sismo de magnitud 6,1 se registro cerca de Tierra del Fuego',
    facts: {
      eventType: 'weather',
      places: ['Pasaje Drake', 'Ushuaia'],
      numbers: ['6,1'],
      dates: ['2026-07-08'],
      rawSummary: 'Otro movimiento ocurrio en el Pasaje Drake.'
    },
    sourceRef: { publisherDomain: 'elchubut.com.ar', publishedAt: '2026-07-08T15:25:00.000Z' }
  });
  assert.equal(different, 'weather|sismo|6-1|2026-07-08|pasaje-drake');
});

test('compacta pendientes persistidos del mismo sismo y reevalua corroboracion', () => {
  const records = {
    'weather|fragment-a': {
      status: 'pending-verification',
      riskLevel: 'high',
      publisherDomains: ['tn.com.ar'],
      sources: [{ tier: 'B', publisherDomain: 'tn.com.ar', url: 'https://tn.com.ar/a', title: 'Un sismo de magnitud 5,9 sacudio a Tierra del Fuego', publishedAt: '2026-07-07T15:48:14.028Z' }],
      factsBySource: [{
        publisherDomain: 'tn.com.ar',
        url: 'https://tn.com.ar/a',
        facts: {
          title: 'Un sismo de magnitud 5,9 sacudio a varias ciudades de Tierra del Fuego',
          eventType: 'weather',
          places: ['Pasaje Drake', 'Ushuaia', 'Tierra del Fuego'],
          numbers: ['5,9', '303', '10'],
          dates: ['07 de julio', '2026-07-07'],
          rawSummary: 'El movimiento ocurrio en Pasaje Drake, a mas de 300 kilometros de Ushuaia y a 10 kilometros de profundidad.'
        }
      }]
    },
    'weather|fragment-b': {
      status: 'pending-verification',
      riskLevel: 'high',
      publisherDomains: ['elchubut.com.ar'],
      sources: [{ tier: 'B', publisherDomain: 'elchubut.com.ar', url: 'https://elchubut.com.ar/b', title: 'Un sismo de magnitud 5,9 se registro cerca de Tierra del Fuego', publishedAt: '2026-07-07T15:25:00.000Z' }],
      factsBySource: [{
        publisherDomain: 'elchubut.com.ar',
        url: 'https://elchubut.com.ar/b',
        facts: {
          title: 'Un sismo de magnitud 5,9 se registro cerca de Tierra del Fuego',
          eventType: 'weather',
          places: ['Pasaje Drake', 'Ushuaia'],
          numbers: ['5,9', '300', '10'],
          dates: ['07/07/2026'],
          rawSummary: 'El movimiento ocurrio en el Pasaje Drake y no hubo alerta de tsunami.'
        }
      }]
    }
  };

  const result = compactEquivalentPendingEvents(records);
  assert.equal(result.merged, 1);
  assert.equal(Object.keys(records).length, 1);
  assert.equal(records['weather|fragment-a'].sources.length, 2);
  assert.equal(records['weather|fragment-a'].status, 'verified-standard');
});

test('agenda invalida claves weather heredadas para buques y Malvinas', () => {
  const agenda = buildEditorialAgenda({
    events: {
      'weather|argentina|chile|reino unido|polemica|malvinas': {
        eventKey: 'weather|argentina|chile|reino unido|polemica|malvinas',
        status: 'pending-verification',
        lastSeenAt: '2026-07-09T22:00:00.000Z',
        verifiedFacts: {
          eventType: 'weather',
          places: ['Rio Grande', 'Islas Malvinas'],
          countries: ['Reino Unido'],
          rawSummary: 'Polemica por el paso de un buque de guerra britanico por aguas territoriales argentinas tras zarpar de Malvinas.'
        },
        factsBySource: [{
          facts: {
            title: 'Polemica por el paso de un buque de guerra britanico por aguas territoriales argentinas tras zarpar de Malvinas',
            eventType: 'weather',
            places: ['Rio Grande', 'Islas Malvinas'],
            countries: ['Reino Unido']
          }
        }]
      }
    }
  }, { now: new Date('2026-07-09T23:00:00.000Z') });

  assert.equal(agenda.summary.invalidStories, 1);
  assert.equal(agenda.summary.topStories.length, 0);
  assert(agenda.stories[0].validationReasons.includes('story-headline-mismatch'));
  assert(agenda.stories[0].validationReasons.includes('topic-event-mismatch'));
});

test('latencia editorial usa cohorte comparable para discovery verification publication', () => {
  const latency = summarizeEditorialLatency({
    comparable: {
      firstDetectedAt: '2026-07-09T10:00:00.000Z',
      verifiedAt: '2026-07-09T10:30:00.000Z',
      publishedAt: '2026-07-09T10:45:00.000Z'
    },
    verifiedOnly: {
      firstDetectedAt: '2026-07-09T09:00:00.000Z',
      verifiedAt: '2026-07-09T10:00:00.000Z'
    },
    migratedPublished: {
      firstDetectedAt: '2026-07-09T11:00:00.000Z',
      publishedAt: '2026-07-09T11:01:00.000Z'
    }
  });

  assert.equal(latency.discoveryToVerificationMinutes.count, 1);
  assert.equal(latency.discoveryToVerificationMinutes.avg, 30);
  assert.equal(latency.verificationToPublicationMinutes.avg, 15);
  assert.equal(latency.discoveryToPublicationMinutes.avg, 45);
  assert(latency.discoveryToPublicationMinutes.avg >= latency.discoveryToVerificationMinutes.avg);
  assert.equal(latency.discoveryToVerificationAllMinutes.count, 2);
  assert.equal(latency.cohort.publicationWithoutVerifiedAtCount, 1);
});

console.log(`\n=== NEWS TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
