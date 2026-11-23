/** D-341 slice A — a request approved ahead: the switch beside Send that lets a chat
 *  conversation's browser actions run without asking, until the owner turns it off or eight hours
 *  pass (`storage/browser-pass-store.ts`, `browser-pass-rpc.ts`, `browser-passes.ts`). What it lets
 *  through at the commit gateway's pass seam is pinned in `held-browser-target.test.ts`; the switch
 *  in the webclient's own test. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_PASS_REQUEST_OPTION_ID,
  BROWSER_REQUEST_PASS_TTL_MS,
  browserPassOffersRequest,
  browserPassOptions,
  type BrowserPassOffer,
  type Checkpoint,
  type ExecutionSource,
} from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';

import { createBrowserPassRpcHandlers } from '../browser-pass-rpc.js';
import { recordBrowserPassAnswer, useBrowserRequestPass } from '../browser-passes.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';

const CHAT = 'chat:chat-1';
const owner = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't1' } as ExecutionSource;

describe('D-341 slice A — the request approved ahead, kept per conversation', () => {
  it('turned on lasts eight hours at most; turned on again keeps it as it is; turned off it ends', () => {
    const store = createBrowserPassStore(new Database(':memory:'));
    expect(store.requestPass(CHAT, 1_000)).toBeUndefined();
    const started = store.startRequestPass(CHAT, 1_000);
    expect(started).toEqual({ channel_session_id: CHAT, started_at: 1_000, expires_at: 1_000 + BROWSER_REQUEST_PASS_TTL_MS, uses: 0 });
    expect(store.startRequestPass(CHAT, 5_000)).toEqual(started);
    // Another conversation has none.
    expect(store.requestPass('chat:chat-2', 5_000)).toBeUndefined();
    expect(store.useRequestPass(CHAT, 6_000)).toMatchObject({ uses: 1 });
    expect(store.requestPass(CHAT, 1_000 + BROWSER_REQUEST_PASS_TTL_MS)).toBeUndefined();
    expect(store.useRequestPass(CHAT, 1_000 + BROWSER_REQUEST_PASS_TTL_MS)).toBeUndefined();
    // On again after it ended: a new one, from then.
    expect(store.startRequestPass(CHAT, 9_000_000_000)).toMatchObject({ started_at: 9_000_000_000, uses: 0 });
    expect(store.endRequestPass(CHAT, 9_000_000_001)).toBe(true);
    expect(store.endRequestPass(CHAT, 9_000_000_002)).toBe(false);
    expect(store.useRequestPass(CHAT, 9_000_000_003)).toBeUndefined();
  });

  it('covers the owner\'s own chat only: never an AI app, a messenger thread or a scheduled prompt', () => {
    const store = createBrowserPassStore(new Database(':memory:'));
    store.startRequestPass(CHAT, 1_000);
    expect(useBrowserRequestPass(store, owner, CHAT, 2_000)).toMatchObject({ uses: 1 });
    const others: ExecutionSource[] = [
      { channel: 'mcp', actor: 'contracted_user', contract_id: 'ct-1', mcp_token_id: 't' } as ExecutionSource,
      { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource,
      { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r' } as ExecutionSource,
      { ...owner, contract_id: 'ct-household' } as ExecutionSource,
    ];
    // Even handed the conversation's own key.
    for (const source of others) expect(useBrowserRequestPass(store, source, CHAT, 3_000), JSON.stringify(source)).toBeUndefined();
    expect(store.requestPass(CHAT, 3_000)).toMatchObject({ uses: 1 });
  });

  it('the owner reads and sets it for a chat conversation, each change audited', async () => {
    const store = createBrowserPassStore(new Database(':memory:'));
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
    let at = 10_000;
    const rpc = createBrowserPassRpcHandlers({ store, auditLog, now: () => at });
    expect(await rpc['collection.contract.getRequestPass']({ session_id: 'chat-1' })).toEqual({});
    expect(await rpc['collection.contract.setRequestPass']({ session_id: 'chat-1', allow: true }))
      .toEqual({ pass: { channel_session_id: CHAT, started_at: 10_000, expires_at: 10_000 + BROWSER_REQUEST_PASS_TTL_MS, uses: 0 } });
    at = 20_000;
    // On again: kept, not started anew, and not audited twice.
    expect((await rpc['collection.contract.setRequestPass']({ session_id: 'chat-1', allow: true })).pass?.started_at).toBe(10_000);
    expect((await rpc['collection.contract.getRequestPass']({ session_id: 'chat-1' })).pass?.started_at).toBe(10_000);
    expect(await rpc['collection.contract.setRequestPass']({ session_id: 'chat-1', allow: false })).toEqual({});
    expect(await rpc['collection.contract.getRequestPass']({ session_id: 'chat-1' })).toEqual({});
    await expect(rpc['collection.contract.setRequestPass']({ session_id: 'chat-1', allow: 'yes' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(rpc['collection.contract.getRequestPass']({})).rejects.toMatchObject({ code: 'bad_request' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await auditLog.listActivities()).map((a) => [a.action, a.target]).sort()).toEqual([
      ['browser_request_pass_ended', CHAT], ['browser_request_pass_started', CHAT]]);
  });

  it('an ask from the owner\'s chat offers to stop asking in this chat; answered, the switch is on', () => {
    const offer: BrowserPassOffer = { key: { principal: { kind: 'owner_chat' }, recipe: 'click-web-element',
      site: 'https://github.com' }, host: 'github.com', channel_session_id: CHAT };
    expect(browserPassOffersRequest(offer)).toBe(true);
    expect(browserPassOptions(offer.host, { request: true }).map((option) => option.id)).toEqual([
      'allow_site_session', 'allow_site_always', BROWSER_PASS_REQUEST_OPTION_ID]);
    expect(browserPassOptions(offer.host, { request: true })[2]!.label).toBe('Don’t ask about browser actions in this chat');
    // An AI app's ask, or one from a messenger, offers only the site answers.
    expect(browserPassOffersRequest({ ...offer, key: { ...offer.key, principal: { kind: 'ai_app', contract_id: 'ct-1' } },
      channel_session_id: 'mcp:t' })).toBe(false);
    expect(browserPassOffersRequest({ ...offer, channel_session_id: 'messenger:telegram:42' })).toBe(false);

    const store = createBrowserPassStore(new Database(':memory:'));
    const checkpoint = { run_id: 'run-1', checkpoint_id: 'held-1', preflight_context: { browser_pass: offer } } as unknown as Checkpoint;
    recordBrowserPassAnswer({ browserPasses: store }, checkpoint, 'approved', { pass: 'request', decision_version: 1, now: 5_000 });
    expect(store.requestPass(CHAT, 5_000)).toMatchObject({ started_at: 5_000 });
    // No pass on the site was minted by it.
    expect(store.listPasses(5_000)).toEqual([]);
  });
});
