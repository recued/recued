/** M1 — shared OS free-space probe unit tests. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osFreeBytes } from '../disk-free.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'disk-free-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('osFreeBytes', () => {
  it('reports a positive free-byte count for a real path', () => {
    expect(osFreeBytes(root)).toBeGreaterThan(0);
  });

  it('throws on a non-existent path (caller decides gate-open)', () => {
    expect(() => osFreeBytes(join(root, 'nope', 'really-nope'))).toThrow();
  });
});
