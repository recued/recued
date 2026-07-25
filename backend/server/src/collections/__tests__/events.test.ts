/** D-124 Phase 1 — `CollectionEventEmitter` `prev` passthrough.
 *
 *  The wrapper's job is to stamp `at` + the `(platform, slug,
 *  entity_type)` triple onto every emit and forward `prev` from
 *  `updated` / `deleted` callers onto the bus event verbatim. Tests
 *  cover the four common shapes plus the `created` / `synced` cases
 *  where `prev` must never appear on the wire. */

import { describe, expect, it, vi } from 'vitest';

import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import { createCollectionEmitter } from '../events.js';

const mockBus = (): { bus: WarehouseEventBus; emitted: WarehouseEvent[] } => {
  const emitted: WarehouseEvent[] = [];
  const bus: WarehouseEventBus = {
    emit: (e) => { emitted.push(e); },
    subscribe: () => () => {},
    dispose: () => {},
  };
  return { bus, emitted };
};

describe('createCollectionEmitter — prev passthrough (D-124 Phase 1)', () => {
  it('attaches `prev` from `updated` callers onto the bus event', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'mail',
      slug: 'work',
      entityType: 'message',
      now: () => 1700000000000,
    });

    emitter.updated('mail:work:abc-123', {
      subject: 'Old subject',
      from: 'a@example.com',
      thread_id: 't-1',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'updated',
      record_id: 'mail:work:abc-123',
      at: 1700000000000,
      prev: {
        subject: 'Old subject',
        from: 'a@example.com',
        thread_id: 't-1',
      },
    });
  });

  it('attaches `prev` from `deleted` callers onto the bus event', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'calendar',
      slug: 'main',
      entityType: 'event',
      now: () => 1700000000000,
    });

    emitter.deleted('cal:main:evt-9', {
      summary: 'Old standup',
      start_at: 1700000000000,
      attendees: ['a@x.com', 'b@y.com'],
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_kind).toBe('deleted');
    expect(emitted[0].prev).toEqual({
      summary: 'Old standup',
      start_at: 1700000000000,
      attendees: ['a@x.com', 'b@y.com'],
    });
  });

  it('omits `prev` on `created` events (no prior state by definition)', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'mail',
      slug: 'work',
      entityType: 'message',
      now: () => 1,
    });

    emitter.created('mail:work:new-1');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_kind).toBe('created');
    expect(emitted[0].prev).toBeUndefined();
    expect('prev' in emitted[0]).toBe(false);
  });

  it('omits `prev` on `synced` events (collection-level tick)', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'file',
      slug: 'dropbox',
      entityType: 'file',
      now: () => 1,
    });

    emitter.synced();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_kind).toBe('synced');
    expect(emitted[0].record_id).toBe('');
    expect(emitted[0].prev).toBeUndefined();
    expect('prev' in emitted[0]).toBe(false);
  });

  it('passes through whatever shape callers supply (collection-agnostic)', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'file',
      slug: 'docs',
      entityType: 'file',
      now: () => 1,
    });

    // File adapter projects metadata-only — not the full hot fields
    // shape mail/calendar use. The bus is collection-agnostic so any
    // Record<string, unknown> rides through unchanged.
    emitter.updated('file:docs:notes.md', {
      path: 'notes.md',
      mtime: 1700000000000,
      size_bytes: 4096,
    });

    expect(emitted[0].prev).toEqual({
      path: 'notes.md',
      mtime: 1700000000000,
      size_bytes: 4096,
    });
  });

  it('preserves the `at` stamp regardless of prev presence', () => {
    const { bus, emitted } = mockBus();
    const emitter = createCollectionEmitter({
      bus,
      platform: 'mail',
      slug: 'work',
      entityType: 'message',
      now: () => 42,
    });

    emitter.created('a');
    emitter.updated('a', { subject: 's' });
    emitter.deleted('a', { subject: 's' });
    emitter.synced();

    expect(emitted.map((e) => e.at)).toEqual([42, 42, 42, 42]);
  });
});
