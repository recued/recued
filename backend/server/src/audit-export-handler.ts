/** D-120 Phase 7 — server-side handler for the unified memory export.
 *
 *  Wires the ext-facing rpc pair `audit.export.estimate` + `audit.export.page`
 *  to the storage-agnostic helpers in `@recued/storage/audit-export`. The
 *  handler owns just three things:
 *
 *    1. Build the `AuditExportSource` adapter that talks to the server's
 *       SQLite-backed audit log + `links` + `recipe_insights` tables.
 *    2. Compose with the identity (server scope, pair instance id).
 *    3. Audit-log the export so compliance has a forensic trail of who
 *       exported what window. Reuses the existing `audit_export` action
 *       (already in `RESERVE_ACTIONS`) so the entry survives retention.
 *
 *  This pair is the whole `audit.*` rpc surface — D-157 P0 deleted the
 *  legacy `audit.*` read-rpc family (including the old write-to-disk
 *  `audit.export` compliance dump).
 *
 *  Spec: D-120 (Phase 7 — Memory rename + unified export).
 */

import type Database from 'better-sqlite3';
import {
  RpcError,
  type AuditExportEstimate,
  type AuditExportPage,
  type AuditExportRequest,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import {
  estimateExport,
  exportPage,
  type AuditExportInsightRow,
  type AuditExportLinkRow,
  type AuditExportSource,
} from '@recued/storage';
import type { AuditEntry, AuditLogStore } from '@recued/storage';
import type { WsClient } from './ws-server.js';

export interface AuditExportRpcDeps {
  /** SQLite handle for the joins onto `links` + `recipe_insights`.
   *  When undefined the handler returns an empty estimate / page —
   *  consistent with the rest of the audit handlers' deps-optional
   *  pattern. */
  db: Database.Database | undefined;
  /** Existing audit log store. Reused for the entry list so we share
   *  the in-flight cache + pruner integration. */
  auditLog: AuditLogStore | undefined;
  /** Pair-instance id surfaced into the envelope. The extension
   *  resolves this via `pair.list`; the server reads it from
   *  identity-store at boot. */
  serverInstanceId: string;
  /** Override for tests. */
  now?: () => number;
}

/** Build the storage-agnostic source adapter from server-side deps.
 *  Exposed for tests so they can drive the helper without standing up
 *  a full WS dispatch path. */
export const makeServerExportSource = (
  deps: AuditExportRpcDeps,
): AuditExportSource => {
  const { db, auditLog } = deps;
  return {
    async fetchEntries(opts) {
      if (!auditLog) return [];
      // Pull a wider page than the cap to absorb post-filter shrink
      // (recipe_id / since / until).
      const rough = await (opts.recipe_id
        ? auditLog.listByRecipe(opts.recipe_id, Math.max(opts.page_size * 4, 500))
        : auditLog.listRecent(Math.max(opts.page_size * 4, 500)));
      const ordered = [...rough].sort((a, b) =>
        (b.started_at - a.started_at) || b.run_id.localeCompare(a.run_id),
      );
      const filtered: AuditEntry[] = [];
      for (const entry of ordered) {
        if (opts.since !== undefined && entry.started_at < opts.since) continue;
        if (opts.until !== undefined && entry.started_at > opts.until) continue;
        if (opts.cursor) {
          // Strict descending order — drop entries at or after the cursor's
          // boundary. Equal-ts uses run_id lexical order as the tiebreaker.
          if (entry.started_at > opts.cursor.last_started_at) continue;
          if (
            entry.started_at === opts.cursor.last_started_at
            && entry.run_id >= opts.cursor.last_run_id
          ) {
            continue;
          }
        }
        filtered.push(entry);
        if (filtered.length === opts.page_size) break;
      }
      return filtered;
    },

    async fetchLinks(runIds) {
      if (!db || runIds.length === 0) return [];
      const placeholders = runIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT memory_id, entity_id, kind, ts FROM links
             WHERE memory_id IN (${placeholders})
             ORDER BY ts DESC`,
        )
        .all(...runIds) as Array<{
          memory_id: string;
          entity_id: string;
          kind: string;
          ts: number;
        }>;
      return rows.map<AuditExportLinkRow>((r) => ({
        memory_id: r.memory_id,
        entity_id: r.entity_id,
        kind: r.kind,
        ts: r.ts,
      }));
    },

    async fetchInsights(hashes) {
      if (!db || hashes.length === 0) return [];
      const placeholders = hashes.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT hash, slug, version, flattened
             FROM recipe_insights
             WHERE hash IN (${placeholders})`,
        )
        .all(...hashes) as Array<{
          hash: string;
          slug: string;
          version: number;
          flattened: string;
        }>;
      return rows.map<AuditExportInsightRow>((r) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.flattened);
        } catch {
          parsed = null;
        }
        return {
          hash: r.hash,
          slug: r.slug,
          version: r.version,
          flattened: parsed,
        };
      });
    },

    async count(opts) {
      if (!auditLog) return 0;
      // COUNT(*)-style: scan the full log + apply filters in process.
      // For very large logs (> ~50k) this should move to a SQL COUNT
      // that talks to `audit_entries` directly; the contract's ±10%
      // estimate budget covers the in-process approximation here.
      const all = await auditLog.exportAll();
      let total = 0;
      for (const entry of all) {
        if (opts.recipe_id !== undefined && entry.recipe_id !== opts.recipe_id) {
          continue;
        }
        if (opts.since !== undefined && entry.started_at < opts.since) continue;
        if (opts.until !== undefined && entry.started_at > opts.until) continue;
        total += 1;
      }
      return total;
    },
  };
};

