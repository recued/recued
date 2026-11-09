/** ⛔ A RUNNING MCP ACTION IS ABANDONED WHEN ITS DISPATCHER IS GONE, NOT WHEN IT IS OLD.
 *
 *  `reconcileMcpAction` took a `running` record untouched for 15 minutes to be
 *  crash residue. A resumed op that ran longer was finished `in_doubt` while it
 *  still ran, and so was any dispatch a laptop slept through: the stdio MCP
 *  poller woke first, and the real result was then refused (`finish` writes a
 *  terminal record once). `markRunning` now records the dispatching process
 *  (pid + start identity), and the reconcile asks whether it is alive. A record
 *  that names no dispatcher keeps the old age rule.
 *
 *  ⚠ REAL PROCESSES: this test process is the live dispatcher, and a child it
 *  kills is the dead one. Windows reports no start identity yet, so those arms
 *  are skipped there. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';

import {
  createMcpActionStore,
  isMcpActionRecord,
  mcpActionDispatcherAlive,
  type McpActionDispatcher,
  type McpActionRecord,
} from '../mcp-action-store.js';
import { reconcileMcpAction } from '../mcp-server.js';
import { processStartIdentity } from '../lifecycle/process-identity.js';

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux';
const HOUR = 60 * 60 * 1_000;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** A process that started, and is now gone — what a crash leaves behind. */
const deadDispatcher = async (): Promise<McpActionDispatcher> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = child.pid!;
  const start = processStartIdentity(pid)!;
  child.kill('SIGKILL');
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
  return { pid, start };
};

const thisProcess = (): McpActionDispatcher => ({ pid: process.pid, start: processStartIdentity(process.pid)! });

/** A raw op resumed after approval: its checkpoint is claimed before dispatch,
 *  and a raw op writes no run anchor, so only the record says it is running. */
const resumedRawOp = async (
  dispatcher: McpActionDispatcher | null,
  markedAt: number,
) => {
  let clock = markedAt;
  const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
    now: () => clock, dispatcher: () => dispatcher,
  });
  await store.createHeld({ run_id: 'run-raw', principal_id: 'token-a', tool_name: 'mail.send', kind: 'raw_op' });
  const running = (await store.markRunning('run-raw'))!;
  clock = Date.now();
  const deps = {
    mcpActionStore: store,
    checkpointStore: { get: async () => null, listByRun: async () => [] },
    auditLog: { get: async () => null },
  } as unknown as Parameters<typeof reconcileMcpAction>[0];
  return { store, running, reconcile: () => reconcileMcpAction(deps, running) };
};

describe.skipIf(unsupported)('a running MCP action and its dispatcher', () => {
  it('⛔ a live dispatcher keeps it running, however long ago it changed — a long op, or a sleep', async () => {
    const { running, reconcile } = await resumedRawOp(thisProcess(), Date.now() - 2 * HOUR);
    expect((await reconcile()).status).toBe('running');
    expect(running.dispatcher).toEqual(thisProcess());
  });

  it('⛔ a dead dispatcher leaves it abandoned at once: the raw op is in doubt', async () => {
    const { reconcile } = await resumedRawOp(await deadDispatcher(), Date.now());
    const record = await reconcile();
    expect(record.status).toBe('in_doubt');
    expect(record.result).toMatchObject({ code: 'continuation_state_missing' });
  });

  it('⛔ a dispatcher whose pid now names another process is dead', async () => {
    const { reconcile } = await resumedRawOp({ pid: process.pid, start: 'not-this-process' }, Date.now());
    expect((await reconcile()).status).toBe('in_doubt');
  });

  it('a record naming no dispatcher keeps the age rule: running when fresh, in doubt when old', async () => {
    expect((await (await resumedRawOp(null, Date.now())).reconcile()).status).toBe('running');
    expect((await (await resumedRawOp(null, Date.now() - 2 * HOUR)).reconcile()).status).toBe('in_doubt');
  });
});

describe.skipIf(unsupported)('a resumed recipe that still has its checkpoint', () => {
  const resumedRecipe = async (dispatcher: McpActionDispatcher, markedAt: number) => {
    let clock = markedAt;
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      now: () => clock, dispatcher: () => dispatcher,
    });
    await store.createHeld({ run_id: 'run-recipe', principal_id: 'token-a', tool_name: 'seller/onboard', kind: 'recipe', checkpoint_id: 'cp-1' });
    const running = (await store.markRunning('run-recipe'))!;
    clock = Date.now();
    const deps = {
      mcpActionStore: store,
      checkpointStore: { get: async () => ({ checkpoint_id: 'cp-1' }), listByRun: async () => [{ checkpoint_id: 'cp-1' }] },
      auditLog: { get: async () => null },
    } as unknown as Parameters<typeof reconcileMcpAction>[0];
    return reconcileMcpAction(deps, running);
  };

  it('⛔ a dead dispatcher returns it to a recoverable wait at once', async () => {
    const record = await resumedRecipe(await deadDispatcher(), Date.now());
    expect(record.status).toBe('awaiting_approval');
    expect(record.status_message).toMatch(/interrupted resume remains recoverable/);
  });

  it('⛔ a live dispatcher is left to finish, however long it has run', async () => {
    expect((await resumedRecipe(thisProcess(), Date.now() - 2 * HOUR)).status).toBe('running');
  });
});

describe.skipIf(unsupported)('markRunning records who dispatches', () => {
  const held = async (dispatcher: () => McpActionDispatcher | null) => {
    const store = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), { dispatcher });
    await store.createHeld({ run_id: 'run-r', principal_id: 'token-a', tool_name: 't', kind: 'recipe', checkpoint_id: 'cp' });
    return store;
  };

  it('a resume after its dispatcher died takes the dispatch over', async () => {
    const dead = await deadDispatcher();
    let me: McpActionDispatcher = dead;
    const store = await held(() => me);
    await store.markRunning('run-r');
    me = thisProcess();
    expect((await store.markRunning('run-r'))?.dispatcher).toEqual(thisProcess());
  });

  it('a second resume leaves a live dispatcher in place', async () => {
    let me: McpActionDispatcher = thisProcess();
    const store = await held(() => me);
    await store.markRunning('run-r');
    me = { pid: process.pid, start: 'another-resumer' };
    expect((await store.markRunning('run-r'))?.dispatcher).toEqual(thisProcess());
  });

  it('records no dispatcher where the platform cannot say', async () => {
    const store = await held(() => null);
    expect(await store.markRunning('run-r')).not.toHaveProperty('dispatcher');
    expect(mcpActionDispatcherAlive({})).toBeNull();
  });

  it('a stored record with a malformed dispatcher is not a record', async () => {
    const store = await held(() => thisProcess());
    const running = (await store.markRunning('run-r'))!;
    expect(isMcpActionRecord(running)).toBe(true);
    expect(isMcpActionRecord({ ...running, dispatcher: { pid: 'x', start: 'y' } })).toBe(false);
    expect(isMcpActionRecord({ ...running, dispatcher: { pid: 12, start: '' } })).toBe(false);
  });
});
