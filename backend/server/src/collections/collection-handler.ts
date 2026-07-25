/** Phase D (D-106) — `collection.*` rpc handlers.
 *
 *  Five methods — list / search / get / runRetention / listEndpoints —
 *  all delegating to the `CollectionRegistry`. The handler owns the
 *  input-validation + error mapping; the registry and Collection
 *  instances own the actual storage work.
 *
 *  `collection_not_found` surfaces as the Phase D contract error
 *  `COLLECTION_NOT_FOUND` on the caller side; unknown-method is the
 *  dispatcher's job (the composed `SERVER_RPC_METHOD_SET` already
 *  lists these).
 */

import { isMailReconciliationId, isMirrorSearchKind, RpcError } from '@recued/contracts';
import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  HandlerSlice,
  MirrorSearchResult,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import type { CollectionRegistry } from './registry.js';
import type { Collection } from './types.js';
import type { CalendarCollection } from './calendar/calendar-collection.js';
import type { FileMetaStore } from '../storage/file-meta-store.js';
import type { FileSourceSyncStateStore } from '../storage/file-source-sync-state.js';
import { createFileViewResolverFromRegistry } from '../file-view-resolver.js';
import {
  exchangeCodeForTokens,
  keyPrefix,
  OAuthError,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProvider,
  type OAuthProviderConfig,
} from './mail/oauth.js';
import {
  handleFileDelete,
  handleFileEnroll,
  handleFileReauth,
  handleFileResync,
  handleFileUpdate,
  handleListInstances,
  type EnrollDeps as FileEnrollDeps,
} from './file/enroll.js';
import {
  handleCalendarEnrollOAuth,
  handleCalendarEnrollBasic,
  handleCalendarList as handleCalendarEnrollList,
  handleCalendarUpdate as handleCalendarEnrollUpdate,
  handleCalendarDelete as handleCalendarEnrollDelete,
  handleCalendarResync as handleCalendarEnrollResync,
  handleCalendarReauth,
  type CalendarEnrollDeps,
} from './calendar/enroll.js';
import {
  handleMailEnrollImap,
  handleMailList,
  handleMailDelete,
  type MailEnrollDeps,
} from './mail/enroll.js';
import {
  handleServiceClearCrash,
  handleServiceDelete,
  handleServiceEnroll,
  handleServiceInstall,
  handleServiceList,
  handleServiceListTemplates,
  handleServiceRestart,
  handleServiceStart,
  handleServiceStop,
  handleServiceUninstall,
  handleServiceUpdate,
  handleServiceUpgrade,
  type ServiceEnrollDeps,
} from './service/enroll.js';

export interface CollectionHandlerDeps {
  registry: CollectionRegistry;
  /** D-192 Fork B — the remote-file meta-store, so `data.mirror.search`'s
   *  `files` branch surfaces vendor-mirrored files (`storage_ref:remote`)
   *  alongside the CAS `data.file.received` collection. Optional: absent →
   *  the picker shows CAS files only (unchanged behavior for a boot with no
   *  meta-store wired). */
  fileMetaStore?: FileMetaStore;
  /** D-192 Fork B hardening — the per-Source file sync-state store; when wired,
   *  a remote file view carries a `freshness` verdict. Optional (absent → no
   *  freshness on remote views). */
  fileSourceSyncState?: FileSourceSyncStateStore;
  /** Enrollment dependencies — optional so test harnesses without a
   *  configured OAuth path keep working; `collection.mail.enrollOAuth`
   *  returns `not_configured` when absent. */
  enrollOAuth?: EnrollOAuthDeps;
  /** Phase 7 (D-110) — file-adapter enroll family. Optional so
   *  tests that only exercise the read path don't need the instance
   *  store + adapter registry wired. */
  fileEnroll?: FileEnrollDeps;
  /** D-117 Phase 7 — calendar-adapter enroll family. Optional so
   *  test harnesses without the calendar registry / account store
   *  wiring keep working; `collection.calendar.*` returns
   *  `not_configured` when absent. */
  calendarEnroll?: CalendarEnrollDeps;
  /** D-118 Phase 7 — service-adapter enroll family. Optional so
   *  test harnesses without the supervisor / template registry
   *  wiring keep working; `collection.service.*` returns
   *  `not_configured` when absent. */
  serviceEnroll?: ServiceEnrollDeps;
  /** D-127 wire-up — mail-adapter enroll family. Optional so
   *  test harnesses without the mail composition root keep working;
   *  `collection.mail.enrollImap` / `collection.mail.list` /
   *  `collection.mail.delete` return `not_configured` when absent. */
  mailEnroll?: MailEnrollDeps;
  /** D-119 Phase 13 — cascade-on-parent-delete hook. When wired,
   *  `collection.deleteRecord` removes every annotation pointing at
   *  the deleted record AND every link with the record as either
   *  endpoint, immediately after the row drops from the collection.
   *  Best-effort — a cascade failure logs but doesn't roll back the
   *  record delete (the collection's own delete is the canonical
   *  state). Absent → no cascade (legacy behavior). */
  annotationCascade?: (
    collection: string,
    id: string,
  ) => { annotations_deleted: number; links_deleted: number };
  /** D-122 Phase 4.5 — cascade-on-parent-delete hook for
   *  `data.enrichment.*`. Wired alongside annotationCascade; same
   *  best-effort discipline. The handler maps platform onto the
   *  enrichment-store scope (`mail` / `calendar` / `file`; `contact`
   *  cascades through the contact-store path, not collection-handler). */
  enrichmentCascadeOnDelete?: (
    scope: 'mail' | 'calendar' | 'file' | 'contact',
    id: string,
  ) => void;
  /** D-122 Phase 4.5 — cascade-on-parent-update hook. Mirrors the
   *  delete hook but routes through the source-update path so
   *  dependent enrichment rows mark stale. */
  enrichmentCascadeOnUpdate?: (
    scope: 'mail' | 'calendar' | 'file' | 'contact',
    id: string,
  ) => void;
}

