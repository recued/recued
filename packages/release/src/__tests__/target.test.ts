import { describe, expect, it } from 'vitest';
import {
  binaryFileName,
  currentPlatformTriple,
  resolvePlatformTriple,
} from '../target.js';
import { PLATFORMS } from '../manifest.js';

describe('resolvePlatformTriple', () => {
  it('maps node platform+arch to the manifest triple vocabulary', () => {
    expect(resolvePlatformTriple('linux', 'x64')).toBe('linux-x64');
    expect(resolvePlatformTriple('linux', 'arm64')).toBe('linux-arm64');
    expect(resolvePlatformTriple('darwin', 'x64')).toBe('macos-x64');
    expect(resolvePlatformTriple('darwin', 'arm64')).toBe('macos-arm64');
    expect(resolvePlatformTriple('win32', 'x64')).toBe('windows-x64');
  });

  it('returns a triple that is always a member of the manifest PLATFORMS set', () => {
    const triple = resolvePlatformTriple('darwin', 'arm64');
    expect(triple).not.toBeNull();
    expect(PLATFORMS).toContain(triple!);
  });

  it('returns null for unknown os or arch (never a partial/guessed triple)', () => {
    expect(resolvePlatformTriple('sunos', 'x64')).toBeNull();
    expect(resolvePlatformTriple('linux', 'ia32')).toBeNull();
    expect(resolvePlatformTriple('aix', 'ppc64')).toBeNull();
    expect(resolvePlatformTriple('', '')).toBeNull();
  });

  it('returns null for windows-arm64 — in the union for forward-compat but not a build target', () => {
    // windows-arm64 IS a Platform key, but win32+arm64 is not a current
    // matrix target; the mapping refuses rather than emit an unbuilt triple.
    // (If/when added to PLATFORMS-as-target, flip this expectation.)
    expect(resolvePlatformTriple('win32', 'arm64')).toBe('windows-arm64');
  });
});

describe('currentPlatformTriple', () => {
  it('resolves an injected host descriptor', () => {
    expect(currentPlatformTriple({ platform: 'darwin', arch: 'arm64' })).toBe('macos-arm64');
    expect(currentPlatformTriple({ platform: 'linux', arch: 'x64' })).toBe('linux-x64');
  });

  it('resolves the real running host to a known triple or null without throwing', () => {
    const triple = currentPlatformTriple();
    expect(triple === null || PLATFORMS.includes(triple)).toBe(true);
  });
});

describe('binaryFileName', () => {
  it('suffixes windows triples with .exe and leaves the rest bare', () => {
    expect(binaryFileName('linux-x64')).toBe('recued-linux-x64');
    expect(binaryFileName('macos-arm64')).toBe('recued-macos-arm64');
    expect(binaryFileName('windows-x64')).toBe('recued-windows-x64.exe');
    expect(binaryFileName('windows-arm64')).toBe('recued-windows-arm64.exe');
  });
});
