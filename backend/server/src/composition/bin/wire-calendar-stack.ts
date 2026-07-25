/** D-117 / D-121 — calendar stack boot composer.
 *
 *  Wraps `composeCalendarStack` from the calendar package with the
 *  bin.ts-level dep wiring: per-collection storage gate factory,
 *  optional contact-derivation observer (D-121 Phase 1), the three
 *  first-wave adapter factories (gcal / graph / caldav) gated on
 *  their OAuth client-id presence, OAuth account-store passthrough,
 *  and a per-stack logger.
 *
 *  Gated on `db && cacheBlobs` — dbless harnesses or boots without a
 *  blob store return `undefined` so the downstream consumers
 *  (`registerCalendarCollections`, `calendarStack.enrollDeps`,
 *  lifecycle drain) all skip cleanly. */

import type Database from 'better-sqlite3';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { AuditLogStore } from '@recued/storage';

import type { ServerAccountStore } from '../../account-store.js';
import type { GateRegistry } from '../../storage-gates.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { OAuthProviderConfig } from '../../collections/mail/oauth.js';
import { deriveContactsFromCalendar } from '../../warehouse/contact-derive.js';
import {
  composeCalendarStack,
  type CalendarStack,
} from '../../collections/calendar/compose.js';
import { createCalendarTable } from '../../collections/calendar/calendar-table.js';
import { createGcalAdapterFactory } from '../../collections/calendar/gcal-provider.js';
import { createGraphCalAdapterFactory } from '../../collections/calendar/graph-provider.js';
import { createCalDavAdapterFactory } from '../../collections/calendar/caldav-provider.js';
import {
  createLocalCalendarAdapterFactory,
  DEFAULT_LOCAL_CALENDAR_SLUG,
  LOCAL_CALENDAR_CAPS,
} from '../../collections/calendar/local-provider.js';
import { validateCalendarCaps } from '../../collections/calendar/caps.js';
import type { BlobStore } from '../../storage/index.js';

export interface ComposeCalendarStackBootDeps {
  /** SQLite handle. Undefined-or-`cacheBlobs`-undefined → composer
   *  returns `undefined`. */
  db: Database.Database | undefined;
  /** Blob store. Same all-or-nothing gating as `db`. */
  cacheBlobs: BlobStore | undefined;
  /** Warehouse bus the underlying stack emits `data.calendar.*` events
   *  onto. */
  warehouseBus: WarehouseEventBus;
  /** Optional — pass-through for the underlying stack's per-upsert
   *  audit emit hook. */
  auditLog?: AuditLogStore;
  /** Optional — when wired, every upsert derives organizer + attendees
   *  into `data.contact` rows via the `onEventUpserted` observer.
   *  Dbless harnesses + tests without a contact store omit this and
   *  the observer never registers. */
  contactStore?: ContactStore;
  /** Per-collection storage gate factory. The composer wraps it into
   *  the `getGate` callback the underlying stack expects, registering
   *  one gate per `(platform='calendar', slug)` with a 512 MB quota
   *  default. Undefined gateRegistry is treated as a programming error
   *  (gateRegistry tracks `db` presence in bin.ts; defensive throw
   *  matches the original inline behaviour). */
  gateRegistry: GateRegistry | undefined;
  /** OAuth account store shared with mail. When absent the gcal/graph
   *  factories register with a no-op account-store double so the rpc
   *  surfaces `not_configured` cleanly; the caldav etag store +
   *  password lookup fall back to a no-op double for the same reason. */
  accountStore?: ServerAccountStore;
  /** Per-USE credential resolver (store-then-env, no boot binding). The
   *  gcal/graph factories always register; the resolver decides availability
   *  at enroll + on every token refresh (`null` ⇒ not configured). */
  resolveOAuthConfig: (adapter: 'gcal' | 'graph') => OAuthProviderConfig | null;
  /** Vault-lock predicate — forwarded into the calendar stack's bundle so a
   *  live collection's poll loop is deferred while the vault is LOCKED. Absent
   *  ⇒ sync always starts (dbless / harness). */
  isVaultUnlocked?: () => boolean;
}