export interface EnrollOAuthDeps {
  accountStore: OAuthAccountStore;
  /** Provider-specific OAuth config (client id / secret / token url). */
  config: (provider: OAuthProvider) => OAuthProviderConfig | null;
  /** Injected fetcher — tests provide a mock; production uses global
   *  `fetch` via the default in `oauth.ts`. */
  fetcher?: HttpFetcher;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// Input validators
// ────────────────────────────────────────────────────────────────

// D-198 Slice 5 — `calendar` reads through the generic collection rpc now that
// the calendar collection's `list`/`get` delegate to its warehouse table (was a
// stub). `service` stays out — it's a process endpoint, not a record stream.
const PLATFORMS = new Set<CollectionPlatform>(['mail', 'file', 'webhook', 'calendar']);

const requirePlatform = (value: unknown): CollectionPlatform => {
  if (typeof value !== 'string' || !PLATFORMS.has(value as CollectionPlatform)) {
    throw new RpcError(
      'bad_request',
      `platform must be one of: ${[...PLATFORMS].join(', ')}`,
      400,
    );
  }
  return value as CollectionPlatform;
};

const requireSlug = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', 'slug must be a non-empty string', 400);
  }
  return value;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${field} must be a non-empty string`, 400);
  }
  return value;
};

/** Resolve and assert a registered collection exists; throw the
 *  `COLLECTION_NOT_FOUND` equivalent otherwise. The `not_found` rpc
 *  code maps to the user-facing `COLLECTION_NOT_FOUND` from
 *  `RecipeErrorCode`. */
const requireCollection = (
  deps: CollectionHandlerDeps,
  platform: CollectionPlatform,
  slug: string,
) => {
  const collection = deps.registry.get(platform, slug);
  if (!collection) {
    throw new RpcError(
      'not_found',
      `COLLECTION_NOT_FOUND: no collection registered for ${platform}:${slug}`,
      404,
    );
  }
  return collection;
};

// ────────────────────────────────────────────────────────────────
// collection.list
// ────────────────────────────────────────────────────────────────

export const handleCollectionList = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown; filters?: unknown; since?: unknown; until?: unknown; limit?: unknown },
): Promise<{ records: CollectionRecord[] }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const collection = requireCollection(deps, platform, slug);
  const query: CollectionListQuery = { platform, slug };
  if (args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters)) {
    query.filters = args.filters as Record<string, unknown>;
  } else if (args.filters !== undefined) {
    throw new RpcError('bad_request', 'filters must be an object', 400);
  }
  if (args.since !== undefined) {
    if (typeof args.since !== 'number') {
      throw new RpcError('bad_request', 'since must be a number (unix-ms)', 400);
    }
    query.since = args.since;
  }
  if (args.until !== undefined) {
    if (typeof args.until !== 'number') {
      throw new RpcError('bad_request', 'until must be a number (unix-ms)', 400);
    }
    query.until = args.until;
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || args.limit <= 0) {
      throw new RpcError('bad_request', 'limit must be a positive number', 400);
    }
    query.limit = args.limit;
  }
  return { records: collection.list(query) };
};

// ────────────────────────────────────────────────────────────────
// collection.search
// ────────────────────────────────────────────────────────────────

export const handleCollectionSearch = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown; query?: unknown; limit?: unknown },
): Promise<{ matches: CollectionSearchMatch[] }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const query = requireString(args.query, 'query');
  const collection = requireCollection(deps, platform, slug);
  const search: CollectionSearchQuery = { platform, slug, query };
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || args.limit <= 0) {
      throw new RpcError('bad_request', 'limit must be a positive number', 400);
    }
    search.limit = args.limit;
  }
  return { matches: collection.search(search) };
};

// ────────────────────────────────────────────────────────────────
// data.mirror.search  (D-174 #22 — feeds the mirror drill-down picker)
// ────────────────────────────────────────────────────────────────

const MIRROR_SEARCH_DEFAULT_LIMIT = 20;
const MIRROR_SEARCH_MAX_LIMIT = 50;
// The file kind's per-source scan cap lives with the resolver
// (`FILE_VIEW_CAS_SCAN_CAP`) — file NAMES are NOT in the FTS index (D-172 — file
// FTS covers contents only), so the resolver scans the most-recent window +
// substring-filters in memory (a v1 bound; a deeper scan would need
// received_at paging).

/** UI mirror kind → warehouse platform. `'files'` (the tab label) is the
 *  `'file'` platform; `'crm'` has no local platform (handled before this). */
const MIRROR_KIND_PLATFORM: Readonly<
  Record<'mail' | 'calendar' | 'files', CollectionPlatform>
> = { mail: 'mail', calendar: 'calendar', files: 'file' };

/** Calendar keeps its real store on `.table` — the bare `Collection.search()`
 *  is a documented no-op (calendar-collection.ts). Local guard mirrors the
 *  chat-tool one (chat-tool-handlers.ts). */
const isCalendarCollection = (c: Collection): c is CalendarCollection =>
  'table' in c && (c as Partial<CalendarCollection>).table !== undefined;

const fileBasename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
};

const formatEventStart = (startAt: unknown): string | undefined => {
  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return undefined;
  return new Date(startAt).toISOString().slice(0, 16).replace('T', ' ');
};

export const handleMirrorSearch = async (
  deps: CollectionHandlerDeps,
  args: { kind?: unknown; query?: unknown; limit?: unknown },
): Promise<{ results: MirrorSearchResult[] }> => {
  if (!isMirrorSearchKind(args.kind)) {
    throw new RpcError('bad_request', 'kind must be one of mail | calendar | crm | files', 400);
  }
  const kind = args.kind;
  // Accept any string (incl. blank) — a blank query resolves to an empty
  // result below, not a validation error (the picker fires on keystrokes,
  // and `requireString` would reject ''). Non-strings still error.
  if (typeof args.query !== 'string') {
    throw new RpcError('bad_request', 'query must be a string', 400);
  }
  const query = args.query.trim();
  let limit = MIRROR_SEARCH_DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || args.limit <= 0) {
      throw new RpcError('bad_request', 'limit must be a positive number', 400);
    }
    // Floor + clamp to [1, MAX] so a fractional `< 1` limit can't slice to 0.
    limit = Math.max(1, Math.min(Math.floor(args.limit), MIRROR_SEARCH_MAX_LIMIT));
  }
  // crm is a D-130 read alias over remote `connection.api.*` — no local
  // searchable record store; an empty query has nothing to match either.
  if (kind === 'crm' || query === '') return { results: [] };

  const platform = MIRROR_KIND_PLATFORM[kind];
  const collections = deps.registry.list().filter((c) => c.platform === platform);
  // The remote-file posture (`file_meta_ref`) lives in its OWN store, NOT the
  // collection registry — so a `files` search with a meta-store wired must NOT
  // be gated on a CAS file collection being registered (e.g. a mirror-only
  // boot). Every other kind needs its registry collections.
  if (collections.length === 0 && !(kind === 'files' && deps.fileMetaStore)) {
    return { results: [] };
  }
  // Only mail / calendar fan the cap across collections; files uses the
  // resolver's own window, so a 0-collection files search leaves this unused.
  const perCollection =
    collections.length > 0 ? Math.max(1, Math.ceil(limit / collections.length)) : 1;

  const results: MirrorSearchResult[] = [];
  const seen = new Set<string>();
  // The entity_id's collection segment is the UI platform name; the
  // warehouse record_id already self-prefixes, so the resolvable form is
  // DOUBLED (e.g. `mail:mail:<hash>`) — exactly what the link/enrichment
  // stores key on and what `data.timeline` resolves (timeline.ts
  // loadTypedLinks queries `to_id` = the part after the FIRST colon).
  const push = (recordId: string, label: string, sublabel?: string): void => {
    const entity_id = `${platform}:${recordId}`;
    if (seen.has(entity_id)) return; // dedup cross-source record_id collisions
    seen.add(entity_id);
    results.push(
      sublabel !== undefined && sublabel !== ''
        ? { entity_id, label, sublabel }
        : { entity_id, label },
    );
  };

  if (kind === 'calendar') {
    for (const c of collections) {
      if (results.length >= limit) break;
      if (!isCalendarCollection(c)) continue;
      for (const m of c.table.search({ query, limit: perCollection })) {
        push(m.record_id, m.hot.summary || '(untitled event)', formatEventStart(m.hot.start_at) ?? c.slug);
      }
    }
  } else if (kind === 'files') {
    // D-192 Fork B — one resolver spans BOTH file postures: the CAS
    // `data.file.received` collection(s) (matched by filename — the prior
    // `path`-only match was dead for CAS rows, which carry none) AND the
    // vendor-mirror `file_meta_ref` meta-store (matched by filename OR path).
    // Each remote row is surfaced under a reversible `file:remote:*` id so the
    // drill-down (timeline) can round-trip it back to the meta-store.
    const resolver = createFileViewResolverFromRegistry(
      deps.registry,
      deps.fileMetaStore,
      deps.fileSourceSyncState,
    );
    for (const v of resolver.searchFileViews(query, limit)) {
      // label = filename (both postures carry it); sublabel = the remote path
      // (CAS rows have none → omitted).
      push(v.record_id, v.filename || fileBasename(v.path ?? '') || '(file)', v.path);
    }
  } else {
    // mail — generic FTS over from / to / cc / subject / body.
    for (const c of collections) {
      if (results.length >= limit) break;
      for (const m of c.search({ platform, slug: c.slug, query, limit: perCollection })) {
        const subject = typeof m.hot_fields.subject === 'string' ? m.hot_fields.subject : '';
        const from = typeof m.hot_fields.from === 'string' ? m.hot_fields.from : undefined;
        push(m.record_id, subject || '(no subject)', from);
      }
    }
  }
  return { results: results.slice(0, limit) };
};

// ────────────────────────────────────────────────────────────────
// collection.get
// ────────────────────────────────────────────────────────────────

export const handleCollectionGet = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown; record_id?: unknown },
): Promise<{ record: CollectionRecord | null }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const record_id = requireString(args.record_id, 'record_id');
  const collection = requireCollection(deps, platform, slug);
  return { record: collection.get(record_id) };
};

// ────────────────────────────────────────────────────────────────
// collection.runRetention
// ────────────────────────────────────────────────────────────────

export const handleCollectionRunRetention = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown },
): Promise<{ pruned: number; bytes_freed: number }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const collection = requireCollection(deps, platform, slug);
  // Narrows the richer `CollectionPruneResult` to the wire shape from
  // `rpc/server-registry.ts`. `skipped_reason` + `blob_hashes_freed`
  // + `duration_ms` stay inside the server — admin callers get the
  // pruned/bytes counters they need.
  const result = await collection.runRetention();
  return {
    pruned: result.pruned_count,
    bytes_freed: result.bytes_freed,
  };
};

// ────────────────────────────────────────────────────────────────
// collection.listEndpoints
// ────────────────────────────────────────────────────────────────

export const handleCollectionListEndpoints = async (
  deps: CollectionHandlerDeps,
): Promise<{ endpoints: CollectionHealth[] }> => {
  const endpoints: CollectionHealth[] = [];
  for (const c of deps.registry.list()) {
    try {
      endpoints.push(c.health());
    } catch {
      // A misbehaving adapter's health() must not block the rest —
      // skip it silently. The heartbeat emitter (Commit 17) follows
      // the same policy.
    }
  }
  return { endpoints };
};

// ────────────────────────────────────────────────────────────────
// collection.mail.enrollOAuth
// ────────────────────────────────────────────────────────────────

const requireOAuthProvider = (value: unknown): OAuthProvider => {
  if (value !== 'gmail' && value !== 'graph') {
    throw new RpcError('bad_request', 'provider must be "gmail" or "graph"', 400);
  }
  return value;
};

// ────────────────────────────────────────────────────────────────
// collection.mail.send (D-127 P1.6)
// ────────────────────────────────────────────────────────────────

const requireStringArray = (
  value: unknown,
  field: string,
  opts: { allowEmpty?: boolean } = {},
): string[] => {
  if (!Array.isArray(value)) {
    throw new RpcError('bad_request', `${field} must be an array of strings`, 400);
  }
  if (!opts.allowEmpty && value.length === 0) {
    throw new RpcError('bad_request', `${field} must contain at least one entry`, 400);
  }
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new RpcError('bad_request', `${field} entries must be non-empty strings`, 400);
    }
  }
  return value as string[];
};

const optionalStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  return requireStringArray(value, field, { allowEmpty: true });
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${field} must be a non-empty string when supplied`, 400);
  }
  return value;
};

