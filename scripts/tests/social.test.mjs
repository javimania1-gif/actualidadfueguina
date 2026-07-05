
import { escapeXml } from '../lib/social-utils.mjs';

async function testSelection() {
  console.log('--- Test Selección y Prioridad ---');
  // Simular lógica de candidatos y sort
  const candidates = [
    { title: 'Normal 5', importance: 5, urgent: false, dailyDigest: false },
    { title: 'Importante 8', importance: 8, urgent: false, dailyDigest: false },
    { title: 'Urgente 10', importance: 10, urgent: true, dailyDigest: false },
    { title: 'Resumen', importance: 5, urgent: false, dailyDigest: true }
  ];

  const sortFn = (isNight) => (a, b) => {
    if (a.urgent && !b.urgent) return -1;
    if (!a.urgent && b.urgent) return 1;
    if (isNight) {
      if (a.dailyDigest && !b.dailyDigest) return -1;
      if (!a.dailyDigest && b.dailyDigest) return 1;
    }
    return b.importance - a.importance;
  };

  const dayOrder = [...candidates].sort(sortFn(false));
  console.log('Día (Urgente primero, luego importancia):', dayOrder.map(c => c.title).join(' > '));
  if (dayOrder[0].title !== 'Urgente 10' || dayOrder[1].title !== 'Importante 8') throw new Error('Falló prioridad día');

  const nightOrder = [...candidates].sort(sortFn(true));
  console.log('Noche (Urgente primero, luego resumen):', nightOrder.map(c => c.title).join(' > '));
  if (nightOrder[0].title !== 'Urgente 10' || nightOrder[1].title !== 'Resumen') throw new Error('Falló prioridad noche');

  console.log('✅ Test Selección OK');
}

async function testEscaping() {
  console.log('--- Test Escaping XML ---');
  const unsafe = 'Título & "Subtítulo" <Urgente>\'';
  const expected = 'Título &amp; &quot;Subtítulo&quot; &lt;Urgente&gt;&apos;';
  const escaped = escapeXml(unsafe);
  if (escaped !== expected) throw new Error(`Falló escape: ${escaped}`);
  console.log('✅ Test Escaping OK');
}

async function runAll() {
  try {
    await testSelection();
    await testEscaping();
    console.log('\n🌟 TODOS LOS TESTS PASARON');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.message);
    process.exit(1);
  }
}

runAll();
