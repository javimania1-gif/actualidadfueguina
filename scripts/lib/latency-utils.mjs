function parseTime(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function minutesBetweenMs(startMs, endMs) {
  if (!startMs || !endMs || endMs < startMs) return null;
  return Math.round(((endMs - startMs) / (60 * 1000)) * 10) / 10;
}

function summarize(items = []) {
  if (!items.length) return { count: 0, avg: null, p50: null, max: null };
  const sorted = [...items].sort((a, b) => a - b);
  return {
    count: sorted.length,
    avg: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10,
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1]
  };
}

export function summarizeEditorialLatency(records = {}) {
  const comparable = {
    discoveryToVerificationMinutes: [],
    verificationToPublicationMinutes: [],
    discoveryToPublicationMinutes: []
  };
  const allVerified = [];
  let verifiedWithoutPublicationCount = 0;
  let publicationWithoutVerifiedAtCount = 0;
  let invalidTimestampCount = 0;

  for (const event of Object.values(records || {})) {
    const firstDetectedAt = parseTime(event.firstDetectedAt);
    const verifiedAt = parseTime(event.verifiedAt);
    const publishedAt = parseTime(event.publishedAt);

    if (firstDetectedAt && verifiedAt && verifiedAt >= firstDetectedAt) {
      allVerified.push(minutesBetweenMs(firstDetectedAt, verifiedAt));
    } else if (event.verifiedAt) {
      invalidTimestampCount++;
    }

    if (!publishedAt) {
      if (verifiedAt) verifiedWithoutPublicationCount++;
      continue;
    }

    if (!verifiedAt) {
      publicationWithoutVerifiedAtCount++;
      continue;
    }

    if (!firstDetectedAt || verifiedAt < firstDetectedAt || publishedAt < verifiedAt) {
      invalidTimestampCount++;
      continue;
    }

    comparable.discoveryToVerificationMinutes.push(minutesBetweenMs(firstDetectedAt, verifiedAt));
    comparable.verificationToPublicationMinutes.push(minutesBetweenMs(verifiedAt, publishedAt));
    comparable.discoveryToPublicationMinutes.push(minutesBetweenMs(firstDetectedAt, publishedAt));
  }

  return {
    discoveryToVerificationMinutes: summarize(comparable.discoveryToVerificationMinutes),
    verificationToPublicationMinutes: summarize(comparable.verificationToPublicationMinutes),
    discoveryToPublicationMinutes: summarize(comparable.discoveryToPublicationMinutes),
    discoveryToVerificationAllMinutes: summarize(allVerified.filter((value) => value !== null)),
    cohort: {
      comparablePublishedCount: comparable.discoveryToPublicationMinutes.length,
      verifiedWithoutPublicationCount,
      publicationWithoutVerifiedAtCount,
      invalidTimestampCount,
      comparableDefinition: 'firstDetectedAt <= verifiedAt <= publishedAt'
    }
  };
}