/** Resolve a registered mail collection by slug + duck-type its
 *  send-capable surface. Throws `not_found` when the slug isn't
 *  registered at all (mirrors `requireCollection`); duck-type
 *  mismatch is mapped to the same error since "non-mail collection
 *  registered under platform=mail" should never happen in practice
 *  (the registry partitions by platform). */
const requireMailCollection = (
  deps: CollectionHandlerDeps,
  slug: string,
): import('./mail/mail-collection.js').MailCollection => {
  const c = requireCollection(deps, 'mail', slug);
  if (!('send' in c) || typeof (c as { send?: unknown }).send !== 'function') {
    throw new RpcError(
      'not_found',
      `COLLECTION_NOT_FOUND: ${slug} is not a send-capable mail collection`,
      404,
    );
  }
  return c as import('./mail/mail-collection.js').MailCollection;
};

export const handleCollectionMailSend = async (
  deps: CollectionHandlerDeps,
  args: {
    instance?: unknown;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subject?: unknown;
    body_text?: unknown;
    body_html?: unknown;
    in_reply_to?: unknown;
    references?: unknown;
    reply_to?: unknown;
    reconciliation_id?: unknown;
    /** D-172 P2 — `data.file` record-id refs to attach. Forwarded to
     *  `MailCollection.send`, which resolves each through the Gateway-
     *  gated `file.read` into bytes before the provider send. */
    attachments?: unknown;
    /** D-127 follow-on — engine-supplied step identity. Forwarded onto
     *  `MailCollection.send` so the rpc-layer `mail_send` audit row
     *  attributes back to the originating recipe + step. Both are
     *  optional; direct rpc callers without engine context (Settings →
     *  Connections probe, MCP agent, tests) leave them absent and the
     *  audit row omits both fields. */
    recipe_id?: unknown;
    step_id?: unknown;
  },
): Promise<{
  source_id: string;
  message_id: string;
  sent_at: number;
  thread_id?: string;
  warnings?: Array<{ code: string; message: string }>;
  _id: string | null;
  _collection: 'data.mail';
}> => {
  const instance = requireString(args.instance, 'instance');
  const to = requireStringArray(args.to, 'to');
  const subject = typeof args.subject === 'string'
    ? args.subject
    : (() => { throw new RpcError('bad_request', 'subject must be a string', 400); })();
  const body_text = typeof args.body_text === 'string'
    ? args.body_text
    : (() => { throw new RpcError('bad_request', 'body_text must be a string', 400); })();
  const collection = requireMailCollection(deps, instance);
  const reconciliation_id = args.reconciliation_id === undefined
    ? undefined
    : isMailReconciliationId(args.reconciliation_id)
      ? args.reconciliation_id
      : (() => {
          throw new RpcError(
            'bad_request',
            'reconciliation_id must be a bounded ASCII header token',
            400,
          );
        })();
  return collection.send({
    to,
    cc: optionalStringArray(args.cc, 'cc'),
    bcc: optionalStringArray(args.bcc, 'bcc'),
    subject,
    body_text,
    body_html: optionalString(args.body_html, 'body_html'),
    in_reply_to: optionalString(args.in_reply_to, 'in_reply_to'),
    references: optionalStringArray(args.references, 'references'),
    reply_to: optionalString(args.reply_to, 'reply_to'),
    reconciliation_id,
    attachments: optionalStringArray(args.attachments, 'attachments'),
    recipe_id: optionalString(args.recipe_id, 'recipe_id'),
    step_id: optionalString(args.step_id, 'step_id'),
  });
};

