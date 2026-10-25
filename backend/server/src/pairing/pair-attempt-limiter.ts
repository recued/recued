/** A bound on failed `/auth/pair` checks.
 *
 *  ⛔ The route had none: about 990 wrong codes a second from one client, and
 *  the real code still worked after 3,000 misses. A pairing code is 40 bits,
 *  so the odds in one 15-minute window are small — until a long-lived code
 *  (`--pair-code-ttl 7d`) meets a page on the owner's network driving the
 *  route (CORS is open so the pair form can reach it). On a server that has
 *  never been paired, a guessed code enrolls the guesser's own recovery key.
 *
 *  Failed code and recovery-key checks are counted per source address and in
 *  total. Past either limit the route answers 429 for a while WITHOUT checking
 *  anything, so the rate of guesses is bounded however they arrive. Generous
 *  per source, because behind a reverse proxy every client shares one
 *  address; a success clears that source's count. */

/** Failed checks one source may make in a window before it is refused. */
export const PAIR_FAILURES_PER_SOURCE = 10;
/** Failed checks from all sources together in a window before every source
 *  is refused — the bound that holds when the guesses come from many places. */
export const PAIR_FAILURES_TOTAL = 60;
export const PAIR_FAILURE_WINDOW_MS = 60_000;
export const PAIR_COOLDOWN_MS = 60_000;
const PAIR_FAILURE_SOURCES_MAX = 1024;

export interface PairAttemptLimiter {
  /** True while `source` (or everyone) is being refused. */
  refused(source: string, now: number): boolean;
  /** Count a failed code or recovery-key check. */
  failed(source: string, now: number): void;
  /** A successful pairing clears its source's count. */
  succeeded(source: string): void;
}

interface Window { count: number; since: number; coolUntil: number }

const bump = (prior: Window | undefined, now: number, limit: number): Window => {
  const next: Window = prior !== undefined && now - prior.since <= PAIR_FAILURE_WINDOW_MS
    ? { ...prior, count: prior.count + 1 }
    : { count: 1, since: now, coolUntil: prior?.coolUntil ?? 0 };
  if (next.count >= limit) return { count: 0, since: now, coolUntil: now + PAIR_COOLDOWN_MS };
  return next;
};

export const createPairAttemptLimiter = (): PairAttemptLimiter => {
  const sources = new Map<string, Window>();
  let total: Window | undefined;
  return {
    refused(source, now) {
      return (sources.get(source)?.coolUntil ?? 0) > now || (total?.coolUntil ?? 0) > now;
    },
    failed(source, now) {
      const entry = bump(sources.get(source), now, PAIR_FAILURES_PER_SOURCE);
      sources.delete(source);
      sources.set(source, entry);
      if (sources.size > PAIR_FAILURE_SOURCES_MAX) {
        const oldest = sources.keys().next().value;
        if (oldest !== undefined) sources.delete(oldest);
      }
      total = bump(total, now, PAIR_FAILURES_TOTAL);
    },
    succeeded(source) {
      sources.delete(source);
    },
  };
};
