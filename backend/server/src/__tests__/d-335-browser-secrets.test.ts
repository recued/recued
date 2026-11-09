/** D-335 slice Z — the secrets browser steps type, which no model holds: a remembered login for the
 *  field on its site, else the owner's answer to an ask that takes the value, waited for at the step
 *  (`bridges/browser-secrets.ts`); and the logins kept, sealed (`storage/browser-login-store.ts`).
 *  The batch that types them is pinned in `d-335-browser-act.test.ts`, the ask's card in the
 *  webclient's tests, and the whole of it in real Chrome in `browser-toolkit-browser.test.ts`. */

import { randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SECRET_ASK_KIND,
  BROWSER_SECRET_STOP_OPTION,
} from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';

import { createBrowserSecrets, type BrowserSecretNotifier, type BrowserSecretRequest } from '../bridges/browser-secrets.js';
import { handleGiveSecret, handlePendingAsks } from '../history-handler.js';
import { createBrowserLoginRpcHandlers } from '../browser-login-rpc.js';
import { createBrowserLoginStore } from '../storage/browser-login-store.js';

afterEach(() => { vi.useRealTimers(); });

const ORIGIN = 'https://login.live.com';
const request = (over: Partial<BrowserSecretRequest> = {}): BrowserSecretRequest => ({
  run_id: 'run-1', kind: 'password', origin: ORIGIN, field: 'name:passwd', label: 'Password', ...over });

/** A notification block that keeps its asks, their handler and what was cancelled. */
const notifierFake = (open: Array<{ ask_id: string; handler_kind: string }> = []) => {
  const asks: Array<{ ask_id: string; message: { title: string; text: string }; options: readonly { id: string; label: string }[];
    handler: { kind: string; payload: Record<string, unknown> } }> = [];
  const cancelled: string[] = [];
  let handler: ((payload: Record<string, unknown>, answer: { option: string }) => void | Promise<void>) | undefined;
  const notifier: BrowserSecretNotifier = {
    ask: vi.fn(async (message, options, h) => {
      const ask_id = `ask-${String(asks.length + 1)}`;
      asks.push({ ask_id, message, options, handler: h });
      return { ask_id };
    }),
    cancelAsk: vi.fn(async (ask_id: string) => { cancelled.push(ask_id); return 'cancelled' as const; }),
    listOpenAsks: vi.fn(async () => open),
    registerAskHandler: vi.fn((kind, h) => { if (kind === BROWSER_SECRET_ASK_KIND) handler = h; }),
  };
  return { notifier, asks, cancelled, answer: (payload: Record<string, unknown>, option: string) => handler?.(payload, { option }) };
};

