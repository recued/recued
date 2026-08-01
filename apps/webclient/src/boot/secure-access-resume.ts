/** Same-origin continuation for the insecure-context handoff.
 *
 * The handoff cannot safely put an owner-entered server URL in a query
 * parameter: a forged Recued-looking link could otherwise prefill an attacker's
 * origin and receive the recovery key submitted by the pair form. Instead, the
 * insecure page carries only this non-authoritative marker. On arrival, the
 * webclient derives the pair destination from the page's own live HTTPS (or
 * loopback HTTP) origin. Query `url` values remain ignored. */

import { parsePairDeeplink } from '../auth/pair-deeplink.js';
import type { PairCodeInputDeeplinkSeed } from '../auth/pair-code-input-host.js';

export const SECURE_ACCESS_RESUME_PARAM = 'recued_pair_resume';
export const SECURE_ACCESS_RESUME_VALUE = 'same-origin';

/** Pair-entry query keys are one-shot boot inputs, not durable page state.
 * Remove them after pairing has been finalized without round-tripping the
 * remaining query through URLSearchParams: that would silently rewrite
 * unrelated encodings (`%20` to `+`) and make the return page less exact. */
const isConsumedPairEntryKey = (rawKey: string): boolean => {
  let key: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    // A malformed unrelated key is still the caller's page state. Preserve it
    // rather than broadening cleanup beyond keys we can identify exactly.
    return false;
  }
  return key === 'code' || key === SECURE_ACCESS_RESUME_PARAM;
};

/** Return the same URL with every consumed pair-code / secure-resume marker
 * removed. Path, hash, ordering, duplicate unrelated keys, values, and raw
 * encoding are retained byte-for-byte. Empty separator fragments are dropped
 * so a code-only arrival becomes a genuinely clean URL rather than `?&`. */
export const cleanConsumedPairEntryUrl = (source: string): string => {
  const hashAt = source.indexOf('#');
  const beforeHash = hashAt >= 0 ? source.slice(0, hashAt) : source;
  const hash = hashAt >= 0 ? source.slice(hashAt) : '';
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return source;

  const base = beforeHash.slice(0, queryAt);
  const rawQuery = beforeHash.slice(queryAt + 1);
  let removed = false;
  const kept: string[] = [];
  for (const part of rawQuery.split('&')) {
    if (isConsumedPairEntryKey(part.split('=', 1)[0] ?? '')) {
      removed = true;
      continue;
    }
    if (part.length > 0) kept.push(part);
  }
  if (!removed) return source;
  const search = kept.length > 0 ? `?${kept.join('&')}` : '';
  return `${base}${search}${hash}`;
};

export interface ParsedPairEntryHandoff {
  /** True when either a safe pairing code or a trusted same-origin resume is
   * present, so boot should carry the seed into an unpaired fallback. */
  readonly active: boolean;
  readonly seed: PairCodeInputDeeplinkSeed;
}

export const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
};

const isPairingSafeOrigin = (url: URL): boolean =>
  url.protocol === 'https:'
  || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));

/** Stamp a handoff destination with a marker that conveys intent, not URL
 * authority. The destination will still re-derive its server URL from itself. */
export const markSecureAccessResume = (target: URL): void => {
  const existing = target.searchParams.getAll(SECURE_ACCESS_RESUME_PARAM);
  if (existing.at(-1) === SECURE_ACCESS_RESUME_VALUE) return;
  // Append without reserializing the existing query. Pair codes may have come
  // from a copied CLI link, and the handoff promises to carry that exact page
  // rather than silently changing its encoding (`%20` into `+`, for example).
  const separator = target.search.length > 0 ? '&' : '?';
  target.search =
    `${target.search}${separator}${SECURE_ACCESS_RESUME_PARAM}=${SECURE_ACCESS_RESUME_VALUE}`;
};

/** Compose the safe CLI `?code=` seed with a same-origin server prefill.
 *
 * `source` must be an absolute live page URL. Invalid, insecure non-loopback,
 * or unmarked URLs retain the existing code-only behavior. Critically, this
 * function never reads `?url=` (or any other query value) as a destination. */
export const parsePairEntryHandoff = (
  source: string | URL,
): ParsedPairEntryHandoff => {
  let page: URL;
  try {
    page = source instanceof URL ? new URL(source.toString()) : new URL(source);
  } catch {
    return { active: false, seed: {} };
  }

  const deeplink = parsePairDeeplink(page.searchParams);
  const resumeMarkers = page.searchParams.getAll(SECURE_ACCESS_RESUME_PARAM);
  const resumeActive =
    resumeMarkers.at(-1) === SECURE_ACCESS_RESUME_VALUE
    && isPairingSafeOrigin(page);
  const seed: PairCodeInputDeeplinkSeed = {
    ...(resumeActive
      ? {
          serverUrl: page.origin,
          sameOriginResume: true,
        }
      : {}),
    ...deeplink.seed,
  };
  return {
    active: resumeActive || deeplink.active,
    seed,
  };
};
