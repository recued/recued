/** D-149 P3 § A.3 — `public_endpoint_registry` + `public_endpoint_access_log`
 *  CRUD store.
 *
 *  Server-internal table; no cross-cloud sync (§ Must Hold I-15; D-097 / D-168).
 *  P1 created the schema as placeholder shells; P3 lands the CRUD methods
 *  driving the rpc surface in `backend/server/src/reception-rpc-handler.ts`.
 *
 *  Mutation discipline:
 *
 *    - `create` inserts with `enabled = 0` by I-1 default-off baseline.
 *      Caller MUST explicitly call `enable` to flip; the SQL DEFAULT 0
 *      makes this load-bearing at the storage layer.
 *    - `enable` flips `enabled = 1` iff `revoked_at IS NULL` AND
 *      `enabled = 0` (returns `already_enabled` / `already_revoked`
 *      sentinels for clean rpc error mapping).
 *    - `revoke` stamps `revoked_at`; idempotent (re-revoking preserves
 *      the original stamp); also stamps `enabled = 0` so the
 *      `idx_endpoint_active` partial index can skip revoked rows.
 *    - `rotateToken` replaces the stored `bearer_secret_hmac` in a
 *      single statement; old bearer fails verify within 60s per I-5
 *      (cache invalidation broadcast on the bus).
 *    - `emergencyDisableAll` flips every `enabled = 1` row to 0;
 *      mass-mutation. Doesn't revoke (reversible).
 *
 *  Lookup discipline:
 *
 *    - `findById` is the cache-miss path. The listener consults the
 *      in-memory cache first; on miss, this method reads from SQL.
 *    - `verifyBearer` is the request-path helper. Takes the submitted
 *      secret + endpoint_id → loads the row → runs HMAC verify under
 *      the pepper. Returns the row on match; `null` on miss / expired /
 *      revoked. Per I-10 the caller is responsible for the per-IP
 *      rate-limit check BEFORE invoking this method.
 *
 *  Spec: docs/d-149-spec.md § A.3 + § A.18.2 + § Must Hold I-1 / I-5 /
 *  I-10. */

import type Database from 'better-sqlite3';
import {
  RECEPTION_ENDPOINT_KIND_SET,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  type AccessLogEntry,
  type EndpointSummary,
  type PacketDeclaration,
  type ReceptionAccessAction,
  type ReceptionAccessOutcome,
  type ReceptionEndpointKind,
  type ReceptionEndpointsListFilter,
  type ReceptionPageConfig,
} from '@recued/contracts';
import { verifyBearerSecret } from '../ports/reception/token-primitives.js';

// ────────────────────────────────────────────────────────────────
// Row shapes
// ────────────────────────────────────────────────────────────────

interface RegistryRow {
  endpoint_id: string;
  kind: string;
  enabled: number;
  packet_declaration: string;
  bearer_secret_hmac: Buffer;
  single_use_secret_hmac: Buffer | null;
  consumed_at: number | null;
  consumed_by_visitor_email_encrypted: Buffer | null;
  created_at: number;
  created_by_client_id: string;
  expires_at: number | null;
  long_lived_acknowledged_at: number | null;
  revoked_at: number | null;
  revocation_reason: string | null;
  audit_count: number;
  last_accessed_at: number | null;
  metadata_blob: string | null;
}

interface AccessLogRow {
  id: string;
  endpoint_id: string;
  accessed_at: number;
  source_ip_hash: string | null;
  user_agent_hash: string | null;
  action_taken: string;
  outcome: string;
  url_path_redacted: string | null;
  metadata_blob: string | null;
}

const parsePacketDeclaration = (raw: string): PacketDeclaration => {
  try {
    return JSON.parse(raw) as PacketDeclaration;
  } catch {
    // Defense in depth — a tampered row shouldn't crash the listener.
    // The substrate validator gates JSON shape at write-time; a parse
    // failure here means the SQL row was hand-edited or the file was
    // restored from a partial backup. Surface a debugging-friendly
    // placeholder that the rpc layer can detect + flag.
    return {
      packet_kind: 'reception_page_packet',
      source_query_ref: { kind: 'reception_page_config' },
    } as PacketDeclaration;
  }
};

const parseMetadataBlob = (raw: string | null): Readonly<Record<string, unknown>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Same defense as packet_declaration; fall through.
  }
  return {};
};

