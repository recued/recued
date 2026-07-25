/** D-196 customer-surface usage reservations.
 *
 * Direct MCP can discover additional customer-controlled multiplicity only at
 * the real ingredient dispatch boundary (D-162 batch mode). One request-local
 * session therefore owns every reservation for the outer tools/call and either
 * commits all of them after a successful business result or releases all of
 * them for denied, held, cancelled, malformed, or failed calls.
 */

import type {
  SellerCustomer,
  SellerTier,
  SellerUsageKind,
} from '@recued/contracts';

import type {
  SellerCustomerUsageGate,
  SellerCustomerUsageAdmissionResult,
  SellerCustomerUsageInput,
  SellerCustomerUsageRateReservation,
} from './customer-usage-policy.js';

export interface CustomerSurfaceUsageInput {
  readonly tool_name: string;
  readonly usage_kind: SellerUsageKind;
  readonly units: number;
}

export type CustomerSurfaceUsageAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly message: string };

export const DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY =
  'direct-mcp-tool-call-base';

/** One meter instance belongs to one accepted surface request. */
export interface CustomerSurfaceUsageSession {
  reserve(input: CustomerSurfaceUsageInput): CustomerSurfaceUsageAdmission;
  /** Reserve one named logical unit at most once in this request. The direct
   * MCP base unit can be claimed by the outer route or the post-approval
   * dispatch hook without double counting. */
  reserveOnce(
    reservationKey: string,
    input: CustomerSurfaceUsageInput,
  ): CustomerSurfaceUsageAdmission;
  /** Mark a named dispatch as accounted for with zero units. D-162 permits an
   * empty customer-controlled batch; the marker prevents the outer successful
   * no-dispatch fallback from turning N=0 into one unit. A later non-empty
   * dispatch may still upgrade the same key through `reserveOnce`. */
  markZeroUnitReservation(
    reservationKey: string,
  ): CustomerSurfaceUsageAdmission;
  /** Whether a named logical dispatch has been accounted for, including by a
   * zero-unit marker. */
  hasReservationKey(reservationKey: string): boolean;
  /** Commit every reservation made by this request. Idempotent. */
  commit(): void;
  /** Release every reservation made by this request. Idempotent. */
  release(): void;
  /** The most recent admission denial, used to preserve the normal MCP error. */
  denialMessage(): string | undefined;
}

export interface CustomerSurfaceUsagePendingReservation {
  readonly key: string;
  readonly units: number;
}

/** Process-local pending-period coordinator. Rate capacity already lives in
 * the shared SellerCustomerUsageGate; this companion closes the equivalent
 * read-then-record race for finite day/month allowances across concurrent
 * direct-MCP requests handled by one transport instance. */
export interface CustomerSurfaceUsagePendingCoordinator {
  reserve(input: {
    readonly contract_id: string;
    readonly usage_kind: SellerUsageKind;
    readonly units: number;
    readonly admission: Extract<
      SellerCustomerUsageAdmissionResult,
      { readonly admitted: true }
    >;
  }):
    | {
        readonly admitted: true;
        readonly reservation: CustomerSurfaceUsagePendingReservation;
      }
    | { readonly admitted: false; readonly message: string };
  release(reservation: CustomerSurfaceUsagePendingReservation): void;
}

export const createCustomerSurfaceUsagePendingCoordinator =
  (): CustomerSurfaceUsagePendingCoordinator => {
    const pendingByKey = new Map<string, number>();
    const live = new Set<CustomerSurfaceUsagePendingReservation>();

    return {
      reserve(input) {
        const key = [
          input.contract_id,
          input.usage_kind,
          input.admission.period_granularity,
          input.admission.period_start,
        ].join(':');
        const pending = pendingByKey.get(key) ?? 0;
        if (
          input.admission.remaining !== null
          && pending > input.admission.remaining
        ) {
          const limit = input.admission.period_limit!;
          return {
            admitted: false,
            message:
              `${input.usage_kind} usage limit exceeded: `
              + `${input.admission.used + pending}/${limit} used or reserved; `
              + `${input.units} requested.`,
          };
        }
        const reservation = { key, units: input.units };
        pendingByKey.set(key, pending + input.units);
        live.add(reservation);
        return { admitted: true, reservation };
      },

      release(reservation) {
        if (!live.delete(reservation)) return;
        const remaining = (pendingByKey.get(reservation.key) ?? 0) - reservation.units;
        if (remaining > 0) pendingByKey.set(reservation.key, remaining);
        else pendingByKey.delete(reservation.key);
      },
    };
  };

