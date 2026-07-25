/** D-210 R-2 slice 3b — the scheduling drain resolves pair-else-default.
 *
 *  Until this slice `scheduling_link` could only take the contract-free `{reactive, system}`
 *  dispatch into the pack's compiled recipe, so the booking flow ran with no door, no grants
 *  and no dish (D-210 §3). Here the drain asks whose recipe owns the endpoint first: the
 *  owner's paired one (under the door's contract) when there is one, the pack's compiled
 *  DEFAULT when there is not — `PACK_SLUG_FOR_KIND` demoted, never deleted.
 *
 *  These tests drive the REAL resolver, the REAL contracts deriver and the REAL pair store
 *  over an in-memory DB, wired exactly as `wire-reception-substrate` wires them. Only the
 *  two IO seams are faked (the paired run, the default dispatch) — a fake resolver would
 *  prove the processor calls something, not that the pair rule holds
 *  ([[test_real_gate_not_mock_for_admission]]).
 *
 *  The properties under test, in the order they matter:
 *    - unpaired ⇒ byte-identical pre-D-210 behaviour (the calendar payload, the default seam),
 *    - paired ⇒ the owner's recipe receives the booking RECORD, and the default never fires,
 *    - the record's key set IS the digest subject (`omit` ⇒ absent; declared-blank ⇒ null),
 *    - every uncertain state HOLDS rather than falling to the default (stale, no seam, no
 *      door, a failed run, a form pair on a scheduling endpoint, an unparseable config),
 *    - a failed paired run must NOT free the slot. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  receptionPairBinding,
  receptionSchedulingPairBinding,
  type RecipeDefinition,
  type SchedulingLinkConfig,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
// D-210 A.8 slice 4b-ii — a booking is a `reception_form_submission` row with a
// slot; `reception_booking_request` has no writer any more.
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createReceptionIntakeRecipePairStore,
  type ReceptionIntakeRecipePairStore,
} from '../storage/reception-intake-recipe-pair-store.js';
// ⚠ The FORM key, not the booking one, and ONE blob instead of four columns —
// the row's readers open with `openFormSubmissionField` (`booking-blob.ts`).
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { sealBookingSubmissionBlob } from '../ports/reception/booking-blob.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createSchedulingLinkSubmissionProcessor } from '../ports/reception/processors/scheduling-link-processor.js';
import type {
  PairedBookingRunOutcome,
  RunPairedBooking,
} from '../ports/reception/processors/scheduling-link-processor.js';
import { resolveReceptionSchedulingRecipePair } from '../ports/reception/scheduling-recipe-pair.js';
import { deriveReceptionSchedulingRecipePairBinding } from '../reception-scheduling-recipe-pair-derivation.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const BOOKING_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));
const WRONG_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x77));

/** A recipe the real `parseRecipe` accepts — the deriver runs it through the standard
 *  parser before hashing, exactly as the intake deriver does, so a shape the parser rejects
 *  would make every paired test hold for the wrong reason. */
const recipe = (recipe_id: string, version: number, note = 'a'): RecipeDefinition => ({
  recipe_id,
  version,
  ttl: 300,
  metadata: {
    name: 'Booking handler',
    description: `Handles a booking (${note})`,
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
} as unknown as RecipeDefinition);

interface Env {
  registry: PublicEndpointRegistryStore;
  booking: FormSubmissionStore;
  pairs: ReceptionIntakeRecipePairStore;
  recipes: Map<string, RecipeDefinition>;
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return {
    registry: createPublicEndpointRegistryStore(db),
    booking: createReceptionFormSubmissionStore(db),
    pairs: createReceptionIntakeRecipePairStore(db),
    recipes: new Map(),
  };
};

const VISITOR_FIELDS: SchedulingLinkConfig['required_visitor_fields'] = {
  name: 'required',
  email: 'required',
  topic: 'optional',
  phone: 'omit',
  notes: 'omit',
};

const minimalConfig = (over: Partial<SchedulingLinkConfig> = {}): SchedulingLinkConfig => ({
  display_name: 'Mary Smith',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 0, end_minute: 1440 }],
  },
  required_visitor_fields: VISITOR_FIELDS,
  min_advance_notice_hours: 1,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
  ...over,
});