/** D-127 wire-up — when the mail enroll deps are wired (production
 *  bin.ts), delegate through `handleMailEnrollOAuth` so the OAuth
 *  flow ALSO writes an instance row + flips the live `MailCollection`
 *  on. The legacy `enrollOAuth` deps path stays as a fallback for
 *  test harnesses that compose only the OAuth subset. The wire shape
 *  preserves the legacy `{ ok, account_key_prefix }` envelope so
 *  callers don't need to migrate. */
export const handleCollectionEnrollOAuth = async (
  deps: CollectionHandlerDeps,
  args: {
    provider?: unknown;
    account_slug?: unknown;
    code?: unknown;
    redirect_uri?: unknown;
  },
): Promise<{ ok: true; account_key_prefix: string }> => {
  if (deps.mailEnroll) {
    const { handleMailEnrollOAuth } = await import('./mail/enroll.js');
    const result = await handleMailEnrollOAuth(deps.mailEnroll, {
      adapter: args.provider,
      account_slug: args.account_slug,
      code: args.code,
      redirect_uri: args.redirect_uri,
    });
    return {
      ok: true,
      account_key_prefix: keyPrefix(
        args.provider as OAuthProvider,
        result.slug,
      ),
    };
  }
  if (!deps.enrollOAuth) {
    throw new RpcError(
      'not_configured',
      'collection.mail.enrollOAuth: server has no OAuth client configured — set RECUED_GMAIL_CLIENT_ID / RECUED_GRAPH_CLIENT_ID',
      503,
    );
  }
  const provider = requireOAuthProvider(args.provider);
  const slug = requireString(args.account_slug, 'account_slug');
  const code = requireString(args.code, 'code');
  const redirectUri = requireString(args.redirect_uri, 'redirect_uri');
  const providerConfig = deps.enrollOAuth.config(provider);
  if (!providerConfig || !providerConfig.clientId) {
    throw new RpcError(
      'not_configured',
      `collection.mail.enrollOAuth: no ${provider} OAuth client id configured`,
      503,
    );
  }
  try {
    await exchangeCodeForTokens({
      provider,
      slug,
      code,
      redirectUri,
      providerConfig,
      accountStore: deps.enrollOAuth.accountStore,
      fetcher: deps.enrollOAuth.fetcher,
      now: deps.enrollOAuth.now,
    });
    return { ok: true, account_key_prefix: keyPrefix(provider, slug) };
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new RpcError(
        err.code === 'missing_refresh_token' ? 'bad_request' : 'upstream_error',
        err.message,
        err.status || 502,
      );
    }
    throw err;
  }
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// collection.resync (Phase G, D-109)
// ────────────────────────────────────────────────────────────────

