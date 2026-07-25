/** D-148 W3.FU + follow-up #4 — exposure + TLS-domain rpc-deps composer.
 *
 *  Builds two adjacent rpc-deps bundles consumed by the
 *  `createServerHandlerSet` composition:
 *    - `exposureRpcDeps` — `getMachine()` thunk + the W3.FU P1
 *      `closeWsClientsForLockout(reason)` fold for the `/ws`-off
 *      lockout drain.
 *    - `tlsDomainRpcDeps` + `tlsDomainStore` — the `SqliteTlsDomainStore`
 *      backing `tls_domain.{upload,remove,list}`; ciphertext column is
 *      AEAD-encrypted under the `tls_domains` sub-DEK when the key
 *      manager is initialised.
 *
 *  Both surfaces need to be visible by the time `composeServerHandlerSet`
 *  runs, but the `ExposureStateMachine` itself is built downstream
 *  (it needs `serverHandlerSet.wsHandle.clientCount()`), and the WS
 *  handle is built later still. So the helper takes both refs as
 *  late-bound getters — caller keeps the existing `let exposureMachineRef`
 *  + `let wsHandleForLockoutRef` bindings and assigns them downstream;
 *  the helper's closures resolve at rpc-call time, which can only fire
 *  after boot completes.
 *
 *  Pre-extraction `getMachine` throws fail-loud when the ref is unset
 *  — that's a boot-order invariant violation, not a race, since rpc
 *  dispatch can only begin after the WS upgrade is bound (which
 *  happens after `exposureMachine.reapply()` runs). The helper
 *  preserves the exact error text.
 *
 *  Gate matrix:
 *   - `db` absent → no `tlsDomainStore`, no `tlsDomainRpcDeps`.
 *     `exposureRpcDeps` still builds (the exposure state machine
 *     itself is db-less; this slice just wires the rpc thunks).
 *   - `keys` absent OR uninitialised → store builds without a
 *     `getKey` provider, falling back to the plaintext column path.
 *
 *  Note on `warmCache()`: the W3.6 store's per-handshake `lookup` path
 *  consults the in-RAM cache populated post-unlock. The SNI dispatch
 *  integration is out of scope here — `tls_domain.{upload}` populates
 *  the cache inline; `list` / `remove` operate on the plaintext columns
 *  + cache entry. A follow-up slice promotes the SNI path. */

import type Database from 'better-sqlite3';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  type SqliteTlsDomainStore,
} from '../../tls/domain-store.js';
import {
  createNodeTlsMetadataReader,
  createNodeTlsVerifiers,
} from '../../tls/cert-verifiers.js';
import type { RuntimeConfigStore } from '@recued/config';
import type { RootApexMode } from '@recued/contracts';
import type { KeyManager } from '../../key-manager.js';
import type { ExposureRpcDeps } from '../../exposure-handler.js';
import type { TlsDomainRpcDeps } from '../../tls-domain-handler.js';
import type { ExposureStateMachine } from '../../exposure/index.js';
import type { WsServerHandle } from '../../ws-server.js';