const seedEndpoint = (
  env: Env,
  endpoint_id: string,
  metadata: SchedulingLinkConfig | Readonly<Record<string, unknown>> = minimalConfig(),
): void => {
  env.registry.create({
    endpoint_id,
    kind: 'scheduling_link',
    packet_declaration: {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: metadata as Readonly<Record<string, unknown>>,
  });
  env.registry.enable(endpoint_id, NOW);
};

/** Bind the endpoint to a recipe with a REAL v3 binding, derived from the same sources the
 *  resolver will re-derive from. Nothing here hand-writes a `pair_revision`. */
const bindScheduling = (
  env: Env,
  endpoint_id: string,
  r: RecipeDefinition,
  fields: SchedulingLinkConfig['required_visitor_fields'] = VISITOR_FIELDS,
): void => {
  env.recipes.set(r.recipe_id, r);
  const binding = receptionSchedulingPairBinding({
    required_visitor_fields: fields,
    recipe: r,
  });
  if (binding === null) throw new Error('test fixture: v3 binding did not derive');
  env.pairs.upsert({ endpoint_id, binding, now: NOW - 100 });
};

const insertBooking = async (
  env: Env,
  input: {
    request_id: string;
    endpoint_id: string;
    slot_start_at: number;
    visitor_name?: string | null;
    visitor_email?: string | null;
    visitor_phone?: string | null;
    visitor_topic?: string | null;
    visitor_notes?: string | null;
    duration_minutes?: number;
    key?: Uint8Array;
  },
): Promise<void> => {
  const key = input.key ?? BOOKING_KEY;
  const duration = input.duration_minutes ?? 30;
  // D-210 A.8 slice 4b-ii — ALL FIVE declared fields ride ONE
  // `submission_blob_encrypted`, `notes` included. Through 4b-i notes had no
  // column and the book handler stashed its ciphertext in `metadata_blob`; the
  // merged table's single blob absorbed both that stash and the four columns.
  // The email KEEPS its own column so the notify path can read an address
  // without unsealing the whole submission.
  env.booking.insert({
    submission_id: input.request_id,
    endpoint_id: input.endpoint_id,
    form_definition_id: null,
    submitted_at: NOW - 500,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: await sealFormSubmissionField({
      key,
      endpoint_id: input.endpoint_id,
      submission_id: input.request_id,
      field: 'visitor_email',
      plaintext: input.visitor_email ?? null,
    }),
    submission_blob_encrypted: await sealBookingSubmissionBlob({
      key,
      endpoint_id: input.endpoint_id,
      submission_id: input.request_id,
      fields: {
        name: input.visitor_name,
        email: input.visitor_email,
        phone: input.visitor_phone,
        topic: input.visitor_topic,
        notes: input.visitor_notes,
      },
    }),
    schema_version: 1,
    processing_outcome: 'pending',
    // `slot` present is what MAKES the row a booking — the store derives the
    // kind from it, and the drain's page filters on it.
    slot: {
      start_at: input.slot_start_at,
      end_at: input.slot_start_at + duration * 60_000,
      duration_minutes: duration,
    },
  });
};

interface FakeFire {
  fn: FireReceptionWorkflow;
  calls: ReceptionWorkflowDispatch[];
}
const fakeFire = (result: { dispatched: boolean } = { dispatched: true }): FakeFire => {
  const calls: ReceptionWorkflowDispatch[] = [];
  return { calls, fn: async (d) => { calls.push(d); return result; } };
};

interface FakeRun {
  fn: RunPairedBooking;
  calls: Array<{ endpoint_id: string; request_id: string; record: Record<string, unknown> }>;
}
const fakeRun = (outcome: PairedBookingRunOutcome = { kind: 'held' }): FakeRun => {
  const calls: FakeRun['calls'] = [];
  return { calls, fn: async (i) => { calls.push(i); return outcome; } };
};

/** The REAL resolver, wired the way `wire-reception-substrate` wires it. */
const realResolver = (env: Env) =>
  (input: Parameters<
    NonNullable<Parameters<typeof createSchedulingLinkSubmissionProcessor>[0]['resolveSchedulingRecipePair']>
  >[0]) =>
    resolveReceptionSchedulingRecipePair({
      endpoint_id: input.endpoint_id,
      required_visitor_fields: input.required_visitor_fields,
      store: env.pairs,
      getRecipe: (id) => env.recipes.get(id) ?? null,
      deriveBinding: deriveReceptionSchedulingRecipePairBinding,
    });

const processorFor = (
  env: Env,
  extra: Partial<Parameters<typeof createSchedulingLinkSubmissionProcessor>[0]> = {},
) =>
  createSchedulingLinkSubmissionProcessor({
    registryStore: env.registry,
    bookingStore: env.booking,
    getFormSubmissionPiiKey: () => BOOKING_KEY,
    now: () => NOW,
    resolveSchedulingRecipePair: realResolver(env),
    ...extra,
  });

const outcomeOf = (env: Env, request_id: string): string | undefined =>
  env.booking.findById(request_id)?.processing_outcome;

let env: Env;
beforeEach(() => {
  env = buildEnv();
});

describe('D-210 R-2 — unpaired keeps the pre-D-210 default', () => {
  it('dispatches the pack default with the booking payload and never the paired run', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      visitor_topic: 'Design review',
    });
    const fire = fakeFire();
    const run = fakeRun();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(run.calls).toHaveLength(0);
    expect(fire.calls).toHaveLength(1);
    expect(fire.calls[0]!.payload).toMatchObject({
      top_tier_kind: 'booking', // D-210 A.2 — a reservation is never a calendar event
      booking_request_id: 'req-1',
      start_at: NOW + DAY,
    });
    // The default's payload never carried the visitor email, and still does not.
    expect(JSON.stringify(fire.calls[0]!.payload)).not.toContain('alex@visitor.test');
    expect(outcomeOf(env, 'req-1')).toBe('processed');
  });

  it('an unparseable config on an UNPAIRED endpoint still dispatches the default', async () => {
    // The pre-D-210 rule: a corrupt blob does not fail the booking (the slot + PII are on
    // the row, the projection is fixed). Only a PAIRED endpoint holds on it.
    seedEndpoint(env, 'ep-1', { display_name: '' });
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });

    expect(fire.calls).toHaveLength(1);
    expect(fire.calls[0]!.payload).toMatchObject({ timezone: 'UTC' });
  });
});

