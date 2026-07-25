/** D-118 Phase 8 — service stack boot composer.
 *
 *  Wraps `composeServiceStack` from the service-collection package with
 *  the bin.ts-level dep wiring: per-publisher vault resolver, runtime-
 *  config snapshot, optional audit log, and the `[service-stack]` logger.
 *
 *  Gated on `db` — dbless harnesses return `undefined` so downstream
 *  consumers (`registerCalendarCollections`-equivalent doesn't apply
 *  here; instead `serviceStack.enrollDeps` / `startAll` / `disposeAll`
 *  are read by name and skip cleanly). */

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import type { ManifestRegistry } from '../../manifest-loader.js';
import {
  composeServiceStack,
  type ServiceStack,
  type ServiceStackRuntimeConfig,
} from '../../collections/service/compose.js';

export interface ComposeServiceStackBootDeps {
  /** SQLite handle. Undefined → composer returns `undefined`. */
  db: Database.Database | undefined;
  /** Absolute path used as the supervisor CWD base. In bin.ts this is
   *  `dirname(dbPath)` — quota tracker + supervisor CWDs resolve under
   *  `<dataPath>/services/<slug>/`. */
  dataPath: string;
  /** Live manifest registry. Service templates parsed at compose time;
   *  re-composition is needed to pick up new templates. */
  manifests: ManifestRegistry;
  /** Pre-resolved runtime config snapshot. Caller reads the four
   *  `collection.service.*` keys from its own runtime-config source and
   *  hands the resolved shape in. */
  runtime: ServiceStackRuntimeConfig;
  /** Vault-keyed env resolver source. The composer wraps a publisher-
   *  scoped `(publisher_id, key) => baseVault['<publisher_id>.<key>']`
   *  closure (D-003). Missing or non-string entries return `undefined`
   *  so the binary's own "credential missing" error surfaces. */
  baseVault: Record<string, unknown>;
  /** Optional audit log — service emitter writes one ActivityEntry per
   *  ServiceAuditEvent when present, falls back to a console log when
   *  absent. */
  auditLog?: AuditLogStore;
}

export const composeServiceBoot = (
  deps: ComposeServiceStackBootDeps,
): ServiceStack | undefined => {
  const { db, dataPath, manifests, runtime, baseVault, auditLog } = deps;

  if (!db) return undefined;

  return composeServiceStack(db, {
    dataPath,
    manifests,
    runtime,
    resolveVault: (publisher_id, key) => {
      // Publisher-scoped vault read — baseVault is keyed by
      // `<publisher_id>.<key>` per D-003.
      const composite = `${publisher_id}.${key}`;
      const v = baseVault[composite];
      return typeof v === 'string' ? v : undefined;
    },
    ...(auditLog ? { auditLog } : {}),
    log: (level, msg, data) => {
      const fn = level === 'error' ? console.error : console.log;
      fn(`[service-stack] ${msg}`, data ?? '');
    },
  });
};
