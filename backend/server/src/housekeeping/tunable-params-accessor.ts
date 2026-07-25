/** D-145 § A.7.8 (Amended 2026-05-26) — typed tunable-param accessor
 *  threaded on `HousekeepingContext.tunableParams`.
 *
 *  Producers MUST NOT read raw `prefs` or hit the store directly —
 *  they call `ctx.tunableParams.getNumber(topic, key)` /
 *  `ctx.tunableParams.getEnum(topic, key)`. The accessor:
 *
 *    1. Resolves the declaration spec via
 *       `getDeclaredTunableParamSpec(topic, key)`.
 *    2. Validates the kind against the call (`getNumber` requires
 *       `kind: 'number'`; `getEnum` requires `kind: 'enum'`); falls
 *       back to a safe sentinel on mismatch + emits a console warning.
 *    3. Reads the effective value from the store (override or default).
 *    4. Validates the read against the declared bounds + clamps
 *       numbers to `[min, max]` defensively. An undeclared param OR
 *       a kind mismatch returns the safe sentinel:
 *         - `getNumber` returns the declared default (when the param
 *           IS declared) or `Number.NaN` otherwise — producers that
 *           depend on a tunable MUST gate on `Number.isFinite` if
 *           they pass the result to math.
 *         - `getEnum` returns the declared default (when declared)
 *           or `''` otherwise — same caveat.
 *
 *  An ABSENT `tunableParams` accessor on the context (test scaffolds
 *  + producers without tunables) is handled by the standalone helpers
 *  `getTunableNumber(ctx, topic, key)` / `getTunableEnum(ctx, topic,
 *  key)` which fall back to the declared default. Producers should
 *  prefer these helpers over `ctx.tunableParams.getNumber(...)?` to
 *  keep call sites uncluttered.
 *
 *  Spec: `docs/d-145-spec.md` § A.7.8. */

import { type EnrichmentTopic } from '@recued/contracts';

import {
  getDeclaredTunableParamSpec,
  type TunableParamsStore,
} from './tunable-params-store.js';
import type { HousekeepingContext } from './registry.js';

// ────────────────────────────────────────────────────────────────
// Accessor surface
// ────────────────────────────────────────────────────────────────

export interface TunableParamsAccessor {
  /** Read an effective numeric tunable. Returns declaration default
   *  when no override row, override clamped to `[min, max]` when
   *  present + valid, and the declaration default on any drift (kind
   *  mismatch, schema drift). Returns `Number.NaN` when the param
   *  isn't declared at all (caller bug — declaration is the contract). */
  getNumber(topic: EnrichmentTopic, param_name: string): number;
  /** Read an effective enum tunable. Returns declaration default when
   *  no override row, override when present + valid, declaration
   *  default on any drift. Returns `''` when the param isn't declared
   *  at all. */
  getEnum(topic: EnrichmentTopic, param_name: string): string;
}

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createTunableParamsAccessor = (
  store: TunableParamsStore,
): TunableParamsAccessor => ({
  getNumber(topic, param_name) {
    const spec = getDeclaredTunableParamSpec(topic, param_name);
    if (!spec) return Number.NaN;
    // Kind mismatch — caller asked for a number but the declaration
    // says enum. Return NaN so a `Number.isFinite` gate catches the
    // misuse cleanly (rather than coercing the enum default's string).
    if (spec.kind !== 'number') return Number.NaN;
    const effective = store.readEffectiveParam(topic, param_name);
    const value =
      typeof effective === 'number' && Number.isFinite(effective)
        ? effective
        : spec.default;
    // Defensive clamp — the store already validates writes against
    // bounds, but a drift-shifted declaration can leave a row outside
    // the new bounds. Read-side clamp keeps producers safe.
    if (value < spec.min) return spec.min;
    if (value > spec.max) return spec.max;
    return value;
  },

  getEnum(topic, param_name) {
    const spec = getDeclaredTunableParamSpec(topic, param_name);
    if (!spec) return '';
    if (spec.kind !== 'enum') return String(spec.default);
    const effective = store.readEffectiveParam(topic, param_name);
    if (typeof effective !== 'string' || !spec.enum_values.includes(effective)) {
      return spec.default;
    }
    return effective;
  },
});

// ────────────────────────────────────────────────────────────────
// Context helpers — preferred call sites for producers
// ────────────────────────────────────────────────────────────────

/** Read a numeric tunable from the context, falling back to the
 *  declaration default when the context's accessor is unwired (test
 *  scaffolds that don't pass a tunableParams stub). Producers call
 *  this directly:
 *
 *    const window_days = getTunableNumber(
 *      ctx,
 *      'project_stall_signal',
 *      'stall_window_days',
 *    );
 *
 *  Returns `Number.NaN` when the param isn't declared at all (caller
 *  bug — production declarations cover every read). */
export const getTunableNumber = (
  ctx: Pick<HousekeepingContext, 'tunableParams'>,
  topic: EnrichmentTopic,
  param_name: string,
): number => {
  if (ctx.tunableParams) return ctx.tunableParams.getNumber(topic, param_name);
  const spec = getDeclaredTunableParamSpec(topic, param_name);
  if (!spec) return Number.NaN;
  return spec.kind === 'number' ? spec.default : Number.NaN;
};

/** Read an enum tunable from the context, falling back to the
 *  declaration default when the context's accessor is unwired. */
export const getTunableEnum = (
  ctx: Pick<HousekeepingContext, 'tunableParams'>,
  topic: EnrichmentTopic,
  param_name: string,
): string => {
  if (ctx.tunableParams) return ctx.tunableParams.getEnum(topic, param_name);
  const spec = getDeclaredTunableParamSpec(topic, param_name);
  if (!spec) return '';
  return spec.kind === 'enum' ? spec.default : '';
};