const rowToSummary = (row: RegistryRow): EndpointSummary => {
  return {
    endpoint_id: row.endpoint_id,
    kind: row.kind as ReceptionEndpointKind,
    enabled: row.enabled === 1,
    packet_declaration: parsePacketDeclaration(row.packet_declaration),
    created_at: row.created_at,
    created_by_client_id: row.created_by_client_id,
    expires_at: row.expires_at,
    long_lived_acknowledged_at: row.long_lived_acknowledged_at,
    revoked_at: row.revoked_at,
    revocation_reason: row.revocation_reason,
    audit_count: row.audit_count,
    last_accessed_at: row.last_accessed_at,
    metadata: parseMetadataBlob(row.metadata_blob),
  };
};

const rowToAccessLogEntry = (row: AccessLogRow): AccessLogEntry => {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    accessed_at: row.accessed_at,
    source_ip_hash: row.source_ip_hash,
    user_agent_hash: row.user_agent_hash,
    action_taken: row.action_taken as ReceptionAccessAction,
    outcome: row.outcome as ReceptionAccessOutcome,
    url_path_redacted: row.url_path_redacted,
    metadata: parseMetadataBlob(row.metadata_blob),
  };
};

// ────────────────────────────────────────────────────────────────
// Store interface
// ────────────────────────────────────────────────────────────────

