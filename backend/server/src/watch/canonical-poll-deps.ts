/** Shared `CanonicalPollDeps` builder.
 *
 *  The SAME executor / profiles / subresource-path / audit / contract-scan /
 *  live-merged-vendor-registry the watch-manager's `connectionApiSource` assembles,
 *  built from the composed `executeDeps`. Single source so EVERY canonical poll —
 *  the generic CRM reconciler boot (`composeCanonicalCrmReconciliation`) AND the S3
 *  chat live-escalation leg (`composeChatOrchestrator`) — resolves policy + projection
 *  identically (a live `deal.search` is gated, path-scoped, audited, and projected
 *  EXACTLY like the reconciler's background poll). */

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { connectionBaseUrlFromConfig } from '../connection-base-url.js';
import { createGatewayAuditEmitter } from '../server-executor.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { CanonicalPollDeps } from './canonical-poll.js';

export const buildCanonicalPollDeps = (
  executeDeps: ExecuteHandlerDeps,
  connectionStore: Pick<ConnectionStoreSqlite, 'get'> | undefined,
): CanonicalPollDeps => {
  const auditEmitter = executeDeps.auditLog
    ? createGatewayAuditEmitter(executeDeps.auditLog)
    : undefined;
  return {
    executorConfig: executeDeps.executorConfig,
    profiles: {
      get: (name) => executeDeps.connectionOperationProfiles?.get(name) ?? null,
    },
    ...(connectionStore
      ? {
          getSubresourcePath: (name: string) =>
            connectionStore.get('api', name)?.subresource_path ?? undefined,
          // D-192 H4 — the per-tenant base URL, so a paginating Source op's
          // absolute next-page link resolves same-origin (else the walk
          // truncates at page 1). Mirrors the recipe/raw-op dispatch paths.
          getBaseUrl: (name: string) =>
            connectionBaseUrlFromConfig(connectionStore.get('api', name)?.config_json),
        }
      : {}),
    ...(auditEmitter ? { onGatewayAudit: auditEmitter } : {}),
    ...(executeDeps.contractScan ? { contractScan: executeDeps.contractScan } : {}),
    // `liveVendorRegistry` is the function `recipe-runnability-handler` re-exports, so
    // this matches the registry the reconciler boot previously built inline.
    resolveVendorRegistry: () => liveVendorRegistry(executeDeps.localManifestStore),
  };
};
