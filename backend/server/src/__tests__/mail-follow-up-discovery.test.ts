import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailFollowUp, MailFollowUpCursor } from '@recued/contracts';
import { createMailFollowUpStore } from '../storage/mail-follow-up-store.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';
import { createMailFollowUpFixture, type MailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';

const fixtures: MailFollowUpFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailFollowUpFixture(); fixtures.push(f); return f; };
const seed = async (f: MailFollowUpFixture) => {
  const watch = await f.service.start(f.request(), 'paired-owner');
  const template = (await f.store.get(watch.id))!;
  await f.service.cancel({ id: watch.id, expected_revision: watch.revision });
  return async (patch: Partial<MailFollowUp>) => {
    const watch = { ...template.watch, id: 'mfw_' + randomUUID(), revision: 1, state: 'cancelled' as const, ...patch };
    await f.store.put({ ...template, thread_key: randomUUID(), watch }, null); return watch;
  };
};

describe('reply watch discovery', () => {
  it('advances over encrypted nonmatches and pages limited matches without omissions, including terminal history', async () => {
    const f = fixture(), add = await seed(f), expected: MailFollowUp[] = [];
    for (let n = 0; n < 7; n++) expected.push(await add({ subject: 'Ｒｅｎｅｗａｌ terms', state: 'replied', updated_at: f.now() + n }));
    for (let n = 0; n < 51; n++) await add({ subject: 'Unrelated invoice', updated_at: f.now() + 100 + n });
    const input = { query: 'renewal WORK reply', state: 'replied', mailbox: 'work', limit: 2 };
    // With only the textual filter, the first encrypted page is allowed to be empty.
    const first = await f.service.list({ query: 'renewal terms', limit: 2 });
    expect(first.watches).toEqual([]); expect(first.next_cursor).not.toBeNull();
    expect((await f.service.list({ query: 'renewal terms', cursor: first.next_cursor })).watches.map(w => w.id).sort()).toEqual(expected.map(w => w.id).sort());
    const ids: string[] = []; let cursor: MailFollowUpCursor | null = null;
    do {
      const page = await f.service.list({ ...input, ...(cursor ? { cursor } : {}) });
      expect(page.watches.length).toBeLessThanOrEqual(2); ids.push(...page.watches.map(w => w.id)); cursor = page.next_cursor;
    } while (cursor);
    expect(ids).toEqual([...expected].reverse().map(w => w.id)); expect(new Set(ids).size).toBe(7);
    expect((await f.service.list({ ...input, mailbox: 'personal' })).watches).toEqual([]);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').all())).not.toContain('Ｒｅｎｅｗａｌ terms');
  });

  it('selects due work before pagination so terminal history and future snoozes cannot bury Today', async () => {
    const f = fixture(), add = await seed(f), at = f.now();
    const due = await add({ state: 'waiting', check_at: at, updated_at: at - 3 });
    const ready = await add({ state: 'draft_ready', check_at: at + 1, updated_at: at - 2 });
    const review = await add({ state: 'needs_attention', check_at: at + 1, updated_at: at - 1 });
    await add({ state: 'waiting', check_at: at + 1 });
    for (let n = 0; n < 55; n++) await add({ state: 'replied', updated_at: at + n });
    expect((await f.service.list({ attention_at: at })).watches.map(w => w.id)).toEqual([review.id, ready.id, due.id]);
    expect(f.draftCount()).toBe(0);
  });

  it('rejects invalid filters and retains lock, ciphertext and paired-owner fences for discovery', async () => {
    const f = fixture(); await f.service.start(f.request(), 'paired-owner');
    for (const input of [{ state: 'ready' }, { mailbox: ' ' }, { query: 'x'.repeat(2001) }, { limit: 51 }, { limit: 0 }, { attention_at: NaN }])
      await expect(f.service.list(input)).rejects.toMatchObject({ code: 'bad_request' });
    f.unlock(false); await expect(f.service.list({ query: 'renewal' })).rejects.toMatchObject({ code: 'server_locked' }); f.unlock(true);
    const locking = createMailFollowUpStore(f.db, { ...f.codec, async open(value) { const result = await f.codec.open(value); f.unlock(false); return result; } });
    await expect(locking.list()).rejects.toMatchObject({ code: 'server_locked' }); f.unlock(true);
    const handlers = makeMailFollowUpHandlers({ service: f.service, authorize: () => { throw Error('Owner only'); } })!.handlers;
    await expect(handlers['mail.follow_up.list']({ query: 'renewal' }, {} as never)).rejects.toThrow('Owner only');
    f.db.prepare("UPDATE mail_follow_ups SET ciphertext='not an encrypted watch'").run();
    await expect(f.service.list({ query: 'no match' })).rejects.toBeDefined();
  });
});
