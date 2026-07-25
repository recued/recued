/** D-173 P1 § A.1 — per-kind reception projection tests.
 *
 *  Asserts the projection routes by `top_tier_kind` to the right
 *  destination (D5): task/note/commitment/project through the D-145
 *  work-entity store under the local builtin Source; contact through the
 *  `contact.upsert` path (NOT a Source). Plus idempotency (I-4) + the
 *  fail-closed branches. Runs over a real in-memory db so the Source
 *  routing + canonical write are exercised end to end. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createFormResponseStore,
  ensureFormResponseSchema,
  type FormResponseStore,
} from '../storage/form-response-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import {
  runReceptionProjection,
  type ReceptionAttachFileInput,
  type ReceptionCalendarEventInput,
  type ReceptionProjectionDeps,
} from '../ports/reception/projection/reception-projection.js';

const NOW = 1_700_000_000_000;

interface Env {
  db: Database.Database;
  workStore: WorkEntityStore;
  contactStore: ContactStore;
  formResponseStore: FormResponseStore;
  deps: ReceptionProjectionDeps;
  /** Captures every `createCalendarEvent` seam call (the calendar branch). */
  calendarCalls: ReceptionCalendarEventInput[];
  /** Captures every `attachFile` seam call (the drop file-attach branch). */
  attachCalls: ReceptionAttachFileInput[];
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureWorkEntitySchema(db);
  ensureFormResponseSchema(db);
  const workStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workStore, NOW);
  const contactStore = createContactStore(db);
  const formResponseStore = createFormResponseStore(db);
  const calendarCalls: ReceptionCalendarEventInput[] = [];
  const attachCalls: ReceptionAttachFileInput[] = [];
  const deps: ReceptionProjectionDeps = {
    workEntityStore: workStore,
    formResponseStore,
    contactDeps: { store: contactStore, now: () => NOW, origin_actor: 'user_self' },
    // Fake local-calendar create seam — records the canonical fields the
    // calendar branch resolved + returns a stable event id.
    createCalendarEvent: async (input) => {
      calendarCalls.push(input);
      return { source_id: 'evt-1' };
    },
    // Fake file-attach seam — records the (file, entity) the drop branch links.
    attachFile: async (input) => {
      attachCalls.push(input);
    },
    now: () => NOW,
  };
  return {
    db,
    workStore,
    contactStore,
    formResponseStore,
    deps,
    calendarCalls,
    attachCalls,
  };
};

let env: Env;
beforeEach(() => {
  env = buildEnv();
});
afterEach(() => {
  env.db.close();
});

