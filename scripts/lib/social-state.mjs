export const SOCIAL_STATUS = Object.freeze({
  RESERVED: 'reserved',
  PREPARING: 'preparing',
  PENDING_ASSET: 'pending-asset',
  ASSET_READY: 'asset-ready',
  PREPARED: 'prepared',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED_RETRYABLE: 'failed-retryable',
  FAILED_FINAL: 'failed-final',
  NEEDS_RECONCILIATION: 'needs-reconciliation',
  CANCELLED: 'cancelled'
});

export const ACTIVE_SOCIAL_STATUSES = new Set([
  SOCIAL_STATUS.RESERVED,
  SOCIAL_STATUS.PREPARING,
  SOCIAL_STATUS.PENDING_ASSET,
  SOCIAL_STATUS.ASSET_READY,
  SOCIAL_STATUS.PREPARED,
  SOCIAL_STATUS.PUBLISHING
]);

export const TERMINAL_SOCIAL_STATUSES = new Set([
  SOCIAL_STATUS.PUBLISHED,
  SOCIAL_STATUS.FAILED_FINAL,
  SOCIAL_STATUS.NEEDS_RECONCILIATION,
  SOCIAL_STATUS.CANCELLED
]);

export function shouldExcludeFromReservation(record) {
  if (!record) return false;
  return ACTIVE_SOCIAL_STATUSES.has(record.status) || TERMINAL_SOCIAL_STATUSES.has(record.status);
}

export function statusForMetaError(error) {
  if (error?.isAmbiguous) return SOCIAL_STATUS.NEEDS_RECONCILIATION;
  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('only photo or video') ||
    message.includes('media type') ||
    message.includes('image_url') ||
    message.includes('asset')
  ) {
    return SOCIAL_STATUS.FAILED_RETRYABLE;
  }
  return SOCIAL_STATUS.FAILED_FINAL;
}

export function isRetryableSocialStatus(status) {
  return status === SOCIAL_STATUS.FAILED_RETRYABLE;
}
