import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBootFailureCounter } from '../update/boot-failure-counter.js';

const path = (): string => join(mkdtempSync(join(tmpdir(), 'recued-bootfail-')), 'boot-failures.json');

describe('boot-failure counter', () => {
  it('reads zero when absent', () => {
    expect(createBootFailureCounter(path()).read()).toBe(0);
  });

  it('increments consecutively for the same release and persists', () => {
    const p = path();
    const c = createBootFailureCounter(p);
    expect(c.increment('rel-A')).toBe(1);
    expect(c.increment('rel-A')).toBe(2);
    // fresh handle sees the persisted count
    expect(createBootFailureCounter(p).read()).toBe(2);
  });

  it('re-keys to 1 when the release changes (a new apply)', () => {
    const p = path();
    const c = createBootFailureCounter(p);
    c.increment('rel-A');
    c.increment('rel-A');
    expect(c.increment('rel-B')).toBe(1);
  });

  it('release-aware read returns 0 for a different release (stale counter)', () => {
    const p = path();
    const c = createBootFailureCounter(p);
    c.increment('rel-A');
    c.increment('rel-A');
    expect(c.read('rel-A')).toBe(2);
    expect(c.read('rel-B')).toBe(0); // stale → not the current apply
    expect(c.read()).toBe(2); // unqualified read is release-agnostic
  });

  it('reset clears the counter', () => {
    const p = path();
    const c = createBootFailureCounter(p);
    c.increment('rel-A');
    c.reset();
    expect(c.read()).toBe(0);
  });

  it('reads zero on a corrupt file (fail toward giving the binary a chance)', () => {
    const p = path();
    writeFileSync(p, '{not json', 'utf8');
    expect(createBootFailureCounter(p).read()).toBe(0);
  });
});
