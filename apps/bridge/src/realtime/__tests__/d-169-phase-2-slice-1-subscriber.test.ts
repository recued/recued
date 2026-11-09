import { describe, expect, it, vi } from 'vitest';

import {
  BROADCAST_EVENT_KIND_SET,
  type BroadcastEventKind,
  type ServerEvent,
} from '@recued/contracts';
import {
  BRIDGE_DEFAULT_SUBSCRIPTIONS,
  createBridgeBroadcastSubscriber,
} from '../subscriber.js';

const notifyEvent = (cursor = 1): Extract<ServerEvent, { kind: 'notification.notify' }> => ({
  kind: 'notification.notify',
  title: 'Title',
  text: 'Body',
  cursor,
});

describe('D-169 P2 Slice 1 - bridge broadcast subscriber', () => {
  it('dispatches valid events to the matching kind listener and onAny listener', () => {
    const subscriber = createBridgeBroadcastSubscriber();
    const onNotify = vi.fn();
    const onAny = vi.fn();
    const event = notifyEvent(10);

    subscriber.on('notification.notify', onNotify);
    subscriber.onAny(onAny);
    subscriber.dispatch(event);

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(event);
    expect(onAny).toHaveBeenCalledTimes(1);
    expect(onAny).toHaveBeenCalledWith(event);
  });

  it('drops non-events before listener dispatch', () => {
    const subscriber = createBridgeBroadcastSubscriber();
    const onAny = vi.fn();
    const unknownKind = 'not-a-broadcast-kind' as BroadcastEventKind;

    expect(BROADCAST_EVENT_KIND_SET.has(unknownKind)).toBe(false);
    subscriber.onAny(onAny);
    subscriber.dispatch(null);
    subscriber.dispatch('nope');
    subscriber.dispatch({ text: 'missing kind' });
    subscriber.dispatch({ kind: unknownKind, cursor: 1 });

    expect(onAny).not.toHaveBeenCalled();
  });

  it('on() returns a working unsubscribe handle', () => {
    const subscriber = createBridgeBroadcastSubscriber();
    const onNotify = vi.fn();
    const unsubscribe = subscriber.on('notification.notify', onNotify);

    subscriber.dispatch(notifyEvent(20));
    unsubscribe();
    subscriber.dispatch(notifyEvent(21));

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(notifyEvent(20));
  });

  it('isolates throwing listeners while still firing siblings and onAny', () => {
    const subscriber = createBridgeBroadcastSubscriber();
    const sibling = vi.fn();
    const onAny = vi.fn();
    const event = notifyEvent(30);

    subscriber.on('notification.notify', () => {
      throw new Error('listener failed');
    });
    subscriber.on('notification.notify', sibling);
    subscriber.onAny(onAny);

    expect(() => subscriber.dispatch(event)).not.toThrow();
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledWith(event);
    expect(onAny).toHaveBeenCalledTimes(1);
    expect(onAny).toHaveBeenCalledWith(event);
  });

  it('reports listener counts by kind and across wildcard listeners', () => {
    const subscriber = createBridgeBroadcastSubscriber();
    const unNotifyA = subscriber.on('notification.notify', vi.fn());
    subscriber.on('notification.notify', vi.fn());
    subscriber.on('execution', vi.fn());
    const unAny = subscriber.onAny(vi.fn());

    expect(subscriber.size('notification.notify')).toBe(2);
    expect(subscriber.size('execution')).toBe(1);
    expect(subscriber.size()).toBe(4);

    unNotifyA();
    unAny();

    expect(subscriber.size('notification.notify')).toBe(1);
    expect(subscriber.size()).toBe(2);
  });

  it('ratchets the bridge default subscription set to valid rendered kinds', () => {
    expect([...BRIDGE_DEFAULT_SUBSCRIPTIONS]).toEqual([
      'execution',
      'notification.ask',
      'notification.ask_closed',
      'notification.bridge_mode_changed',
      'notification.notify',
    ]);
    for (const kind of BRIDGE_DEFAULT_SUBSCRIPTIONS) {
      expect(BROADCAST_EVENT_KIND_SET.has(kind)).toBe(true);
    }
  });
});