describe('D-173 A.1 — runReceptionProjection routing (D5)', () => {
  it('completes a store-only form response only after exact canonical promotion', async () => {
    env.formResponseStore.accept({
      submission_id: 'submission-1',
      endpoint_id: 'endpoint-1',
      form_definition_id: 'client-intake',
      definition_snapshot: { form_definition_id: 'client-intake', fields: [] },
      values: { project: 'Launch' },
      submitted_at: NOW - 100,
      accepted_at: NOW,
    });

    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'form_response',
      id: 'submission-1',
      title: 'Client intake',
      metadata: {
        reception_form_submission_id: 'submission-1',
        reception_endpoint_id: 'endpoint-1',
        form_definition_id: 'client-intake',
      },
    });

    expect(res).toEqual({
      top_tier_kind: 'form_response',
      target_id: 'submission-1',
    });
    expect(env.workStore.countTasks()).toBe(0);
    expect(env.workStore.countNotes()).toBe(0);
    expect(env.workStore.countCommitments()).toBe(0);
  });

  it('projects a task to the local builtin task Source', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'task',
      id: 'reception_t1',
      title: 'Fix the door',
      body: 'It squeaks',
      metadata: { reception_endpoint_id: 'ep-1' },
    });
    expect(res).toEqual({ top_tier_kind: 'task', target_id: 'reception_t1' });
    const task = env.workStore.readTask('reception_t1')!;
    expect(task.title).toBe('Fix the door');
    expect(task.body).toBe('It squeaks');
    expect(task.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(task.source_extension_blob).toMatchObject({ reception_endpoint_id: 'ep-1' });
  });

  it('projects a note (body required → falls back to title)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'note',
      id: 'reception_n1',
      title: 'A standalone title',
    });
    expect(res.top_tier_kind).toBe('note');
    const note = env.workStore.readNote('reception_n1')!;
    expect(note.body).toBe('A standalone title'); // body fell back to title
    expect(note.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('note'));
  });

  it('projects a commitment as inbound / peer_received / pending', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'commitment',
      id: 'reception_c1',
      title: 'fallback',
      body: 'I will send the contract',
    });
    expect(res.top_tier_kind).toBe('commitment');
    const c = env.workStore.readCommitment('reception_c1')!;
    expect(c.direction).toBe('inbound');
    expect(c.derivation).toBe('peer_received');
    expect(c.lifecycle_state).toBe('pending');
    expect(c.statement).toBe('I will send the contract');
    expect(c.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('commitment'));
  });

  // ────────────────────────────────────────────────────────────
  // D-210 A.7 — booking, the primary reception destination.
  // ────────────────────────────────────────────────────────────

  it('projects a booking — NOT a task (the arm the taxonomy change needed)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'booking',
      id: 'reception_b1',
      title: 'Table for four',
      metadata: { reception_endpoint_id: 'ep-9' },
    });
    expect(res).toEqual({ top_tier_kind: 'booking', target_id: 'reception_b1' });

    const booking = env.workStore.readBooking('reception_b1')!;
    expect(booking.title).toBe('Table for four');
    expect(booking.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('booking'));
    expect(booking.source_extension_blob).toMatchObject({ reception_endpoint_id: 'ep-9' });
    // Store default, not the first enum member.
    expect(booking.lifecycle_state).toBe('confirmed');

    // ⛔ THE REGRESSION THIS PINS. Before the `booking` arm existed the switch
    // ended `case 'task': default:`, so a booking fell through and silently
    // wrote a TASK at `success: true` — the owner picked "booking" and got a
    // task. Asserting the booking exists is NOT enough to catch that: a
    // fallthrough would ALSO leave `readBooking` empty and a task present.
    expect(env.workStore.readTask('reception_b1')).toBeNull();
  });

  it('INVENTS no counterparty — the arm resolves no identity of its own', async () => {
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'booking',
      id: 'reception_b2',
      title: 'Consultation',
      metadata: { reception_endpoint_id: 'ep-2', budget: '$5k' },
    });
    const booking = env.workStore.readBooking('reception_b2')!;
    // `counterparty_contact_id` stays empty until something resolves an OPAQUE
    // contact id. The intake path has none, so the arm must not manufacture one
    // (e.g. from an email) — `data.booking` is grantable.
    expect(booking.counterparty_contact_id ?? null).toBeNull();

    // ⚠ THIS TEST DELIBERATELY DOES NOT FEED A `visitor_email` INTO `metadata`.
    // An earlier version did, and asserted only that the counterparty was
    // empty — which read as "the arm strips sealed PII" while the email in fact
    // landed verbatim in `source_extension_blob` one field over. The fixture
    // was also unreachable: `buildEntityShape` (intake-form-processor.ts) is
    // where the seal is enforced, and it copies ONLY
    // `fields_to_attach_as_metadata` plus three provenance ids — never the
    // substrate-injected `visitor_email`, which stays in
    // `visitor_email_encrypted` behind the D-138 gate. Metadata reaching this
    // arm is already sanitized; asserting otherwise here would claim a
    // guarantee this code does not make and cannot make.
    // ⇒ [[feedback_a_green_test_over_a_hollow_seam]]
    expect(booking.source_extension_blob).toMatchObject({ budget: '$5k' });
  });

  it('projects a project (body → description)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'project',
      id: 'reception_p1',
      title: 'Launch plan',
      body: 'Q3 launch',
    });
    expect(res.top_tier_kind).toBe('project');
    const p = env.workStore.readProject('reception_p1')!;
    expect(p.title).toBe('Launch plan');
    expect(p.description).toBe('Q3 launch');
    expect(p.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('project'));
  });

  it('projects a contact via contact.upsert (NOT a Source)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'contact',
      id: 'reception_x1', // ignored for contact
      title: 'ignored',
      contact_email: 'Visitor@Example.com',
      contact_name: 'Visitor',
    });
    expect(res.top_tier_kind).toBe('contact');
    // The contact is keyed on canonical (lowercased) email.
    const contact = env.contactStore.get('visitor@example.com')!;
    expect(contact).not.toBeNull();
    expect(contact.name).toBe('Visitor');
    // No contact Source was registered — the write bypassed the registry.
    expect(env.workStore.listSources('contact')).toHaveLength(0);
    expect(res.target_id).toBe(contact.contact_id ?? 'visitor@example.com');
  });

  it('honors an explicit external Source id for write-back (D6)', async () => {
    // Register an external task Source so the write resolves against it.
    env.workStore.registerSource({
      id: 'ext.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'External tasks',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'task',
      id: 'reception_t_ext',
      title: 'External task',
      source_id: 'ext.task',
    });
    expect(env.workStore.readTask(res.target_id)!.source_id).toBe('ext.task');
  });
});

