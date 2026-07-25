import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import { createCollectionEmitter } from '../collections/events.js';

let bus: WarehouseEventBus;
let received: WarehouseEvent[];

const seed = (): void => {
  bus = createWarehouseEventBus();
  received = [];
  // Subscribe via a `**` glob to capture everything.
  bus.subscribe('**', (e) => { received.push(e); });
};

beforeEach(() => { seed(); });

describe('created / updated / deleted', () => {
  it('each emits the right event_kind bound to the configured triple', () => {
    const mail = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
      now: () => 1_700_000_000_000,
    });
    mail.created('uid:1');
    mail.updated('uid:2', { subject: 'Hello' });
    mail.deleted('uid:3', { subject: 'Goodbye' });
    expect(received).toEqual([
      { platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id: 'uid:1', at: 1_700_000_000_000 },
      { platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'updated', record_id: 'uid:2', at: 1_700_000_000_000, prev: { subject: 'Hello' } },
      { platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'deleted', record_id: 'uid:3', at: 1_700_000_000_000, prev: { subject: 'Goodbye' } },
    ]);
  });

  it('stamps `at` from the injected clock', () => {
    let t = 1_000;
    const em = createCollectionEmitter({
      bus, platform: 'file', slug: 'downloads', entityType: 'file',
      now: () => t,
    });
    em.created('a');
    t = 2_000;
    em.updated('a', { path: 'a' });
    expect(received.map((e) => e.at)).toEqual([1_000, 2_000]);
  });
});

describe('synced', () => {
  it('defaults record_id to empty string for whole-collection ticks', () => {
    const em = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
    });
    em.synced();
    expect(received).toEqual([
      expect.objectContaining({ event_kind: 'synced', record_id: '' }),
    ]);
  });

  it('accepts a batch / folder id when the adapter wants one', () => {
    const em = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
    });
    em.synced('INBOX');
    expect(received).toEqual([
      expect.objectContaining({ event_kind: 'synced', record_id: 'INBOX' }),
    ]);
  });
});

describe('raw escape hatch', () => {
  it('forwards a caller-shaped event, stamping `at` when omitted', () => {
    const em = createCollectionEmitter({
      bus, platform: 'webhook', slug: 'github', entityType: 'webhook_delivery',
      now: () => 42,
    });
    em.raw({
      platform: 'webhook',
      slug: 'github',
      entity_type: 'webhook_delivery.partial',
      event_kind: 'updated',
      record_id: 'd-1',
    });
    expect(received).toEqual([{
      platform: 'webhook',
      slug: 'github',
      entity_type: 'webhook_delivery.partial',
      event_kind: 'updated',
      record_id: 'd-1',
      at: 42,
    }]);
  });

  it('honors a caller-provided `at` timestamp', () => {
    const em = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
      now: () => 99,
    });
    em.raw({
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'synced',
      record_id: 'INBOX',
      at: 123,
    });
    expect(received[0].at).toBe(123);
  });
});

describe('multi-emitter isolation', () => {
  it('distinct emitters route to distinct (platform, slug, entity_type)', () => {
    const mailWork = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
    });
    const mailPersonal = createCollectionEmitter({
      bus, platform: 'mail', slug: 'personal', entityType: 'message',
    });
    const fileDownloads = createCollectionEmitter({
      bus, platform: 'file', slug: 'downloads', entityType: 'file',
    });
    mailWork.created('a');
    mailPersonal.created('b');
    fileDownloads.created('c');
    expect(received.map((e) => `${e.platform}:${e.slug}:${e.record_id}`)).toEqual([
      'mail:work:a',
      'mail:personal:b',
      'file:downloads:c',
    ]);
  });

  it('subscribe patterns can target a single emitter', () => {
    // Start with a fresh bus so the '**' subscription from beforeEach
    // doesn't observe the narrow subscriber we care about.
    bus = createWarehouseEventBus();
    const onlyWork: WarehouseEvent[] = [];
    bus.subscribe('data.mail.work.**', (e) => { onlyWork.push(e); });
    const mailWork = createCollectionEmitter({
      bus, platform: 'mail', slug: 'work', entityType: 'message',
    });
    const mailPersonal = createCollectionEmitter({
      bus, platform: 'mail', slug: 'personal', entityType: 'message',
    });
    mailWork.created('a');
    mailPersonal.created('b');
    expect(onlyWork.map((e) => e.slug)).toEqual(['work']);
  });
});
