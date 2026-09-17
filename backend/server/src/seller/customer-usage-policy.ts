/** D-196 Seller Economy - customer usage policy + rollup writer.
 *
 *  The store owns durable day/month rollups; this module is the small admission
 *  layer that interprets a tier's per-kind usage_policy_json and decides whether
 *  a customer-visible unit can run.
 */

import { usageCapWindowStart } from '@recued/contracts';
import type {
  SellerCustomer,
  SellerCustomerUsageRollup,
  SellerTier,
  SellerUsageKind,
  SellerUsagePeriodGranularity,
} from '@recued/contracts';
import {
  isSellerUsagePeriodGranularity,
} from '@recued/contracts';

import type { SellerStore } from '../storage/seller-store.js';

export type SellerCustomerUsageDenyReason =
  | 'policy_invalid'
  | 'period_limit_exceeded'
  | 'rate_limit_exceeded'
  | 'usage_error';

export interface SellerCustomerUsageInput {
  readonly customer: SellerCustomer;
  readonly tier: SellerTier;
  readonly usage_kind: SellerUsageKind;
  readonly units?: number;
  readonly now?: number;
}

export type SellerCustomerUsageAdmissionResult =
  | {
      readonly admitted: true;
      readonly usage_kind: SellerUsageKind;
      readonly units: number;
      readonly period_granularity: SellerUsagePeriodGranularity;
      readonly period_start: number;
      readonly period_limit: number | null;
      readonly used: number;
      readonly remaining: number | null;
    }
  | {
      readonly admitted: false;
      readonly reason: SellerCustomerUsageDenyReason;
      readonly message: string;
      readonly usage_kind: SellerUsageKind;
      readonly units: number;
      readonly period_granularity?: SellerUsagePeriodGranularity;
      readonly period_start?: number;
      readonly period_limit?: number | null;
      readonly used?: number;
      readonly remaining?: number;
      readonly retry_after_ms?: number;
    };

export interface SellerCustomerUsageRecordResult {
  readonly rollup: SellerCustomerUsageRollup;
}

export type SellerCustomerUsageStore = Pick<
  SellerStore,
  // D-250 § D — `recordTokenUsage` joins the two metering methods because the
  // measurement lands on the SAME rollup row, in the same period, at the same
  // commit. A separate store handle would have made it possible to record a
  // cost against a row whose units went somewhere else.
  'getUsageRollup' | 'recordUsage' | 'recordTokenUsage'
>;

/** Opaque handle for one admitted token-bucket debit that has not crossed its
 * success boundary yet. Callers may only commit or release it through the gate
 * that created it. */
export interface SellerCustomerUsageRateReservation {
  readonly bucket_key: string;
  readonly event_id: number;
  readonly gate_id: symbol;
}

export interface SellerCustomerUsageRateReservationResult {
  readonly admission: SellerCustomerUsageAdmissionResult;
  readonly reservation: SellerCustomerUsageRateReservation | null;
}

export interface SellerCustomerUsageGate {
  admit(input: SellerCustomerUsageInput): SellerCustomerUsageAdmissionResult;
  reserveRate(input: SellerCustomerUsageInput): SellerCustomerUsageRateReservationResult;
  record(input: SellerCustomerUsageInput): SellerCustomerUsageRecordResult;
  commitRate(reservation: SellerCustomerUsageRateReservation, at?: number): void;
  /** Remove an admitted debit and replay later successful debits exactly, so
   * elapsed refill is neither double-credited nor lost. */
  releaseRate(reservation: SellerCustomerUsageRateReservation, at?: number): void;
}

export interface SellerCustomerUsageGateDeps {
  readonly sellerStore: SellerCustomerUsageStore;
  readonly now?: () => number;
}

export interface SellerCustomerUsagePolicy {
  readonly period_granularity: SellerUsagePeriodGranularity;
  readonly period_limit: number | null;
  readonly rate_limit_per_minute: number | null;
}

interface RateEvent {
  readonly id: number;
  readonly at: number;
  readonly units: number;
  reserved: boolean;
}

interface RateBucket {
  readonly capacity: number;
  checkpoint_tokens: number;
  checkpoint_at: number;
  next_event_id: number;
  readonly events: RateEvent[];
}

