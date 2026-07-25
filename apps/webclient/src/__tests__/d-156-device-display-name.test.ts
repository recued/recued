/** D-156 — `deriveDeviceDisplayName` / `resolveDeviceDisplayName` unit
 *  tests. Guards the UA/platform → "Chrome on macOS"-style label the
 *  webclient sends to `/auth/pair` so the Devices roster row reads
 *  legibly instead of the server's "unknown device" fallback. */

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveDeviceDisplayName,
  resolveDeviceDisplayName,
} from '../auth/device-display-name.js';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  firefoxWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  chromeIosCriOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  firefoxLinux:
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Playwright / Puppeteer old-headless mode — "HeadlessChrome/" (IS Chrome).
  headlessChromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36',
  // iPadOS Safari "Request Mobile Website" — carries the iPad token.
  safariIpadMobile:
    'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  // iPadOS Safari desktop-class mode (default) — "Macintosh", no iPad
  // token, but a "Mobile/" build token a real Mac UA never has.
  safariIpadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
} as const;

describe('deriveDeviceDisplayName — browser × OS', () => {
  it('Chrome on macOS', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.chromeMac })).toBe(
      'Chrome on macOS',
    );
  });

  it('Firefox on Windows', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.firefoxWin })).toBe(
      'Firefox on Windows',
    );
  });

  it('Safari on macOS (desktop Version/+Safari/, not Chrome)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.safariMac })).toBe(
      'Safari on macOS',
    );
  });

  it('Safari on iOS (iPhone)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.safariIphone })).toBe(
      'Safari on iOS',
    );
  });

  it('Chrome on iOS via CriOS (Chrome-family token wins over Safari/)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.chromeIosCriOS })).toBe(
      'Chrome on iOS',
    );
  });

  it('Edge on Windows (Edg/ tested before Chrome/)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.edgeWin })).toBe(
      'Edge on Windows',
    );
  });

  it('Opera on Windows (OPR/ tested before Chrome/)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.operaWin })).toBe(
      'Opera on Windows',
    );
  });

  it('Chrome on Android (iOS/Android tested before the broad Linux token)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.chromeAndroid })).toBe(
      'Chrome on Android',
    );
  });

  it('Firefox on Linux', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.firefoxLinux })).toBe(
      'Firefox on Linux',
    );
  });

  it('Chrome on ChromeOS', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.chromeOs })).toBe(
      'Chrome on ChromeOS',
    );
  });

  it('HeadlessChrome maps to Chrome (automation UA — not "Web browser")', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.headlessChromeMac })).toBe(
      'Chrome on macOS',
    );
  });

  it('Safari on iOS for an iPad in mobile mode (explicit iPad token)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.safariIpadMobile })).toBe(
      'Safari on iOS',
    );
  });

  it('Safari on iOS for an iPad in desktop mode (Macintosh + Mobile/ ≠ a real Mac)', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.safariIpadDesktop })).toBe(
      'Safari on iOS',
    );
  });

  it('real Mac Safari (Macintosh, no Mobile/ token) stays macOS', () => {
    expect(deriveDeviceDisplayName({ userAgent: UA.safariMac })).toBe(
      'Safari on macOS',
    );
  });
});

describe('deriveDeviceDisplayName — hints + fallbacks', () => {
  it('prefers the userAgentData.platform Client-Hint for OS', () => {
    // A Linux Chrome UA, but the Client-Hint says macOS → hint wins.
    expect(
      deriveDeviceDisplayName({
        userAgent: UA.chromeOs.replace('CrOS', 'Linux'),
        uaDataPlatform: 'macOS',
      }),
    ).toBe('Chrome on macOS');
  });

  it('falls back to legacy navigator.platform for OS when the UA yields none', () => {
    expect(
      deriveDeviceDisplayName({
        userAgent: 'CustomAgent/1.0',
        platform: 'MacIntel',
      }),
    ).toBe('Web browser on macOS');
  });

  it('browser only → bare browser name when OS is unrecognised', () => {
    expect(
      deriveDeviceDisplayName({ userAgent: 'Firefox/121.0' }),
    ).toBe('Firefox');
  });

  it('nothing recognisable → "Web browser" (never the empty string)', () => {
    expect(deriveDeviceDisplayName({})).toBe('Web browser');
    expect(deriveDeviceDisplayName({ userAgent: '', platform: '' })).toBe(
      'Web browser',
    );
    expect(
      deriveDeviceDisplayName({ userAgent: null, platform: null }),
    ).toBe('Web browser');
  });

  it('always returns a non-empty string', () => {
    for (const ua of Object.values(UA)) {
      expect(deriveDeviceDisplayName({ userAgent: ua }).length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('resolveDeviceDisplayName — reads globalThis.navigator', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      Reflect.deleteProperty(globalThis as object, 'navigator');
    }
  });

  it('derives from the live navigator UA + platform', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: UA.chromeMac, platform: 'MacIntel' },
    });
    expect(resolveDeviceDisplayName()).toBe('Chrome on macOS');
  });

  it('prefers navigator.userAgentData.platform over the legacy platform', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        userAgent: UA.chromeAndroid,
        platform: 'Linux armv8l',
        userAgentData: { platform: 'Android' },
      },
    });
    expect(resolveDeviceDisplayName()).toBe('Chrome on Android');
  });

  it('degrades to "Web browser" when no navigator is present', () => {
    // Define as `undefined` (rather than deleting) so the falsy branch is
    // hit deterministically regardless of the host's navigator descriptor.
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: undefined,
    });
    expect(resolveDeviceDisplayName()).toBe('Web browser');
  });
});
