/** D-127 wire-up — mail-collection composition helper.
 *
 *  Parallel to `composeCalendarStack` / `composeFileStack`: assembles
 *  the instance store, live-collection map, and enrollment hooks for
 *  the mail substrate. bin.ts calls this once, wires `mailEnroll`
 *  onto `collectionDeps`, and registers each `MailCollection` with
 *  the shared collection registry for heartbeat + retention plumbing.
 *
 *  Owns live-collection lifecycle:
 *    - `startAll()` reads every `platform='mail'` row from the
 *      instance store and spins up a `MailCollection` per row
 *      (provider construction + retention + emitter + sync). Per-row
 *      failures log + skip so one broken IMAP host can't prevent the
 *      server from booting.
 *    - `enrollDeps.onEnrolled` / `onDeleted` flow enroll-rpc and
 *      delete-rpc through the same helpers so the live map stays
 *      consistent with the instance store.
 *    - `disposeAll()` closes every live collection during the
 *      lifecycle drain.
 *
 *  Provider construction:
 *    - imap → `createImapProvider` with config hydrated from the
 *      instance row + passwords pulled from the account store.
 *    - gmail → `createGmailProvider` with `granted_scopes` resolved
 *      lazily via `getGrantedScopes(accountStore, 'gmail', slug)` on
 *      every config() call so a refresh-time scope downgrade flips
 *      `sendCapable` without restarting the server.
 *    - graph → mirror of gmail with `Mail.Send` as the send scope.
 */

import type Database from 'better-sqlite3';
import type { CollectionInstanceRow } from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { BlobStore } from '../../storage/blob-store.js';
import {
  createInstanceStore,
  type CollectionInstanceRecord,
  type CollectionInstanceStore,
} from '../instance-store.js';
import type { CollectionRegistry } from '../registry.js';
import {
  pauseCollectionSync,
  resumeCollectionSync,
  syncDeferredWhileLocked,
} from '../vault-gated-sync.js';
import type { FileReadDeps } from '../file/file-read-handler.js';

import {
  createMailCollection,
  type CreateMailCollectionOptions,
  type MailCollection,
  type MailCollectionConfig,
  type MailInboundAttachmentDeps,
} from './mail-collection.js';
import type { MailProvider } from './provider.js';
import type { MailEnrollDeps } from './enroll.js';
import { readImapPassword, readImapSmtpPassword } from './enroll.js';
import {
  createImapProvider,
  type ImapProviderConfig,
  type ImapSmtpConfig,
  type SmtpTransportFactory,
} from './imap-provider.js';
import {
  createGmailProvider,
  GMAIL_SEND_SCOPE,
  type GmailProviderConfig,
} from './gmail-provider.js';
import {
  createGraphProvider,
  GRAPH_SEND_SCOPE,
  type GraphProviderConfig,
} from './graph-provider.js';
import {
  getGrantedScopes,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProvider,
  type OAuthProviderConfig,
} from './oauth.js';

export type MailStackLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: unknown,
) => void;

/** Default mail config knobs. Match the per-platform spec defaults
 *  (mail: 30 d backfill / 365 d retention / 512 MB quota). Per-row
 *  config values override these. */
const DEFAULT_MAIL_BACKFILL_DAYS = 30;
const DEFAULT_MAIL_RETENTION_DAYS = 365;
const DEFAULT_MAIL_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_GMAIL_POLL_SECONDS = 30;
const DEFAULT_GRAPH_POLL_SECONDS = 30;

export interface MailStackStorageDeps {
  blobs: BlobStore;
  /** Per-collection storage gate factory. Returns the gate for
   *  `(platform='mail', slug)`. Mirrors the calendar/file pattern. */
  getGate: (slug: string) => StorageGate;
  /** Warehouse event bus shared with calendar + file. */
  bus: WarehouseEventBus;
  auditLog?: AuditLogStore;
  /** D-121 Phase 1 — derivation hook fired after a successful upsert.
   *  Threaded through to `createMailCollection.onMessageUpserted` so
   *  contact rows materialise from From/To/CC headers as mail lands. */
  onMessageUpserted?: CreateMailCollectionOptions['onMessageUpserted'];
  /** D-172 P2 — lazy provider of the `file.read` deps for resolving
   *  outbound `attachments` refs. Forwarded verbatim to
   *  `createMailCollection.fileReadDeps`. Lazy because the collection
   *  registry is created after the mail stack in the boot composer.
   *  Absent on dbless / no-CAS harnesses — attachment sends then throw
   *  `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` rather than silently dropping. */
  fileReadDeps?: () => FileReadDeps | undefined;
  /** D-172 A.7 — lazy inbound file/link deps for received mail
   *  attachments. Forwarded to `createMailCollection` so provider
   *  attachment parts materialize into `data.file.received` and
   *  `role:"attachment"` links after each successful mail upsert. */
  inboundAttachmentDeps?: () => MailInboundAttachmentDeps | undefined;
}

