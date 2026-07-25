/** Doc section 4 - pick-resolution server wiring unit tests. */

import { PICK_HANDLER_KIND, type PickNotifier, type PickRerunRef } from '@recued/gateway';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PICK_RERUN_PREFIX,
  createPickRerunDispatcher,
  registerPickResolution,
} from '../pick-server-wiring.js';

const EVENT_AT = Date.parse('2026-06-01T10:00:00.000Z');

const auditAnchor = (commit_status: AuditEntry['commit_status']): AuditEntry =>
  buildAuditEntry({
    recipe_id: 'recipe-open-deals',
    recipe_hash: 'recipe-hash-1',
    commit_status,
    duration_ms: 0,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: null,
    instance_id: null,
    run_id: `${PICK_RERUN_PREFIX}pick-1`,
    now: EVENT_AT,
  });

const auditLog = (getImpl: AuditLogStore['get']): AuditLogStore =>
  ({ get: getImpl }) as unknown as AuditLogStore;

const rerun = (overrides: Partial<PickRerunRef> = {}): PickRerunRef => ({
  pick_id: 'pick-1',
  recipe_id: 'recipe-open-deals',
  config: { limit: 25 },
  variable: 'crm',
  connection_name: 'hubspot1',
  ...overrides,
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('createPickRerunDispatcher', () => {
  it('skips when an anchor already exists and never dereferences executeDeps', async () => {
    const get = vi.fn(async () => auditAnchor('failed'));
    const getExecuteDeps = vi.fn(() => {
      throw new Error('executeDeps must not be dereferenced on anchor skip');
    });
    const dispatcher = createPickRerunDispatcher({
      auditLog: auditLog(get),
      getExecuteDeps,
    });

    await expect(dispatcher.dispatchPickedRun(rerun())).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`${PICK_RERUN_PREFIX}pick-1`);
    expect(getExecuteDeps).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws a transient error when executeDeps is not yet published', async () => {
    const get = vi.fn(async () => null);
    const getExecuteDeps = vi.fn(() => undefined);
    const dispatcher = createPickRerunDispatcher({
      auditLog: auditLog(get),
      getExecuteDeps,
    });

    await expect(dispatcher.dispatchPickedRun(rerun()))
      .rejects.toThrow(/executeDeps not yet published/);

    expect(get).toHaveBeenCalledWith(`${PICK_RERUN_PREFIX}pick-1`);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(
      getExecuteDeps.mock.invocationCallOrder[0],
    );
    expect(getExecuteDeps).toHaveBeenCalledTimes(1);
  });
});

describe('registerPickResolution', () => {
  it('registers gateway.pick exactly once and exposes a callable handler', async () => {
    const registered: Array<{ kind: unknown; handler: unknown }> = [];
    const notifier: PickNotifier = {
      ask: vi.fn(async () => ({ ask_id: 'ask-unused' })),
      registerAskHandler: vi.fn((kind, handler) => {
        registered.push({ kind, handler });
      }),
    };
    const getExecuteDeps = vi.fn(() => undefined);

    registerPickResolution(notifier, {
      auditLog: auditLog(vi.fn(async () => null)),
      getExecuteDeps,
    });

    expect(notifier.registerAskHandler).toHaveBeenCalledTimes(1);
    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe(PICK_HANDLER_KIND);
    expect(registered[0].handler).toEqual(expect.any(Function));

    await expect(
      (registered[0].handler as (
        payload: Record<string, unknown>,
        answer: { option: string; answered_at: number },
      ) => Promise<void>)(
        {
          pick_id: 'pick-1',
          recipe_id: 'recipe-open-deals',
          variable: 'crm',
          config: {},
          candidate_names: ['hubspot1'],
        },
        { option: 'cancel', answered_at: EVENT_AT },
      ),
    ).resolves.toBeUndefined();
    expect(getExecuteDeps).not.toHaveBeenCalled();
  });
});