const MINUTE_MS = 60 * 1000;

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const optionalWholeNumber = (
  value: unknown,
  field: string,
): { ok: true; value: number | null } | { ok: false; message: string } => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Number.isInteger(value) || (value as number) < 0) {
    return { ok: false, message: `${field} must be a non-negative integer` };
  }
  return { ok: true, value: value as number };
};

const policyValue = (
  obj: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  }
  return undefined;
};

export const resolveSellerCustomerUsagePolicy = (
  tier: SellerTier,
  usage_kind: SellerUsageKind,
): { ok: true; policy: SellerCustomerUsagePolicy } | { ok: false; message: string } => {
  const raw = tier.usage_policy_json[usage_kind];
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      policy: {
        period_granularity: 'month',
        period_limit: null,
        rate_limit_per_minute: null,
      },
    };
  }
  const obj = objectRecord(raw);
  if (!obj) {
    return { ok: false, message: `${usage_kind} usage policy must be an object` };
  }

  const granularityRaw = policyValue(obj, [
    'period_granularity',
    'granularity',
    'period',
  ]);
  const period_granularity =
    granularityRaw === undefined || granularityRaw === null
      ? 'month'
      : isSellerUsagePeriodGranularity(granularityRaw)
        ? granularityRaw
        : null;
  if (period_granularity === null) {
    return {
      ok: false,
      message: `${usage_kind} period_granularity must be 'day' or 'month'`,
    };
  }

  const limitRaw = policyValue(obj, [
    'period_limit',
    'period_allowance',
    'allowance',
    period_granularity === 'day' ? 'daily_limit' : 'monthly_limit',
  ]);
  const periodLimit = optionalWholeNumber(limitRaw, `${usage_kind}.period_limit`);
  if (!periodLimit.ok) return { ok: false, message: periodLimit.message };

  const rateRaw = policyValue(obj, [
    'rate_limit_per_min',
    'rate_limit_per_minute',
    'per_minute_rate_limit',
    'rate_per_minute',
    'per_minute',
  ]);
  const rateLimit = optionalWholeNumber(
    rateRaw,
    `${usage_kind}.rate_limit_per_minute`,
  );
  if (!rateLimit.ok) return { ok: false, message: rateLimit.message };

  return {
    ok: true,
    policy: {
      period_granularity,
      period_limit: periodLimit.value,
      rate_limit_per_minute: rateLimit.value,
    },
  };
};

/** ⛔⛔ ONE BOUNDARY, ONE IMPLEMENTATION. This was hand-rolled here, hand-rolled
 *  AGAIN privately in `customer-status.ts`, and a third time in
 *  `contract-definition.ts` for the contract use cap — three answers to "when
 *  does the UTC month start", two of them in this directory and one of them
 *  private, so an edit to this exported one would not have reached it.
 *
 *  🔑 THE DRIFT THAT MATTERS IS SILENT. They agreed byte-for-byte, so nothing
 *  was wrong; but a dispatch counted against one boundary and billed against
 *  another is a discrepancy no test would show, because each copy is
 *  self-consistent. Delegating leaves one place for the arithmetic to be wrong
 *  in, which is the only number of places worth having.
 *
 *  ⚠ THE VOCABULARY IS DELIBERATELY NOT MERGED. `UsageCapPeriod` carries a
 *  `'total'` member this granularity has no use for, and whether every cap
 *  period is a valid BILLING period is a policy question, not a typing one — so
 *  the two lists stay separate and a ratchet pins the containment instead. */
export const sellerCustomerUsagePeriodStart = (
  now: number,
  granularity: SellerUsagePeriodGranularity,
): number => {
  // Non-null by construction: `usageCapWindowStart` returns null only for
  // `'total'`, which is not a member of this granularity.
  const start = usageCapWindowStart(granularity, now);
  if (start === null) {
    throw new Error(`seller usage period: no window for granularity '${String(granularity)}'`);
  }
  return start;
};

const cleanUnits = (units: number | undefined): number => {
  const value = units ?? 1;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('usage units must be a positive integer');
  }
  return value;
};