describe("D-210 R-2 — paired runs the OWNER's recipe with the booking RECORD", () => {
  it('hands the record to the paired run and never fires the default', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      visitor_topic: 'Design review',
    });
    const fire = fakeFire();
    const run = fakeRun({ kind: 'held' });
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    // ⛔ The default must NOT also fire — that would be two artifacts for one booking.
    expect(fire.calls).toHaveLength(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.endpoint_id).toBe('ep-1');
    expect(run.calls[0]!.request_id).toBe('req-1');
    expect(outcomeOf(env, 'req-1')).toBe('processed');
  });

  it('the record is the form table, not the calendar projection', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      visitor_topic: 'Design review',
      duration_minutes: 30,
    });
    const run = fakeRun();
    await processorFor(env, { runPairedBooking: run.fn }).drainOnce({ now: NOW, limit: 50 });

    const record = run.calls[0]!.record;
    // The visitor's fields, in the CONFIG's vocabulary — the same words the owner sets to
    // `omit`, not the `visitor_*` storage spelling.
    expect(record.name).toBe('Alex');
    expect(record.email).toBe('alex@visitor.test');
    expect(record.topic).toBe('Design review');
    // The slot.
    expect(record.slot_start_at).toBe(NOW + DAY);
    expect(record.slot_end_at).toBe(NOW + DAY + 30 * 60_000);
    expect(record.duration_minutes).toBe(30);
    expect(record.timezone).toBe('America/New_York');
    // ⛔ NOT the default's materialize args. Where this booking goes is the recipe's call.
    expect(record.top_tier_kind).toBeUndefined();
    expect(record.booking_request_id).toBeUndefined();
    expect(record.reject_if_slot_past).toBeUndefined();
    expect(record.title).toBeUndefined();
  });

  it("the record's key set IS the digest subject: omit ⇒ absent, declared-blank ⇒ null", async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      // `topic` is declared `optional` and left blank; `phone`/`notes` are `omit`.
      visitor_topic: null,
      visitor_phone: '+15551234567',
    });
    const run = fakeRun();
    await processorFor(env, { runPairedBooking: run.fn }).drainOnce({ now: NOW, limit: 50 });

    const record = run.calls[0]!.record;
    // Declared but blank — the key EXISTS on this endpoint and is empty.
    expect('topic' in record).toBe(true);
    expect(record.topic).toBeNull();
    // `omit` — the endpoint does not collect it, so the record must not claim it exists.
    // ⚠ The visitor's phone IS on the row (sealed); the config is what keeps it out.
    expect('phone' in record).toBe(false);
    expect('notes' in record).toBe(false);
    expect(JSON.stringify(record)).not.toContain('5551234567');
  });

  // ⚠ D-210 A.8 slice 4b-ii — `notes` used to have no column and rode `metadata_blob`; it is
  // now inside `submission_blob_encrypted` with the other four. The assertion is unchanged
  // because the guarantee is: a field the config DECLARES reaches the recipe, wherever the
  // substrate happens to keep it.
  it('a declared `notes` field reaches the recipe', async () => {
    const fields = { ...VISITOR_FIELDS, notes: 'optional' as const };
    seedEndpoint(env, 'ep-1', minimalConfig({ required_visitor_fields: fields }));
    bindScheduling(env, 'ep-1', recipe('book-handler', 1), fields);
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      visitor_notes: 'Please call ahead',
    });
    const run = fakeRun();
    await processorFor(env, { runPairedBooking: run.fn }).drainOnce({ now: NOW, limit: 50 });

    expect(run.calls[0]!.record.notes).toBe('Please call ahead');
  });
});

