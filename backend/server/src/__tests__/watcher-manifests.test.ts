/** D-115 Phase 6 — per-watcher manifest contract tests.
 *
 *  kernel-manifests.test.ts auto-lints every inlined manifest via the generic `validateIngredient`;
 *  this file pins D-115-specific invariants: kernel flag, `should_run` output, and slug
 *  enumeration so Phase 5 runtime wiring stays in lockstep with the manifest catalog.
 *
 *  The watcher manifests are kernel substrate, inlined in KERNEL_MANIFESTS (moved out of
 *  community/ in the kernel/community separation), so this test lives in backend/server where
 *  KERNEL_MANIFESTS is importable. */

import { describe, it, expect } from 'vitest';
import { validateIngredient } from '@recued/ingredients';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const bySlug = new Map(KERNEL_MANIFESTS.map((m) => [m.slug, m] as const));
const loadManifest = (file: string): Record<string, unknown> => {
  const slug = file.replace(/\.json$/, '');
  const m = bySlug.get(slug);
  if (!m) throw new Error(`kernel manifest not found: ${slug}`);
  return m as unknown as Record<string, unknown>;
};

/** The D-115 watchers still shipped. The mail, file, calendar, webhook and
 *  recipe watchers were retired 2026-10-05. */
const WATCHER_FILES = [
  'time-watcher.json',
  'http-watcher.json',
];

describe('watcher manifests — D-115 Phase 6', () => {
  it.each(WATCHER_FILES)('%s exists and parses', (file) => {
    const manifest = loadManifest(file);
    expect(manifest.slug).toBe(file.replace(/\.json$/, ''));
  });

  it.each(WATCHER_FILES)('%s validates cleanly', (file) => {
    const result = validateIngredient(loadManifest(file));
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors, `${file} had errors: ${errors.map((e) => e.code).join(',')}`).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(WATCHER_FILES)('%s is a kernel ingredient (author = recued)', (file) => {
    const m = loadManifest(file);
    expect(m.author, `${file} author`).toBe('recued');
  });

  it.each(WATCHER_FILES)('%s is category=data, risk_tier=read', (file) => {
    const m = loadManifest(file);
    expect(m.category, `${file} category`).toBe('data');
    expect(m.risk_tier, `${file} risk_tier`).toBe('read');
  });

  it.each(WATCHER_FILES)('%s declares a should_run output', (file) => {
    const m = loadManifest(file);
    const output = m.output as Record<string, string>;
    expect(output.should_run, `${file} output.should_run`).toBe('should_run');
  });

  it.each(WATCHER_FILES)('%s is authored under the recued publisher', (file) => {
    const m = loadManifest(file);
    expect(m.author).toBe('recued');
  });

  /** ⚠ Read from the kernel catalog itself. This compared its own list with
   *  itself, so a manifest added or left behind could never fail it. */
  it('exactly the shipped watcher manifests are present (no stragglers)', () => {
    expect(KERNEL_MANIFESTS.map((m) => m.slug).filter((slug) => slug.endsWith('-watcher')).sort()).toEqual([
      'http-watcher',
      'time-relative-watcher',
      'time-watcher',
    ]);
  });

  it('http-watcher exposes both etag and hash outputs for cursor choice', () => {
    const m = loadManifest('http-watcher.json');
    const output = m.output as Record<string, string>;
    expect(output).toHaveProperty('etag');
    expect(output).toHaveProperty('hash');
  });

  it('time-watcher declares weekday / hour-range inputs (both optional)', () => {
    const m = loadManifest('time-watcher.json');
    const input = m.input as Record<string, unknown>;
    expect(input).toHaveProperty('weekdays');
    expect(input).toHaveProperty('start_hour');
    expect(input).toHaveProperty('end_hour');
  });
});