const replayRate = (
  bucket: RateBucket,
  at: number,
): { readonly tokens: number; readonly at: number } => {
  const refillPerMs = bucket.capacity / MINUTE_MS;
  let tokens = bucket.checkpoint_tokens;
  let cursor = bucket.checkpoint_at;
  for (const event of bucket.events) {
    const eventAt = Math.max(event.at, cursor);
    tokens = Math.min(
      bucket.capacity,
      tokens + (eventAt - cursor) * refillPerMs,
    );
    tokens -= event.units;
    cursor = eventAt;
  }
  const effectiveAt = Math.max(at, cursor);
  tokens = Math.min(
    bucket.capacity,
    tokens + (effectiveAt - cursor) * refillPerMs,
  );
  return { tokens, at: effectiveAt };
};

const hasPendingRateReservation = (bucket: RateBucket): boolean =>
  bucket.events.some((event) => event.reserved);

const compactRate = (bucket: RateBucket, at: number): void => {
  if (hasPendingRateReservation(bucket)) return;
  const state = replayRate(bucket, at);
  bucket.checkpoint_tokens = state.tokens;
  bucket.checkpoint_at = state.at;
  bucket.events.length = 0;
};

const consumeRate = (
  buckets: Map<string, RateBucket>,
  input: {
    readonly key: string;
    readonly capacity: number;
    readonly units: number;
    readonly now: number;
    readonly reserve: boolean;
    readonly gate_id: symbol;
  },
):
  | {
      readonly allowed: true;
      readonly reservation: SellerCustomerUsageRateReservation | null;
    }
  | { readonly allowed: false; readonly retry_after_ms: number } => {
  if (input.capacity <= 0) return { allowed: false, retry_after_ms: MINUTE_MS };
  const refillPerMs = input.capacity / MINUTE_MS;
  let bucket = buckets.get(input.key);
  if (!bucket) {
    bucket = {
      capacity: input.capacity,
      checkpoint_tokens: input.capacity,
      checkpoint_at: input.now,
      next_event_id: 1,
      events: [],
    };
    buckets.set(input.key, bucket);
  }
  const state = replayRate(bucket, input.now);
  if (state.tokens >= input.units) {
    const event: RateEvent = {
      id: bucket.next_event_id++,
      at: state.at,
      units: input.units,
      reserved: input.reserve,
    };
    bucket.events.push(event);
    const reservation = input.reserve
      ? {
          bucket_key: input.key,
          event_id: event.id,
          gate_id: input.gate_id,
        }
      : null;
    compactRate(bucket, state.at);
    return { allowed: true, reservation };
  }
  if (!hasPendingRateReservation(bucket)) {
    bucket.checkpoint_tokens = state.tokens;
    bucket.checkpoint_at = state.at;
    bucket.events.length = 0;
  }
  const needed = input.units - state.tokens;
  return { allowed: false, retry_after_ms: Math.ceil(needed / refillPerMs) };
};