/** Trigger an out-of-band resync pass on `(platform, slug)`. Returns
 *  the queued_at unix-ms. The adapter owns the actual work — the
 *  handler just hands off. Idempotent: a second call while an earlier
 *  pass is still running is accepted and coalesces (the adapter
 *  dedupes internally). */
export const handleCollectionResync = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown },
): Promise<{ ok: true; queued_at: number }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const collection = requireCollection(deps, platform, slug);
  // Drive the sync loop via start() — it's the public entry point
  // adapters expose, and it's idempotent (second call in `syncing`
  // state coalesces). A bespoke "force refresh" hook would be cleaner
  // but adapters don't expose one yet; this produces the right
  // user-visible outcome (new records land on the next tick).
  try {
    await collection.sync.start();
    return { ok: true, queued_at: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RpcError('collection_source_unreachable', msg, 502);
  }
};

// ────────────────────────────────────────────────────────────────
// collection.deleteRecord (Phase G, D-109)
// ────────────────────────────────────────────────────────────────

/** Delete one record by `record_id`. Raises `not_found`
 *  (→ `COLLECTION_RECORD_NOT_FOUND` on the caller) when the row
 *  doesn't exist — distinct from the table not being registered.
 *  D-119 Phase 13: when `annotationCascade` is wired, every
 *  annotation pointing at the record AND every link with the record
 *  as either endpoint is removed in the same operation so the
 *  warehouse never carries dangling references. */
