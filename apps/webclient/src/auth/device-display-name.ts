/** D-156 — Webclient device display-name derivation.
 *
 *  The Devices roster (Settings → Devices, `pair.list`) renders one row
 *  per paired client, labelled with the `display_name` the client sent
 *  to `POST /auth/pair`. The webclient historically sent none, so every
 *  row (including "This device") read "unknown device" — the server's
 *  fallback (`backend/server/src/server.ts` `/auth/pair`:
 *  `display_name: body.displayName ?? 'unknown device'`).
 *
 *  This module derives a short, human-readable label from the browser's
 *  UA / platform hints — e.g. "Chrome on macOS", "Firefox on Windows",
 *  "Safari on iOS" — so the roster is legible without asking the user to
 *  name the device. The boot path reads `globalThis.navigator` and feeds
 *  the strings here; the function is pure so the parsing is unit-testable
 *  without a real `navigator`.
 *
 *  Best-effort by design: a missing / unrecognised UA degrades to
 *  "Web browser" (still strictly better than "unknown device"), and the
 *  server's own fallback covers the case where this returns nothing.
 *
 *  Spec: docs/d-156-spec.md (Devices roster). */

export interface DeriveDeviceDisplayNameInput {
  /** `navigator.userAgent`. */
  readonly userAgent?: string | null;
  /** Legacy `navigator.platform` (e.g. "MacIntel", "Win32", "iPhone").
   *  Used only as an OS fallback when the UA string doesn't yield one. */
  readonly platform?: string | null;
  /** `navigator.userAgentData.platform` Client-Hint (e.g. "macOS",
   *  "Windows", "Android"). Preferred for OS when present — it's the
   *  cleanest signal modern Chromium browsers expose. */
  readonly uaDataPlatform?: string | null;
}

/** Recognise the browser engine from the UA string. Order matters:
 *  Edge / Opera UAs also contain "Chrome", and Chrome's contains
 *  "Safari", so the more-specific tokens are tested first. Returns null
 *  when nothing recognisable matches. */
const detectBrowser = (ua: string): string | null => {
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera[ /]/.test(ua)) return 'Opera';
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  // CriOS = Chrome on iOS; Chrome desktop/Android = "Chrome/";
  // HeadlessChrome = automation / old headless mode (it IS Chrome — new
  // headless reports plain "Chrome/", but old-headless + embedded webviews
  // still emit "HeadlessChrome/", and the leading "Headless" defeats a
  // bare \bChrome\/ boundary).
  if (/\b(?:Chrome|CriOS|Chromium|HeadlessChrome)\//.test(ua)) return 'Chrome';
  // Safari proper carries both "Version/" and "Safari/" (and is not
  // one of the Chromium-family UAs already matched above).
  if (/\bVersion\/[\d.]+ +(?:Mobile\/\S+ +)?Safari\//.test(ua)) return 'Safari';
  return null;
};

/** Normalise a Client-Hint / `navigator.platform` OS token into the
 *  short label the roster shows. */
const normalizeOsToken = (raw: string): string | null => {
  const s = raw.trim();
  if (s.length === 0) return null;
  const lower = s.toLowerCase();
  if (lower.includes('mac')) return 'macOS';
  if (lower.includes('win')) return 'Windows';
  if (lower.includes('iphone') || lower.includes('ipad') || lower === 'ios') {
    return 'iOS';
  }
  if (lower.includes('android')) return 'Android';
  if (lower.includes('cros') || lower.includes('chrome os')) return 'ChromeOS';
  if (lower.includes('linux')) return 'Linux';
  return null;
};

/** Recognise the OS, preferring the Client-Hint, then the UA string,
 *  then the legacy `navigator.platform`. Returns null when nothing
 *  recognisable matches. */
const detectOs = (
  ua: string,
  platform: string,
  uaDataPlatform: string,
): string | null => {
  const fromHint = normalizeOsToken(uaDataPlatform);
  if (fromHint) return fromHint;
  // UA ordering: test iOS / Android before the broader "Mac"/"Linux"
  // tokens (iPad UAs say "Macintosh"; Android UAs say "Linux").
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) return 'iOS';
  // iPadOS Safari in desktop-class mode (the default) reports
  // "Macintosh" with NO "iPad" token — indistinguishable from a Mac by
  // UA alone, EXCEPT it carries a "Mobile/" build token that a real
  // macOS browser never does. Treat that combination as iOS.
  if (/\bMacintosh\b/.test(ua) && /\bMobile\//.test(ua)) return 'iOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return normalizeOsToken(platform);
};

/** Derive a short, human-readable device label from the browser's UA /
 *  platform hints. Pure + always returns a non-empty string. */
export const deriveDeviceDisplayName = (
  input: DeriveDeviceDisplayNameInput = {},
): string => {
  const ua = (input.userAgent ?? '').trim();
  const platform = (input.platform ?? '').trim();
  const uaDataPlatform = (input.uaDataPlatform ?? '').trim();
  const browser = detectBrowser(ua);
  const os = detectOs(ua, platform, uaDataPlatform);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Web browser on ${os}`;
  return 'Web browser';
};

/** Read `globalThis.navigator` and derive the device display name. The
 *  navigator read is isolated here (mirrors `resolveOrGenerateInstanceId`
 *  reading `globalThis.crypto` in the boot path) so the pure
 *  `deriveDeviceDisplayName` stays trivially testable. Best-effort —
 *  any access failure falls through to the bare default. */
export const resolveDeviceDisplayName = (): string => {
  const nav = (globalThis as {
    navigator?: {
      userAgent?: string;
      platform?: string;
      userAgentData?: { platform?: string };
    };
  }).navigator;
  if (!nav) return deriveDeviceDisplayName();
  return deriveDeviceDisplayName({
    userAgent: nav.userAgent ?? null,
    platform: nav.platform ?? null,
    uaDataPlatform: nav.userAgentData?.platform ?? null,
  });
};
