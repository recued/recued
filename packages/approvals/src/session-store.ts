import { SESSION_LIMITS } from '@recued/contracts';
import type { SessionApproval, RiskTier } from '@recued/contracts';
import type { SessionStore } from './types.js';

/** In-memory session approval store. Wiped on browser restart per D-040.
 *  Validity = not expired AND not idle.
 */
/** Sweep interval for cleaning expired sessions (10 minutes). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export const createSessionStore = (now: () => number = Date.now): SessionStore => {
  const sessions = new Map<string, SessionApproval>();
  const buildKey = (recipe_id: string, tier: RiskTier) => `${recipe_id}::${tier}`;

  /** Proactively remove expired sessions so the Map doesn't grow unbounded. */
  const sweep = (): void => {
    const current = now();
    for (const [key, session] of sessions) {
      const expiresAt = new Date(session.expires_at).getTime();
      const lastUsedAt = new Date(session.last_used_at).getTime();
      if (current > expiresAt || current - lastUsedAt > SESSION_LIMITS.idle_timeout_ms) {
        sessions.delete(key);
      }
    }
  };

  // Periodic sweep — cleans up sessions that were never re-validated
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Unref if available (Node/Deno) so the timer doesn't prevent SW shutdown
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref();
  }

  return {
    add(approval) {
      sessions.set(buildKey(approval.recipe_id, approval.risk_tier), approval);
    },

    isValid(recipe_id, tier) {
      const session = sessions.get(buildKey(recipe_id, tier));
      if (!session) return false;

      const current = now();
      const expiresAt = new Date(session.expires_at).getTime();
      const lastUsedAt = new Date(session.last_used_at).getTime();

      // Hard cap from grant time
      if (current > expiresAt) {
        sessions.delete(buildKey(recipe_id, tier));
        return false;
      }

      // Idle timeout from last use
      if (current - lastUsedAt > SESSION_LIMITS.idle_timeout_ms) {
        sessions.delete(buildKey(recipe_id, tier));
        return false;
      }

      // Bump last_used_at — successful validation refreshes idle timer
      session.last_used_at = new Date(current).toISOString();
      return true;
    },

    remove(recipe_id, tier) {
      sessions.delete(buildKey(recipe_id, tier));
    },

    clear() {
      sessions.clear();
    },
  };
};
