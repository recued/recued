/** D-127 / D-121 — mail stack boot composer.
 *
 *  Wraps `composeMailStack` from the mail package with the bin.ts-level
 *  dep wiring: per-collection storage gate factory, optional contact-
 *  derivation observer (D-121 Phase 1), shared OAuth account store for
 *  gmail + graph token persistence, and a per-stack logger.
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
import type { FileReadDeps } from '../../collections/file/file-read-handler.js';
import type { MailInboundAttachmentDeps } from '../../collections/mail/mail-collection.js';
import type { OAuthProviderConfig } from '../../collections/mail/oauth.js';
import { deriveContactsFromMail } from '../../warehouse/contact-derive.js';
import {
  composeMailStack,
  type MailStack,
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

export const composeMailBoot = (
  deps: ComposeMailStackBootDeps,
): MailStack | undefined => {
  const {
    db,
    cacheBlobs,
    warehouseBus,
    auditLog,
    contactStore,
    gateRegistry,
    accountStore,
    resolveOAuthConfig,
    fileReadDeps,
    inboundAttachmentDeps,
    isVaultUnlocked,
    getCollectionRegistry,
  } = deps;

  if (!db || !cacheBlobs) return undefined;

  return composeMailStack(
    db,
    {
      blobs: cacheBlobs,
      bus: warehouseBus,
      ...(auditLog ? { auditLog } : {}),
      ...(getCollectionRegistry ? { getCollectionRegistry } : {}),
      ...(fileReadDeps ? { fileReadDeps } : {}),
      ...(inboundAttachmentDeps ? { inboundAttachmentDeps } : {}),
      ...(contactStore
        ? {
            onMessageUpserted: (msg) => {
              // D-121 Phase 1 — derive contacts from From/To/CC.
              // Errors swallowed inside the collection's try/catch so
              // a bad row never rolls back ingest.
              const obs = deriveContactsFromMail(msg);
              if (obs.length > 0) contactStore.observeBatch(obs);
            },
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
      ...(accountStore
        ? {
            accountStore: {
              get: (k) => accountStore.get(k),
              set: (k, v) => accountStore.set(k, v),
              delete: (k) => accountStore.delete(k),
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