export const handleCollectionDeleteRecord = async (
  deps: CollectionHandlerDeps,
  args: { platform?: unknown; slug?: unknown; record_id?: unknown },
): Promise<{ ok: true }> => {
  const platform = requirePlatform(args.platform);
  const slug = requireSlug(args.slug);
  const record_id = requireString(args.record_id, 'record_id');
  const collection = requireCollection(deps, platform, slug);
  const removed = collection.delete(record_id);
  if (!removed) {
    throw new RpcError(
      'not_found',
      `COLLECTION_RECORD_NOT_FOUND: no record '${record_id}' in ${platform}:${slug}`,
      404,
    );
  }
  if (deps.annotationCascade) {
    try {
      // The platform name (mail / file / webhook / calendar) doubles
      // as the canonical-collection name in the annotation+link store.
      deps.annotationCascade(platform, record_id);
    } catch {
      // Best-effort — record delete is the canonical state; cascade
      // failure logs (handler-side) but doesn't roll back.
    }
  }
  // D-122 Phase 4.5 — enrichment cascade. Webhook collections don't
  // carry enrichment topics today (no registry entries reference
  // `webhook` scope), so we narrow to the two platforms this rpc
  // accepts that DO carry topics. Calendar deletes don't flow through
  // this rpc (PLATFORMS allowlist excludes calendar — calendar uses
  // its own `calendar.deleteEvent` dispatcher path); the calendar
  // delete cascade fires from `bridgeEnrichmentCascade` against the
  // warehouse-events bus instead. Contact deletes flow through
  // `ContactStore.delete` → `onDelete` callback, also bypassing
  // this rpc.
  if (deps.enrichmentCascadeOnDelete
    && (platform === 'mail' || platform === 'file')) {
    try {
      deps.enrichmentCascadeOnDelete(platform, record_id);
    } catch {
      // Best-effort, same discipline as the annotation cascade above.
    }
  }
  return { ok: true };
};