describe('D-173 — commitment due-time + slot guard (generic, D7 / I-7)', () => {
  // Scheduling now materializes a calendar event (P4.3); the commitment branch
  // keeps `promised_for_at` (the approval pack's dated commitments) + the
  // generic `reject_if_slot_past` guard any dated-commitment caller can opt
  // into. These exercise that shared guard through the commitment branch.
  const FUTURE = NOW + 86_400_000; // +1 day

  it('maps promised_for_at onto the commitment (D7)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'commitment',
      id: 'reception_b1',
      title: 'Booking with Alex',
      body: 'Booking with Alex — design review',
      promised_for_at: FUTURE,
      reject_if_slot_past: true,
    });
    expect(res.top_tier_kind).toBe('commitment');
    const c = env.workStore.readCommitment('reception_b1')!;
    expect(c.promised_for_at).toBe(FUTURE);
    expect(c.statement).toBe('Booking with Alex — design review');
    expect(c.direction).toBe('inbound');
    expect(c.derivation).toBe('peer_received');
  });

  it('refuses to materialize a past slot when reject_if_slot_past is set (I-7)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'commitment',
        id: 'reception_past',
        title: 'Late booking',
        promised_for_at: NOW - 1, // already in the past relative to deps.now()
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/past/);
    // Nothing materialized — I-7.
    expect(env.workStore.readCommitment('reception_past')).toBeNull();
  });

  it('a slot exactly at now is treated as past (<= guard)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'commitment',
        id: 'reception_now',
        title: 'Now booking',
        promised_for_at: NOW,
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/past/);
  });

  it('refuses a scheduling booking whose slot edit cleared the time (fail-closed, I-7)', async () => {
    // The slot is editable at the gate; clearing it (the webclient returns
    // undefined for a non-required datetime) must NOT slip past the guard and
    // book a timeless commitment — that would also let a slot that passed
    // while held materialize. reject_if_slot_past + no resolvable time = refuse.
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'commitment',
        id: 'reception_notime',
        title: 'Slot cleared at approve',
        reject_if_slot_past: true,
        // promised_for_at intentionally absent
      }),
    ).rejects.toThrow(/no resolvable slot time/);
    expect(env.workStore.readCommitment('reception_notime')).toBeNull();
  });

  it('refuses a scheduling booking whose slot edit is unparseable junk (fail-closed, I-7)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'commitment',
        id: 'reception_junk',
        title: 'Garbage slot',
        promised_for_at: 'not-a-date' as unknown as number,
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/no resolvable slot time/);
    expect(env.workStore.readCommitment('reception_junk')).toBeNull();
  });

  it('a commitment WITHOUT the scheduling flag may be undated (no slot guard)', async () => {
    // Non-scheduling commitments (e.g. an approval with no due date) are
    // allowed to materialize with no promised_for_at.
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'commitment',
      id: 'reception_undated',
      title: 'No due date',
    });
    expect(res.top_tier_kind).toBe('commitment');
    expect(env.workStore.readCommitment('reception_undated')!.promised_for_at).toBeUndefined();
  });

  it('a past promised_for_at WITHOUT the scheduling flag is allowed (overdue commitment)', async () => {
    // Non-scheduling commitments (e.g. an overdue approval) may legitimately
    // carry a past due time — the guard only fires for reject_if_slot_past.
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'commitment',
      id: 'reception_overdue',
      title: 'Overdue promise',
      promised_for_at: NOW - 86_400_000,
    });
    expect(res.top_tier_kind).toBe('commitment');
    expect(env.workStore.readCommitment('reception_overdue')!.promised_for_at).toBe(NOW - 86_400_000);
  });

  it('coerces an ISO-string promised_for_at to epoch ms (robust input)', async () => {
    const iso = new Date(FUTURE).toISOString();
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'commitment',
      id: 'reception_iso',
      title: 'String-slot booking',
      // An inbox edit could hand a string; the projection coerces it.
      promised_for_at: iso as unknown as number,
      reject_if_slot_past: true,
    });
    expect(env.workStore.readCommitment('reception_iso')!.promised_for_at).toBe(FUTURE);
  });
});

