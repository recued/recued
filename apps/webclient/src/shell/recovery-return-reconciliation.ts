/** Truthful reconciliation for a recovery return.
 *
 * The switch marker knows only a scrubbed broad area and whether a detail was
 * deliberately withheld. The mounted route remains responsible for its fresh
 * server read. This module joins those two privacy-safe facts without ever
 * inferring that an old record, draft, run, or connection still exists. */

import type { RecoveryReturnContext } from './server-switch-continuity.js';

export type RecoveryContextFreshness =
  | 'current'
  | 'mounted_only'
  | 'unavailable';

export interface RecoveryContextProbe {
  /** Resolves after the route's initial authoritative reads settle. */
  whenLoaded?: () => Promise<void>;
  /** Common route seam: any populated entry means the current view is partial. */
  getLoadErrors?: () => unknown;
  /** Route-specific override when its state cannot be expressed as an error map. */
  getRecoveryContextFreshness?: () => 'current' | 'unavailable';
  /** Re-runs the mounted route's own authoritative read. The shell never
   * reconstructs a private record/session/draft target to perform a retry. */
  retryRecoveryContext?: () => Promise<void>;
}

const hasLoadError = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (value instanceof Error) return true;
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return false;
  return Object.values(value as Record<string, unknown>).some(hasLoadError);
};

/** Wait for the route-owned read boundary. A route without a load/status seam
 * earns only `mounted_only`; mounting DOM is not evidence that its data is
 * current. Probe failures are presentation failures, never fresh evidence. */
export const reconcileRecoveryContext = async (
  probe: RecoveryContextProbe,
): Promise<RecoveryContextFreshness> => {
  const hasReadBoundary = probe.whenLoaded !== undefined;
  try {
    await probe.whenLoaded?.();
    if (!hasReadBoundary) return 'mounted_only';
    if (probe.getRecoveryContextFreshness !== undefined) {
      return probe.getRecoveryContextFreshness();
    }
    if (probe.getLoadErrors !== undefined) {
      return hasLoadError(probe.getLoadErrors())
        ? 'unavailable'
        : 'current';
    }
    return 'mounted_only';
  } catch {
    return 'unavailable';
  }
};

export interface RecoveryReturnReceipt {
  readonly copy: string;
  readonly actionLabel: string;
  readonly intent: 'continue' | 'choose_again' | 'retry' | 'return' | 'review';
  readonly tone: 'success' | 'attention';
}

export const recoveryReturnReceipt = (input: {
  readonly profileLabel: string;
  readonly areaLabel: string;
  readonly returnContext?: RecoveryReturnContext;
  readonly freshness: RecoveryContextFreshness;
  readonly routeStillActive: boolean;
  readonly canRetry?: boolean;
}): RecoveryReturnReceipt => {
  const reviewAction = `Review ${input.areaLabel}`;
  if (!input.routeStillActive) {
    return {
      copy: `Back on ${input.profileLabel}. ${input.areaLabel} was your saved return area, but this tab has moved since arrival.`,
      actionLabel: `Return to ${input.areaLabel}`,
      intent: 'return',
      tone: 'attention',
    };
  }
  if (input.freshness === 'unavailable') {
    if (input.canRetry === true) {
      return {
        copy: `Back on ${input.profileLabel}, but Recued couldn’t confirm ${input.areaLabel} is current. Try again to check the latest information before continuing.`,
        actionLabel: `Retry ${input.areaLabel}`,
        intent: 'retry',
        tone: 'attention',
      };
    }
    return {
      copy: `Back on ${input.profileLabel}, but Recued couldn’t confirm ${input.areaLabel} is current. Review the area before continuing.`,
      actionLabel: reviewAction,
      intent: 'review',
      tone: 'attention',
    };
  }
  if (input.freshness === 'mounted_only') {
    return {
      copy: `Back on ${input.profileLabel}. You’re in ${input.areaLabel}; review the current view before continuing.`,
      actionLabel: reviewAction,
      intent: 'review',
      tone: 'attention',
    };
  }
  if (input.returnContext === 'detail_withheld') {
    return {
      copy: `Back on ${input.profileLabel}. ${input.areaLabel} is refreshed. For privacy, the item you had open wasn’t carried across servers; choose it again if you still need it.`,
      actionLabel: `Choose again in ${input.areaLabel}`,
      intent: 'choose_again',
      tone: 'attention',
    };
  }
  if (input.returnContext !== 'area') {
    return {
      copy: `Back on ${input.profileLabel}. ${input.areaLabel} is refreshed; review the current view before continuing.`,
      actionLabel: reviewAction,
      intent: 'review',
      tone: 'attention',
    };
  }
  return {
    copy: `Back on ${input.profileLabel}. ${input.areaLabel} is refreshed and ready.`,
    actionLabel: `Continue in ${input.areaLabel}`,
    intent: 'continue',
    tone: 'success',
  };
};

/** A route-qualified freshness result cannot survive a connection gap. This
 * copy is safe to defer because it asks for review without claiming that the
 * destination area is still current or even still mounted. */
export const recoveryReturnAfterReconnectReceipt = (input: {
  readonly profileLabel: string;
  readonly areaLabel: string;
}): RecoveryReturnReceipt => ({
  copy: `Back on ${input.profileLabel}. The server is connected, but Recued hasn’t confirmed ${input.areaLabel} is current. Review the area before continuing.`,
  actionLabel: `Review ${input.areaLabel}`,
  intent: 'review',
  tone: 'attention',
});