const validateRequest = (raw: unknown): AuditExportRequest => {
  if (raw === null || typeof raw !== 'object') {
    throw new RpcError('bad_request', 'audit.export args must be an object', 400);
  }
  const args = raw as Record<string, unknown>;
  const out: AuditExportRequest = {};
  if (args.since !== undefined) {
    if (typeof args.since !== 'number' || !Number.isFinite(args.since)) {
      throw new RpcError('bad_request', 'since must be a finite number', 400);
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (typeof args.until !== 'number' || !Number.isFinite(args.until)) {
      throw new RpcError('bad_request', 'until must be a finite number', 400);
    }
    out.until = args.until;
  }
  if (out.since !== undefined && out.until !== undefined && out.since > out.until) {
    throw new RpcError('bad_request', 'since must be <= until', 400);
  }
  if (args.recipe_id !== undefined) {
    if (typeof args.recipe_id !== 'string' || args.recipe_id.length === 0) {
      throw new RpcError('bad_request', 'recipe_id must be a non-empty string', 400);
    }
    out.recipe_id = args.recipe_id;
  }
  if (args.format !== undefined) {
    if (args.format !== 'json' && args.format !== 'jsonl' && args.format !== 'csv') {
      throw new RpcError('bad_request', "format must be one of 'json' | 'jsonl' | 'csv'", 400);
    }
    out.format = args.format;
  }
  if (args.page_size !== undefined) {
    if (typeof args.page_size !== 'number' || !Number.isFinite(args.page_size)) {
      throw new RpcError('bad_request', 'page_size must be a finite number', 400);
    }
    out.page_size = args.page_size;
  }
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string') {
      throw new RpcError('bad_request', 'cursor must be a string', 400);
    }
    out.cursor = args.cursor;
  }
  return out;
};

export const handleAuditExportEstimate = async (
  deps: AuditExportRpcDeps,
  args: unknown,
): Promise<AuditExportEstimate> => {
  const request = validateRequest(args);
  const source = makeServerExportSource(deps);
  return estimateExport(source, request);
};

export const handleAuditExportPage = async (
  deps: AuditExportRpcDeps,
  args: unknown,
): Promise<AuditExportPage> => {
  const request = validateRequest(args);
  const source = makeServerExportSource(deps);
  const page = await exportPage(source, {
    instance_id: deps.serverInstanceId,
    scope: 'server',
    ...(deps.now ? { now: deps.now } : {}),
  }, request);

  // Audit-log only on the FIRST page (where the envelope lands) so a
  // multi-page export creates one ledger entry, not one per page. The
  // `audit_export` action is already reserve-class so the entry survives
  // retention pruning.
  if (page.envelope && deps.auditLog) {
    const detail =
      `format=${request.format ?? 'json'}`
      + (request.recipe_id ? ` recipe_id=${request.recipe_id}` : '')
      + ` count=${page.entries_in_page}`;
    await deps.auditLog
      .logActivity({
        activity_id: '',
        timestamp: (deps.now ?? Date.now)(),
        action: 'audit_export',
        target: 'unified-export',
        detail,
      })
      .catch(() => { /* best-effort */ });
  }

  return page;
};

export type AuditExportMethods = 'audit.export.estimate' | 'audit.export.page';

export const makeAuditExportHandlers = (
  deps: AuditExportRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, AuditExportMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['audit.export.estimate', 'audit.export.page'],
    handlers: {
      'audit.export.estimate': async (args) =>
        handleAuditExportEstimate(deps, args),
      'audit.export.page': async (args) =>
        handleAuditExportPage(deps, args),
    },
  };
};
