/** The traces the recipes that issue passes leave, read by the one-off repair of
 *  D-306's permanent passes (D-308) and by re-applying a package (D-309).
 *
 *  An order is read through the order store. A free DeepTutor enrollment leaves no
 *  order, only the student record `enroll-free-student-deeptutor` writes, which is
 *  read here through the records store's own export. */

import type { RecordsPackRef } from '@recued/contracts';

import type { RecordsStore } from '../records/store.js';

/** Where `enroll-free-student-deeptutor` writes its student records. */
export const DEEPTUTOR_RECORDS: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'deeptutor-records' };

/** How long one enrollment run may take between issuing the customer and writing
 *  the student record. A customer created earlier than that existed before. */
export const ENROLLMENT_RUN_MS = 10 * 60 * 1000;

/** One free DeepTutor enrollment, as its student record tells it. */
export interface Enrollment {
  readonly customer_id: string;
  readonly class_key: string;
  readonly door_id: string | null;
  /** The record's creation: the first enrollment. */
  readonly first_at: number;
  /** `enrolled_at`, which every re-enrollment rewrites: the last. */
  readonly last_at: number;
}

const epochMs = (value: unknown): number | null => {
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** The free enrollments' student records, read before the repair writes.
 *
 *  ⛔ Anything that stops the read — the pack was never installed, a migration is
 *  running, the export is over its budget — yields NO enrollments. Those students
 *  are then listed for the owner, never guessed at. A paid student's record is
 *  skipped: its order is the evidence. */
export const readEnrollments = (
  records: Pick<RecordsStore, 'exportNamespace'> | undefined,
): Map<string, Enrollment[]> => {
  const byCustomer = new Map<string, Enrollment[]>();
  if (records === undefined) return byCustomer;
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = records.exportNamespace(DEEPTUTOR_RECORDS, 'student').records.student ?? [];
  } catch {
    return byCustomer;
  }
  for (const row of rows) {
    const meta = row._record as { created_at?: unknown } | undefined;
    const first_at = epochMs(meta?.created_at);
    if (typeof row.customer_id !== 'string' || typeof row.class_key !== 'string' || first_at === null) continue;
    if (row.lifecycle_source !== 'manual' || typeof row.source_order_handle === 'string') continue;
    const enrollment: Enrollment = {
      customer_id: row.customer_id,
      class_key: row.class_key,
      door_id: typeof row.door_id === 'string' ? row.door_id : null,
      first_at,
      last_at: Math.max(first_at, epochMs(row.enrolled_at) ?? first_at),
    };
    byCustomer.set(row.customer_id, [...(byCustomer.get(row.customer_id) ?? []), enrollment]);
  }
  return byCustomer;
};

/** The customer's enrollment in this class on its own door, if the records
 *  hold one. A record that names no door matches any door. */
export const enrollmentFor = (
  enrollments: ReadonlyMap<string, readonly Enrollment[]>,
  customer: { readonly customer_id: string; readonly door_id: string },
  class_key: string,
): Enrollment | undefined =>
  enrollments.get(customer.customer_id)?.find((e) =>
    e.class_key === class_key && (e.door_id === null || e.door_id === customer.door_id));
