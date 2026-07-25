/** D-157 server-wiring - in-doubt reconciliation annotation writer. */

import {
  IN_DOUBT_ANNOTATION_KEY,
  IN_DOUBT_TARGET_COLLECTION,
} from '@recued/gateway';
import { describe, expect, it, vi } from 'vitest';

import type { AnnotationStore } from '../storage/annotation-store.js';
import {
  GATEWAY_IN_DOUBT_AUTHOR_ID,
  createInDoubtAnnotationWriter,
} from '../in-doubt-annotation-writer.js';

const annotation = (overrides: Record<string, unknown> = {}) => ({
  commit_id: 'commit-1',
  correlation_id: 'corr-1',
  answer: 'sent',
  answered_at: Date.parse('2026-05-22T18:01:00.000Z'),
  event_at: Date.parse('2026-05-22T18:00:00.000Z'),
  ...overrides,
});

const store = () => {
  const rows: Array<{ key: string }> = [];
  const annotate = vi.fn(async (input) => {
    rows.push({ key: (input as { key: string }).key });
    return { _id: 'ann-1', ...input };
  });
  const annotationsForRecord = vi.fn(async () => rows);
  return {
    rows,
    store: {
      annotate,
      annotationsForRecord,
    } as unknown as AnnotationStore,
    annotate,
    annotationsForRecord,
  };
};

describe('InDoubtAnnotationWriter.writeReconciliation', () => {
  it('writes the reconciliation annotation with synthetic stamps', async () => {
    const s = store();
    const writer = createInDoubtAnnotationWriter(s.store);

    await writer.writeReconciliation(annotation());

    expect(s.annotationsForRecord).toHaveBeenCalledWith(
      IN_DOUBT_TARGET_COLLECTION,
      'commit-1',
    );
    expect(s.annotate).toHaveBeenCalledTimes(1);
    expect(s.annotate).toHaveBeenCalledWith({
      target_collection: IN_DOUBT_TARGET_COLLECTION,
      target_id: 'commit-1',
      key: IN_DOUBT_ANNOTATION_KEY,
      value: {
        answer: 'sent',
        answered_at: Date.parse('2026-05-22T18:01:00.000Z'),
        commit_id: 'commit-1',
        correlation_id: 'corr-1',
      },
      authored_by_recipe_id: GATEWAY_IN_DOUBT_AUTHOR_ID,
      source_record_hash: 'commit-1',
      recipe_hash: 'gateway-in-doubt-reconciliation',
      event_at: Date.parse('2026-05-22T18:00:00.000Z'),
    });
  });

  it('no-ops on a second call for the same commit_id', async () => {
    const s = store();
    const writer = createInDoubtAnnotationWriter(s.store);

    await writer.writeReconciliation(annotation());
    await writer.writeReconciliation(annotation({ answer: 'retry' }));

    expect(s.annotationsForRecord).toHaveBeenCalledTimes(2);
    expect(s.annotate).toHaveBeenCalledTimes(1);
  });

  it('forwards event_at when supplied', async () => {
    const s = store();
    const writer = createInDoubtAnnotationWriter(s.store);
    const eventAt = Date.parse('2026-05-20T09:30:00.000Z');

    await writer.writeReconciliation(annotation({ event_at: eventAt }));

    expect(s.annotate.mock.calls[0]?.[0]).toMatchObject({ event_at: eventAt });
  });

  it('does not write when an existing reconciliation row is present', async () => {
    const s = store();
    s.rows.push({ key: IN_DOUBT_ANNOTATION_KEY });
    const writer = createInDoubtAnnotationWriter(s.store);

    await writer.writeReconciliation(annotation());

    expect(s.annotate).not.toHaveBeenCalled();
  });
});