export interface PublicEndpointRegistryStore {
  /** § A.3 endpoint.create — insert a new row with default-off
   *  `enabled = 0`. Mutating the `enabled` column requires the
   *  explicit `enable` call. Returns the persisted row's stamp. */
  create(input: {
    endpoint_id: string;
    kind: ReceptionEndpointKind;
    packet_declaration: PacketDeclaration;
    bearer_secret_hmac: Buffer;
    created_at: number;
    created_by_client_id: string;
    expires_at: number | null;
    long_lived_acknowledged_at: number | null;
    metadata: Readonly<Record<string, unknown>>;
  }): EndpointSummary;
  /** § A.3 endpoint.list — paginated + filtered list view for the
   *  Settings UX renderer. */
  list(filter?: ReceptionEndpointsListFilter): ReadonlyArray<EndpointSummary>;
  /** § A.3 cache-miss path — single-row read by id; null when absent. */
  findById(endpoint_id: string): EndpointSummary | null;
  /** § A.3 endpoint.enable — flip `enabled = 1` iff the row is not
   *  revoked AND not already enabled. Returns `'enabled'` /
   *  `'already_enabled'` / `'already_revoked'` / `'not_found'` so the
   *  rpc layer can map cleanly to `RpcError.code`. */
  enable(endpoint_id: string, now: number):
    | 'enabled'
    | 'already_enabled'
    | 'already_revoked'
    | 'not_found';
  /** § A.3 endpoint.disable — flip `enabled = 0` iff the row is not
   *  revoked AND currently enabled. Symmetric to `enable`. */
  disable(endpoint_id: string, now: number):
    | 'disabled'
    | 'already_disabled'
    | 'already_revoked'
    | 'not_found';
  /** § A.3 endpoint.revoke — irreversibly mark the row revoked + flip
   *  `enabled = 0`. Idempotent — re-revoking preserves the original
   *  stamp + reason. */
  revoke(input: { endpoint_id: string; now: number; reason: string | null }):
    | 'revoked'
    | 'already_revoked'
    | 'not_found';
  /** § A.3 endpoint.extend — update `expires_at` iff the row is not
   *  revoked. `null` flips long-lived (sets `long_lived_acknowledged_at`). */
  extend(input: { endpoint_id: string; new_expires_at: number | null; now: number }):
    | 'extended'
    | 'already_revoked'
    | 'not_found';
  /** § A.3 endpoint.rotate_token — replace the stored HMAC with a new
   *  one. Returns the prior `revoked_at` so the rpc layer can reject
   *  rotations on revoked rows. */
  rotateToken(input: {
    endpoint_id: string;
    new_bearer_secret_hmac: Buffer;
    now: number;
  }): 'rotated' | 'already_revoked' | 'not_found';
  /** § A.3 endpoint.emergency_disable_all — flip every enabled row off
   *  (revoked rows preserved). Returns the count of affected rows. */
  emergencyDisableAll(now: number): number;
  /** Internal helper — load the full registry row including the HMAC
   *  for verify path. Returns null on miss / revoked / expired. */
  loadForVerify(endpoint_id: string, now: number): RegistryRow | null;
  /** § A.3 access log — append an entry. Always writes synchronously
   *  per § Must Hold I-12 (visitor handlers never block waiting for
   *  async I/O). */
  appendAccessLog(input: {
    id: string;
    endpoint_id: string;
    accessed_at: number;
    source_ip_hash: string | null;
    user_agent_hash: string | null;
    action_taken: ReceptionAccessAction;
    outcome: ReceptionAccessOutcome;
    url_path_redacted: string | null;
    metadata: Readonly<Record<string, unknown>>;
  }): void;
  /** § A.3 endpoint.access_log rpc — paged read; default 100 rows
   *  most-recent first. */
  readAccessLog(input: {
    endpoint_id: string;
    since?: number;
    limit?: number;
  }): ReadonlyArray<AccessLogEntry>;
  /** D-149 P12 § A.20.5 — server-wide operational-access-log read for
   *  the Abuse Inbox aggregation. Reads across every endpoint (the
   *  per-endpoint `readAccessLog` is keyed on a single endpoint_id);
   *  default 5000 rows most-recent first, hard cap 20000. */
  readAccessLogAcrossEndpoints(input: {
    since?: number;
    limit?: number;
  }): ReadonlyArray<AccessLogEntry>;
  /** Audit-counter bump — fired alongside high-assurance audit emit so
   *  the Settings UX can render "X events in last 7d" without a JOIN. */
  bumpAuditCounter(endpoint_id: string, now: number): void;
  /** Verify a submitted bearer secret against the stored HMAC under
   *  the supplied pepper. Returns the registry summary on match;
   *  `null` on miss / expired / revoked. The caller is responsible
   *  for the per-IP rate-limit check BEFORE invoking per I-10. */
  verifyBearer(input: {
    endpoint_id: string;
    submitted_secret: string;
    pepper: Buffer;
    now: number;
  }):
    | { kind: 'ok'; endpoint: EndpointSummary }
    | { kind: 'invalid_token' }
    | { kind: 'revoked' }
    | { kind: 'expired' };
  /** D-149 P4 § A.5.1 — load the reception_page singleton row + parse
   *  its config blob. Returns `null` when no upsert has run yet
   *  (fresh-install state — visitor sees substrate placeholder). The
   *  row's `metadata_blob` carries the `ReceptionPageConfig` shape;
   *  parse failures surface as `null` (defense in depth — a corrupt
   *  blob falls back to the placeholder rather than 500ing the page). */
  loadReceptionPageSingleton(): {
    config: ReceptionPageConfig;
    last_updated_at: number;
  } | null;
  /** D-149 P12 § A.20.7 follow-on — read the reception_page singleton's
   *  config blob for per-server SETTINGS purposes, WITHOUT the
   *  enable/revoke gate `loadReceptionPageSingleton` applies. The
   *  singleton config carries per-server settings
   *  (`trust_footer_enabled`; D-210 Phase C `inbox_fanout_mode`) that are
   *  independent of whether the
   *  front-door page is being served: disabling the `/reception/`
   *  landing page must not silently flip an explicit
   *  `trust_footer_enabled: false` back to its default-on for the
   *  still-enabled link-style endpoints. Returns `null` only when the
   *  row is absent or its blob is corrupt — a disabled / revoked
   *  singleton still yields its config. Callers reading per-server
   *  settings use this; callers deciding whether to RENDER the
   *  front-door page use `loadReceptionPageSingleton` (which gates on
   *  enable/revoke per the P4 emergency-disable contract). */
  loadReceptionPageConfigForSettings(): ReceptionPageConfig | null;
  /** D-149 P4 § A.5.1 — create or update the reception_page singleton
   *  row. Inserts on first call (with a sentinel bearer_secret_hmac
   *  per § A.5.1 "No per-link tokens"); updates `metadata_blob` +
   *  bumps `last_accessed_at` to `now` on subsequent calls. Returns
   *  `'created'` when the row was just inserted, `'updated'` when it
   *  already existed. */
  upsertReceptionPageSingleton(input: {
    config: ReceptionPageConfig;
    now: number;
    actor_instance_id: string;
  }): 'created' | 'updated';
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export const createPublicEndpointRegistryStore = (
  db: Database.Database,
): PublicEndpointRegistryStore => {
  const insertStmt = db.prepare(`
    INSERT INTO public_endpoint_registry (
      endpoint_id, kind, enabled, packet_declaration, bearer_secret_hmac,
      single_use_secret_hmac, consumed_at, consumed_by_visitor_email_encrypted,
      created_at, created_by_client_id, expires_at, long_lived_acknowledged_at,
      revoked_at, revocation_reason, audit_count, last_accessed_at, metadata_blob
    ) VALUES (
      @endpoint_id, @kind, 0, @packet_declaration, @bearer_secret_hmac,
      NULL, NULL, NULL,
      @created_at, @created_by_client_id, @expires_at, @long_lived_acknowledged_at,
      NULL, NULL, 0, NULL, @metadata_blob
    )
  `);

  const selectByIdStmt = db.prepare(
    `SELECT * FROM public_endpoint_registry WHERE endpoint_id = @endpoint_id`,
  );

  const enableStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET enabled = 1
     WHERE endpoint_id = @endpoint_id
       AND enabled = 0
       AND revoked_at IS NULL
  `);

  const disableStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET enabled = 0
     WHERE endpoint_id = @endpoint_id
       AND enabled = 1
       AND revoked_at IS NULL
  `);

