/**
 * Per-walk guard for provider pagination.
 *
 * Provider cursors are untrusted response data. A buggy or compromised endpoint
 * can repeat a cursor forever, manufacture an endless stream of unique cursors,
 * or return an absolute continuation URL on another origin. The first two cases
 * pin a worker in a non-terminating walk; the last one can forward the provider's
 * bearer token to an attacker when the caller treats the returned URL as a new
 * top-level request.
 *
 * Keep this guard scoped to ONE logical walk. It deliberately throws instead of
 * returning a partial-success result: callers must retain their prior durable
 * watermark rather than certify an incomplete page chain as exhausted.
 */

export const PROVIDER_PAGINATION_MAX_PAGES = 100_000;

export class ProviderPaginationError extends Error {
  readonly code = 'PROVIDER_PAGINATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderPaginationError';
  }
}

/**
 * Decode the ordinary "missing/empty means exhausted" continuation shape.
 * Any other runtime type is schema corruption, not exhaustion: treating `0`,
 * `false`, or an object as done can silently certify a partial provider walk.
 */
export const readProviderStringContinuation = (
  value: unknown,
  label: string,
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ProviderPaginationError(
      `${label} pagination returned a non-string continuation`,
    );
  }
  return value;
};

export interface ProviderPaginationGuardOptions {
  /** When present, every claimed ref must be an absolute URL on this origin. */
  trustedBaseUrl?: string;
  maxPages?: number;
}

const parseTrustedOrigin = (baseUrl: string, label: string): string => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new ProviderPaginationError(
      `${label} pagination has an invalid trusted API base URL`,
    );
  }
};

const parseAbsoluteProviderUrl = (url: string, label: string): URL => {
  if (typeof url !== 'string') {
    throw new ProviderPaginationError(
      `${label} pagination returned a non-string page URL`,
    );
  }
  try {
    const candidate = new URL(url);
    if (candidate.username !== '' || candidate.password !== '') {
      throw new ProviderPaginationError(
        `${label} pagination returned a URL containing credentials`,
      );
    }
    return candidate;
  } catch (err) {
    if (err instanceof ProviderPaginationError) throw err;
    throw new ProviderPaginationError(
      `${label} pagination returned a malformed absolute URL`,
    );
  }
};

/** Validate a bearer-bearing provider URL before the request leaves the box. */
export const assertProviderPageUrl = (
  url: string,
  trustedBaseUrl: string,
  label: string,
): string => {
  const trustedOrigin = parseTrustedOrigin(trustedBaseUrl, label);
  // These call sites fetch continuation URLs directly. Require the provider's
  // documented absolute form rather than resolving an ambiguous relative or
  // protocol-relative value while credentials are attached.
  const candidate = parseAbsoluteProviderUrl(url, label);
  if (candidate.origin !== trustedOrigin) {
    throw new ProviderPaginationError(
      `${label} pagination refused an off-origin URL`,
    );
  }
  return url;
};

export class ProviderPaginationGuard {
  readonly #label: string;
  readonly #trustedOrigin: string | undefined;
  readonly #maxPages: number;
  readonly #seen = new Set<string>();

  constructor(label: string, options: ProviderPaginationGuardOptions = {}) {
    const maxPages = options.maxPages ?? PROVIDER_PAGINATION_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new TypeError('provider pagination maxPages must be a positive safe integer');
    }
    this.#label = label;
    this.#trustedOrigin = options.trustedBaseUrl === undefined
      ? undefined
      : parseTrustedOrigin(options.trustedBaseUrl, label);
    this.#maxPages = maxPages;
  }

  /** Claim exactly one page ref before fetching it. Returns the unchanged ref. */
  claim(ref: string): string {
    if (typeof ref !== 'string') {
      throw new ProviderPaginationError(
        `${this.#label} pagination returned a non-string page reference`,
      );
    }
    let identity = ref;
    if (this.#trustedOrigin !== undefined) {
      const candidate = parseAbsoluteProviderUrl(ref, this.#label);
      if (candidate.origin !== this.#trustedOrigin) {
        throw new ProviderPaginationError(
          `${this.#label} pagination refused an off-origin URL`,
        );
      }
      identity = candidate.href;
    }
    if (this.#seen.has(identity)) {
      throw new ProviderPaginationError(
        `${this.#label} pagination repeated a page reference`,
      );
    }
    if (this.#seen.size >= this.#maxPages) {
      throw new ProviderPaginationError(
        `${this.#label} pagination exceeded ${this.#maxPages} pages`,
      );
    }
    this.#seen.add(identity);
    return ref;
  }
}