interface PendingUsageReservation {
  readonly input: SellerCustomerUsageInput & {
    readonly units: number;
    readonly now: number;
  };
  readonly rate_reservation: SellerCustomerUsageRateReservation | null;
  readonly pending_reservation: CustomerSurfaceUsagePendingReservation;
}

/** Adapt the durable seller rollup gate into one request-local all-or-nothing
 * surface session. The durable store remains the source of truth; the shared
 * pending coordinator plus local remaining map make concurrent requests and a
 * base + D-162 extra reservation honor the allowance before a row is recorded. */
export const createCustomerSurfaceUsageSession = (input: {
  readonly gate: SellerCustomerUsageGate;
  readonly customer: SellerCustomer;
  readonly tier: SellerTier;
  readonly now?: () => number;
  readonly pendingCoordinator?: CustomerSurfaceUsagePendingCoordinator;
}): CustomerSurfaceUsageSession => {
  const now = input.now ?? (() => Date.now());
  const pendingCoordinator =
    input.pendingCoordinator ?? createCustomerSurfaceUsagePendingCoordinator();
  const pending: PendingUsageReservation[] = [];
  const remainingByKind = new Map<SellerUsageKind, number | null>();
  const admittedAtByKind = new Map<SellerUsageKind, number>();
  // `false` is an explicit zero-unit marker; `true` means capacity was
  // reserved. Keeping the states distinct lets a later real dispatch upgrade
  // an earlier empty-batch marker while the outer fallback can still detect
  // that the empty dispatch was already accounted for.
  const onceReservations = new Map<string, boolean>();
  let denial: string | undefined;
  let settled = false;

  const settlePending = (commit: boolean): unknown => {
    let firstError: unknown;
    for (const entry of pending) {
      try {
        if (entry.rate_reservation) {
          if (commit) input.gate.commitRate(entry.rate_reservation, now());
          else input.gate.releaseRate(entry.rate_reservation, now());
        }
      } catch (error) {
        firstError ??= error;
      }
      try {
        pendingCoordinator.release(entry.pending_reservation);
      } catch (error) {
        firstError ??= error;
      }
    }
    pending.length = 0;
    return firstError;
  };

  const reserve = (
    usage: CustomerSurfaceUsageInput,
  ): CustomerSurfaceUsageAdmission => {
    if (settled) {
      denial = 'This customer usage request has already settled.';
      return { admitted: false, message: denial };
    }
    // One denied piece makes the whole surface request non-dispatchable. A
    // recipe can contain more than one gated step; allowing a later step to
    // reserve after an earlier N-unit denial could cross an effect boundary
    // even though the enclosing MCP call will ultimately return the denial.
    if (denial !== undefined) {
      return { admitted: false, message: denial };
    }

    const priorRemaining = remainingByKind.get(usage.usage_kind);
    if (priorRemaining !== undefined && priorRemaining !== null && usage.units > priorRemaining) {
      denial =
        `${usage.usage_kind} usage limit exceeded: `
        + `${priorRemaining} request-local units remain; ${usage.units} requested.`;
      return { admitted: false, message: denial };
    }

    // Keep one accepted surface request in one allowance period even if the
    // clock crosses midnight/month-end between its base and D-162 N-1
    // reservations. It also prevents a long-running request from gaining a
    // rate-bucket refill between pieces of the same logical customer call.
    const admittedAt = admittedAtByKind.get(usage.usage_kind) ?? now();
    const usageInput = {
      customer: input.customer,
      tier: input.tier,
      usage_kind: usage.usage_kind,
      units: usage.units,
      now: admittedAt,
    } as const;
    const { admission, reservation } = input.gate.reserveRate(usageInput);
    if (!admission.admitted) {
      denial = admission.message;
      return { admitted: false, message: denial };
    }
    const pendingAdmission = pendingCoordinator.reserve({
      contract_id: input.customer.contract_id,
      usage_kind: usage.usage_kind,
      units: usage.units,
      admission,
    });
    if (!pendingAdmission.admitted) {
      if (reservation) input.gate.releaseRate(reservation, now());
      denial = pendingAdmission.message;
      return { admitted: false, message: denial };
    }

    const effectiveRemaining = priorRemaining === null
      ? null
      : priorRemaining === undefined
        ? admission.remaining
        : Math.max(priorRemaining - usage.units, 0);
    admittedAtByKind.set(usage.usage_kind, admittedAt);
    remainingByKind.set(usage.usage_kind, effectiveRemaining);
    pending.push({
      input: usageInput,
      rate_reservation: reservation,
      pending_reservation: pendingAdmission.reservation,
    });
    return { admitted: true };
  };

  return {
    reserve,

    reserveOnce(reservationKey, usage) {
      if (denial !== undefined) return { admitted: false, message: denial };
      if (onceReservations.get(reservationKey) === true) return { admitted: true };
      const admission = reserve(usage);
      if (admission.admitted) onceReservations.set(reservationKey, true);
      return admission;
    },

    markZeroUnitReservation(reservationKey) {
      if (settled) {
        denial = 'This customer usage request has already settled.';
        return { admitted: false, message: denial };
      }
      if (denial !== undefined) return { admitted: false, message: denial };
      if (!onceReservations.has(reservationKey)) {
        onceReservations.set(reservationKey, false);
      }
      return { admitted: true };
    },

    hasReservationKey: (reservationKey) => onceReservations.has(reservationKey),

    commit() {
      if (settled) return;
      settled = true;
      // Callers normally inspect `denialMessage()` and release. Keep the
      // all-or-nothing guarantee inside the session too so an accidental
      // commit after a partial denial can never durably record the prefix.
      if (denial !== undefined) {
        const error = settlePending(false);
        if (error !== undefined) throw error;
        return;
      }
      let firstError: unknown;
      const grouped = new Map<
        SellerUsageKind,
        { input: PendingUsageReservation['input']; units: number }
      >();
      for (const entry of pending) {
        const prior = grouped.get(entry.input.usage_kind);
        if (prior) prior.units += entry.input.units;
        else grouped.set(entry.input.usage_kind, {
          input: entry.input,
          units: entry.input.units,
        });
      }
      for (const group of grouped.values()) {
        try {
          input.gate.record({ ...group.input, units: group.units });
        } catch (error) {
          firstError ??= error;
        }
      }
      const settlementError = settlePending(true);
      firstError ??= settlementError;
      if (firstError !== undefined) throw firstError;
    },

    release() {
      if (settled) return;
      settled = true;
      const error = settlePending(false);
      if (error !== undefined) throw error;
    },

    denialMessage: () => denial,
  };
};

/** D-196 mcp_chat turn meter. Direction-C transport is still a future D-140
 * consumer, so this leaf owns the exact accepted-completion contract without
 * pretending the absent federation transport is live: one resolved turn
 * commits one chat_turn; admission denial runs no turn; a thrown/failed turn
 * releases its reservation. */
export const runMeteredMcpChatTurn = async <T>(input: {
  readonly usage: CustomerSurfaceUsageSession;
  readonly runAcceptedCompletion: () => Promise<T>;
  readonly onUsageRecordError?: (error: unknown) => void;
}): Promise<
  | { readonly admitted: true; readonly value: T }
  | { readonly admitted: false; readonly message: string }
> => {
  const admission = input.usage.reserve({
    tool_name: 'mcp_chat',
    usage_kind: 'chat_turn',
    units: 1,
  });
  if (!admission.admitted) return admission;

  try {
    const value = await input.runAcceptedCompletion();
    try {
      input.usage.commit();
    } catch (error) {
      input.onUsageRecordError?.(error);
    }
    return { admitted: true, value };
  } catch (error) {
    input.usage.release();
    throw error;
  }
};