export interface ComposeExposureAndTlsRpcDepsDeps {
  readonly db: Database.Database | undefined;
  readonly keys: KeyManager | undefined;
  /** Late-bound accessor for the exposure state machine. The caller
   *  keeps the `let` binding it threads downstream into
   *  `composeServerHandlerSet` + `exposureMachine.reapply()`; the
   *  helper's closure reads through on every rpc dispatch. Throws
   *  fail-loud at dispatch time if the ref is still undefined — that's
   *  a boot-order invariant violation, never a race. */
  readonly getExposureMachine: () => ExposureStateMachine | undefined;
  /** Late-bound accessor for the WS handle the `/ws` lockout drain
   *  reaches into. The caller keeps the `let` binding it assigns
   *  after `serverHandlerSet.wsHandle` materialises. Returns 0 when
   *  the ref is still undefined (which can only happen pre-boot, and
   *  no rpc can dispatch in that window). */
  readonly getWsHandleForLockout: () => WsServerHandle | undefined;
  /** R26.2 Delta 2 — the runtime-config store backing the apex
   *  (`GET /`) serving mode (`network.apex_mode`). When present, the
   *  exposure deps expose an `apex` get/set wrapping it; absent (db-less /
   *  no-config-file harness) → the `exposure.set_apex` rpc surfaces
   *  `not_configured` + `exposure.get` falls back to `redirect`. */
  readonly runtimeConfig?: RuntimeConfigStore;
  /** R26.2 Delta 3 — boot-time result of the verified-bundle servability
   *  probe (`isVerifiedWebclientBundlePresent`). Surfaced to the apex dep as
   *  `isWebclientBundlePresent` so the `exposure.set_apex` setter rejects
   *  `serve_webclient` when no bundle is deployed (matching the live root
   *  handler, which 404s the apex without a bundle). Absent → treated as
   *  false. */
  readonly webclientBundlePresent?: boolean;
}

export interface ExposureAndTlsRpcDepsBundle {
  readonly exposureRpcDeps: ExposureRpcDeps;
  readonly tlsDomainStore: SqliteTlsDomainStore | undefined;
  readonly tlsDomainRpcDeps: TlsDomainRpcDeps | undefined;
}

export const composeExposureAndTlsRpcDeps = (
  deps: ComposeExposureAndTlsRpcDepsDeps,
): ExposureAndTlsRpcDepsBundle => {
  const exposureRpcDeps: ExposureRpcDeps = {
    getMachine: () => {
      const machine = deps.getExposureMachine();
      if (!machine) {
        throw new Error(
          'exposure rpc dispatched before ExposureStateMachine was wired — boot-order invariant violated',
        );
      }
      return machine;
    },
    closeWsClientsForLockout: (reason: string) => {
      return deps.getWsHandleForLockout()?.closeAllForWsLockout(reason) ?? 0;
    },
    // R26.2 Delta 2/3 — apex get/set over the runtime-config field. The root
    // handler reads the same `network.apex_mode` field per request, so a set
    // here is hot. The `serve_webclient` consistency gate reads
    // `resolution.webclient.public` from the exposure machine directly in the
    // setter (R26.2 Delta 3 — webclient is a grid path role), so no extra dep
    // is threaded here.
    ...(deps.runtimeConfig
      ? {
          apex: {
            get: (): RootApexMode =>
              deps.runtimeConfig!.get('network.apex_mode') as RootApexMode,
            set: (mode: RootApexMode): void => {
              deps.runtimeConfig!.set('network.apex_mode', mode);
            },
            isWebclientBundlePresent: (): boolean =>
              deps.webclientBundlePresent === true,
          },
        }
      : {}),
  };

  let tlsDomainStore: SqliteTlsDomainStore | undefined;
  if (deps.db) {
    ensureTlsDomainSchema(deps.db);
    const getKey = deps.keys ? deps.keys.keyProvider('tls_domains') : undefined;
    tlsDomainStore = createSqliteTlsDomainStore({
      db: deps.db,
      verifiers: createNodeTlsVerifiers(),
      metadataReader: createNodeTlsMetadataReader(),
      ...(getKey ? { getKey } : {}),
    });
  }

  const tlsDomainRpcDeps: TlsDomainRpcDeps | undefined = tlsDomainStore
    ? {
        getStore: () => {
          // Captured-store closure — `tlsDomainStore` is fully built
          // by the time this lambda fires (rpc dispatch can only run
          // after the WS upgrade is bound, which happens downstream).
          // The non-null assertion is safe; the conditional above
          // ensures we never construct deps without a backing store.
          return tlsDomainStore!;
        },
      }
    : undefined;

  return { exposureRpcDeps, tlsDomainStore, tlsDomainRpcDeps };
};
