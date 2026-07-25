import { describe, expect, it, vi } from 'vitest';

import { createWarehouseEventBus } from '../bus.js';
import type { WarehouseEvent } from '../types.js';

const mkEvent = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'mail',
  slug: 'work',
  entity_type: 'message',
  event_kind: 'created',
  record_id: 'abc',
  at: 1700000000000,
  ...overrides,
});

describe('createWarehouseEventBus', () => {
  it('fans out events that match the subscriber pattern', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.mail.*.message.created', listener);
    bus.emit(mkEvent());
    expect(listener).toHaveBeenCalledOnce();
  });

  it('ignores events that do not match', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.file.**', listener);
    bus.emit(mkEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('** matches any number of trailing segments', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.mail.**', listener);
    bus.emit(mkEvent());
    bus.emit(mkEvent({ entity_type: 'thread', event_kind: 'updated' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    const off = bus.subscribe('data.mail.**', listener);
    bus.emit(mkEvent());
    off();
    bus.emit(mkEvent());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listener exceptions are swallowed', () => {
    const bus = createWarehouseEventBus();
    bus.subscribe('data.mail.**', () => { throw new Error('boom'); });
    expect(() => bus.emit(mkEvent())).not.toThrow();
  });

  it('dispose drops every listener', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.**', listener);
    bus.dispose();
    bus.emit(mkEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  // D-124 Phase 1 — prev passthrough.
  it('forwards `prev` snapshot on updated events', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.mail.**', listener);
    const event = mkEvent({
      event_kind: 'updated',
      prev: { subject: 'Old subject', from: 'a@b.c' },
    });
    bus.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
    expect(listener.mock.calls[0][0].prev).toEqual({
      subject: 'Old subject',
      from: 'a@b.c',
    });
  });

  it('forwards `prev` snapshot on deleted events', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.calendar.**', listener);
    const event = mkEvent({
      platform: 'calendar',
      entity_type: 'event',
      event_kind: 'deleted',
      prev: { summary: 'Standup', start_at: 1700000000000 },
    });
    bus.emit(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].prev).toEqual({
      summary: 'Standup',
      start_at: 1700000000000,
    });
  });

  it('omits `prev` on created and synced events', () => {
    const bus = createWarehouseEventBus();
    const listener = vi.fn();
    bus.subscribe('data.**', listener);
    bus.emit(mkEvent({ event_kind: 'created' }));
    bus.emit(mkEvent({ event_kind: 'synced' }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].prev).toBeUndefined();
    expect(listener.mock.calls[1][0].prev).toBeUndefined();
  });
});
