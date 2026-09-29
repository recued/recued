/** D-127 / D-121 / D-315 — mail stack boot composer.
 *
 *  Wraps `composeMailStack` from the mail package with the bin.ts-level
 *  dep wiring: per-collection storage gate factory, optional contact-
 *  derivation observer (D-121 Phase 1), optional mail-fact writer
 *  (D-315), shared OAuth account store for gmail + graph token
 *  persistence, and a per-stack logger.
 *
 *  Mirrors the calendar boot composer's shape — same `db && cacheBlobs`
 *  gating, same conditional spreads, same defensive `getGate` throw.
 *  Mail's adapter set is simpler (no factory list — gmail / graph /
 *  imap are baked into `composeMailStack` itself; the bundle only
 *  carries `accountStore` + `oauthConfig`). */

import type Database from 'better-sqlite3';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { AuditLogStore } from '@recued/storage';

import type { ServerAccountStore } from '../../account-store.js';
import type { GateRegistry } from '../../storage-gates.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { MailFactWriter } from '../../mail-facts/fact-writer.js';
import { createMailFactIngest } from '../../mail-facts/mail-ingest.js';
import type { FileReadDeps } from '../../collections/file/file-read-handler.js';
import type { MailInboundAttachmentDeps } from '../../collections/mail/mail-collection.js';
import type { OAuthProviderConfig } from '../../collections/mail/oauth.js';
import { deriveContactsFromMail } from '../../warehouse/contact-derive.js';
import {
  composeMailStack,
  type MailStack,
  type MailStackStorageDeps,
} from '../../collections/mail/compose.js';
import type { BlobStore } from '../../storage/index.js';

export interface ComposeMailStackBootDeps {
  /** LAZY accessor for the shared `CollectionRegistry`, forwarded to the stack
   *  so a post-boot enroll registers immediately.
   *
   *  ⚠ This interface is a FIELD-BY-FIELD copier into `composeMailStack` below —
   *  a field added to the caller but not forwarded here is silently absent and
   *  typechecks clean at every layer (both ends are optional). Add to BOTH. */
  getCollectionRegistry?: () => import('../../collections/registry.js').CollectionRegistry | undefined;
  /** SQLite handle. Undefined-or-`cacheBlobs`-undefined → composer
   *  returns `undefined`. */
  db: Database.Database | undefined;
  /** Blob store. Same all-or-nothing gating as `db`. */
  cacheBlobs: BlobStore | undefined;
  /** Warehouse bus the underlying stack emits `data.mail.*` events
   *  onto. */
  warehouseBus: WarehouseEventBus;
  /** Optional — pass-through for the underlying stack's per-upsert
   *  audit emit hook. */
  auditLog?: AuditLogStore;
  /** Optional — when wired, every upsert derives From/To/CC into
   *  `data.contact` rows via the `onMessageUpserted` observer.
   *  Dbless harnesses + tests without a contact store omit this and
   *  the observer never registers. */
  contactStore?: ContactStore;
  /** D-315 — optional. When wired, every upsert is read for mail facts through
   *  this writer, and a deleted, pruned or moved message takes its facts along.
   *  The sender's relationships come from `contactStore` when both are wired.
   *  The composition owns the one writer: a backfill writes through it too. */
  mailFactWriter?: MailFactWriter;
  /** Per-collection storage gate factory. The composer wraps it into
   *  the `getGate` callback the underlying stack expects, registering
   *  one gate per `(platform='mail', slug)` with a 512 MB quota
   *  default. Undefined gateRegistry is treated as a programming error
   *  (gateRegistry tracks `db` presence in bin.ts; defensive throw
   *  matches the original inline behaviour). */
  gateRegistry: GateRegistry | undefined;
  /** OAuth account store shared with calendar. When absent the bundle
   *  omits `accountStore` and the enroll rpc surfaces `not_configured`
   *  for OAuth providers. */
  accountStore?: ServerAccountStore;
  /** Per-USE credential resolver (store-then-env, no boot binding). Called at
   *  enroll AND on every token refresh — `null` ⇒ not configured (enroll
   *  surfaces `not_configured`; refresh throws `oauth_app_not_configured`). */
  resolveOAuthConfig: (provider: 'gmail' | 'graph') => OAuthProviderConfig | null;
  /** D-172 P2 — lazy provider of the `file.read` deps used to resolve
   *  outbound mail `attachments` refs into bytes at
   *  `MailCollection.send`. Lazy because the collection registry is
   *  created after this stack in the boot composer; the getter defers
   *  the read to call time. Forwarded verbatim into the underlying
   *  stack's storage deps. Omitted on dbless / no-CAS harnesses. */
  fileReadDeps?: () => FileReadDeps | undefined;
  /** D-172 A.7 — lazy inbound file/link deps for received mail
   *  attachments. Omitted on partial/dbless boots; the collection logs
   *  surfaced parts as not configured instead of silently dropping. */
  inboundAttachmentDeps?: () => MailInboundAttachmentDeps | undefined;
  /** Vault-lock predicate — forwarded into the mail stack's bundle so a live
   *  collection's poll loop is deferred while the vault is LOCKED. Absent ⇒
   *  sync always starts (dbless / harness). */
  isVaultUnlocked?: () => boolean;
}