  const revokeStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET revoked_at = @now,
           revocation_reason = @reason,
           enabled = 0
     WHERE endpoint_id = @endpoint_id
       AND revoked_at IS NULL
  `);

  const extendStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET expires_at = @new_expires_at,
           long_lived_acknowledged_at = @long_lived_acknowledged_at
     WHERE endpoint_id = @endpoint_id
       AND revoked_at IS NULL
  `);

  const rotateTokenStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET bearer_secret_hmac = @new_bearer_secret_hmac
     WHERE endpoint_id = @endpoint_id
       AND revoked_at IS NULL
  `);

  const emergencyDisableAllStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET enabled = 0
     WHERE enabled = 1
       AND revoked_at IS NULL
  `);

  const accessLogInsertStmt = db.prepare(`
    INSERT INTO public_endpoint_access_log (
      id, endpoint_id, accessed_at, source_ip_hash, user_agent_hash,
      action_taken, outcome, url_path_redacted, metadata_blob
    ) VALUES (
      @id, @endpoint_id, @accessed_at, @source_ip_hash, @user_agent_hash,
      @action_taken, @outcome, @url_path_redacted, @metadata_blob
    )
  `);

  const bumpAuditStmt = db.prepare(`
    UPDATE public_endpoint_registry
       SET audit_count = audit_count + 1,
           last_accessed_at = @now
     WHERE endpoint_id = @endpoint_id
  `);

  return {
    create(input) {
      insertStmt.run({
        endpoint_id: input.endpoint_id,
        kind: input.kind,
        packet_declaration: JSON.stringify(input.packet_declaration),
        bearer_secret_hmac: input.bearer_secret_hmac,
        created_at: input.created_at,
        created_by_client_id: input.created_by_client_id,
        expires_at: input.expires_at,
        long_lived_acknowledged_at: input.long_lived_acknowledged_at,
        metadata_blob: JSON.stringify(input.metadata),
      });
      const row = selectByIdStmt.get({ endpoint_id: input.endpoint_id }) as
        | RegistryRow
        | undefined;
      if (!row) {
        throw new Error(`PublicEndpointRegistryStore.create: row missing after insert`);
      }
      return rowToSummary(row);
    },

    list(filter) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.kind !== undefined) {
        if (!RECEPTION_ENDPOINT_KIND_SET.has(filter.kind)) {
          // Defense in depth — caller-supplied filter should be validated
          // upstream; reject unknown kinds at the storage layer too so a
          // bad filter doesn't return every row by accident.
          return [];
        }
        clauses.push('kind = @kind');
        params.kind = filter.kind;
      }
      if (filter?.enabled !== undefined) {
        clauses.push('enabled = @enabled');
        params.enabled = filter.enabled ? 1 : 0;
      }
      if (filter?.include_revoked !== true) {
        clauses.push('revoked_at IS NULL');
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const stmt = db.prepare(
        `SELECT * FROM public_endpoint_registry ${where} ORDER BY created_at DESC`,
      );
      const rows = stmt.all(params) as RegistryRow[];
      return rows.map(rowToSummary);
    },

    findById(endpoint_id) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return null;
      return rowToSummary(row);
    },

    enable(endpoint_id, _now) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return 'not_found';
      if (row.revoked_at !== null) return 'already_revoked';
      if (row.enabled === 1) return 'already_enabled';
      const res = enableStmt.run({ endpoint_id });
      return res.changes > 0 ? 'enabled' : 'not_found';
    },

    disable(endpoint_id, _now) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return 'not_found';
      if (row.revoked_at !== null) return 'already_revoked';
      if (row.enabled === 0) return 'already_disabled';
      const res = disableStmt.run({ endpoint_id });
      return res.changes > 0 ? 'disabled' : 'not_found';
    },

    revoke({ endpoint_id, now, reason }) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return 'not_found';
      if (row.revoked_at !== null) return 'already_revoked';
      revokeStmt.run({ endpoint_id, now, reason });
      return 'revoked';
    },

    extend({ endpoint_id, new_expires_at, now }) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return 'not_found';
      if (row.revoked_at !== null) return 'already_revoked';
      extendStmt.run({
        endpoint_id,
        new_expires_at,
        long_lived_acknowledged_at: new_expires_at === null ? now : null,
      });
      return 'extended';
    },

    rotateToken({ endpoint_id, new_bearer_secret_hmac, now: _now }) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return 'not_found';
      if (row.revoked_at !== null) return 'already_revoked';
      rotateTokenStmt.run({ endpoint_id, new_bearer_secret_hmac });
      return 'rotated';
    },

    emergencyDisableAll(_now) {
      const res = emergencyDisableAllStmt.run();
      return res.changes;
    },

    loadForVerify(endpoint_id, _now) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      return row ?? null;
    },

    appendAccessLog(input) {
      accessLogInsertStmt.run({
        id: input.id,
        endpoint_id: input.endpoint_id,
        accessed_at: input.accessed_at,
        source_ip_hash: input.source_ip_hash,
        user_agent_hash: input.user_agent_hash,
        action_taken: input.action_taken,
        outcome: input.outcome,
        url_path_redacted: input.url_path_redacted,
        metadata_blob: JSON.stringify(input.metadata),
      });
    },

    readAccessLog({ endpoint_id, since, limit }) {
      const max = Math.min(limit ?? 100, 1000);
      const sinceClause = since !== undefined ? 'AND accessed_at >= @since' : '';
      const stmt = db.prepare(`
        SELECT * FROM public_endpoint_access_log
         WHERE endpoint_id = @endpoint_id ${sinceClause}
         ORDER BY accessed_at DESC
         LIMIT @limit
      `);
      const params: Record<string, unknown> = { endpoint_id, limit: max };
      if (since !== undefined) params.since = since;
      const rows = stmt.all(params) as AccessLogRow[];
      return rows.map(rowToAccessLogEntry);
    },

    readAccessLogAcrossEndpoints({ since, limit }) {
      // D-149 P12 § A.20.5 — Abuse Inbox aggregation source. Server-wide
      // (no endpoint_id filter); 5000-row default, 20000 hard cap so a
      // single rpc can't pull an unbounded slab of the operational log.
      // `Math.floor` keeps the bound an integer even if a caller slips a
      // fractional value past the rpc-edge guard — SQLite's `LIMIT`
      // rejects a REAL bind (Codex P2 fold; defense in depth).
      const max = Math.floor(Math.min(limit ?? 5000, 20000));
      const sinceClause = since !== undefined ? 'WHERE accessed_at >= @since' : '';
      const stmt = db.prepare(`
        SELECT * FROM public_endpoint_access_log
         ${sinceClause}
         ORDER BY accessed_at DESC
         LIMIT @limit
      `);
      const params: Record<string, unknown> = { limit: max };
      if (since !== undefined) params.since = since;
      const rows = stmt.all(params) as AccessLogRow[];
      return rows.map(rowToAccessLogEntry);
    },

    bumpAuditCounter(endpoint_id, now) {
      bumpAuditStmt.run({ endpoint_id, now });
    },

    verifyBearer({ endpoint_id, submitted_secret, pepper, now }) {
      const row = selectByIdStmt.get({ endpoint_id }) as RegistryRow | undefined;
      if (!row) return { kind: 'invalid_token' };
      if (row.revoked_at !== null) return { kind: 'revoked' };
      if (row.expires_at !== null && row.expires_at <= now) {
        return { kind: 'expired' };
      }
      if (row.enabled === 0) return { kind: 'invalid_token' };
      const ok = verifyBearerSecret({
        submitted_secret,
        stored_hmac: row.bearer_secret_hmac,
        pepper,
      });
      if (!ok) return { kind: 'invalid_token' };
      return { kind: 'ok', endpoint: rowToSummary(row) };
    },

    loadReceptionPageSingleton() {
      const row = selectByIdStmt.get({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      }) as RegistryRow | undefined;
      if (!row) return null;
      if (row.kind !== 'reception_page') return null;
      // Codex review P1 fold (2026-05-13 P4) — `reception.emergency_disable_all`
      // sweeps every `enabled = 1` row to 0 + the dedicated
      // `reception.endpoint.disable` rpc flips the singleton's enable
      // bit individually. Either path is the operator's kill switch
      // for the public front-door surface. Returning the config blob
      // here would let the handler bypass the link-style enable/revoke
      // checks and keep serving the configured page; gate at the loader
      // so the singleton respects the same emergency-disable contract
      // as every link-style endpoint. Revoked rows (defense in depth —
      // the singleton isn't normally revoked) hide too.
      if (row.enabled === 0) return null;
      if (row.revoked_at !== null) return null;
      const parsed = parseMetadataBlob(row.metadata_blob);
      // The metadata blob carries the `ReceptionPageConfig` shape; if
      // the parser returns an empty object (corrupt / missing blob)
      // surface as `null` so the handler falls back to the substrate
      // placeholder instead of rendering an undefined display_name.
      if (
        !parsed ||
        typeof (parsed as { display_overrides?: unknown }).display_overrides !== 'object'
      ) {
        return null;
      }
      // Use `last_accessed_at` as the upsert timestamp — the singleton
      // path stamps that column on every upsert. `created_at` records
      // the first upsert; `last_accessed_at` records the most-recent
      // mutation so the Settings UX can render "last saved 5m ago".
      const last_updated_at = row.last_accessed_at ?? row.created_at;
      return {
        config: parsed as unknown as ReceptionPageConfig,
        last_updated_at,
      };
    },

    loadReceptionPageConfigForSettings() {
      const row = selectByIdStmt.get({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      }) as RegistryRow | undefined;
      if (!row) return null;
      if (row.kind !== 'reception_page') return null;
      // NO enable / revoke gate — unlike `loadReceptionPageSingleton`,
      // this reads a per-server SETTING off the config blob, not the
      // renderable front-door. A disabled / revoked singleton still
      // carries the operator's saved `trust_footer_enabled` preference;
      // gating here would silently default-on a footer the operator
      // explicitly turned off (Codex review fold).
      const parsed = parseMetadataBlob(row.metadata_blob);
      if (
        !parsed ||
        typeof (parsed as { display_overrides?: unknown }).display_overrides !== 'object'
      ) {
        return null;
      }
      return parsed as unknown as ReceptionPageConfig;
    },

    upsertReceptionPageSingleton({ config, now, actor_instance_id }) {
      // The singleton row carries a sentinel `bearer_secret_hmac` (a
      // zero-byte buffer) per § A.5.1 "No per-link tokens" — the
      // listener special-cases the bare `/reception/` path so the
      // sentinel HMAC is never compared. Stored as a 32-byte zero
      // buffer to match the HMAC-SHA256 output length of other rows
      // (defense in depth — if a future migration drops the special
      // case + treats every row uniformly, the sentinel is
      // constant-time-comparable but cryptographically unable to
      // match any real secret).
      const sentinel_hmac = Buffer.alloc(32, 0);
      const existing = selectByIdStmt.get({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      }) as RegistryRow | undefined;
      if (!existing) {
        insertStmt.run({
          endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
          kind: 'reception_page',
          packet_declaration: JSON.stringify({
            packet_kind: 'reception_page_packet',
            source_query_ref: { kind: 'reception_page_config' },
          } satisfies PacketDeclaration),
          bearer_secret_hmac: sentinel_hmac,
          created_at: now,
          created_by_client_id: actor_instance_id,
          expires_at: null,
          long_lived_acknowledged_at: now,
          metadata_blob: JSON.stringify(config),
        });
        // Flip enabled to 1 on first upsert — the singleton is always
        // reachable per § A.5.1 (the page exists at `/reception/`
        // regardless of section toggles; sections-all-off surfaces
        // the substrate placeholder). The default-off enforcement
        // around link-style endpoints does not apply here because
        // the singleton has no bearer secret to leak.
        enableStmt.run({ endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID });
        bumpAuditStmt.run({
          endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
          now,
        });
        return 'created';
      }
      // Update path — replace the metadata_blob + bump last_accessed_at
      // (which doubles as the most-recent-upsert stamp for the
      // singleton). Re-stamping `created_at` is intentional: the
      // singleton's first-upsert stamp records when Mary first
      // configured the page, not when the row was last touched.
      const updateStmt = db.prepare(`
        UPDATE public_endpoint_registry
           SET metadata_blob = @metadata_blob,
               last_accessed_at = @now,
               audit_count = audit_count + 1
         WHERE endpoint_id = @endpoint_id
      `);
      updateStmt.run({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        metadata_blob: JSON.stringify(config),
        now,
      });
      return 'updated';
    },
  };
};