const audited = () => createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
/** Until the registry has made its ask: the ask is made after an await. */
const asked = async (asks: unknown[], count = 1) => {
  for (let i = 0; i < 50 && asks.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('D-335 slice Z — the logins remembered for browser steps, sealed', () => {
  const key = randomBytes(32);
  const store = (withKey = true) => {
    const db = new Database(':memory:');
    return { db, logins: createBrowserLoginStore(db, withKey ? { key: () => Uint8Array.from(key) } : {}) };
  };

  it('keeps a secret for one field on one site, sealed: the row never holds it, and only that field on that site opens it', async () => {
    const { db, logins } = store();
    expect(await logins.save({ origin: ORIGIN, field: 'name:passwd', label: 'Password', kind: 'password', value: 'hunter2', now: 10 }))
      .toBe(true);
    expect(await logins.get(ORIGIN, 'name:passwd')).toBe('hunter2');
    const row = db.prepare('SELECT * FROM browser_logins').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('hunter2');
    // Another field, or the same field on another site, has none.
    expect(await logins.get(ORIGIN, 'name:pin')).toBeUndefined();
    expect(await logins.get('https://login.example.com', 'name:passwd')).toBeUndefined();
    // A sealed value copied onto another row does not open there.
    db.prepare(`INSERT INTO browser_logins (origin, field, label, kind, sealed, saved_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('https://evil.example', 'name:passwd', 'Password', 'password', row.sealed, 11);
    expect(await logins.get('https://evil.example', 'name:passwd')).toBeUndefined();
  });

  it('lists the logins without their secrets, notes a use, and forgets one', async () => {
    const { logins } = store();
    await logins.save({ origin: ORIGIN, field: 'name:passwd', label: 'Password', kind: 'password', value: 'hunter2', now: 10 });
    logins.used(ORIGIN, 'name:passwd', 20);
    expect(logins.list()).toEqual([{ origin: ORIGIN, site: 'login.live.com', field: 'name:passwd', label: 'Password',
      kind: 'password', saved_at: 10, used_at: 20 }]);
    expect(JSON.stringify(logins.list())).not.toContain('hunter2');
    expect(logins.forget(ORIGIN, 'name:passwd')).toBe(true);
    expect(logins.forget(ORIGIN, 'name:passwd')).toBe(false);
    expect(await logins.get(ORIGIN, 'name:passwd')).toBeUndefined();
  });

  it('with no key to seal it with (a server not yet unlocked), keeps nothing', async () => {
    const { db, logins } = store(false);
    expect(await logins.save({ origin: ORIGIN, field: 'name:passwd', label: 'Password', kind: 'password', value: 'hunter2', now: 10 }))
      .toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM browser_logins').get()).toEqual({ n: 0 });
  });

  it('the owner lists and forgets them over rpc, the forgetting audited, never the secret', async () => {
    const { logins } = store();
    await logins.save({ origin: ORIGIN, field: 'name:passwd', label: 'Password', kind: 'password', value: 'hunter2', now: 10 });
    const auditLog = audited();
    const rpc = createBrowserLoginRpcHandlers({ store: logins, auditLog, now: () => 30 });
    expect((await rpc['collection.contract.listBrowserLogins']()).logins).toHaveLength(1);
    expect(await rpc['collection.contract.forgetBrowserLogin']({ origin: ORIGIN, field: 'name:passwd' })).toEqual({ forgotten: true });
    await expect(rpc['collection.contract.forgetBrowserLogin']({ origin: ORIGIN, field: 'name:passwd' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await auditLog.listActivities()).map((a) => [a.action, a.target])).toEqual([['browser_login_forgotten', ORIGIN]]);
  });
});

describe('D-335 slice Z — a secret asked for at its step and waited for', () => {
  const setup = async (options: { open?: Array<{ ask_id: string; handler_kind: string }>; waitMs?: number; logins?: boolean } = {}) => {
    const fake = notifierFake(options.open);
    const db = new Database(':memory:');
    const logins = createBrowserLoginStore(db, { key: () => Uint8Array.from(randomBytes(32).fill(7)) });
    const auditLog = audited();
    const secrets = createBrowserSecrets();
    await secrets.install({ notifier: fake.notifier, ...(options.logins === false ? {} : { logins }), auditLog, now: () => 1_000,
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}) });
    return { ...fake, secrets, logins, auditLog };
  };
  const actions = async (auditLog: ReturnType<typeof audited>) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One clock for all of them, so their order in the log is not theirs: as a set.
    return (await auditLog.listActivities()).map((a) => a.action).sort();
  };

  it('asks the owner, with the site and the field and never a value; the value given goes to the step, remembered when asked', async () => {
    const t = await setup();
    const extendBudget = vi.fn();
    const answer = t.secrets.resolve(request({ extendBudget }));
    await asked(t.asks);
    const [ask] = t.asks;
    expect(ask!.message.title).toBe('Your password for login.live.com');
    expect(ask!.message.text).toBe('A step in your browser needs your password for login.live.com, to type into the field “Password”. '
      + 'Give it in the Recued app, on this ask: it goes to your browser for that one step and is kept nowhere else, unless you '
      + 'choose to remember it. Do not send it in a chat. The task waits 5 minutes for it.');
    // The ask's only option stops the task: the value comes in through its own field.
    expect(ask!.options).toEqual([{ id: BROWSER_SECRET_STOP_OPTION, label: 'Stop the task' }]);
    expect(ask!.handler).toEqual({ kind: BROWSER_SECRET_ASK_KIND, payload: { kind: 'password', site: 'login.live.com',
      field: 'Password', remember: true, expires_at: 1_000 + 300_000, request_id: expect.any(String) } });
    // Waiting for the owner is not the run's time.
    expect(extendBudget).toHaveBeenCalledWith(300_000);
    expect(await t.secrets.give(ask!.ask_id, 'hunter2', true)).toBe(true);
    expect(await answer).toEqual({ value: 'hunter2', from: 'owner' });
    // Its ask closes everywhere; the login is kept, sealed, for that field on that site.
    expect(t.cancelled).toEqual([ask!.ask_id]);
    expect(await t.logins.get(ORIGIN, 'name:passwd')).toBe('hunter2');
    expect(await actions(t.auditLog)).toEqual(['browser_login_saved', 'browser_secret_asked', 'browser_secret_given']);
    const rows = JSON.stringify(await t.auditLog.listActivities());
    expect(rows).not.toContain('hunter2');
    // Given once: a second give finds no step waiting.
    expect(await t.secrets.give(ask!.ask_id, 'hunter2', true)).toBe(false);
  });

  it('a remembered login is typed with no ask; another field on the same site still asks', async () => {
    const t = await setup();
    await t.logins.save({ origin: ORIGIN, field: 'name:passwd', label: 'Password', kind: 'password', value: 'hunter2', now: 5 });
    expect(await t.secrets.resolve(request())).toEqual({ value: 'hunter2', from: 'saved' });
    expect(t.asks).toHaveLength(0);
    expect(await actions(t.auditLog)).toEqual(['browser_login_used']);
    void t.secrets.resolve(request({ field: 'name:pin', label: 'PIN', kind: 'PIN' }));
    await asked(t.asks);
    expect(t.asks).toHaveLength(1);
  });

  it('a sign-in code is asked for every time and never remembered', async () => {
    const t = await setup();
    const answer = t.secrets.resolve(request({ kind: 'sign-in code', field: 'name:otc', label: 'Code' }));
    await asked(t.asks);
    expect(t.asks[0]!.message.text).toContain('needs the sign-in code login.live.com sent you');
    expect(t.asks[0]!.message.text).not.toContain('remember');
    expect(t.asks[0]!.handler.payload).toMatchObject({ kind: 'sign-in code', remember: false });
    await t.secrets.give(t.asks[0]!.ask_id, '123456', true);
    expect(await answer).toEqual({ value: '123456', from: 'owner' });
    expect(t.logins.list()).toEqual([]);
  });

  it('stops at the step when the owner stops it, when nobody gives it in time, or when the run is stopped, closing the ask', async () => {
    const stopped = await setup();
    const byOwner = stopped.secrets.resolve(request());
    await asked(stopped.asks);
    await stopped.answer(stopped.asks[0]!.handler.payload, BROWSER_SECRET_STOP_OPTION);
    expect(await byOwner).toEqual({ refused: 'you stopped the task here, at the step that needed your password for login.live.com' });

    const late = await setup({ waitMs: 20 });
    const timedOut = await late.secrets.resolve(request());
    expect(timedOut).toEqual({ refused: 'nobody gave your password for login.live.com within a short while, so the task stopped at this step' });
    expect(late.cancelled).toEqual(['ask-1']);

    const run = await setup();
    const controller = new AbortController();
    const aborted = run.secrets.resolve(request({ signal: controller.signal }));
    await asked(run.asks);
    controller.abort();
    expect(await aborted).toEqual({ refused: 'the task was stopped while it waited for your password for login.live.com' });
    expect(run.cancelled).toEqual(['ask-1']);
    expect(await run.secrets.give('ask-1', 'hunter2', false)).toBe(false);
  });

  it('ends at boot the secret asks a restart left open, whose steps are gone; with no block, a step cannot be asked', async () => {
    const t = await setup({ open: [{ ask_id: 'old-1', handler_kind: BROWSER_SECRET_ASK_KIND }, { ask_id: 'other', handler_kind: 'preflight' }] });
    expect(t.cancelled).toEqual(['old-1']);
    expect(await createBrowserSecrets().resolve(request())).toEqual({
      refused: 'this step needs your password for login.live.com, and Recued cannot ask you for it here' });
  });
});

describe('D-335 slice Z — the ask\'s card and the owner\'s answer', () => {
  it('the open asks name what a secret ask asks for, so its card takes the value in a field of its own', async () => {
    const payload = { kind: 'password', site: 'login.live.com', field: 'Password', remember: true, expires_at: 9, request_id: 'r' };
    const { asks } = await handlePendingAsks({ listOpenAsks: async () => [{ ask_id: 'a1', message: { title: 'Your password', text: 'x' },
      options: [{ id: BROWSER_SECRET_STOP_OPTION, label: 'Stop the task' }], handler_kind: BROWSER_SECRET_ASK_KIND, handler_payload: payload,
      fanout_channels: ['ui'], status: 'open', created_at: 1 }] } as never);
    expect(asks[0]).toMatchObject({ ask_id: 'a1', secret_prompt: { kind: 'password', site: 'login.live.com', field: 'Password',
      remember: true, expires_at: 9 } });
    expect(asks[0]!.secret_prompt).not.toHaveProperty('request_id');
  });

  it('gives a well-formed value to the waiting step; anything else is not given, and never an error that could carry it', async () => {
    const giveSecret = vi.fn(async () => true);
    expect(await handleGiveSecret({ giveSecret }, { ask_id: 'a1', value: 'hunter2', remember: true })).toEqual({ given: true });
    expect(giveSecret).toHaveBeenCalledWith('a1', 'hunter2', true);
    expect(await handleGiveSecret({ giveSecret }, { ask_id: 'a1', value: '' })).toEqual({ given: false });
    expect(await handleGiveSecret({ giveSecret }, { ask_id: '', value: 'x' })).toEqual({ given: false });
    expect(await handleGiveSecret({ giveSecret }, { ask_id: 'a1', value: 'x'.repeat(1_001) })).toEqual({ given: false });
    expect(await handleGiveSecret({ giveSecret }, null as never)).toEqual({ given: false });
    expect(await handleGiveSecret({ giveSecret: async () => { throw new Error('boom hunter2'); } }, { ask_id: 'a1', value: 'hunter2' }))
      .toEqual({ given: false });
    expect(giveSecret).toHaveBeenCalledTimes(1);
  });
});