export interface ComposeMailStackOptions {
  log?: MailStackLogger;
  /** When true, auto-start live collections immediately after
   *  construction. Defaults to false — bin.ts calls `startAll()`
   *  explicitly after the lifecycle manager is ready. */
  autoStart?: boolean;
}

export interface MailAdapterBundle {
  /** LAZY accessor for the shared `CollectionRegistry`.
   *
   *  ⚠ Lazy because the registry is constructed AFTER the mail stack in the boot
   *  composer (`compose-collection-context.ts`) — a direct reference would be
   *  undefined at construction. By the time a collection goes live it exists.
   *
   *  Without this, a mail account enrolled AFTER boot went live in this stack's
   *  own map but was never added to the SHARED registry (which happened once, in
   *  `startCollectionAdapters`), so every `collection.*` read answered
   *  `COLLECTION_NOT_FOUND: no collection registered for mail:<slug>` until the
   *  server restarted. */
  getCollectionRegistry?: () => CollectionRegistry | undefined;
  /** Account store shared with calendar's OAuth path. When absent
   *  every enroll surfaces `not_configured` and live providers can't
   *  refresh their tokens — bin.ts always wires this in production. */
  accountStore?: OAuthAccountStore;
  /** OAuth client config resolver. Returning `null` for a provider
   *  surfaces `not_configured` on `enrollOAuth`. Production ALWAYS supplies
   *  this (bin.ts → wire-mail-stack → the store-backed per-use resolver);
   *  absent (harness / db-less) there is nothing behind it, so every provider
   *  reads `not_configured`. It used to fall back to the process-env-driven
   *  `GMAIL_OAUTH_CONFIG` / `GRAPH_OAUTH_CONFIG` — deleted 2026-07-28. */
  oauthConfig?: (provider: 'gmail' | 'graph') => OAuthProviderConfig | null;
  /** Test-friendly HTTP fetcher hook. */
  fetcher?: HttpFetcher;
  /** SMTP transport factory for imap-adapter sends. Absent ⇒
   *  `defaultSmtpTransportFactory` (nodemailer, the production path).
   *
   *  THE seam for running a real server without real network sends. It exists
   *  because the alternative was worse: `defaultSmtpTransportFactory` used to
   *  read `RECUED_BENCH_SMTP_OUTBOX` itself, which put a silent mail-diversion
   *  switch into every release artifact (see the note there). Injection keeps
   *  that decision at the composition root, where the caller can see it.
   *
   *  The substrate-bench sets this from its own patch over
   *  `wire-mail-stack.ts`, so the bench transport is bundled ONLY into the
   *  bench's `dist-bench/bin.js`. Nothing in production supplies it. */
  smtpFactory?: SmtpTransportFactory;
  now?: () => number;
  /** Vault-lock predicate. When it returns false (the server vault is LOCKED —
   *  enrolled but the Master DEK is not in memory), a live collection's poll
   *  loop is NOT started (`sync.start()` is deferred): polling while sealed
   *  would fetch new mail whose CAS-backed parts (attachments / >64 KB bodies)
   *  fail-close on the locked blob store WHILE the sync cursor advances past
   *  them → silent, permanent loss (the D-117 locked-window gap). `resumeSync()`
   *  starts the deferred loops on the vault→unlocked edge. Absent (dbless /
   *  harness — no vault) ⇒ sync always starts (prior behaviour). */
  isVaultUnlocked?: () => boolean;
}

export interface MailStack {
  instances: CollectionInstanceStore;
  /** Read-only snapshot of every live mail collection — used for
   *  heartbeat + the `data.mail.send_capable_instances` resolver. */
  listLive(): MailCollection[];
  /** Feed to `collectionDeps.mailEnroll`. Carries `onEnrolled`/
   *  `onDeleted` hooks that maintain the live-collection map. */
  enrollDeps: MailEnrollDeps;
  /** Rehydrate every live `MailCollection` from the instance store.
   *  Call once at boot before `startServer`. */
  startAll(): Promise<void>;
  /** Stop every live collection. Called from the lifecycle drain's
   *  `pause_collections` step. Idempotent. */
  disposeAll(): Promise<void>;
  /** Start the poll loop for every live collection whose sync is deferred /
   *  stopped — the vault→unlocked edge. Idempotent (`sync.start()` no-ops an
   *  already-running loop). Collections stay registered/readable throughout. */
  resumeSync(): Promise<void>;
  /** Stop the poll loop for every live collection WITHOUT closing it (reads
   *  stay) — the vault→locked edge, so an auto-lock mid-life halts polling
   *  before the next tick can drop a CAS item. Idempotent. */
  pauseSync(): Promise<void>;
}