type UpsertHook = NonNullable<MailStackStorageDeps['onMessageUpserted']>;

/** Run every hook, each on its own: a contact write that throws must not keep
 *  the message from being read for facts, nor the other way round. The first
 *  error is rethrown once all have run, so the collection still records it. */
const runEachUpsertHook = (hooks: readonly UpsertHook[]): UpsertHook => (msg, ctx) => {
  let first: { error: unknown } | undefined;
  for (const hook of hooks) {
    try {
      hook(msg, ctx);
    } catch (error) {
      first ??= { error };
    }
  }
  if (first !== undefined) throw first.error;
};

export const composeMailBoot = (
  deps: ComposeMailStackBootDeps,
): MailStack | undefined => {
  const {
    db,
    cacheBlobs,
    warehouseBus,
    auditLog,
    contactStore,
    mailFactWriter,
    gateRegistry,
    accountStore,
    resolveOAuthConfig,
    fileReadDeps,
    inboundAttachmentDeps,
    isVaultUnlocked,
    getCollectionRegistry,
  } = deps;

  if (!db || !cacheBlobs) return undefined;

  // D-315 — every upsert is read for facts through the composition's writer.
  const factIngest = mailFactWriter
    ? createMailFactIngest({
        writer: mailFactWriter,
        now: () => Date.now(),
        ...(contactStore
          ? { relationshipsOf: (address: string) => contactStore.get(address)?.network_domain ?? [] }
          : {}),
      })
    : undefined;

  // Contacts first: a new sender's contact row exists before its mail is read.
  const upsertHooks: UpsertHook[] = [];
  if (contactStore) {
    upsertHooks.push((msg) => {
      // D-121 Phase 1 — derive contacts from From/To/CC.
      // Errors swallowed inside the collection's try/catch so
      // a bad row never rolls back ingest.
      const obs = deriveContactsFromMail(msg);
      if (obs.length > 0) contactStore.observeBatch(obs);
    });
  }
  if (factIngest) {
    upsertHooks.push((msg, ctx) => {
      factIngest.onMessageUpserted(msg, ctx);
    });
  }

  return composeMailStack(
    db,
    {
      blobs: cacheBlobs,
      bus: warehouseBus,
      ...(auditLog ? { auditLog } : {}),
      ...(fileReadDeps ? { fileReadDeps } : {}),
      ...(inboundAttachmentDeps ? { inboundAttachmentDeps } : {}),
      ...(upsertHooks.length > 0 ? { onMessageUpserted: runEachUpsertHook(upsertHooks) } : {}),
      ...(factIngest
        ? {
            onMessageStored: (msg, ctx) => factIngest.onMessageStored(msg, ctx),
            onRecordsRemoved: (slug: string, recordIds: readonly string[]) =>
              factIngest.onRecordsRemoved(slug, recordIds),
            onRecordRekeyed: (slug: string, from: string, to: string) =>
              factIngest.onRecordRekeyed(slug, from, to),
          }
        : {}),
      getGate: (slug: string) => {
        const name = `collection:mail:${slug}`;
        if (gateRegistry) {
          const existing = gateRegistry.get(name);
          if (existing) return existing;
          return gateRegistry.register(name, {
            quota: 512 * 1024 * 1024,
            reservePct: 10,
            initialUsage: 0,
          });
        }
        // Practically unreachable: bin.ts only constructs the stack
        // when `db` is present, and gateRegistry tracks `db`. Defensive
        // throw matches the original.
        throw new Error('mailStack: gateRegistry not available');
      },
    },
    {
      // ⛔ Belongs on the BUNDLE (3rd arg) — `runStartLive` reads
      // `bundle.getCollectionRegistry`. It sat in the storage arg (2nd) until
      // 2026-08-12, where the conditional spread hid it from the excess-property
      // check, so post-boot enrolls never joined the shared registry and every
      // send answered MAIL_INSTANCE_NOT_FOUND until a restart.
      ...(getCollectionRegistry ? { getCollectionRegistry } : {}),
      ...(accountStore
        ? {
            accountStore: {
              get: (k) => accountStore.get(k),
              set: (k, v) => accountStore.set(k, v),
              delete: (k) => accountStore.delete(k),
              getAll: () => accountStore.getAll(),
            },
          }
        : {}),
      // Per-use credential fetch for the initial code-exchange (enroll). The
      // adapter's refresh path resolves the same way via `buildProvider`.
      oauthConfig: (provider) => resolveOAuthConfig(provider),
      ...(isVaultUnlocked ? { isVaultUnlocked } : {}),
    },
    {
      log: (level, msg, data) => {
        const fn = level === 'error' ? console.error : console.log;
        fn(`[mail-stack] ${msg}`, data ?? '');
      },
    },
  );
};
