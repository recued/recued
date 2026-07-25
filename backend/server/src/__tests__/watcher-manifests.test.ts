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

const WATCHER_FILES = [
  'time-watcher.json',
  'recipe-watcher.json',
  'http-watcher.json',
  'mail-watcher.json',
  'file-watcher.json',
  'calendar-watcher.json',
  'webhook-watcher.json',
];

const WATCHER_SLUGS = WATCHER_FILES.map((f) => f.replace(/\.json$/, ''));

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

  it('exactly the seven D-115 watcher manifests are present (no stragglers)', () => {
    expect(WATCHER_SLUGS.sort()).toEqual([
      'calendar-watcher',
      'file-watcher',
      'http-watcher',
      'mail-watcher',
      'recipe-watcher',
      'time-watcher',
      'webhook-watcher',
    ]);
  });

  it('mail / file / calendar watchers declare since + limit for warehouse paging', () => {
    for (const file of ['mail-watcher.json', 'file-watcher.json', 'calendar-watcher.json']) {
      const m = loadManifest(file);
      const input = m.input as Record<string, unknown>;
      expect(input).toHaveProperty('since');
      expect(input).toHaveProperty('limit');
    }
  });

  it('mail / file / calendar watchers emit last_seen_at for cursor advance', () => {
    for (const file of ['mail-watcher.json', 'file-watcher.json', 'calendar-watcher.json']) {
      const m = loadManifest(file);
      const output = m.output as Record<string, string>;
      expect(output).toHaveProperty('last_seen_at');
    }
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

  it('recipe-watcher carries kind + recipe_id + since_ms', () => {
    const m = loadManifest('recipe-watcher.json');
    const input = m.input as Record<string, unknown>;
    expect(input).toHaveProperty('kind');
    expect(input).toHaveProperty('recipe_id');
    expect(input).toHaveProperty('since_ms');
  });

  it('webhook-watcher carries recipe_id + slug for endpoint scoping', () => {
    const m = loadManifest('webhook-watcher.json');
    const input = m.input as Record<string, unknown>;
    expect(input).toHaveProperty('recipe_id');
    expect(input).toHaveProperty('slug');
    const output = m.output as Record<string, string>;
    expect(output).toHaveProperty('requests');
    expect(output).toHaveProperty('queue_size');
  });
});