describe('D-210 R-2 — every uncertain state HOLDS, never the default', () => {
  const expectHeld = async (fire: FakeFire, run: FakeRun, res: unknown) => {
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
    // Pending = retryable. The booking is not lost and not silently re-routed.
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  };

  it('a recipe edited after the bind is stale ⇒ hold', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    // The owner edits the recipe; the stored binding's digest no longer re-derives.
    env.recipes.set('book-handler', recipe('book-handler', 2, 'edited'));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });
    await expectHeld(fire, run, res);
  });

  it('a visitor-field map edited after the bind is stale ⇒ hold', async () => {
    // The owner flips `phone` from `omit` to `required` — the change the digest exists to
    // catch, because it changes what the paired recipe receives.
    seedEndpoint(env, 'ep-1', minimalConfig({
      required_visitor_fields: { ...VISITOR_FIELDS, phone: 'required' },
    }));
    bindScheduling(env, 'ep-1', recipe('book-handler', 1), VISITOR_FIELDS);
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });
    await expectHeld(fire, run, res);
  });

  it('a FORM pair (v1) on a scheduling endpoint never reads as unpaired', async () => {
    // The store is general since the rebuild, so a v1 CAN sit here. It must never read as
    // `unpaired` — that would hand the booking to the pack's default on an endpoint the
    // owner believes is paired.
    //
    // ⚠ TWO independent rules produce this, and mutation testing says so: deleting the
    // resolver's `isReceptionSchedulingPairBinding` narrow does NOT turn this test red,
    // because `receptionPairBindingEquals` compares versions and a v1 can never equal the
    // v3 the deriver mints (`reception-pair-binding.ts:374-377`). The narrow is a TYPE gate
    // (removing it is a compile error — `ready.binding` is `ReceptionSchedulingPairBinding`)
    // plus defence-in-depth for the day someone "simplifies" that equality to compare only
    // the fields both variants share. This test pins the OUTCOME, which is the thing that
    // must hold however it is enforced.
    seedEndpoint(env, 'ep-1');
    const r = recipe('form-handler', 1);
    env.recipes.set(r.recipe_id, r);
    const formBinding = receptionPairBinding({
      form_config: {
        display_name: 'A form',
        success_message: 'Received.',
        form_definition: {
          form_definition_id: 'fd-1',
          fields: [{ name: 'brief', type: 'textarea', label: 'Brief', required: true }],
        },
        submission_processing_rule: {
          // D-210 A.8 slice 2b step 3 — a D-200 pair mints no destination
          // entity: the response row IS the paid deliverable. Was an ABSENT
          // target_kind; absent is no longer a value.
          //
          // ⚠ The `as never` below meant TypeScript could NOT flag this when
          // the field became required — only the runtime binding did, by
          // refusing to derive. A cast opts a fixture out of exactly the check
          // that would have found it.
          target_kind: 'form_response',
          fields_to_include_in_target: [],
          fields_to_attach_as_metadata: [],
        },
        anti_spam: {
          honeypot_fields: [],
          rate_limit_per_ip: 5,
          require_proof_of_work: false,
          require_captcha: false,
        },
        required_visitor_fields: { email: 'required' },
      } as never,
      recipe: r,
      seller_offer_id: null,
    });
    if (formBinding === null) throw new Error('test fixture: v1 binding did not derive');
    env.pairs.upsert({ endpoint_id: 'ep-1', binding: formBinding, now: NOW - 100 });
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });
    await expectHeld(fire, run, res);
  });

  it('an unparseable config on a PAIRED endpoint holds (it cannot re-derive the binding)', async () => {
    seedEndpoint(env, 'ep-1', { display_name: '' });
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });
    await expectHeld(fire, run, res);
  });

  it('paired with NO run seam holds — it must not fall through to the default', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const res = await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({
      now: NOW,
      limit: 50,
    });
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  });

  it('a paired run that FAILS leaves the booking pending — it must not end the reservation', async () => {
    // ⚠ RATIONALE CORRECTED (D-210 audit 2026-07-20). This used to read "`rejected` is what
    // the overlap check excludes, so rejecting here would hand the slot to a stranger" —
    // that mechanism is GONE: `hasOverlappingBooking` was deleted with the capacity-1
    // hardcode, so no query reads the outcome and `rejected` frees nothing. The harm is
    // simpler and worse: `markProcessed` REFUSES `pending`, so `rejected` is TERMINAL —
    // the booking is silently lost forever over a bug the owner could have fixed, while
    // the visitor believes they hold the slot.
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun({ kind: 'failed', errors: ['connection down'] });
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(run.calls).toHaveLength(1);
    expect(fire.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  });

  it('a paired run that THROWS leaves the booking pending — a throw is not a terminal state', async () => {
    // D-210 audit finding 2. `plan.run` reaches `handleExecute`, which THROWS for a
    // request-shape problem (`recipe_not_found`, `assertRunTargets`, the engine catch-all)
    // instead of returning `{kind:'failed'}` — and nothing between the two converted it.
    // The throw escaped to the tick's outer catch, which marks `rejected`.
    //
    // ⛔ There was NO test for the throw path at all, which is why the inversion survived:
    // every modelled outcome was pinned and the un-modelled one was not.
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const calls: FakeRun['calls'] = [];
    const throwingRun: RunPairedBooking = async (input) => {
      calls.push(input);
      throw new Error('recipe_not_found');
    };
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: throwingRun,
    }).drainOnce({ now: NOW, limit: 50 });

    // Identical to the returned-`failed` case above — ONE policy, not two.
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    // ⛔ It must NOT fall through to the pack's default (§3a.2: drift ⇒ HOLD, never the default).
    expect(fire.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  });

  it('a booking whose paired run THREW is RE-DRAINED on the next tick', async () => {
    // The label was never the harm — `rejected` being TERMINAL was. `markProcessed` refuses
    // `pending`, so the pre-fix row could never come back no matter what the owner fixed.
    // Pin the property the spec actually promises: "retryable, dispatching once the owner
    // re-binds".
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const throwingRun: RunPairedBooking = async () => {
      throw new Error('recipe_not_found');
    };
    await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: throwingRun,
    }).drainOnce({ now: NOW, limit: 50 });
    expect(outcomeOf(env, 'req-1')).toBe('pending');

    // The owner fixes the recipe; the very next tick reaches it and hands off.
    const healthy = fakeRun({ kind: 'held' });
    const res2 = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: healthy.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(healthy.calls).toHaveLength(1);
    expect(res2).toEqual({ processed: 1, failed: 0 });
    expect(outcomeOf(env, 'req-1')).toBe('processed');
  });

  it('a pair with no minted door (`no_door`) holds', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const fire = fakeFire();
    const run = fakeRun({ kind: 'no_door' });
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  });
});

