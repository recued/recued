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
import type {
  MailInboundAttachmentDeps,
  MailReceiver,
  MailStoredContext,
  MailUpsertContext,
} from '../../collections/mail/mail-collection.js';
import type { CanonicalMessage } from '../../collections/mail/provider.js';
import type { OAuthProviderConfig } from '../../collections/mail/oauth.js';
import { deriveContactsFromMail } from '../../warehouse/contact-derive.js';
import {
  composeMailStack,
  type MailStack,
  type MailStackStorageDeps,
} from '../../collections/mail/compose.js';
import type { BlobStore } from '../../storage/index.js';

export interface ComposeMailStackBootDeps {
  managedOAuth?: import('../../managed-oauth-consumers.js').ManagedOAuthConsumers;
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
  resolveOAuthConfig: (provider: 'gmail' | 'graph', appId?: string) => OAuthProviderConfig | null;
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
  /** D-318 P23 — the email-approval reply check, called on every upsert while
   *  the provider's own record of the message is in hand. The listeners bind
   *  it late (`createLateEmailAnswerHook`); absent ⇒ no mail answers an ask. */
  emailAnswerHook?: (msg: CanonicalMessage, ctx: MailUpsertContext) => void;
  /** D-318 step 1 — is this mailbox the email chat door's chat mailbox? Its
   *  mail is the conversation, not the owner's mail: it makes no contacts and
   *  no mail facts. Read per message, so naming or clearing it applies to the
   *  next one. Absent ⇒ no mailbox is the chat mailbox. */
  isChatMailbox?: (slug: string) => boolean;
  /** D-318 step 5 — is this message, in one of the owner's OTHER mailboxes,
   *  the conversation with the chat mailbox: an answer in the inbox, or the Sent
   *  copy of a request (`conversation-mail.ts`)? It makes no contacts and no mail
   *  facts either. `receiver` is the mailbox it landed in, when known. Absent ⇒
   *  none is. */
  isChatConversationMail?: (msg: CanonicalMessage, receiver?: MailReceiver) => boolean;
  /** D-318 step 2 — told of every message the moment its row first lands, in
   *  any mailbox: one in the chat mailbox is recorded to be checked against the
   *  owner's Sent record. At the landing, not the upsert hook after the
   *  attachments: a stop in between makes a replay see the row as old, and the
   *  request would be lost. Absent ⇒ no message is checked. */
  chatRequestHook?: (msg: CanonicalMessage, ctx: MailStoredContext) => void;
  /** D-318 step 4 — told of every message once its attachments are stored, in
   *  any mailbox: a request in the chat mailbox records its files (the signature's
   *  images left out), and its hand-over to chat may go on. Absent ⇒ requests
   *  are handed over without files once the wait for them has passed. */
  chatFilesHook?: (msg: CanonicalMessage, ctx: MailUpsertContext) => void;
  /** D-318 audit — a mailbox was deleted: the door forgets it. */
  onMailboxDeleted?: (slug: string) => void;
  /** D-318 audit — did Recued send mail under this reconciliation id (its send
   *  claims)? Only then is a message carrying one Recued's own, which the mail
   *  facts leave out: the header alone is anyone's to write. Absent ⇒ none is. */
  isOwnSend?: (reconciliation_id: string) => boolean;
}

type UpsertHook = NonNullable<MailStackStorageDeps['onMessageUpserted']>;
type StoredHook = NonNullable<MailStackStorageDeps['onMessageStored']>;

/** Run every hook, each on its own: a contact write that throws must not keep
 *  the message from being read for facts, nor the other way round. The first
 *  error is rethrown once all have run, so the collection still records it. */
