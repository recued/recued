/** Canonical token guard.
 *
 *  1. Drift guard — `THEME_TOKENS_CSS` (the generated string) must equal
 *     `tokens.css` byte-for-byte. If this fails, someone edited one half
 *     without running `npm run -w @recued/ui-shared generate:tokens`.
 *  2. Sanity — the canonical D-174 values are present so a bad edit
 *     (wrong accent, missing dark block) is caught here, not in a surface. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_TOKENS_CSS } from '../index.js';

const themeDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = readFileSync(join(themeDir, 'tokens.css'), 'utf8');

describe('canonical theme tokens', () => {
  it('THEME_TOKENS_CSS is byte-identical to tokens.css (run generate:tokens if this fails)', () => {
    expect(THEME_TOKENS_CSS).toBe(tokensCss);
  });

  it('carries the D-174 canonical accent + danger (light)', () => {
    expect(tokensCss).toContain('--accent: #0e7490;');
    expect(tokensCss).toContain('--brand: #0e7490;');
    expect(tokensCss).toContain('--danger: #dc2626;');
    expect(tokensCss).toContain('--on-accent: #ffffff;');
  });

  it('carries a prefers-color-scheme dark block with the adapted accent', () => {
    expect(tokensCss).toContain('@media (prefers-color-scheme: dark)');
    expect(tokensCss).toContain('--accent: #22c1d6;');
    expect(tokensCss).toContain('--danger: #f87171;');
  });

  it('keeps success/warning hue-free (D-174: ok/warn resolve to neutral, not green/amber)', () => {
    // The aliases must point at neutral tokens — never a literal green/amber.
    expect(tokensCss).toContain('--ok: var(--fg);');
    expect(tokensCss).toContain('--warn: var(--fg);');
    expect(tokensCss).toContain('--ok-bg: var(--surface-sunk);');
    expect(tokensCss).toContain('--warn-bg: var(--surface-sunk);');
  });

  it('exposes a single accent (brand === accent), not a second colour', () => {
    // Brand is the fixed hue; accent is derived from it. In light mode they
    // are the same value — the "one accent" invariant.
    const light = tokensCss.slice(0, tokensCss.indexOf('@media'));
    expect(light).toContain('--brand: #0e7490;');
    expect(light).toContain('--accent: #0e7490;');
  });
});
