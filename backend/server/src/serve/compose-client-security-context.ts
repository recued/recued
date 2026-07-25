import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import type { CertStack } from '../composition/bin/wire-cert-stack.js';
import { composeCertStack } from '../composition/bin/wire-cert-stack.js';
import { composePassportFetchSubstrate } from '../composition/bin/wire-passport-fetch-substrate.js';
import type { ExposureStateMachine } from '../exposure/index.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { EventBus } from '../events/bus.js';
import type { PairedInstancesStore } from '../paired-instances-store.js';
import {
  createClientTokenStore,
  type ClientTokenStore,
} from '../pairing/client-tokens.js';
import {
  createTokenRotationEmitter,
  type TokenRotationEmitter,
} from '../pairing/token-rotation-emitter.js';
import type { PassportFetchRpcDeps } from '../passport/fetch-handler.js';
import type { PassportUserRpcDeps } from '../passport/export-handler.js';
import type { WsServerHandle } from '../ws-server.js';

export interface ClientSecurityContext {
  readonly clientTokens: ClientTokenStore | undefined;
  readonly tokenRotationEmitter: TokenRotationEmitter | undefined;
  readonly certStack: CertStack;
  readonly rotationEngine: CertStack['rotationEngine'];
  /** R26.4 Delta 3 — `key.rotate` + `key.health` rpc deps. Undefined
   *  whenever `rotationEngine` is. */
  readonly keyRotateDeps: CertStack['keyRotateDeps'];
  readonly proAuthStateMachineRef: CertStack['proAuthStateMachineRef'];
  readonly passportFetchDeps: PassportFetchRpcDeps | undefined;
  /** R26.4 Delta 2 — `passport.export` + `passport.history.list` deps
   *  (the user-initiated half). Undefined when the audit log is absent. */
  readonly passportUserRpcDeps: PassportUserRpcDeps | undefined;
}

export interface ComposeClientSecurityContextOptions {
  readonly db: Database.Database | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly signingIdentity: BootedServerIdentity | undefined;
  readonly eventBus: EventBus;
  readonly cloudBaseUrl: string;
  readonly pairedInstances: PairedInstancesStore | undefined;
  readonly getWsHandleForLockout: () => WsServerHandle | undefined;
  /** Late-bound accessor for the `ExposureStateMachine`, threaded into the
   *  passport fetch substrate so `loadNetwork` attests the real exposure
   *  posture. Optional — when absent, `loadNetwork` falls back to the
   *  conservative `DEFAULT_EXPOSURE_STATE`. */
  readonly getExposureMachine?: () => ExposureStateMachine | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export const composeClientSecurityContext = async (
  options: ComposeClientSecurityContextOptions,
): Promise<ClientSecurityContext> => {
  const {
    db,
    auditLog,
    signingIdentity,
    eventBus,
    cloudBaseUrl,
    pairedInstances,
    getWsHandleForLockout,
    getExposureMachine,
    env,
  } = options;

  // The notification block's Bridge readiness probe consults its own
  // ClientTokenStore handle composed in `composeAppContext` (D-163
  // Slice B); both handles wrap the same SQLite `client_tokens` table
  // and the store is stateless (every method is a SQL query with no
  // in-process cache), so two handles over the same `db` are
  // functionally equivalent. Keeping construction here untouched
  // preserves the cert-stack + rotation-emitter wiring contract that
  // already lives downstream of this composer.
  const clientTokens = db ? createClientTokenStore(db) : undefined;
  const tokenRotationEmitter = clientTokens
    ? createTokenRotationEmitter({ clientTokens, bus: eventBus })
    : undefined;

  const certStack = await composeCertStack({
    db,
    auditLog,
    signingIdentity,
    eventBus,
    cloudBaseUrl,
    pairedInstances,
    clientTokens,
    closeAllActiveSessions: () =>
      getWsHandleForLockout()?.revokeAllConnectedInstances() ?? 0,
    ...(env ? { env } : {}),
  });

  const passportFetchBundle = composePassportFetchSubstrate({
    db,
    signingIdentity,
    certStack,
    auditLog,
    getExposureMachine,
    pairedInstances,
  });

  return {
    clientTokens,
    tokenRotationEmitter,
    certStack,
    rotationEngine: certStack.rotationEngine,
    keyRotateDeps: certStack.keyRotateDeps,
    proAuthStateMachineRef: certStack.proAuthStateMachineRef,
    passportFetchDeps: passportFetchBundle?.passportFetchDeps,
    passportUserRpcDeps: passportFetchBundle?.passportUserRpcDeps,
  };
};
