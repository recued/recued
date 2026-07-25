import { describe, expect, it, vi } from 'vitest';

import {
  FORM_RESPONSE_CREATED_EVENT_PATTERN,
  matchesTriggerDispatchFilter,
  type FormResponse,
} from '@recued/contracts';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import {
  emitFormResponseCreatedEvents,
  toFormResponseTriggerRecord,
} from '../form-response-events.js';

const RESPONSE: FormResponse = {
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'form-1',
  definition_snapshot: {
    form_definition_id: 'form-1',
    fields: [{ name: 'secret', label: 'Secret', type: 'text' }],
  },
  values: { secret: 'visitor answer', budget: 5_000 },
  visitor: { email: 'visitor@example.test' },
  submitted_at: 1_000,
  accepted_at: 2_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: {
    template_ref: 'foundation/client-inquiry',
    private_plan: 'owner-only-plan',
  },
};

describe('accepted FormResponse event bridge', () => {
  it('fires the stable watcher path with routing metadata only', () => {
    const warehouseBus = createWarehouseEventBus();
    const seen: WarehouseEvent[] = [];
    warehouseBus.subscribe(FORM_RESPONSE_CREATED_EVENT_PATTERN, (event) => seen.push(event));
    const realtimeEmit = vi.fn();

    emitFormResponseCreatedEvents({
      warehouseBus,
      realtimeBus: { emit: realtimeEmit },
    }, RESPONSE);

    expect(seen).toEqual([{
      platform: 'form_response',
      slug: 'accepted',
      entity_type: 'response',
      event_kind: 'created',
      record_id: 'submission-1',
      at: 2_000,
      record: {
        _id: 'submission-1',
        _collection: 'form_response',
        submission_id: 'submission-1',
        endpoint_id: 'endpoint-1',
        form_definition_id: 'form-1',
        submitted_at: 1_000,
        accepted_at: 2_000,
      },
    }]);
    expect(realtimeEmit).toHaveBeenCalledOnce();
    expect(realtimeEmit).toHaveBeenCalledWith({
      kind: 'warehouse',
      collection: 'form_response',
      op: 'insert',
      id: 'submission-1',
    });

    const event = seen[0]!;
    const payload = {
      record_id: event.record_id,
      at: event.at,
      platform: event.platform,
      slug: event.slug,
      entity_type: event.entity_type,
      record: event.record,
    };
    // Load-bearing coupling guard (spec §9): a `where`-narrowed recipe lowers to
    // a `record.<field>` filter, and the dispatcher PASSES an absent path. These
    // assertions — plus the exact `record` shape pinned above — fail if the
    // emitted event ever drops `record`/its routing fields, which would silently
    // turn a narrowed recipe into an over-fire across every form.
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.form_definition_id': 'form-1' } },
      payload,
    )).toBe(true);
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.form_definition_id': 'other-form' } },
      payload,
    )).toBe(false);

    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toContain('visitor answer');
    expect(serialized).not.toContain('visitor@example.test');
    expect(serialized).not.toContain('owner-only-plan');
    expect(serialized).not.toContain('definition_snapshot');
  });

  it('never projects free-form metadata into the trigger record', () => {
    expect(toFormResponseTriggerRecord({
      ...RESPONSE,
      metadata: {
        template_ref: 'owner-authored/template',
        unrelated: 'private',
      },
    })).toEqual({
      _id: 'submission-1',
      _collection: 'form_response',
      submission_id: 'submission-1',
      endpoint_id: 'endpoint-1',
      form_definition_id: 'form-1',
      submitted_at: 1_000,
      accepted_at: 2_000,
    });
  });

  it('isolates realtime and watcher bus failures after persistence', () => {
    const warehouseEmit = vi.fn();
    const realtimeEmit = vi.fn(() => {
      throw new Error('realtime down');
    });
    expect(() => emitFormResponseCreatedEvents({
      warehouseBus: { emit: warehouseEmit } as Pick<WarehouseEventBus, 'emit'>,
      realtimeBus: { emit: realtimeEmit },
    }, RESPONSE)).not.toThrow();
    expect(warehouseEmit).toHaveBeenCalledOnce();

    const secondRealtimeEmit = vi.fn();
    expect(() => emitFormResponseCreatedEvents({
      warehouseBus: {
        emit: () => {
          throw new Error('watcher down');
        },
      },
      realtimeBus: { emit: secondRealtimeEmit },
    }, RESPONSE)).not.toThrow();
    expect(secondRealtimeEmit).toHaveBeenCalledOnce();
  });
});