export type CollectionMethods =
  | 'collection.list'
  | 'collection.search'
  // D-174 #22 — mirror drill-down name→entity_id search. Lives in this
  // slice because it fans out over the collection registry; named in the
  // `data.*` read vocabulary it shares with `data.timeline`.
  | 'data.mirror.search'
  | 'collection.get'
  | 'collection.runRetention'
  | 'collection.listEndpoints'
  | 'collection.mail.enrollOAuth'
  // D-177 N.12 — `collection.mail.send` is NOT in this slice (not a wire
  // method). `handleCollectionMailSend` stays exported as the gateway's
  // internal executor (kernel `mailSend` dispatcher calls it post-gate).
  | 'collection.mail.enrollImap'
  | 'collection.mail.list'
  | 'collection.mail.delete'
  | 'collection.resync'
  | 'collection.deleteRecord'
  | 'collection.file.enroll'
  | 'collection.file.update'
  | 'collection.file.delete'
  | 'collection.file.resync'
  | 'collection.file.reauth'
  | 'collection.listInstances'
  | 'collection.calendar.enrollOAuth'
  | 'collection.calendar.enrollBasic'
  | 'collection.calendar.list'
  | 'collection.calendar.update'
  | 'collection.calendar.delete'
  | 'collection.calendar.resync'
  | 'collection.calendar.reauth'
  | 'collection.service.list'
  | 'collection.service.listTemplates'
  | 'collection.service.enroll'
  | 'collection.service.install'
  | 'collection.service.upgrade'
  | 'collection.service.uninstall'
  | 'collection.service.update'
  | 'collection.service.delete'
  | 'collection.service.clear_crash'
  | 'collection.service.start'
  | 'collection.service.stop'
  | 'collection.service.restart';

const requireFileEnroll = (
  deps: CollectionHandlerDeps,
): FileEnrollDeps => {
  if (!deps.fileEnroll) {
    throw new RpcError(
      'not_configured',
      'collection.file.* enroll family requires the file-adapter store — compose bin.ts with instance store + adapter registry',
      503,
    );
  }
  return deps.fileEnroll;
};

const requireCalendarEnroll = (
  deps: CollectionHandlerDeps,
): CalendarEnrollDeps => {
  if (!deps.calendarEnroll) {
    throw new RpcError(
      'not_configured',
      'collection.calendar.* enroll family requires the calendar-adapter store — compose bin.ts with instance store, calendar registry + account store',
      503,
    );
  }
  return deps.calendarEnroll;
};

const requireServiceEnroll = (
  deps: CollectionHandlerDeps,
): ServiceEnrollDeps => {
  if (!deps.serviceEnroll) {
    throw new RpcError(
      'not_configured',
      'collection.service.* enroll family requires the service stack — compose bin.ts with serviceStack',
      503,
    );
  }
  return deps.serviceEnroll;
};

const requireMailEnroll = (
  deps: CollectionHandlerDeps,
): MailEnrollDeps => {
  if (!deps.mailEnroll) {
    throw new RpcError(
      'not_configured',
      'collection.mail.* enroll family requires the mail composition root — compose bin.ts with composeMailStack',
      503,
    );
  }
  return deps.mailEnroll;
};