const buildImapConfig = (
  cfg: Record<string, unknown>,
  password: string,
  smtpPassword: string | null,
): ImapProviderConfig => {
  const smtpRaw = cfg.smtp as Record<string, unknown> | undefined;
  let smtp: ImapSmtpConfig | undefined;
  if (smtpRaw && typeof smtpRaw === 'object') {
    smtp = { host: String(smtpRaw.host ?? '') };
    if (typeof smtpRaw.port === 'number') smtp.port = smtpRaw.port;
    if (typeof smtpRaw.secure === 'boolean') smtp.secure = smtpRaw.secure;
    if (typeof smtpRaw.username === 'string') smtp.username = smtpRaw.username;
    if (typeof smtpRaw.from === 'string') smtp.from = smtpRaw.from;
    if (smtpPassword !== null) smtp.password = smtpPassword;
  }
  return {
    host: String(cfg.host ?? ''),
    port: typeof cfg.port === 'number' ? cfg.port : 993,
    secure: typeof cfg.secure === 'boolean' ? cfg.secure : true,
    username: String(cfg.username ?? ''),
    password,
    folders: Array.isArray(cfg.folders) ? (cfg.folders as string[]) : ['INBOX'],
    ...(smtp ? { smtp } : {}),
  };
};

const buildMailCollectionConfig = (
  row: CollectionInstanceRecord,
): MailCollectionConfig => {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  return {
    backfill_days: typeof cfg.backfill_days === 'number'
      ? cfg.backfill_days
      : DEFAULT_MAIL_BACKFILL_DAYS,
    retention_days: typeof cfg.retention_days === 'number'
      ? cfg.retention_days
      : DEFAULT_MAIL_RETENTION_DAYS,
    quota_bytes: typeof cfg.quota_bytes === 'number'
      ? cfg.quota_bytes
      : DEFAULT_MAIL_QUOTA_BYTES,
  };
};

