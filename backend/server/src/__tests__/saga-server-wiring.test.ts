/** R2 step 6 - saga server wiring unit tests. */

import {
  SAGA_ANNOTATION_KEY,
  SAGA_TARGET_COLLECTION,
  type SagaCompensationPlanRef,
} from '@recued/gateway';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GATEWAY_SAGA_AUTHOR_ID,
  SAGA_COMPENSATION_RUN_PREFIX,
  createSagaAnnotationWriter,
  createSagaCompensationDispatcher,
} from '../saga-server-wiring.js';
import type { AnnotationStore } from '../storage/annotation-store.js';

const EVENT_AT = Date.parse('2026-06-01T10:00:00.000Z');
const ANSWERED_AT = Date.parse('2026-06-01T10:01:00.000Z');

interface AnnotationInput {
  target_collection: string;
  target_id: string;
  key: string;
  value: unknown;
  authored_by_recipe_id: string;
  source_record_hash: string;
  recipe_hash: string;
  event_at: number;
}

const annotation = () => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  landed_commit_ids: ['commit-1', 'commit-2'],
  answer: 'undo',
  answered_at: ANSWERED_AT,
  event_at: EVENT_AT,
});

const annotationStore = () => {
  const rows: AnnotationInput[] = [];
  const annotationsForRecord = vi.fn(async (
    target_collection: string,
    target_id: string,
  ) =>
    rows.filter(
      (row) =>
        row.target_collection === target_collection && row.target_id === target_id,
    ),
  );
  const annotate = vi.fn(async (input: AnnotationInput) => {
    rows.push(input);
    return { _id: `ann-${rows.length}`, ...input };
  });
  return {
    rows,
    annotationsForRecord,
    annotate,
    store: {
      annotationsForRecord,
      annotate,
    } as unknown as AnnotationStore,
  };
};

const auditAnchor = (commit_status: AuditEntry['commit_status']): AuditEntry =>
  buildAuditEntry({
    recipe_id: 'saga-undo-commit-1',
    recipe_hash: 'recipe-hash-1',
    commit_status,
    duration_ms: 0,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: null,
    instance_id: null,
    run_id: `${SAGA_COMPENSATION_RUN_PREFIX}commit-1`,
    now: EVENT_AT,
  });

const auditLog = (
  getImpl: AuditLogStore['get'],
): AuditLogStore =>
  ({
    get: getImpl,
  }) as unknown as AuditLogStore;

const plan = (): SagaCompensationPlanRef => ({
  recipe: { recipe_id: 'saga-undo-commit-1' },
  config: { target_connection: 'hubspot1' },
  predecessor_commit_id: 'commit-1',
  description: "delete deal 31337 on 'hubspot1'",
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('createSagaAnnotationWriter', () => {
  it('writes the documented run/key triple with gateway saga author stamps', async () => {
    const s = annotationStore();
    const writer = createSagaAnnotationWriter(s.store);

    await writer.writeReconciliation(annotation());

    expect(s.annotationsForRecord).toHaveBeenCalledWith(
      SAGA_TARGET_COLLECTION,
      'run-1',
    );
    expect(s.annotationsForRecord.mock.invocationCallOrder[0]).toBeLessThan(
      s.annotate.mock.invocationCallOrder[0],
    );
    expect(s.annotate).toHaveBeenCalledTimes(1);
    expect(s.annotate).toHaveBeenCalledWith({
      target_collection: SAGA_TARGET_COLLECTION,
      target_id: 'run-1',
      key: SAGA_ANNOTATION_KEY,
      value: {
        answer: 'undo',
        answered_at: ANSWERED_AT,
        run_id: 'run-1',
        recipe_id: 'recipe-1',
        landed_commit_ids: ['commit-1', 'commit-2'],
      },
      authored_by_recipe_id: GATEWAY_SAGA_AUTHOR_ID,
      source_record_hash: 'run-1',
      recipe_hash: 'gateway-saga-reconciliation',
      event_at: EVENT_AT,
    });
  });

  it('no-ops on a second write for the same run after reading existing annotations', async () => {
    const s = annotationStore();
    const writer = createSagaAnnotationWriter(s.store);

    await writer.writeReconciliation(annotation());
    await writer.writeReconciliation({ ...annotation(), answer: 'keep' });

    expect(s.annotationsForRecord).toHaveBeenCalledTimes(2);
    expect(s.annotate).toHaveBeenCalledTimes(1);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].value).toMatchObject({ answer: 'undo' });
  });
});

describe('createSagaCompensationDispatcher', () => {
  it.each(['awaiting_approval', 'succeeded', 'failed', 'cancelled', 'in_doubt'] as const)(
    'skips when an anchor already exists with status %s and never dereferences executeDeps',
    async (commit_status) => {
      const get = vi.fn(async () => auditAnchor(commit_status));
      const getExecuteDeps = vi.fn(() => {
        throw new Error('executeDeps must not be dereferenced on anchor skip');
      });
      const dispatcher = createSagaCompensationDispatcher({
        auditLog: auditLog(get),
        getExecuteDeps,
      });

      await dispatcher.dispatchCompensation(plan());

      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith(`${SAGA_COMPENSATION_RUN_PREFIX}commit-1`);
      expect(getExecuteDeps).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('throws a transient error when executeDeps is not yet published', async () => {
    const get = vi.fn(async () => null);
    const getExecuteDeps = vi.fn(() => undefined);
    const dispatcher = createSagaCompensationDispatcher({
      auditLog: auditLog(get),
      getExecuteDeps,
    });

    await expect(dispatcher.dispatchCompensation(plan()))
      .rejects.toThrow(/executeDeps not yet published/);

    expect(get).toHaveBeenCalledWith(`${SAGA_COMPENSATION_RUN_PREFIX}commit-1`);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(
      getExecuteDeps.mock.invocationCallOrder[0],
    );
    expect(getExecuteDeps).toHaveBeenCalledTimes(1);
  });
});