const runEach = <C>(
  hooks: readonly ((msg: CanonicalMessage, ctx: C) => void)[],
): ((msg: CanonicalMessage, ctx: C) => void) => (msg, ctx) => {
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
  const isChatMailbox = deps.isChatMailbox ?? (() => false);
  const isChatConversationMail = deps.isChatConversationMail ?? (() => false);
  /** The chat mailbox's mail, or the conversation's mail in another mailbox:
   *  the one the hook's context names, read as the collection read it when it
   *  marked the row. */
  const isConversation = (msg: CanonicalMessage, ctx: MailUpsertContext | MailStoredContext): boolean =>
    isChatMailbox(ctx.slug) || isChatConversationMail(msg, ctx.provider_kind !== undefined
      ? { provider_kind: ctx.provider_kind, account_email: ctx.account_email ?? '' }
      : undefined);

  // D-315 — every upsert is read for facts through the composition's writer.
  const factIngest = mailFactWriter
    ? createMailFactIngest({
        writer: mailFactWriter,
        now: () => Date.now(),
        ...(deps.isOwnSend ? { isOwnSend: deps.isOwnSend } : {}),
        ...(contactStore
          ? { relationshipsOf: (address: string) => contactStore.get(address)?.network_domain ?? [] }
          : {}),
      })
    : undefined;

  // Contacts first: a new sender's contact row exists before its mail is read.
  const upsertHooks: UpsertHook[] = [];
  if (contactStore) {
    upsertHooks.push((msg, ctx) => {
      // D-318 — the chat mailbox's mail is the conversation with Recued, and so
      // are its answers and requests in the owner's other mailboxes.
      if (isConversation(msg, ctx)) return;
      // D-121 Phase 1 — derive contacts from From/To/CC.
      // Errors swallowed inside the collection's try/catch so
      // a bad row never rolls back ingest.
      const obs = deriveContactsFromMail(msg);
      if (obs.length > 0) contactStore.observeBatch(obs);
    });
  }
  if (factIngest) {
    upsertHooks.push((msg, ctx) => {
      if (isConversation(msg, ctx)) return;
      factIngest.onMessageUpserted(msg, ctx);
    });
  }
  const { emailAnswerHook, chatRequestHook, chatFilesHook } = deps;
  if (emailAnswerHook) upsertHooks.push(emailAnswerHook);
  if (chatFilesHook) upsertHooks.push(chatFilesHook);

  // A row's first landing: news for the facts, a request for the chat door.
  // Each runs on its own, as the upsert hooks do.
  const storedHooks: StoredHook[] = [];
  if (factIngest) {
    storedHooks.push((msg, ctx) => {
      if (!isConversation(msg, ctx)) factIngest.onMessageStored(msg, ctx);
    });
  }
  if (chatRequestHook) storedHooks.push(chatRequestHook);

  return composeMailStack(
    db,
    {
      blobs: cacheBlobs,
      bus: warehouseBus,
      ...(auditLog ? { auditLog } : {}),
      ...(fileReadDeps ? { fileReadDeps } : {}),
      ...(inboundAttachmentDeps ? { inboundAttachmentDeps } : {}),
      ...(upsertHooks.length > 0 ? { onMessageUpserted: runEach(upsertHooks) } : {}),
      ...(storedHooks.length > 0 ? { onMessageStored: runEach(storedHooks) } : {}),
      ...(deps.onMailboxDeleted ? { onMailboxDeleted: deps.onMailboxDeleted } : {}),
      // The conversation's mail in the owner's mailboxes is marked as it is
      // stored, so every reader of their stored mail can leave it out.
      ...(deps.isChatConversationMail ? { isChatConversation: deps.isChatConversationMail } : {}),
      ...(factIngest
        ? {
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
      ...(deps.managedOAuth ? { managedOAuth: deps.managedOAuth } : {}),
      ...(accountStore
        ? {
            accountStore: {
              ...(accountStore.transactionalWrite ? { transactionalWrite: accountStore.transactionalWrite } : {}),
              get: (k) => accountStore.get(k),
              set: (k, v) => accountStore.set(k, v),
              delete: (k) => accountStore.delete(k),
              getAll: () => accountStore.getAll(),
            },
          }
        : {}),
      // Per-use credential fetch for the initial code-exchange (enroll). The
      // adapter's refresh path resolves the same way via `buildProvider`.
      oauthConfig: (provider, appId) => resolveOAuthConfig(provider, appId),
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
