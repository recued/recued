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
 *  Pure-function scope + a wiring test that drives the resolver →
 *  `setSplashMessage` composition against a fake splash document (the
 *  `readSecureContextEnv` global reads are covered in their own block), so the
 *  user-visible outcome is verified without a browser. */

import { describe, expect, it } from 'vitest';
import {
  INSECURE_CONTEXT_SPLASH_MESSAGE,
  WEBCRYPTO_MISSING_SPLASH_MESSAGE,
  readSecureContextEnv,
  resolveInsecureContextMessage,
  type SecureContextEnv,
} from '../boot/secure-context-guard.js';
import { setSplashMessage } from '../boot/pair-fallback-bootstrap.js';

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

describe('wiring — insecure context upgrades the boot splash (the user-visible outcome)', () => {
  // Fake splash document mirroring the boot HTML's
  // `#webclient-boot-splash-message` element (webclient tests run in node with
  // hand-built document seams — no jsdom global).
  const makeSplashDoc = (): { doc: Document; read: () => string } => {
    let text = '';
    const messageEl = {
      get textContent(): string {
        return text;
      },
      set textContent(v: string) {
        text = v;
      },
    };
    const doc = {
      getElementById: (id: string): unknown =>
        id === 'webclient-boot-splash-message' ? messageEl : null,
    } as unknown as Document;
    return { doc, read: () => text };
  };

  it('drives resolver → setSplashMessage → DOM: the splash shows the insecure-context copy', () => {
    const { doc, read } = makeSplashDoc();
    const message = resolveInsecureContextMessage({
      isSecureContext: false,
      hasSubtleCrypto: false,
    });
    expect(message).toBe(INSECURE_CONTEXT_SPLASH_MESSAGE);
    setSplashMessage(message ?? '', doc);
    expect(read()).toBe(INSECURE_CONTEXT_SPLASH_MESSAGE);
  });

  it('a healthy environment resolves to null, so the entry never overwrites the splash', () => {
    const { doc, read } = makeSplashDoc();
    read(); // baseline: empty
    const message = resolveInsecureContextMessage({
      isSecureContext: true,
      hasSubtleCrypto: true,
    });
    expect(message).toBeNull();
    // The entry guards on a non-null message before calling setSplashMessage,
    // so a healthy boot leaves the splash untouched (loading copy stays).
    if (message) setSplashMessage(message, doc);
    expect(read()).toBe('');
  });
});
