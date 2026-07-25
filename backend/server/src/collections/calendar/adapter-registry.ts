/** D-117 Phase 2 — CalendarProvider adapter registry.
 *
 *  Closed registry paralleling `collections/file/adapter-registry.ts`.
 *  First wave lands three factories (`gcal`, `graph`, `caldav`) in
 *  Phases 3 / 4 / 5. New adapters require an upstream contribution
 *  — plugin adapters are explicitly non-goal per D-117 (mirroring
 *  D-110's stance for file adapters).
 *
 *  Each factory promises two things:
 *    1. `probeCaps(config, ctx)` — run a read-only capabilities probe
 *       (list calendars + sample listEvents). Must not keep process
 *       state after resolving. Returns `ProbedCalendarCaps`.
 *    2. `create(ctx)` — instantiate a running adapter for the same
 *       config. Wires to the outer `CalendarCollection` layer; the
 *       caller (enroll rpc + bin.ts wiring) decides when to start it.
 *
 *  The registry itself is stateless — factories close over their
 *  config; tests swap with `createCalendarAdapterRegistry()` + their
 *  own factories to avoid live-network side effects. No mutable
 *  global state on the production path.
 */

import type { CalendarCollectionCaps } from '@recued/contracts';
import { validateCalendarCaps } from './caps.js';
import type {
  CalendarProvider,
  CalendarProviderKind,
  ProbedCalendarCaps,
} from './provider.js';

/** Context a calendar adapter factory gets when being instantiated.
 *  Stays narrow so factories can't reach into the composition root
 *  and take dependencies that weren't declared. */
export interface CalendarAdapterContext {
  /** User-chosen slug. Useful for log prefixes + cursor keys. */
  slug: string;
  /** Validated config for this instance — adapter-specific shape.
   *  Factories parse further at construction time. */
  config: Record<string, unknown>;
  /** Account-namespace reader for credentials. Adapters never touch
   *  the raw `account` store directly; they ask through this hook so
   *  the composition root can enforce scoping. Returns `null` when
   *  the key is unset.
   *
   *  Keys are scoped `<kind>.<slug>.<name>` — e.g.
   *  `gcal.work.refresh_token`, `caldav.fastmail.password`. */
  getAccountValue: (key: string) => Promise<string | null>;
  /** Optional log hook. Defaults to no-op. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** A calendar adapter factory — probe + create. Both operations
 *  receive the same context so adapter-specific config can be
 *  validated once. */
export interface CalendarAdapterFactory {
  /** Registry key. Must equal the `adapter_type` stored on the
   *  `collection_instances` row for this instance. */
  readonly kind: CalendarProviderKind;
  /** Probe the capabilities an adapter will expose given this
   *  config. Called at enrollment time and on manual re-probe. */
  probeCaps(ctx: CalendarAdapterContext): Promise<ProbedCalendarCaps>;
  /** Instantiate the adapter. Called after a successful probe; the
   *  caller wires the returned instance to the outer
   *  `CalendarCollection`. */
  create(ctx: CalendarAdapterContext): CalendarProvider;
}

export interface CalendarAdapterRegistry {
  register(factory: CalendarAdapterFactory): void;
  /** Return the factory matching `kind`, or `undefined` when unknown.
   *  Unknown adapter types surface as 400 on the enroll rpc. */
  get(kind: string): CalendarAdapterFactory | undefined;
  /** Every registered adapter kind in registration order. Populates
   *  the extension Options UI adapter picker. */
  listKinds(): CalendarProviderKind[];
}

export const createCalendarAdapterRegistry = (): CalendarAdapterRegistry => {
  const byKind = new Map<CalendarProviderKind, CalendarAdapterFactory>();
  const order: CalendarProviderKind[] = [];
  return {
    register(factory) {
      if (byKind.has(factory.kind)) {
        throw new Error(
          `CalendarAdapterRegistry: duplicate registration for '${factory.kind}'`,
        );
      }
      byKind.set(factory.kind, factory);
      order.push(factory.kind);
    },
    get(kind) {
      return byKind.get(kind as CalendarProviderKind);
    },
    listKinds() {
      return [...order];
    },
  };
};

/** Run a probe + validate the returned shape. Wraps
 *  `factory.probeCaps` so every call site gets the same
 *  shape-check + error handling. Throws a developer-grade `Error`
 *  when the factory returns a malformed caps shape (factory bug,
 *  not user config). */
export const probeCalendarAdapter = async (
  factory: CalendarAdapterFactory,
  ctx: CalendarAdapterContext,
): Promise<CalendarCollectionCaps> => {
  let probed: ProbedCalendarCaps;
  try {
    probed = await factory.probeCaps(ctx);
  } catch (err) {
    throw new Error(
      `probe failed for calendar adapter '${factory.kind}': ${(err as Error).message}`,
    );
  }
  return validateCalendarCaps(probed);
};
