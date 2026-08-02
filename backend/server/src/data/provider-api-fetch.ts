import { makeBoundedOriginApiFetch } from '../bounded-origin-http-fetcher.js';

/** Ordinary CRM API calls should fail promptly enough for housekeeping retry. */
export const PROVIDER_API_TIMEOUT_MS = 30_000;
/** Salesforce holds Bayeux `/meta/connect` for roughly 110 seconds. */
export const PROVIDER_LONG_POLL_TIMEOUT_MS = 125_000;
export const PROVIDER_API_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export const defaultProviderApiFetch = makeBoundedOriginApiFetch({
  timeoutMs: PROVIDER_API_TIMEOUT_MS,
  maxResponseBytes: PROVIDER_API_RESPONSE_MAX_BYTES,
});

export const defaultProviderLongPollFetch = makeBoundedOriginApiFetch({
  timeoutMs: PROVIDER_LONG_POLL_TIMEOUT_MS,
  maxResponseBytes: PROVIDER_API_RESPONSE_MAX_BYTES,
});