describe('D-210 R-2 — the pre-existing guards still hold on a paired endpoint', () => {
  it('a past slot is rejected before any pair logic (I-7)', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW - DAY });
    const run = fakeRun();
    const res = await processorFor(env, { runPairedBooking: run.fn }).drainOnce({
      now: NOW,
      limit: 50,
    });
    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(run.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('rejected');
  });

  it('an unreadable DECLARED field refuses the paired run (never runs on what it could not recover)', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      key: WRONG_KEY,
    });
    const run = fakeRun();
    const res = await processorFor(env, { runPairedBooking: run.fn }).drainOnce({
      now: NOW,
      limit: 50,
    });
    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(run.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('rejected');
  });

  it('a locked vault leaves a paired booking pending rather than rejecting it', async () => {
    seedEndpoint(env, 'ep-1');
    bindScheduling(env, 'ep-1', recipe('book-handler', 1));
    await insertBooking(env, { request_id: 'req-1', endpoint_id: 'ep-1', slot_start_at: NOW + DAY });
    const run = fakeRun();
    const res = await createSchedulingLinkSubmissionProcessor({
      registryStore: env.registry,
      bookingStore: env.booking,
      getFormSubmissionPiiKey: () => { throw new Error('vault locked'); },
      now: () => NOW,
      resolveSchedulingRecipePair: realResolver(env),
      runPairedBooking: run.fn,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(run.calls).toHaveLength(0);
    expect(outcomeOf(env, 'req-1')).toBe('pending');
  });
});
