/** R13 T4-6.1 — dropped-audit-writes sidecar marker tests. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  consumeDroppedWritesMarker,
  droppedWritesMarkerPath,
  writeDroppedWritesMarker,
} from '../audit/dropped-writes-marker.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const makeDir = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'recued-drop-marker-'));
  return dir;
};

describe('dropped-writes marker (R13 T4-6.1)', () => {
  it('derives a sidecar path only for on-disk databases', () => {
    expect(droppedWritesMarkerPath(':memory:')).toBeNull();
    expect(droppedWritesMarkerPath('')).toBeNull();
    expect(droppedWritesMarkerPath('file::memory:?cache=shared')).toBeNull();
    expect(droppedWritesMarkerPath('/data/recued/server.db')).toBe(
      '/data/recued/server.db.dropped-audit-writes.json',
    );
  });

  it('round-trips a marker and consumes it exactly once', () => {
    const path = join(makeDir(), 'server.db.dropped-audit-writes.json');
    expect(consumeDroppedWritesMarker(path)).toBeNull();
    writeDroppedWritesMarker(path, { dropped: 3, at: 1_700_000_000_000 });
    expect(consumeDroppedWritesMarker(path)).toEqual({ dropped: 3, at: 1_700_000_000_000 });
    // Consumed = deleted — the count surfaces once, never on every boot.
    expect(existsSync(path)).toBe(false);
    expect(consumeDroppedWritesMarker(path)).toBeNull();
  });

  it('overwrite-writes: the marker always holds the latest running total', () => {
    const path = join(makeDir(), 'server.db.dropped-audit-writes.json');
    writeDroppedWritesMarker(path, { dropped: 1, at: 10 });
    writeDroppedWritesMarker(path, { dropped: 2, at: 20 });
    expect(consumeDroppedWritesMarker(path)).toEqual({ dropped: 2, at: 20 });
  });

  it('consumes (deletes) a malformed marker instead of resurfacing it forever', () => {
    const base = makeDir();
    const notJson = join(base, 'a.json');
    writeFileSync(notJson, 'not json');
    expect(consumeDroppedWritesMarker(notJson)).toBeNull();
    expect(existsSync(notJson)).toBe(false);

    const wrongShape = join(base, 'b.json');
    writeFileSync(wrongShape, JSON.stringify({ dropped: 'three' }));
    expect(consumeDroppedWritesMarker(wrongShape)).toBeNull();
    expect(existsSync(wrongShape)).toBe(false);
  });
});
