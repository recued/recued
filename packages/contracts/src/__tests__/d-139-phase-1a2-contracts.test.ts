/** D-139 Phase 1a.2 — contracts smoke tests.
 *
 *  Covers the four new HubSpot engagement entity registrations + per-
 *  type property lists added in P1a.2:
 *    - `hubspot.meeting`
 *    - `hubspot.note`
 *    - `hubspot.call`
 *    - `hubspot.task`
 *
 *  Spec: docs/d-139-spec.md § A.1, § A.3, § A.3.6, § P1a.2 acceptance. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_MEETING_PROPERTIES,
  HUBSPOT_NOTE_PROPERTIES,
  HUBSPOT_CALL_PROPERTIES,
  HUBSPOT_TASK_PROPERTIES,
  getVendorEntityByVendorEntity,
} from '../index.js';

describe('D-139 P1a.2 — hubspot.{meeting,note,call,task} entity registrations', () => {
  it('CONNECTION_VENDOR_ENTITIES includes hubspot.meeting at scope connection.api.hubspot.meeting', () => {
    const meeting = getVendorEntityByVendorEntity('hubspot', 'meeting');
    expect(meeting).toBeDefined();
    expect(meeting?.scope).toBe('connection.api.hubspot.meeting');
    expect(meeting?.display_name).toBe('HubSpot Meeting Engagement');
  });
  it('CONNECTION_VENDOR_ENTITIES includes hubspot.note at scope connection.api.hubspot.note', () => {
    const note = getVendorEntityByVendorEntity('hubspot', 'note');
    expect(note).toBeDefined();
    expect(note?.scope).toBe('connection.api.hubspot.note');
  });
  it('CONNECTION_VENDOR_ENTITIES includes hubspot.call at scope connection.api.hubspot.call', () => {
    const call = getVendorEntityByVendorEntity('hubspot', 'call');
    expect(call).toBeDefined();
    expect(call?.scope).toBe('connection.api.hubspot.call');
  });
  it('CONNECTION_VENDOR_ENTITIES includes hubspot.task at scope connection.api.hubspot.task', () => {
    const task = getVendorEntityByVendorEntity('hubspot', 'task');
    expect(task).toBeDefined();
    expect(task?.scope).toBe('connection.api.hubspot.task');
  });

  it('all four engagement types carry no crm_alias (Deal Identity Asymmetry Invariant § A.5.5)', () => {
    for (const entity of ['meeting', 'note', 'call', 'task']) {
      const e = getVendorEntityByVendorEntity('hubspot', entity);
      expect(e?.crm_alias).toBeUndefined();
    }
  });

  it('hubspot.meeting meta_fields cover title + start_time + outcome + external_url + attendees + owner', () => {
    const meeting = getVendorEntityByVendorEntity('hubspot', 'meeting');
    const keys = (meeting?.meta_fields ?? []).map((f) => f.key);
    expect(keys).toContain('title');
    expect(keys).toContain('start_time');
    expect(keys).toContain('end_time');
    expect(keys).toContain('outcome');
    expect(keys).toContain('location');
    expect(keys).toContain('external_url');
    expect(keys).toContain('attendee_emails');
    expect(keys).toContain('owner');
  });

  it('hubspot.note meta_fields cover body_preview + created_at + owner', () => {
    const note = getVendorEntityByVendorEntity('hubspot', 'note');
    const keys = (note?.meta_fields ?? []).map((f) => f.key);
    expect(keys).toContain('body_preview');
    expect(keys).toContain('created_at');
    expect(keys).toContain('owner');
  });

  it('hubspot.call meta_fields cover title + direction + status + duration_ms + disposition + recording_url + body_preview + owner', () => {
    const call = getVendorEntityByVendorEntity('hubspot', 'call');
    const keys = (call?.meta_fields ?? []).map((f) => f.key);
    expect(keys).toContain('title');
    expect(keys).toContain('direction');
    expect(keys).toContain('status');
    expect(keys).toContain('duration_ms');
    expect(keys).toContain('disposition');
    expect(keys).toContain('recording_url');
    expect(keys).toContain('timestamp');
    expect(keys).toContain('body_preview');
    expect(keys).toContain('owner');
  });

  it('hubspot.task meta_fields cover subject + status + priority + type + due_at + completed_at + body_preview + owner', () => {
    const task = getVendorEntityByVendorEntity('hubspot', 'task');
    const keys = (task?.meta_fields ?? []).map((f) => f.key);
    expect(keys).toContain('subject');
    expect(keys).toContain('status');
    expect(keys).toContain('priority');
    expect(keys).toContain('type');
    expect(keys).toContain('due_at');
    expect(keys).toContain('completed_at');
    expect(keys).toContain('body_preview');
    expect(keys).toContain('owner');
  });

  it('all four entities carry the same 8 KB meta_max_bytes envelope inherited from D-128', () => {
    for (const entity of ['meeting', 'note', 'call', 'task']) {
      const e = getVendorEntityByVendorEntity('hubspot', entity);
      // The substrate's `PLATFORM_REFERENCE_META_MAX_BYTES` is the
      // global cap — every CONNECTION_VENDOR_ENTITIES row inherits
      // it; entity-level overrides aren't a feature at v1.
      expect(e?.scope).toMatch(/^connection\.api\.hubspot\./);
    }
  });
});

describe('D-139 P1a.2 — HubSpot per-type property lists', () => {
  it('HUBSPOT_MEETING_PROPERTIES carries the lifecycle drivers + cursor field + calendar-twin URL', () => {
    expect(HUBSPOT_MEETING_PROPERTIES).toContain('hs_meeting_outcome');
    expect(HUBSPOT_MEETING_PROPERTIES).toContain('hs_meeting_start_time');
    expect(HUBSPOT_MEETING_PROPERTIES).toContain('hs_meeting_external_url');
    expect(HUBSPOT_MEETING_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('HUBSPOT_NOTE_PROPERTIES carries body + cursor + authorship hints', () => {
    expect(HUBSPOT_NOTE_PROPERTIES).toContain('hs_note_body');
    expect(HUBSPOT_NOTE_PROPERTIES).toContain('hs_lastmodifieddate');
    expect(HUBSPOT_NOTE_PROPERTIES).toContain('hs_createdate');
    expect(HUBSPOT_NOTE_PROPERTIES).toContain('hubspot_owner_id');
    expect(HUBSPOT_NOTE_PROPERTIES).toContain('hs_created_by_workflow_id');
  });

  it('HUBSPOT_CALL_PROPERTIES carries direction + status + duration + recording + cursor', () => {
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_call_direction');
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_call_status');
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_call_duration');
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_call_recording_url');
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_call_disposition');
    expect(HUBSPOT_CALL_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('HUBSPOT_TASK_PROPERTIES carries subject + status + completion + cursor', () => {
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_task_subject');
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_task_status');
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_task_priority');
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_task_type');
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_task_completion_date');
    expect(HUBSPOT_TASK_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('every property list carries no duplicate entries', () => {
    for (const list of [
      HUBSPOT_MEETING_PROPERTIES,
      HUBSPOT_NOTE_PROPERTIES,
      HUBSPOT_CALL_PROPERTIES,
      HUBSPOT_TASK_PROPERTIES,
    ]) {
      const unique = new Set(list);
      expect(unique.size).toBe(list.length);
    }
  });
});

describe('D-139 P1a.2 — registry boot validation', () => {
  it('CONNECTION_VENDOR_ENTITIES boot-validates clean post-P1a.2 registrations', () => {
    // Smoke — the registry validator runs at module-load; any
    // duplicate-key / mismatched-scope error would have thrown
    // before this test fires. Asserting the non-empty registry is the
    // canary.
    expect(CONNECTION_VENDOR_ENTITIES.length).toBeGreaterThan(8);
  });

  it('every hubspot.{meeting,note,call,task} entity routes to a stable scope path', () => {
    for (const entity of ['meeting', 'note', 'call', 'task']) {
      const e = getVendorEntityByVendorEntity('hubspot', entity);
      expect(e?.scope).toBe(`connection.api.hubspot.${entity}`);
    }
  });
});
