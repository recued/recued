/** D-320 ruling 20 — a CRM record a trigger hands a recipe says which connection it
 *  came from, as a search's rows do: `connection_name`, and `target_id` (D-190), the
 *  id a later step routes by. Added where the event becomes the recipe's context,
 *  so the poll's stored records, which it hashes to see what changed, stay as they
 *  are, and the poll's and the reconciler's events read the same. */

import { describe, expect, it } from 'vitest';
import type { WarehouseEvent } from '@recued/warehouse-events';

import { triggerEventContext } from '../triggers/event-context.js';

const payloadOf = (event: WarehouseEvent) =>
  (triggerEventContext('t', event).event as { payload: Record<string, unknown> }).payload;

const deal = (over: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'connection.api.hubspot.deal',
  slug: 'hubspot-key',
  entity_type: 'deal',
  event_kind: 'updated',
  record_id: '11',
  at: 1,
  prev: { id: '11', stage: 'open' },
  record: { id: '11', stage: 'won' },
  changed_fields: ['stage'],
  ...over,
});

describe('D-320 ruling 20 — a trigger\'s CRM record names its connection', () => {
  it("a polled record (the vendor's id): its record and prev carry both, beside its fields", () => {
    const payload = payloadOf(deal());
    expect(payload.record).toEqual({
      target_id: 'hubspot_deal_hubspot-key_11',
      connection_name: 'hubspot-key',
      id: '11',
      stage: 'won',
    });
    expect(payload.prev).toMatchObject({ target_id: 'hubspot_deal_hubspot-key_11', connection_name: 'hubspot-key' });
    // The pointer fields and the change list are as they were.
    expect(payload).toMatchObject({ record_id: '11', slug: 'hubspot-key', changed_fields: ['stage'] });
  });

  it("a reconciled record (the composed id) keeps its own, and a deleted one's prev says it too", () => {
    const composed = 'hubspot_deal_hubspot-key_11';
    expect(payloadOf(deal({ record_id: composed })).record).toMatchObject({ target_id: composed, connection_name: 'hubspot-key' });
    const deleted = payloadOf(deal({ record_id: composed, event_kind: 'deleted', record: undefined }));
    expect(deleted.prev).toMatchObject({ target_id: composed });
    expect(deleted).not.toHaveProperty('record');
  });

  it('never guesses: a composed id naming another connection gets no target_id', () => {
    const record = payloadOf(deal({ record_id: 'hubspot_deal_hubspot-app_11' })).record as Record<string, unknown>;
    expect(record).not.toHaveProperty('target_id');
    expect(record.connection_name).toBe('hubspot-key');
  });

  it('a kind the D-190 parser does not read names its connection only', () => {
    const record = payloadOf(deal({ platform: 'connection.api.hubspot.ticket', entity_type: 'ticket' })).record as Record<string, unknown>;
    expect(record).not.toHaveProperty('target_id');
    expect(record.connection_name).toBe('hubspot-key');
  });

  it("a record's own field wins", () => {
    const record = payloadOf(deal({ record: { id: '11', connection_name: 'its-own' } })).record;
    expect(record).toMatchObject({ connection_name: 'its-own', target_id: 'hubspot_deal_hubspot-key_11' });
  });

  it('anything not a CRM connection is untouched', () => {
    const mail = { id: 'm-1', subject: 'Hi' };
    expect(payloadOf(deal({ platform: 'mail', slug: 'work', entity_type: 'message', record: mail })).record).toEqual(mail);
    expect(payloadOf(deal({ platform: 'connection.mcp.files.x' })).record).toEqual({ id: '11', stage: 'won' });
  });

  it("does not touch the event itself (the poll's snapshot, a stored event)", () => {
    const event = deal();
    payloadOf(event);
    expect(event.record).toEqual({ id: '11', stage: 'won' });
    expect(event.prev).toEqual({ id: '11', stage: 'open' });
  });
});