describe('D-173 P4.3 — scheduling calendar event (slot → start/end, D7 amended / I-7)', () => {
  const FUTURE = NOW + 86_400_000; // +1 day

  it('materializes a calendar event (start_at + duration → end_at, summary, tz)', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'calendar.event',
      id: 'reception_b1',
      title: 'Booking with Alex — design review',
      start_at: FUTURE,
      duration_minutes: 45,
      timezone: 'America/New_York',
      booking_request_id: 'req-1',
      reject_if_slot_past: true,
    });
    expect(res).toEqual({ top_tier_kind: 'calendar.event', target_id: 'evt-1' });
    expect(env.calendarCalls).toHaveLength(1);
    expect(env.calendarCalls[0]).toEqual({
      booking_request_id: 'req-1',
      summary: 'Booking with Alex — design review',
      start_at: FUTURE,
      end_at: FUTURE + 45 * 60_000, // start + duration (so an edited start shifts the end)
      timezone: 'America/New_York',
    });
  });

  it('defaults the duration (30 min) when none is supplied', async () => {
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'calendar.event',
      id: 'reception_b2',
      title: 'No-duration booking',
      start_at: FUTURE,
      reject_if_slot_past: true,
    });
    expect(env.calendarCalls[0]!.end_at).toBe(FUTURE + 30 * 60_000);
  });

  it('defaults the timezone to UTC when none is supplied', async () => {
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'calendar.event',
      id: 'reception_b3',
      title: 'No-tz booking',
      start_at: FUTURE,
      duration_minutes: 30,
    });
    expect(env.calendarCalls[0]!.timezone).toBe('UTC');
  });

  it('passes the body through as the event description when present', async () => {
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'calendar.event',
      id: 'reception_b4',
      title: 'Booking',
      body: 'Bring the deck',
      start_at: FUTURE,
    });
    expect(env.calendarCalls[0]!.description).toBe('Bring the deck');
  });

  it('refuses a past slot when reject_if_slot_past is set (I-7) — no event created', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'calendar.event',
        id: 'reception_past',
        title: 'Late booking',
        start_at: NOW - 1,
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/past/);
    expect(env.calendarCalls).toHaveLength(0);
  });

  it('a slot exactly at now is treated as past (<= guard)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'calendar.event',
        id: 'reception_now',
        title: 'Now booking',
        start_at: NOW,
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/past/);
    expect(env.calendarCalls).toHaveLength(0);
  });

  it('refuses a cleared / malformed slot edit when reject_if_slot_past (fail-closed, I-7)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'calendar.event',
        id: 'reception_notime',
        title: 'Slot cleared at approve',
        reject_if_slot_past: true,
        // start_at intentionally absent
      }),
    ).rejects.toThrow(/no resolvable slot time/);
    expect(env.calendarCalls).toHaveLength(0);
  });

  it('requires a start time even without the past-slot guard', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'calendar.event',
        id: 'reception_nostart',
        title: 'No start',
        // start_at absent, reject_if_slot_past unset
      }),
    ).rejects.toThrow(/requires a start time/);
    expect(env.calendarCalls).toHaveLength(0);
  });

  it('fail-closes when no createCalendarEvent seam is wired', async () => {
    const depsNoCalendar: ReceptionProjectionDeps = {
      workEntityStore: env.workStore,
      now: () => NOW,
    };
    await expect(
      runReceptionProjection(depsNoCalendar, {
        top_tier_kind: 'calendar.event',
        id: 'reception_noseam',
        title: 'No seam',
        start_at: FUTURE,
        reject_if_slot_past: true,
      }),
    ).rejects.toThrow(/requires the createCalendarEvent seam/);
  });
});

