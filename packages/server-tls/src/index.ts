/** D-148 § A.6 — path-routed TLS termination + two-listener orchestrator.
 *
 *  Public surface for the path-routing substrate (Amendment 2026-05-11;
 *  W3.5 retires the per-port `createListenerSet` outright per pre-launch
 *  zero-installs policy):
 *
 *    - `PortRequestHandler` / `PortUpgradeHandler` types
 *    - `CertChainHolder` — atomic cert rotation primitive shared by
 *      both listeners; pointer-swap propagates without re-bind
 *    - `createPathRouter` — per-listener path dispatcher
 *    - `createPathListenerSet` — LAN + public listener orchestrator
 *
 *  The actual per-role HTTP handlers live in
 *  `backend/server/src/ports/`; this package is provider-agnostic so
 *  unit tests can compose a fixture handler without pulling the
 *  server runtime. */

export type {
  PortRequestHandler,
  PortUpgradeHandler,
  CertChain,
  ListenerFailureReason,
} from './types.js';

export {
  buildCertChain,
  computeCertFingerprint,
  createCertChainHolder,
  type CertChainHolder,
  type CertRotationListener,
} from './cert-chain.js';

export {
  createPathRouter,
  type PathRouter,
  type PathRouterLegacyAlias,
  type PathRouterListener,
  type PathRouterOptions,
} from './path-router.js';

export {
  createPathListenerSet,
  DEFAULT_LAN_PORT,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_LAN_BIND_ADDRESS,
  DEFAULT_PUBLIC_BIND_ADDRESS,
  selectSniCertChain,
  tlsDomainSourceForHostnameCertSource,
  type PathListenerSet,
  type PathListenerSetOptions,
  type PathListenerStatus,
  type HostnameSniBinding,
  type HostnameSniBindingLookup,
  type SniCertDispatchFailureReason,
  type SniCertDispatchResult,
} from './path-listener-set.js';