export const createSellerCustomerUsageGate = (
  deps: SellerCustomerUsageGateDeps,
): SellerCustomerUsageGate => {
  const now = deps.now ?? (() => Date.now());
  const rateBuckets = new Map<string, RateBucket>();
  const gateId = Symbol('seller-customer-usage-gate');

  const resolvePolicy = (
    input: SellerCustomerUsageInput,
    units: number,
    timestamp: number,
  ): SellerCustomerUsageAdmissionResult | {
    readonly policy: SellerCustomerUsagePolicy;
    readonly period_start: number;
  } => {
    const parsed = resolveSellerCustomerUsagePolicy(input.tier, input.usage_kind);
    if (!parsed.ok) {
      return {
        admitted: false,
        reason: 'policy_invalid',
        message: parsed.message,
        usage_kind: input.usage_kind,
        units,
      };
    }
    return {
      policy: parsed.policy,
      period_start: sellerCustomerUsagePeriodStart(
        timestamp,
        parsed.policy.period_granularity,
      ),
    };
  };

  const admitUsage = (
    input: SellerCustomerUsageInput,
    reserveRateCapacity: boolean,
  ): SellerCustomerUsageRateReservationResult => {
    const units = cleanUnits(input.units);
    const timestamp = input.now ?? now();
    const resolved = resolvePolicy(input, units, timestamp);
    if ('admitted' in resolved) {
      return { admission: resolved, reservation: null };
    }

    const { policy, period_start } = resolved;
    const rollup = deps.sellerStore.getUsageRollup({
      contract_id: input.customer.contract_id,
      usage_kind: input.usage_kind,
      period_granularity: policy.period_granularity,
      period_start,
    });
    const used = rollup?.units ?? 0;
    if (policy.period_limit !== null && used + units > policy.period_limit) {
      const remaining = Math.max(policy.period_limit - used, 0);
      return {
        admission: {
          admitted: false,
          reason: 'period_limit_exceeded',
          message:
            `${input.usage_kind} usage limit exceeded: `
            + `${used}/${policy.period_limit} used; ${units} requested.`,
          usage_kind: input.usage_kind,
          units,
          period_granularity: policy.period_granularity,
          period_start,
          period_limit: policy.period_limit,
          used,
          remaining,
        },
        reservation: null,
      };
    }

    let reservation: SellerCustomerUsageRateReservation | null = null;
    if (policy.rate_limit_per_minute !== null) {
      const rate = consumeRate(rateBuckets, {
        key:
          `${input.customer.contract_id}:${input.usage_kind}:`
          + `${policy.rate_limit_per_minute}`,
        capacity: policy.rate_limit_per_minute,
        units,
        now: timestamp,
        reserve: reserveRateCapacity,
        gate_id: gateId,
      });
      if (!rate.allowed) {
        return {
          admission: {
            admitted: false,
            reason: 'rate_limit_exceeded',
            message:
              `${input.usage_kind} rate limit exceeded: `
              + `${policy.rate_limit_per_minute}/minute.`,
            usage_kind: input.usage_kind,
            units,
            period_granularity: policy.period_granularity,
            period_start,
            period_limit: policy.period_limit,
            used,
            remaining:
              policy.period_limit === null
                ? undefined
                : Math.max(policy.period_limit - used, 0),
            retry_after_ms: rate.retry_after_ms,
          },
          reservation: null,
        };
      }
      reservation = rate.reservation;
    }

    return {
      admission: {
        admitted: true,
        usage_kind: input.usage_kind,
        units,
        period_granularity: policy.period_granularity,
        period_start,
        period_limit: policy.period_limit,
        used,
        remaining:
          policy.period_limit === null
            ? null
            : Math.max(policy.period_limit - used - units, 0),
      },
      reservation,
    };
  };

  const findRateReservation = (
    reservation: SellerCustomerUsageRateReservation,
  ): { readonly bucket: RateBucket; readonly index: number } | null => {
    if (reservation.gate_id !== gateId) return null;
    const bucket = rateBuckets.get(reservation.bucket_key);
    if (!bucket) return null;
    const index = bucket.events.findIndex(
      (event) => event.id === reservation.event_id && event.reserved,
    );
    return index < 0 ? null : { bucket, index };
  };

  return {
    admit(input) {
      return admitUsage(input, false).admission;
    },
    reserveRate(input) {
      return admitUsage(input, true);
    },
    record(input) {
      const units = cleanUnits(input.units);
      const timestamp = input.now ?? now();
      const resolved = resolvePolicy(input, units, timestamp);
      if ('admitted' in resolved) {
        throw new Error(
          `cannot record usage: ${
            resolved.admitted ? 'unexpected admitted policy result' : resolved.message
          }`,
        );
      }
      const rollup = deps.sellerStore.recordUsage({
        contract_id: input.customer.contract_id,
        usage_kind: input.usage_kind,
        period_granularity: resolved.policy.period_granularity,
        period_start: resolved.period_start,
        units,
        now: timestamp,
      });
      return { rollup };
    },
    commitRate(reservation, at = now()) {
      const found = findRateReservation(reservation);
      if (!found) return;
      found.bucket.events[found.index]!.reserved = false;
      compactRate(found.bucket, at);
    },
    releaseRate(reservation, at = now()) {
      const found = findRateReservation(reservation);
      if (!found) return;
      found.bucket.events.splice(found.index, 1);
      compactRate(found.bucket, at);
    },
  };
};