describe('D-173 P5 — drop file attach (a task with the file attached)', () => {
  it('writes the task then attaches the file via the seam', async () => {
    const res = await runReceptionProjection(env.deps, {
      top_tier_kind: 'task',
      id: 'reception_drop1',
      title: 'contract.pdf',
      body: 'From Alex: signed',
      file_id: 'file:abc123',
    });
    expect(res).toEqual({ top_tier_kind: 'task', target_id: 'reception_drop1' });
    // The task was written...
    const task = env.workStore.readTask('reception_drop1')!;
    expect(task.title).toBe('contract.pdf');
    expect(task.body).toBe('From Alex: signed');
    // ...and the file attached to it (entity = task, by id).
    expect(env.attachCalls).toEqual([
      { file_id: 'file:abc123', to_collection: 'task', to_id: 'reception_drop1' },
    ]);
  });

  it('a work-entity projection WITHOUT a file_id never attaches', async () => {
    await runReceptionProjection(env.deps, {
      top_tier_kind: 'task',
      id: 'reception_plain',
      title: 'No file',
    });
    expect(env.attachCalls).toHaveLength(0);
  });

  it('fail-closes BEFORE writing the task when a file_id is present but no seam (no partial materialize)', async () => {
    const depsNoAttach: ReceptionProjectionDeps = {
      workEntityStore: env.workStore,
      now: () => NOW,
    };
    await expect(
      runReceptionProjection(depsNoAttach, {
        top_tier_kind: 'task',
        id: 'reception_noattach',
        title: 'Has file, no seam',
        file_id: 'file:xyz',
      }),
    ).rejects.toThrow(/no attachFile seam/);
    // The guard fires BEFORE the work-entity write — no orphan task without
    // its file (both land or neither).
    expect(env.workStore.readTask('reception_noattach')).toBeNull();
  });
});

describe('D-173 A.1 — runReceptionProjection idempotency (I-4)', () => {
  it('a repeat work-entity projection on the same id is a no-op (overwrite, no duplicate)', async () => {
    const input = {
      top_tier_kind: 'commitment' as const,
      id: 'reception_dup',
      title: 'x',
      body: 'first',
    };
    await runReceptionProjection(env.deps, input);
    await runReceptionProjection(env.deps, { ...input, body: 'second' });
    expect(env.workStore.countCommitments()).toBe(1);
    expect(env.workStore.readCommitment('reception_dup')!.statement).toBe('second');
  });

  it('a repeat contact projection on the same email is idempotent', async () => {
    const input = {
      top_tier_kind: 'contact' as const,
      id: 'ignored',
      title: 'x',
      contact_email: 'dup@example.com',
    };
    await runReceptionProjection(env.deps, input);
    await runReceptionProjection(env.deps, input);
    expect(env.contactStore.count()).toBe(1);
  });
});

