/** Boot-time secure-context guard tests.
 *
 *  `boot/secure-context-guard.ts` decides whether the webclient can boot:
 *  Web Crypto (`crypto.subtle`) needs a SECURE CONTEXT (https, or http on a
 *  loopback origin). On a plain-http LAN address it is unavailable, so the
 *  entry aborts boot with an actionable splash message instead of crashing on
 *  the first `crypto.subtle` call. Companion to the server's bare-`/` →
 *  `/webclient/` LAN redirect (that makes the localhost path work; a LAN-IP-
 *  over-http load still needs HTTPS — this is where the user learns that).
 *
 *  Pure-function scope + a source-order ratchet over the real production entry
 *  (the rendered card itself has unit + browser coverage). The ratchet keeps
 *  the guard and guided handoff ahead of service-worker, storage, and crypto
 *  startup rather than exercising the retired static-splash composition. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSECURE_CONTEXT_SPLASH_MESSAGE,
  WEBCRYPTO_MISSING_SPLASH_MESSAGE,
  readSecureContextEnv,
  resolveInsecureContextMessage,
  resolveSecureContextIssue,
  type SecureContextEnv,
} from '../boot/secure-context-guard.js';

const WEBCLIENT_MAIN_PATH = resolve(__dirname, '../webclient-main.ts');

describe('resolveInsecureContextMessage', () => {
  it('secure context + Web Crypto present → null (boot proceeds)', () => {
    const env: SecureContextEnv = { isSecureContext: true, hasSubtleCrypto: true };
    expect(resolveInsecureContextMessage(env)).toBeNull();
  });

  it('insecure context → the insecure-context message (the LAN-IP-over-http case)', () => {
    const env: SecureContextEnv = { isSecureContext: false, hasSubtleCrypto: false };
    expect(resolveInsecureContextMessage(env)).toBe(INSECURE_CONTEXT_SPLASH_MESSAGE);
  });

  it('insecure wins even if crypto.subtle somehow reports present (fixing the context is the actionable step)', () => {
    const env: SecureContextEnv = { isSecureContext: false, hasSubtleCrypto: true };
    expect(resolveInsecureContextMessage(env)).toBe(INSECURE_CONTEXT_SPLASH_MESSAGE);
  });

  it('secure context but no crypto.subtle → the Web-Crypto-missing message (ancient browser)', () => {
    const env: SecureContextEnv = { isSecureContext: true, hasSubtleCrypto: false };
    expect(resolveInsecureContextMessage(env)).toBe(WEBCRYPTO_MISSING_SPLASH_MESSAGE);
  });

  it('the two messages are distinct', () => {
    expect(INSECURE_CONTEXT_SPLASH_MESSAGE).not.toBe(WEBCRYPTO_MISSING_SPLASH_MESSAGE);
  });

  it('returns a typed reason so the boot handoff does not parse display copy', () => {
    expect(resolveSecureContextIssue({
      isSecureContext: false,
      hasSubtleCrypto: false,
    })).toEqual({
      kind: 'insecure_context',
      message: INSECURE_CONTEXT_SPLASH_MESSAGE,
    });
    expect(resolveSecureContextIssue({
      isSecureContext: true,
      hasSubtleCrypto: false,
    })).toEqual({
      kind: 'webcrypto_missing',
      message: WEBCRYPTO_MISSING_SPLASH_MESSAGE,
    });
  });
});

describe('readSecureContextEnv', () => {
  it('reflects globalThis.isSecureContext === true', () => {
    const g = globalThis as { isSecureContext?: boolean };
    const original = g.isSecureContext;
    try {
      g.isSecureContext = true;
      expect(readSecureContextEnv().isSecureContext).toBe(true);
    } finally {
      if (original === undefined) delete g.isSecureContext;
      else g.isSecureContext = original;
    }
  });

  it('treats an absent isSecureContext global as insecure (only explicit true counts)', () => {
    const g = globalThis as { isSecureContext?: boolean };
    const original = g.isSecureContext;
    try {
      delete g.isSecureContext;
      expect(readSecureContextEnv().isSecureContext).toBe(false);
    } finally {
      if (original !== undefined) g.isSecureContext = original;
    }
  });

  it('reports crypto.subtle present in the test runtime (Node WebCrypto)', () => {
    // Node 20+ exposes globalThis.crypto.subtle — sanity that the reader sees
    // it (the absent branch is covered by resolveInsecureContextMessage above).
    expect(readSecureContextEnv().hasSubtleCrypto).toBe(true);
  });
});

describe('production entry secure-access wiring', () => {
  it('consumes reload intent before guards and leaves sibling-completed startup silent', () => {
    const source = readFileSync(WEBCLIENT_MAIN_PATH, 'utf8');
    const mainIndex = source.indexOf('const main = async (): Promise<void> => {');
    const consumeIndex = source.indexOf(
      'consumeStartupReloadRecovery();',
      mainIndex,
    );
    const guardIndex = source.indexOf(
      'const secureContextIssue = resolveSecureContextIssue(',
      mainIndex,
    );
    const credentialRecoveryIndex = source.indexOf(
      'credentialHealth = await recoverStartupTaskWithTriage({',
      guardIndex,
    );
    const recoveryReloadIndex = source.indexOf(
      'onReload: () => requestStartupRecoveryReload(),',
      credentialRecoveryIndex,
    );
    const repeatedIndex = source.indexOf(
      'repeated: startupReloadRecoveryRequested,',
      credentialRecoveryIndex,
    );
    const reloadAttemptedIndex = source.indexOf(
      'reloadAttempted: startupReloadRecoveryRequested,',
      repeatedIndex,
    );
    const depsIndex = source.indexOf(
      'const bootstrapDeps: PairFallbackBootstrapDeps = {',
      reloadAttemptedIndex,
    );
    const silentConvergenceIndex = source.indexOf(
      'silentCredentialConvergence: true',
      depsIndex,
    );
    const siblingReceiptGuardIndex = source.indexOf(
      'credentialHealth.pairCompletedInAnotherTab !== true',
      silentConvergenceIndex,
    );
    const queueIndex = source.indexOf(
      "queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');",
      siblingReceiptGuardIndex,
    );
    const bootstrapIndex = source.indexOf(
      'runBootstrapWithPairFallback(bootstrapDeps)',
      queueIndex,
    );

    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(consumeIndex).toBeGreaterThan(mainIndex);
    expect(guardIndex).toBeGreaterThan(consumeIndex);
    expect(credentialRecoveryIndex).toBeGreaterThan(guardIndex);
    expect(recoveryReloadIndex).toBeGreaterThan(credentialRecoveryIndex);
    expect(repeatedIndex).toBeGreaterThan(credentialRecoveryIndex);
    expect(reloadAttemptedIndex).toBeGreaterThan(repeatedIndex);
    expect(depsIndex).toBeGreaterThan(reloadAttemptedIndex);
    expect(silentConvergenceIndex).toBeGreaterThan(depsIndex);
    expect(siblingReceiptGuardIndex).toBeGreaterThan(
      silentConvergenceIndex,
    );
    expect(queueIndex).toBeGreaterThan(siblingReceiptGuardIndex);
    expect(bootstrapIndex).toBeGreaterThan(queueIndex);
  });

  it('mounts the guided handoff and returns before service-worker or storage startup', () => {
    const source = readFileSync(WEBCLIENT_MAIN_PATH, 'utf8');
    const guardIndex = source.indexOf(
      'const secureContextIssue = resolveSecureContextIssue(',
    );
    const handoffIndex = source.indexOf(
      'mountSecureAccessHandoff({',
      guardIndex,
    );
    const returnIndex = source.indexOf('\n    return;', handoffIndex);
    const serviceWorkerIndex = source.indexOf(
      'void registerServiceWorker()',
      handoffIndex,
    );
    const storageIndex = source.indexOf(
      'openPersistentStorageWithRecovery({',
      handoffIndex,
    );

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(handoffIndex).toBeGreaterThan(guardIndex);
    expect(returnIndex).toBeGreaterThan(handoffIndex);
    expect(serviceWorkerIndex).toBeGreaterThan(returnIndex);
    expect(storageIndex).toBeGreaterThan(serviceWorkerIndex);
    expect(source.slice(handoffIndex, returnIndex)).toContain(
      'setSplashMessage(secureContextIssue.message)',
    );
  });

  it('threads explicit reload continuity through persistent-storage startup', () => {
    const source = readFileSync(WEBCLIENT_MAIN_PATH, 'utf8');
    const storageIndex = source.indexOf(
      'db = await openPersistentStorageWithRecovery({',
    );
    const reloadContextIndex = source.indexOf(
      'reloadAttempted: startupReloadRecoveryRequested,',
      storageIndex,
    );
    const markedReloadIndex = source.indexOf(
      'reload: () => requestStartupRecoveryReload(),',
      reloadContextIndex,
    );
    const storageFailureIndex = source.indexOf(
      'onFailure: (error, kind) => {',
      markedReloadIndex,
    );

    expect(storageIndex).toBeGreaterThanOrEqual(0);
    expect(reloadContextIndex).toBeGreaterThan(storageIndex);
    expect(markedReloadIndex).toBeGreaterThan(reloadContextIndex);
    expect(storageFailureIndex).toBeGreaterThan(markedReloadIndex);
  });

  it('threads explicit reload continuity through cold credential repair', () => {
    const source = readFileSync(WEBCLIENT_MAIN_PATH, 'utf8');
    const repairIndex = source.indexOf(
      'startColdStartCredentialRepair({',
    );
    const reloadContextIndex = source.indexOf(
      'reloadAttempted: startupReloadRecoveryRequested,',
      repairIndex,
    );
    const markedReloadIndex = source.indexOf(
      'reload: () => requestStartupRecoveryReload(),',
      reloadContextIndex,
    );
    const repairReturnIndex = source.indexOf('\n    return;', repairIndex);

    expect(repairIndex).toBeGreaterThanOrEqual(0);
    expect(reloadContextIndex).toBeGreaterThan(repairIndex);
    expect(markedReloadIndex).toBeGreaterThan(reloadContextIndex);
    expect(repairReturnIndex).toBeGreaterThan(markedReloadIndex);
  });

  it('resumes pairing from the live destination URL, not a query URL', () => {
    const source = readFileSync(WEBCLIENT_MAIN_PATH, 'utf8');
    expect(source).toContain(
      'const pairEntry = parsePairEntryHandoff(',
    );
    expect(source).toContain("globalThis.location?.href ?? ''");
    expect(source.match(/pairEntry\.active/g)).toHaveLength(2);
    expect(source).not.toContain("parsePairDeeplink(globalThis.location");
  });
});