export const composeMailStack = (
  db: Database.Database,
  storage: MailStackStorageDeps,
  bundle: MailAdapterBundle,
  options: ComposeMailStackOptions = {},
): MailStack => {
  const log: MailStackLogger = options.log ?? (() => {});
  const instances = createInstanceStore({ db });
  const live = new Map<string, MailCollection>();

  const oauthConfigFor = (
    provider: 'gmail' | 'graph',
  ): OAuthProviderConfig | null =>
    bundle.oauthConfig ? bundle.oauthConfig(provider) : null;

  const buildProvider = async (
    row: CollectionInstanceRecord,
  ): Promise<MailProvider | null> => {
    const slug = row.slug;
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    if (row.adapter_type === 'imap') {
      if (!bundle.accountStore) {
        log('warn', `mail-stack: no accountStore configured — cannot hydrate imap creds for '${slug}'`);
        return null;
      }
      const password = await readImapPassword(bundle.accountStore, slug);
      if (!password) {
        log('warn', `mail-stack: imap password missing for '${slug}' — was the row enrolled before P4.1?`);
        return null;
      }
      const smtpPassword = cfg.smtp
        ? await readImapSmtpPassword(bundle.accountStore, slug)
        : null;
      const captured = buildImapConfig(cfg, password, smtpPassword);
      return createImapProvider({
        slug,
        config: () => captured,
        ...(bundle.now ? { now: bundle.now } : {}),
        // Absent in production ⇒ createImapProvider falls back to
        // `defaultSmtpTransportFactory` (nodemailer).
        ...(bundle.smtpFactory ? { smtpFactory: bundle.smtpFactory } : {}),
        log: (level, msg, data) => log(level, msg, data),
      });
    }
    if (row.adapter_type === 'gmail' || row.adapter_type === 'graph') {
      const provider = row.adapter_type;
      const providerConfig = oauthConfigFor(provider);
      if (!providerConfig || !bundle.accountStore) {
        log(
          'warn',
          `mail-stack: ${provider} OAuth config or accountStore missing — skipping live mirror for '${slug}'`,
        );
        return null;
      }
      const accountStore = bundle.accountStore;
      const accountSlug = typeof cfg.account_slug === 'string'
        ? cfg.account_slug
        : slug;
      const accountEmail = typeof cfg.account_email === 'string'
        ? cfg.account_email
        : '';
      // Build the per-call config closure. Lazy `granted_scopes` read
      // means a refresh-time scope change flips `sendCapable` next
      // time the provider rebuilds — but providers cache the value at
      // construction (per gmail-provider.ts comment), so a re-enroll
      // is the canonical way to flip. Keeping it lazy regardless so a
      // future provider that re-reads picks up the change.
      let cachedScopes: string[] | undefined;
      const ensureScopes = async (): Promise<string[]> => {
        if (cachedScopes !== undefined) return cachedScopes;
        cachedScopes = await getGrantedScopes(
          accountStore,
          provider as OAuthProvider,
          accountSlug,
        );
        return cachedScopes;
      };
      // Pre-warm the cache so the provider's `config()` calls are
      // synchronous from construction onward.
      await ensureScopes();
      if (provider === 'gmail') {
        const gmailConfig: () => GmailProviderConfig = () => ({
          account_slug: accountSlug,
          account_email: accountEmail,
          backfill_days: typeof cfg.backfill_days === 'number'
            ? cfg.backfill_days
            : DEFAULT_MAIL_BACKFILL_DAYS,
          poll_seconds: typeof cfg.poll_seconds === 'number'
            ? cfg.poll_seconds
            : DEFAULT_GMAIL_POLL_SECONDS,
          ...(Array.isArray(cfg.label_filter)
            ? { label_filter: cfg.label_filter as string[] }
            : {}),
          granted_scopes: cachedScopes ?? [],
        });
        return createGmailProvider({
          slug,
          config: gmailConfig,
          accountStore,
          // Per-use resolver — token refresh re-fetches the (store-then-env)
          // credential so a UI-updated secret applies without a restart.
          providerConfig: () => oauthConfigFor(provider),
          ...(bundle.fetcher ? { fetcher: bundle.fetcher } : {}),
          ...(bundle.now ? { now: bundle.now } : {}),
          log: (level, msg, data) => log(level, msg, data),
        });
      }
      const graphConfig: () => GraphProviderConfig = () => ({
        account_slug: accountSlug,
        account_email: accountEmail,
        backfill_days: typeof cfg.backfill_days === 'number'
          ? cfg.backfill_days
          : DEFAULT_MAIL_BACKFILL_DAYS,
        poll_seconds: typeof cfg.poll_seconds === 'number'
          ? cfg.poll_seconds
          : DEFAULT_GRAPH_POLL_SECONDS,
        ...(Array.isArray(cfg.folder_filter)
          ? { folder_filter: cfg.folder_filter as string[] }
          : {}),
        granted_scopes: cachedScopes ?? [],
      });
      return createGraphProvider({
        slug,
        config: graphConfig,
        accountStore,
        providerConfig: () => oauthConfigFor(provider),
        ...(bundle.fetcher ? { fetcher: bundle.fetcher } : {}),
        ...(bundle.now ? { now: bundle.now } : {}),
        log: (level, msg, data) => log(level, msg, data),
      });
    }
    log('warn', `mail-stack: unknown adapter_type '${row.adapter_type}' for '${slug}'`);
    return null;
  };

  const startLive = async (row: CollectionInstanceRecord): Promise<void> => {
    if (live.has(row.slug)) return;
    let provider: MailProvider | null;
    try {
      provider = await buildProvider(row);
    } catch (err) {
      log('error', `mail-stack: provider construction failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!provider) return;

    let collection: MailCollection;
    try {
      collection = createMailCollection({
        db,
        blobs: storage.blobs,
        gate: storage.getGate(row.slug),
        bus: storage.bus,
        slug: row.slug,
        provider,
        config: () => buildMailCollectionConfig(row),
        ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
        ...(bundle.now ? { now: bundle.now } : {}),
        ...(storage.onMessageUpserted
          ? { onMessageUpserted: storage.onMessageUpserted }
          : {}),
        ...(storage.fileReadDeps
          ? { fileReadDeps: storage.fileReadDeps }
          : {}),
        ...(storage.inboundAttachmentDeps
          ? { inboundAttachmentDeps: storage.inboundAttachmentDeps }
          : {}),
        instances,
        log: (level, msg, data) => log(level, msg, data),
      });
    } catch (err) {
      log('error', `mail-stack: createMailCollection failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      try { await provider.close(); } catch { /* ignore */ }
      return;
    }

    live.set(row.slug, collection);
    // Register with the SHARED registry the moment the collection goes live, so
    // an enroll is readable immediately instead of only after a restart. Guarded
    // because `register` throws on a duplicate and both `startAll` and the boot
    // `registerMailCollections` sweep can reach the same slug.
    try {
      const shared = bundle.getCollectionRegistry?.();
      if (shared && !shared.get('mail', row.slug)) shared.register(collection);
    } catch (err) {
      log('warn', `mail-stack: registry register failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (syncDeferredWhileLocked(bundle.isVaultUnlocked)) {
      // Vault LOCKED → defer the poll loop. The collection stays live (its
      // warehouse rows read from plaintext SQLite; its `send` rpc still works),
      // but we do NOT start the provider fetch loop while sealed — see the
      // `isVaultUnlocked` doc. `resumeSync()` starts it on the unlock edge.
      log('info', `mail-stack: sync deferred for '${row.slug}' — vault locked`);
      return;
    }

    try {
      await collection.sync.start();
    } catch (err) {
      log('warn', `mail-stack: sync.start failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      // Collection still lives — its `send` rpc still works against the
      // provider, and a future resync can restart the inbound loop.
    }
  };

  const stopLive = async (slug: string): Promise<void> => {
    const collection = live.get(slug);
    if (!collection) return;
    live.delete(slug);
    // Drop it from the shared registry too. `register` throws on a duplicate and
    // there is no other way out, so a stale entry means a delete → re-enroll of
    // the same slug keeps serving the CLOSED collection from the first enroll.
    try { bundle.getCollectionRegistry?.()?.unregister('mail', slug); }
    catch { /* registry teardown races drain; never block a stop */ }
    try {
      await collection.close();
    } catch (err) {
      log('warn', `mail-stack: close failed for '${slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const enrollDeps: MailEnrollDeps = {
    instances,
    accountStore: bundle.accountStore ?? {
      // Safe null-route for test harnesses that skip the account
      // store — every enroll that needs credentials throws
      // `not_configured` before reaching this stub.
      async get() { return null; },
      async set() { /* ignored */ },
      async delete() { /* ignored */ },
    },
    ...(bundle.oauthConfig
      ? { oauthConfig: bundle.oauthConfig }
      : { oauthConfig: oauthConfigFor }),
    ...(bundle.fetcher ? { fetcher: bundle.fetcher } : {}),
    ...(bundle.now ? { now: bundle.now } : {}),
    onEnrolled: async (row: CollectionInstanceRow) => {
      const full = instances.get('mail', row.slug);
      if (full) await startLive(full);
    },
    onDeleted: (slug) => stopLive(slug),
  };

  const startAll = async (): Promise<void> => {
    const rows = instances.list('mail');
    for (const row of rows) {
      try { await startLive(row); }
      catch {
        // startLive logs inline — keep booting.
      }
    }
  };

  const disposeAll = async (): Promise<void> => {
    const slugs = [...live.keys()];
    for (const slug of slugs) {
      await stopLive(slug);
    }
  };

  // R21.1 parity — the vault-gated pause/resume of the live poll loops, driven
  // by the vault-state edges (compose-collection-context). Shared with the
  // calendar stack via `vault-gated-sync`.
  const onSyncEdgeError = (message: string, err: unknown): void =>
    log('warn', `mail-stack: ${message}`, {
      err: err instanceof Error ? err.message : String(err),
    });
  const resumeSync = (): Promise<void> =>
    resumeCollectionSync(live.values(), onSyncEdgeError);
  const pauseSync = (): Promise<void> =>
    pauseCollectionSync(live.values(), onSyncEdgeError);

  if (options.autoStart) {
    void startAll();
  }

  return {
    instances,
    listLive: () => [...live.values()],
    enrollDeps,
    startAll,
    disposeAll,
    resumeSync,
    pauseSync,
  };
};

/** Register every live `MailCollection` with the shared collection
 *  registry so heartbeat enrichment + retention sweeps + generic
 *  `collection.list / search / get` rpcs find them via
 *  `registry.list()` the same way they do calendar collections.
 *  Safe to call after every enroll — dedupes on the `(platform, slug)`
 *  key. */
export const registerMailCollections = (
  stack: MailStack,
  registry: CollectionRegistry,
): void => {
  for (const collection of stack.listLive()) {
    if (!registry.get('mail', collection.slug)) {
      registry.register(collection);
    }
  }
};

// Re-exports so bin.ts consumers can ergonomically reference them
// without reaching into the per-provider modules.
export { GMAIL_SEND_SCOPE, GRAPH_SEND_SCOPE };
