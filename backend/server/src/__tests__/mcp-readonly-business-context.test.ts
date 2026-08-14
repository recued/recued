import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { RECUED_BUILTIN_SOURCE_ID, type CanonicalEvent } from '@recued/contracts';

import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { resolveContactBusinessContext } from '../contact-business-context.js';
import {
  createMcpReadonlyBusinessContextReaders,
} from '../mcp-readonly-business-context.js';
import { createContactStore } from '../storage/contact-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
} from '../storage/work-entity-store.js';

describe('standalone MCP business-context readers', () => {
  it('reads shared stores and sees a calendar enrolled after MCP composition', () => {
    const db = new Database(':memory:');
    try {
      const readers = createMcpReadonlyBusinessContextReaders(db);
      // Simulate writes owned by the serve process through separate handles.
      const contacts = createContactStore(db);
      ensureWorkEntitySchema(db);
      const workEntities = createWorkEntityStore(db);
      const contact = contacts.upsertManual({
        email: 'ada@example.test',
        first_seen: 100,
      }, 100);
      workEntities.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID('task'),
        top_tier_kind: 'task',
        source_kind: 'builtin',
        source_label: 'Recued tasks',
        write_capable: true,
        registered_at: 100,
      });
      workEntities.writeTask({
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 'not projected',
        assigned_contact_id: contact.email,
      }, 200);

      // Enrol after reader construction to pin the dynamic table-only view.
      createInstanceStore({ db }).upsert({
        platform: 'calendar',
        slug: 'work',
        adapter_type: 'gcal',
        config: {},
        caps: {
          read: 'yes',
          list_calendars: 'yes',
          create_event: 'yes',
          update_event: 'yes',
          delete_event: 'yes',
          rsvp: 'yes',
          search: 'remote',
          watch: 'poll',
          auth: 'oauth',
          recurrence: 'server',
        },
        auth_state: 'healthy',
        last_synced_at: 300,
      });
      const calendar = createCalendarTable({ db, slug: 'work' });
      const event: CanonicalEvent = {
        source_id: 'event-1',
        ical_uid: 'event-1@example.test',
        calendar_id: 'primary',
        summary: 'not projected',
        organizer: { email: contact.email },
        start_at: 1_000,
        end_at: 2_000,
        timezone: 'UTC',
        is_all_day: false,
        status: 'confirmed',
        created_at: 100,
        updated_at: 300,
      };
      calendar.upsert({ event, size_bytes: 0, now: 300 });

      const output = resolveContactBusinessContext({
        contacts: readers.contacts,
        workEntities: readers.workEntities,
        calendars: readers.calendars,
      }, { email: contact.email, as_of: 500, known_before_at: 500 });

      expect(output.tasks.active_count).toBe(1);
      expect(output.calendar.active_count).toBe(1);
      expect(output.calendar.coverage).toBe('partial');
      expect(output.active_families).toEqual(['tasks', 'calendar']);
      expect(JSON.stringify(output)).not.toContain('not projected');
    } finally {
      db.close();
    }
  });
});