export const composeCalendarBoot = (
  deps: ComposeCalendarStackBootDeps,
): CalendarStack | undefined => {
  const {
    db,
    cacheBlobs,
    warehouseBus,
    auditLog,
    contactStore,
    gateRegistry,
    accountStore,
    resolveOAuthConfig,
    isVaultUnlocked,
  } = deps;

  if (!db || !cacheBlobs) return undefined;

  // gcal / graph factories take the OAuth account store as their
  // token-persistence backend. Tests + dbless harnesses skip OAuth
  // entirely and the no-op double surfaces `not_configured` on the
  // enroll rpc.
  const oauthAccountStoreDouble = accountStore
    ? {
        get: (k: string) => accountStore.get(k),
        set: (k: string, v: string) => accountStore.set(k, v),
        delete: (k: string) => accountStore.delete(k),
      }
    : {
        async get() {
          return null;
        },
        async set() {},
        async delete() {},
      };

  const stack = composeCalendarStack(
    db,
    {
      blobs: cacheBlobs,
      bus: warehouseBus,
      ...(auditLog ? { auditLog } : {}),
      ...(contactStore
        ? {
            onEventUpserted: (payload) => {
              // D-121 Phase 1 — derive contacts from organizer +
              // attendees. Errors swallowed inside the collection's
              // try/catch so a bad row never rolls back ingest.
              const obs = deriveContactsFromCalendar(payload.event);
              if (obs.length > 0) contactStore.observeBatch(obs);
            },
          }
        : {}),
      getGate: (slug: string) => {
        const name = `collection:calendar:${slug}`;
        if (gateRegistry) {
          const existing = gateRegistry.get(name);
          if (existing) return existing;
          // 512 MB default — matches the calendar spec's per-instance
          // quota. Users widen via TOML.
          return gateRegistry.register(name, {
            quota: 512 * 1024 * 1024,
            reservePct: 10,
            initialUsage: 0,
          });
        }
        // Practically unreachable: bin.ts only constructs the stack
        // when `db` is present, and gateRegistry tracks `db`. Defensive
        // throw matches the original.
        throw new Error('calendarStack: gateRegistry not available');
      },
    },
    {
      ...(isVaultUnlocked ? { isVaultUnlocked } : {}),
      factories: [
        // D-173 P4.3 — the credential-free local calendar. Always
        // registered (no OAuth client / vault key to gate on); backs the
        // auto-created default local instance so a user has a calendar to
        // put events on without connecting an external provider.
        createLocalCalendarAdapterFactory({
          now: () => Date.now(),
          // Slice 2 — the `updateEvent` merge base. For an external adapter the
          // provider's API holds the current event; for `local` the warehouse
          // does, so the composition root hands the adapter a narrow read.
          //
          // `createCalendarTable` is idempotent per slug (it CREATEs IF NOT
          // EXISTS and returns a handle to the same table), so this resolves the
          // live row without needing a reference to a collection that does not
          // exist yet when factories are registered. Read-only by construction:
          // no `onBytesChanged` is passed because nothing here writes — the
          // merged event goes back through the dispatcher's
          // `applyVerifiedUpsert`, exactly as an external provider's would.
          readEvent: (slug, source_id) =>
            createCalendarTable({ db, slug }).get(source_id)?.event ?? null,
        }),
        // gcal / graph factories ALWAYS register; the per-use resolver
        // decides availability (enroll guards `null`; refresh throws). This
        // is what lets UI-entered credentials work without a restart — a
        // boot-time client-id gate would have required one.
        createGcalAdapterFactory({
          accountStore: oauthAccountStoreDouble,
          providerConfig: () => resolveOAuthConfig('gcal'),
        }),
        createGraphCalAdapterFactory({
          accountStore: oauthAccountStoreDouble,
          providerConfig: () => resolveOAuthConfig('graph'),
        }),
        // caldav needs an etag cache. The password resolves through the
        // adapter context's `getAccountValue('password')` →
        // `caldav.<slug>.password` (written by enrollBasic), so no
        // separate resolver wiring. The etag keys live under
        // `caldav.<slug>.etag.*` so they coexist with that password +
        // the OAuth token storage on the shared account store.
        createCalDavAdapterFactory({
          etagStore: accountStore
            ? {
                get: (k) => accountStore.get(k),
                set: (k, v) => accountStore.set(k, v),
                delete: (k) => accountStore.delete(k),
                list: async (prefix: string) => {
                  const all = await accountStore.getAll();
                  return Object.entries(all)
                    .filter(([k]) => k.startsWith(prefix))
                    .map(([k, v]) => ({ key: k, value: v }));
                },
              }
            : {
                async get() {
                  return null;
                },
                async set() {},
                async delete() {},
                async list() {
                  return [];
                },
              },
        }),
      ],
      oauthConfig: (adapter) => resolveOAuthConfig(adapter),
      ...(accountStore
        ? {
            accountStore: {
              get: (k) => accountStore.get(k),
              set: (k, v) => accountStore.set(k, v),
              delete: (k) => accountStore.delete(k),
              // Threaded so the enroll DELETE handler can prefix-sweep a
              // caldav instance's `caldav.<slug>.*` keys (password + etag
              // sync-cursors); without it the sweep silently no-ops to the
              // password-only fallback in production.
              getAll: () => accountStore.getAll(),
            },
          }
        : {}),
    },
    {
      log: (level, msg, data) => {
        const fn = level === 'error' ? console.error : console.log;
        fn(`[calendar-stack] ${msg}`, data ?? '');
      },
    },
  );

  // D-173 P4.3 — ensure the default local calendar exists before the
  // caller's `startAll()` runs, so a user (and reception scheduling) has
  // a credential-free calendar to write events to out of the box.
  //
  // 🔑 CAPS ARE REFRESHED ON EVERY BOOT, not written once (slice 2, 2026-07-16).
  //
  // The dispatcher's write gate reads caps from THIS ROW, not from
  // `LOCAL_CALENDAR_CAPS` (`calendar-dispatcher.ts` requireRow → effectiveCaps →
  // hasCap). The row is persisted. So while this block skipped an existing row
  // entirely, the caps were frozen at whatever the code said on FIRST boot —
  // and slice 2 flipping `update_event` / `delete_event` to `'yes'` in the
  // constant would have been INERT on every server that had already booted
  // once. Every move and cancel would keep 403'ing, forever, with the constant
  // plainly reading `'yes'`. A declaration nothing reads.
  //
  // Refreshing is correct specifically because `local` caps are a CODE fact:
  // `probeCaps` returns the static constant, there is no network probe, and
  // there is no user-configurable cap surface. So the row must track the code.
  // Everything that IS instance state — `config`, `auth_state`,
  // `last_synced_at`, and the warehouse events themselves — is preserved
  // verbatim, which is what the original skip was really protecting.
  const existingLocal = stack.instances.get('calendar', DEFAULT_LOCAL_CALENDAR_SLUG);
  stack.instances.upsert({
    platform: 'calendar',
    slug: DEFAULT_LOCAL_CALENDAR_SLUG,
    adapter_type: 'local',
    config: existingLocal?.config ?? {},
    caps: validateCalendarCaps(LOCAL_CALENDAR_CAPS),
    auth_state: existingLocal?.auth_state ?? 'healthy',
    last_synced_at: existingLocal?.last_synced_at ?? null,
  });

  return stack;
};
