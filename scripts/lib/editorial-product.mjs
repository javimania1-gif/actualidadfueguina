export const CONTENT_TYPES = Object.freeze([
  'noticia',
  'claves-af',
  'analisis',
  'entrevista',
  'opinion',
  'patrocinado'
]);

export const EDITORIAL_PROCESSES = Object.freeze([
  'automatico',
  'revisado',
  'original'
]);

const ORIGINAL_TYPES = new Set(['analisis', 'entrevista', 'opinion']);
const AUTOMATED_TYPES = new Set(['noticia', 'claves-af']);
const GENERIC_AUTHORS = new Set([
  '',
  'actualidad fueguina',
  'redaccion',
  'redaccion actualidad fueguina'
]);

function normalizeAuthor(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function resolveEditorialProcess(note = {}) {
  if (EDITORIAL_PROCESSES.includes(note.editorialProcess)) return note.editorialProcess;
  return note.automated ? 'automatico' : 'revisado';
}

export function displayAuthor(note = {}) {
  if (note.automated) return 'Redacción Actualidad Fueguina';
  return String(note.author || 'Redacción Actualidad Fueguina').trim();
}

export function validateEditorialProduct(note = {}) {
  const errors = [];
  const warnings = [];
  const contentType = note.contentType || 'noticia';
  const editorialProcess = resolveEditorialProcess(note);
  const author = normalizeAuthor(note.author || '');
  const keyPoints = Array.isArray(note.keyPoints) ? note.keyPoints.filter(Boolean) : [];

  if (!CONTENT_TYPES.includes(contentType)) errors.push('invalid-content-type');
  if (!EDITORIAL_PROCESSES.includes(editorialProcess)) errors.push('invalid-editorial-process');

  if (note.automated && editorialProcess !== 'automatico') {
    errors.push('automated-content-must-use-automatic-process');
  }
  if (note.automated && !AUTOMATED_TYPES.has(contentType)) {
    errors.push('automated-content-cannot-claim-original-format');
  }
  if (ORIGINAL_TYPES.has(contentType) && editorialProcess !== 'original') {
    errors.push('original-format-requires-original-process');
  }
  if (editorialProcess === 'original' && GENERIC_AUTHORS.has(author)) {
    errors.push('original-content-requires-named-author');
  }
  if (contentType === 'claves-af') {
    if (keyPoints.length < 2) errors.push('claves-af-requires-key-points');
    if (!String(note.whyItMatters || '').trim()) errors.push('claves-af-requires-why-it-matters');
  }
  if (contentType === 'patrocinado') {
    if (note.automated) errors.push('sponsored-content-cannot-publish-automatically');
    if (!String(note.sponsorName || '').trim()) errors.push('sponsored-content-requires-sponsor');
    if (!String(note.disclosure || '').trim()) errors.push('sponsored-content-requires-disclosure');
  } else if (note.sponsorName || note.disclosure) {
    warnings.push('commercial-metadata-outside-sponsored-content');
  }

  return { ok: errors.length === 0, errors, warnings, contentType, editorialProcess };
}
