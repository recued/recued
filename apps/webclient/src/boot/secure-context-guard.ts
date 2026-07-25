/** Boot-time secure-context guard for the webclient PWA.
 *
 *  Web Crypto (`crypto.subtle`) is only available in a SECURE CONTEXT —
 *  https, or plain http on a loopback origin (`localhost` / `127.0.0.1` /
 *  `[::1]`). The webclient uses it pervasively (the AES-GCM token store,
 *  the ed25519 server-key verifier, key generation), so on a plain-http
 *  LAN address like `http://192.168.1.42/webclient/` every one of those
 *  calls throws a cryptic `Cannot read properties of undefined (reading
 *  'subtle')` and the user is left staring at a dead splash.
 *
 *  This module is the companion to the server's bare-`/` → `/webclient/`
 *  LAN redirect: that redirect makes the same-machine `http://localhost:<port>/`
 *  path work (loopback is a secure context), but a load from ANOTHER device
 *  over `http://<lan-ip>/` is still insecure and cannot pair. Rather than
 *  crash, the entry (`webclient-main.ts#main`) reads the environment through
 *  `readSecureContextEnv` and, if `resolveInsecureContextMessage` returns a
 *  message, upgrades the boot splash with an actionable explanation and stops
 *  (the DD#2 pattern — init failures upgrade the splash, they do not throw).
 *
 *  Kept PURE + dependency-free (no DOM, no `@recued/*` imports) so it obeys
 *  the webclient role-boundary lint (DD#3) and is unit-testable in plain node
 *  without a browser — the caller injects the environment. */

/** Splash copy for the common case: the page is on a plain-http LAN address
 *  (insecure context), so Web Crypto is unavailable. Names both fixes — open
 *  from `http://localhost` on the server machine, or put HTTPS in front. */
export const INSECURE_CONTEXT_SPLASH_MESSAGE =
  'Recued needs a secure context to run. This page was opened over an insecure ' +
  '(non-HTTPS) connection, so the browser blocks the Web Crypto APIs that ' +
  'pairing needs. Open the webclient from http://localhost on the machine ' +
  'running your server, or set up HTTPS (Recued Pro, or your own certificate / ' +
  'reverse proxy) to reach it from another device.';

/** Splash copy for the rarer case: a secure context whose browser still
 *  lacks `crypto.subtle` (a very old or stripped-down browser). */
export const WEBCRYPTO_MISSING_SPLASH_MESSAGE =
  'Recued needs the Web Crypto API, which this browser does not provide. ' +
  'Please use a current version of Chrome, Firefox, Safari, or Edge.';

export interface SecureContextEnv {
  /** `window.isSecureContext` — true for https and for http on a loopback
   *  origin (localhost / 127.0.0.1 / [::1]); false for a plain-http LAN IP. */
  isSecureContext: boolean;
  /** Whether `crypto.subtle` is present. Undefined in an insecure context,
   *  and absent on ancient browsers even when the context is secure. */
  hasSubtleCrypto: boolean;
}

/** Read the live secure-context signals off `globalThis`. A thin seam so the
 *  resolver can be exercised for both branches without a real browser — the
 *  caller in `main()` uses this; tests pass a `SecureContextEnv` directly. */
export const readSecureContextEnv = (): SecureContextEnv => ({
  // Default to false when the global is absent (a non-browser env is not a
  // secure context). Only an explicit `true` counts.
  isSecureContext:
    (globalThis as { isSecureContext?: boolean }).isSecureContext === true,
  hasSubtleCrypto: !!(globalThis as { crypto?: { subtle?: unknown } }).crypto
    ?.subtle,
});

/** Decide whether boot must abort because Web Crypto is unavailable. Returns
 *  the splash message to show, or `null` when the environment can run the
 *  webclient. Pure — the caller supplies the environment. The insecure-context
 *  message wins when both signals are bad (fixing the context restores
 *  `crypto.subtle` too), so it is the more actionable of the two. */
export const resolveInsecureContextMessage = (
  env: SecureContextEnv,
): string | null => {
  if (!env.isSecureContext) return INSECURE_CONTEXT_SPLASH_MESSAGE;
  if (!env.hasSubtleCrypto) return WEBCRYPTO_MISSING_SPLASH_MESSAGE;
  return null;
};