export const makeCollectionHandlers = (
  deps: CollectionHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, CollectionMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'collection.list',
      'collection.search',
      'data.mirror.search',
      'collection.get',
      'collection.runRetention',
      'collection.listEndpoints',
      'collection.mail.enrollOAuth',
      // D-177 N.12 — `collection.mail.send` deliberately omitted (gateway
      // internal executor only; see the type union + handlers below).
      'collection.mail.enrollImap',
      'collection.mail.list',
      'collection.mail.delete',
      'collection.resync',
      'collection.deleteRecord',
      'collection.file.enroll',
      'collection.file.update',
      'collection.file.delete',
      'collection.file.resync',
      'collection.file.reauth',
      'collection.listInstances',
      'collection.calendar.enrollOAuth',
      'collection.calendar.enrollBasic',
      'collection.calendar.list',
      'collection.calendar.update',
      'collection.calendar.delete',
      'collection.calendar.resync',
      'collection.calendar.reauth',
      'collection.service.list',
      'collection.service.listTemplates',
      'collection.service.enroll',
      'collection.service.install',
      'collection.service.upgrade',
      'collection.service.uninstall',
      'collection.service.update',
      'collection.service.delete',
      'collection.service.clear_crash',
      'collection.service.start',
      'collection.service.stop',
      'collection.service.restart',
    ],
    handlers: {
      'collection.list': async (args) =>
        handleCollectionList(deps, args as Parameters<typeof handleCollectionList>[1]),
      'collection.search': async (args) =>
        handleCollectionSearch(deps, args as Parameters<typeof handleCollectionSearch>[1]),
      'data.mirror.search': async (args) =>
        handleMirrorSearch(deps, args as Parameters<typeof handleMirrorSearch>[1]),
      'collection.get': async (args) =>
        handleCollectionGet(deps, args as Parameters<typeof handleCollectionGet>[1]),
      'collection.runRetention': async (args) =>
        handleCollectionRunRetention(deps, args as Parameters<typeof handleCollectionRunRetention>[1]),
      'collection.listEndpoints': async () =>
        handleCollectionListEndpoints(deps),
      'collection.mail.enrollOAuth': async (args) =>
        handleCollectionEnrollOAuth(deps, args as Parameters<typeof handleCollectionEnrollOAuth>[1]),
      // D-177 N.12 — NO `collection.mail.send` handler here. Outbound mail
      // is a gated action: the `recued/mail-send` kernel ingredient is the
      // entry point (gateway outbound-send escalation → `ask`), and the
      // kernel `mailSend` dispatcher calls `handleCollectionMailSend`
      // directly as the gateway's internal executor AFTER the verdict.
      // Wiring it here would re-open a client/MCP-reachable trust-bypass.
      'collection.mail.enrollImap': async (args) =>
        handleMailEnrollImap(requireMailEnroll(deps), args as Parameters<typeof handleMailEnrollImap>[1]),
      'collection.mail.list': async () =>
        handleMailList(requireMailEnroll(deps)),
      'collection.mail.delete': async (args) =>
        handleMailDelete(requireMailEnroll(deps), args as Parameters<typeof handleMailDelete>[1]),
      'collection.resync': async (args) =>
        handleCollectionResync(deps, args as Parameters<typeof handleCollectionResync>[1]),
      'collection.deleteRecord': async (args) =>
        handleCollectionDeleteRecord(deps, args as Parameters<typeof handleCollectionDeleteRecord>[1]),
      'collection.file.enroll': async (args) =>
        handleFileEnroll(requireFileEnroll(deps), args as Parameters<typeof handleFileEnroll>[1]),
      'collection.file.update': async (args) =>
        handleFileUpdate(requireFileEnroll(deps), args as Parameters<typeof handleFileUpdate>[1]),
      'collection.file.delete': async (args) =>
        handleFileDelete(requireFileEnroll(deps), args as Parameters<typeof handleFileDelete>[1]),
      'collection.file.resync': async (args) =>
        handleFileResync(requireFileEnroll(deps), args as Parameters<typeof handleFileResync>[1]),
      'collection.file.reauth': async (args) =>
        handleFileReauth(requireFileEnroll(deps), args as Parameters<typeof handleFileReauth>[1]),
      'collection.listInstances': async (args) =>
        handleListInstances(requireFileEnroll(deps), args as Parameters<typeof handleListInstances>[1]),
      'collection.calendar.enrollOAuth': async (args) =>
        handleCalendarEnrollOAuth(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarEnrollOAuth>[1]),
      'collection.calendar.enrollBasic': async (args) =>
        handleCalendarEnrollBasic(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarEnrollBasic>[1]),
      'collection.calendar.list': async () =>
        handleCalendarEnrollList(requireCalendarEnroll(deps)),
      'collection.calendar.update': async (args) =>
        handleCalendarEnrollUpdate(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarEnrollUpdate>[1]),
      'collection.calendar.delete': async (args) =>
        handleCalendarEnrollDelete(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarEnrollDelete>[1]),
      'collection.calendar.resync': async (args) =>
        handleCalendarEnrollResync(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarEnrollResync>[1]),
      'collection.calendar.reauth': async (args) =>
        handleCalendarReauth(requireCalendarEnroll(deps), args as Parameters<typeof handleCalendarReauth>[1]),
      'collection.service.list': async () =>
        handleServiceList(requireServiceEnroll(deps)),
      'collection.service.listTemplates': async (args) =>
        handleServiceListTemplates(
          requireServiceEnroll(deps),
          args as Parameters<typeof handleServiceListTemplates>[1],
        ),
      'collection.service.enroll': async (args) =>
        handleServiceEnroll(requireServiceEnroll(deps), args as Parameters<typeof handleServiceEnroll>[1]),
      'collection.service.install': async (args) =>
        handleServiceInstall(requireServiceEnroll(deps), args as Parameters<typeof handleServiceInstall>[1]),
      'collection.service.upgrade': async (args) =>
        handleServiceUpgrade(requireServiceEnroll(deps), args as Parameters<typeof handleServiceUpgrade>[1]),
      'collection.service.uninstall': async (args) =>
        handleServiceUninstall(requireServiceEnroll(deps), args as Parameters<typeof handleServiceUninstall>[1]),
      'collection.service.update': async (args) =>
        handleServiceUpdate(requireServiceEnroll(deps), args as Parameters<typeof handleServiceUpdate>[1]),
      'collection.service.delete': async (args) =>
        handleServiceDelete(requireServiceEnroll(deps), args as Parameters<typeof handleServiceDelete>[1]),
      'collection.service.clear_crash': async (args) =>
        handleServiceClearCrash(requireServiceEnroll(deps), args as Parameters<typeof handleServiceClearCrash>[1]),
      'collection.service.start': async (args) =>
        handleServiceStart(requireServiceEnroll(deps), args as Parameters<typeof handleServiceStart>[1]),
      'collection.service.stop': async (args) =>
        handleServiceStop(requireServiceEnroll(deps), args as Parameters<typeof handleServiceStop>[1]),
      'collection.service.restart': async (args) =>
        handleServiceRestart(requireServiceEnroll(deps), args as Parameters<typeof handleServiceRestart>[1]),
    },
  };
};
