/** A representable absolute UTC deadline, never a client-side countdown. */
export const isLlmRetryTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;

/** Round up so the displayed second never invites a premature retry. */
export const formatLlmRetryTime = (value: unknown): string | undefined =>
  isLlmRetryTime(value)
    ? new Date(Math.ceil(value / 1_000) * 1_000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : undefined;
