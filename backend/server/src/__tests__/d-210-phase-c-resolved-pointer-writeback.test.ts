/** D-210 Phase C §4b — the resolved-pointer write-back.
 *
 *  ⛔ THIS FIXES A LIVE BUG, not just a Phase C prerequisite.
 *
 *  `reception_form_submission` carries `resolved_target_kind` /
 *  `resolved_target_id`, and `reception.record.list` reads them to compute a
 *  record's `resolved` pointer — the middle link of D-210 step 2's display
 *  chain: record → resolved pointer → destination → `data.timeline(id)`.
 *
 *  Only the AUTO-ACCEPT branch ever wrote them. The review path deliberately
 *  leaves them null ("nothing is materialized until the user approves") and
 *  nothing wrote them back when the approval actually materialized the
 *  destination. So TODAY every reviewed intake reads as UNRESOLVED forever,
 *  with its task / note / calendar event sitting right there. And retiring
 *  auto-accept removes the last writer, which would make the column
 *  permanently dead.
 *
 *  These tests drive the REAL projection over a REAL submission row and then
 *  read the row back — asserting the stored pointer, not that a seam was
 *  called. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runReceptionProjection } from '../ports/reception/projection/reception-projection.js';
// THE REAL wired helpers — not a mirror. A copied write-back in the test
// would drift from the composer's and quietly stop testing it.
import {
  readIntakeSubmissionId,
  writeResolvedPointerBack,
} from '../ports/reception/projection/reception-resolved-pointer.js';
import { sealFormSubmissionField, deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const NOW = 1_700_000_000_000;
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x52));


describe('D-210 Phase C §4b — resolved pointer written back on approve', () => {
  let db: Database.Database;
  let submissionStore: FormSubmissionStore;
  let workStore: WorkEntityStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureReceptionSchema(db);
    ensureWorkEntitySchema(db);
    submissionStore = createReceptionFormSubmissionStore(db);
    workStore = createWorkEntityStore(db);
    autoRegisterRecuedBuiltinSources(workStore, NOW);
  });

  afterEach(() => db.close());

  const seedReviewedSubmission = async (submission_id: string): Promise<void> => {
    const [visitor, blob] = await Promise.all([
      sealFormSubmissionField({
        key: FORM_KEY,
        endpoint_id: 'ep-1',
        submission_id,
        field: 'visitor_email',
        plaintext: 'visitor@example.test',
      }),
      sealFormSubmissionField({
        key: FORM_KEY,
        endpoint_id: 'ep-1',
        submission_id,
        field: 'submission_blob',
        plaintext: JSON.stringify({ fields: { project: 'Northwind' } }),
      }),
    ]);
    submissionStore.insert({
      submission_id,
      endpoint_id: 'ep-1',
      form_definition_id: 'form-1',
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: visitor,
      submission_blob_encrypted: blob!,
      schema_version: 1,
      processing_outcome: 'pending',
      metadata: { definition_snapshot: { form_definition_id: 'form-1', fields: [] } },
    });
    // The REVIEW dispatch: marks processed, pointers deliberately null.
    submissionStore.markProcessed({ submission_id, outcome: 'processed' });
  };

  /** The approve-resume leg, driving the SAME two functions the composer
   *  calls: project, then `writeResolvedPointerBack`. */
  const approveResume = async (submission_id: string) => {
    const input = {
      top_tier_kind: 'commitment' as const,
      id: `intake-${submission_id}`,
      title: 'Northwind project enquiry',
      metadata: {
        reception_form_submission_id: submission_id,
        reception_endpoint_id: 'ep-1',
        form_definition_id: 'form-1',
      },
    };
    const projected = await runReceptionProjection(
      {
        workEntityStore: workStore,
        resolver: createWorkEntityResolver(workStore),
        now: () => NOW,
      } as unknown as Parameters<typeof runReceptionProjection>[0],
      input as unknown as Parameters<typeof runReceptionProjection>[1],
    );
    writeResolvedPointerBack(submissionStore, input, projected);
    return projected;
  };

  it('a REVIEWED intake reads unresolved until approve, then carries its destination', async () => {
    await seedReviewedSubmission('sub-1');

    // The bug's own shape: dispatched for review, destination not yet real.
    const beforeApprove = submissionStore.findById('sub-1');
    expect(beforeApprove?.processing_outcome).toBe('processed');
    expect(beforeApprove?.resolved_target_kind ?? null).toBeNull();
    expect(beforeApprove?.resolved_target_id ?? null).toBeNull();

    const projected = await approveResume('sub-1');

    // The fix: the row now names the thing the approval actually created —
    // read back off storage, not off the projection's return value.
    const afterApprove = submissionStore.findById('sub-1');
    expect(afterApprove?.resolved_target_kind).toBe(projected.top_tier_kind);
    expect(afterApprove?.resolved_target_id).toBe(projected.target_id);
    expect(afterApprove?.resolved_target_id).toBeTruthy();
    // And the pointer resolves to a destination that really exists — the
    // whole point of the chain (record → pointer → destination → timeline).
    expect(projected.top_tier_kind).toBe('commitment');
    expect(workStore.readCommitment(projected.target_id)).not.toBeNull();
  });

  it('stays `processed` — the write-back must not disturb the outcome', async () => {
    await seedReviewedSubmission('sub-2');
    await approveResume('sub-2');
    expect(submissionStore.findById('sub-2')?.processing_outcome).toBe('processed');
  });

  it('is idempotent — a boot-sweep retry of the same approve rewrites the same pointer', async () => {
    await seedReviewedSubmission('sub-3');
    const first = await approveResume('sub-3');
    const afterFirst = submissionStore.findById('sub-3');
    await approveResume('sub-3');
    const afterSecond = submissionStore.findById('sub-3');

    expect(afterSecond?.resolved_target_kind).toBe(afterFirst?.resolved_target_kind);
    expect(afterSecond?.resolved_target_id).toBe(first.target_id);
  });

  it('⛔ claims NOTHING when the materialize is not an intake', () => {
    // A `form_definition_id` can legitimately appear in an unrelated
    // workflow. Keying on it instead of the substrate-owned
    // `reception_form_submission_id` would stamp a resolved pointer onto a
    // row this materialize never materialized.
    expect(readIntakeSubmissionId({ metadata: { form_definition_id: 'form-1' } }))
      .toBeUndefined();
    expect(readIntakeSubmissionId({ metadata: {} })).toBeUndefined();
    expect(readIntakeSubmissionId({})).toBeUndefined();
    expect(readIntakeSubmissionId({ metadata: null })).toBeUndefined();
    expect(readIntakeSubmissionId({ metadata: { reception_form_submission_id: '' } }))
      .toBeUndefined();
    expect(
      readIntakeSubmissionId({ metadata: { reception_form_submission_id: 'sub-9' } }),
    ).toBe('sub-9');
  });
});