describe('D-173 A.1 — runReceptionProjection fail-closed branches', () => {
  it('refuses a store-only response when canonical promotion did not run', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'form_response',
        id: 'missing-submission',
        title: 'Client intake',
        metadata: {
          reception_form_submission_id: 'missing-submission',
          reception_endpoint_id: 'endpoint-1',
          form_definition_id: 'client-intake',
        },
      }),
    ).rejects.toThrow(/was not promoted/);
  });

  it('refuses a store-only response whose immutable provenance does not match', async () => {
    env.formResponseStore.accept({
      submission_id: 'submission-1',
      endpoint_id: 'endpoint-1',
      form_definition_id: 'client-intake',
      definition_snapshot: { form_definition_id: 'client-intake', fields: [] },
      values: {},
      submitted_at: NOW - 100,
      accepted_at: NOW,
    });
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'form_response',
        id: 'submission-1',
        title: 'Client intake',
        metadata: {
          reception_form_submission_id: 'submission-1',
          reception_endpoint_id: 'other-endpoint',
          form_definition_id: 'client-intake',
        },
      }),
    ).rejects.toThrow(/provenance does not match/);
  });

  it('refuses a canonical-store lookup that returns a different submission id', async () => {
    env.formResponseStore.accept({
      submission_id: 'other-submission',
      endpoint_id: 'endpoint-1',
      form_definition_id: 'client-intake',
      definition_snapshot: { form_definition_id: 'client-intake', fields: [] },
      values: {},
      submitted_at: NOW - 100,
      accepted_at: NOW,
    });
    const wrongResponse = env.formResponseStore.findById('other-submission')!;

    await expect(
      runReceptionProjection(
        {
          ...env.deps,
          formResponseStore: { findById: () => wrongResponse },
        },
        {
          top_tier_kind: 'form_response',
          id: 'submission-1',
          title: 'Client intake',
          metadata: {
            reception_form_submission_id: 'submission-1',
            reception_endpoint_id: 'endpoint-1',
            form_definition_id: 'client-intake',
          },
        },
      ),
    ).rejects.toThrow(/provenance does not match/);
  });

  it('refuses a store-only response when the canonical store is unavailable', async () => {
    await expect(
      runReceptionProjection(
        { workEntityStore: env.workStore, now: () => NOW },
        {
          top_tier_kind: 'form_response',
          id: 'submission-1',
          title: 'Client intake',
          metadata: {
            reception_form_submission_id: 'submission-1',
            reception_endpoint_id: 'endpoint-1',
            form_definition_id: 'client-intake',
          },
        },
      ),
    ).rejects.toThrow(/requires the canonical FormResponse store/);
  });

  it('throws on an unsupported top_tier_kind (no local materialize path)', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'mail_message',
        id: 'reception_m1',
        title: 'x',
      }),
    ).rejects.toThrow(/not locally materializable/);
  });

  it('throws when a contact projection has no contactDeps (D5)', async () => {
    const depsNoContact: ReceptionProjectionDeps = {
      workEntityStore: env.workStore,
      now: () => NOW,
    };
    await expect(
      runReceptionProjection(depsNoContact, {
        top_tier_kind: 'contact',
        id: 'x',
        title: 'x',
        contact_email: 'a@b.com',
      }),
    ).rejects.toThrow(/requires contactDeps/);
  });

  it('throws when a contact projection has no email', async () => {
    await expect(
      runReceptionProjection(env.deps, {
        top_tier_kind: 'contact',
        id: 'x',
        title: 'x',
      }),
    ).rejects.toThrow(/requires a contact_email/);
  });
});
