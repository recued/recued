/** D-255 — canonical ops in CHAT, from the same builder the door uses.
 *
 *  ⛔ THE POINT OF THESE IS THAT THERE IS NO OWNER PATH. The owner is the
 *  `user_self` contract and a door is another contract id; both resolve through
 *  one gate, so the catalog and the dispatch must be one mechanism keyed on the
 *  turn's source. An earlier cut gated the DOOR listing on the MCP per-token
 *  checklist — a thing only doors have — which would have left chat unfiltered
 *  while the tested surface looked correct.
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_OP_TOOL_PREFIX } from '@recued/contracts';

import {
  createChatRawOpSource,
  createChatRawOpDispatch,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import { buildCanonicalOpToolDescriptors } from '../canonical-op-tool-catalog.js';

const CANONICAL = buildCanonicalOpToolDescriptors({
  boundConnections: [{ name: 'acme-corp', vendor: 'hubspot' }],
});

const OWNER_SOURCE = { channel: 'chat', actor: 'user_self' } as never;

const deps = (over: Partial<ChatToolHandlerDeps> = {}): ChatToolHandlerDeps => ({
  getCanonicalOpTools: () => CANONICAL,
  // No pack scan ⇒ no RAW ops; isolates the canonical contribution.
  scanInstalledPacks: undefined,
  ...over,
} as unknown as ChatToolHandlerDeps);

describe('canonical ops reach the chat catalog through the shared hook', () => {
  it('⛔ appears in `rawOpSource` — the SAME hook chat-orchestrator already looks up', () => {
    // Riding the existing source is what makes chat need no new seam: the
    // orchestrator's single lookup finds it and routes it to the single dispatch.
    const entries = createChatRawOpSource(deps())(OWNER_SOURCE);
    const names = entries.map((e) => e.name);
    expect(names).toContain(`${CANONICAL_OP_TOOL_PREFIX}contact.update`);
    expect(names).toContain(`${CANONICAL_OP_TOOL_PREFIX}deal.update`);
  });

  it('carries the tier-2 entry shape the catalog expects', () => {
    const entry = createChatRawOpSource(deps())(OWNER_SOURCE)
      .find((e) => e.name === `${CANONICAL_OP_TOOL_PREFIX}contact.update`);
    expect(entry?.tier).toBe(2);
    expect(entry?.classification).toBe('write');
    expect(entry?.arg_schema).toBeDefined();
  });

  it('⛔ contributes nothing when the thunk is absent (dbless posture)', () => {
    const entries = createChatRawOpSource(deps({ getCanonicalOpTools: undefined }))(OWNER_SOURCE);
    expect(entries.filter((e) => e.name.startsWith(CANONICAL_OP_TOOL_PREFIX))).toEqual([]);
  });
});

describe('canonical ops dispatch through the shared hook', () => {
  const dispatch = (over: Partial<ChatToolHandlerDeps> = {}) =>
    createChatRawOpDispatch(deps(over));

  it('⛔ requires a connection and never defaults one', async () => {
    const res = await dispatch()(
      `${CANONICAL_OP_TOOL_PREFIX}contact.update`, { args: { id: 'c-1' } }, {} as never,
    );
    expect(JSON.stringify(res)).toContain("requires a 'connection'");
  });

  it('⛔ refuses an unknown alias before executing anything', async () => {
    const res = await dispatch({ getExecuteRecipe: () => (async () => ({})) as never })(
      `${CANONICAL_OP_TOOL_PREFIX}ticket.update`, { connection: 'acme-corp' }, {} as never,
    );
    expect(JSON.stringify(res)).toContain('unknown canonical alias');
  });

  it('🔑 builds the transient recipe and runs it through the recipe executor', async () => {
    // The wiring proof: the executor receives a one-step canonical recipe with the
    // connection in config — not a raw op, and not a hand-shaped request.
    let seen: { recipe?: { steps?: { op?: string }[] }; config?: Record<string, unknown> } | null = null;
    const res = await dispatch({
      getExecuteRecipe: () => (async (req: unknown) => {
        seen = req as typeof seen;
        return { success: true } as never;
      }) as never,
    })(
      `${CANONICAL_OP_TOOL_PREFIX}contact.update`,
      { connection: 'acme-corp', args: { id: 'c-1', jobtitle: 'CTO' } },
      {} as never,
    );
    expect(res.ok).toBe(true);
    expect(seen!.recipe!.steps![0]!.op).toBe('contact.update');
    expect(seen!.config).toEqual({ connection: 'acme-corp' });
  });

  it('still routes a NON-canonical name down the raw-op path', async () => {
    // One hook, two families — the prefix is the only discriminator.
    const res = await dispatch()('recued_op_pub.pack.thing', {}, {} as never);
    expect(JSON.stringify(res)).toContain('raw op dispatch unavailable');
  });
});

describe('canonical search fans out; everything else names its connection', () => {
  // ⛔ AN ACCOUNTING ALIAS, DELIBERATELY. Canonical `search` is suppressed for every
  // shipped `crm_alias` (a Tier-1 tool fans out over more sources), so exercising
  // fan-out through `contact.search` would test a tool that must not exist. The
  // accounting family has no Tier-1 tool, which is exactly where the canonical
  // fan-out is the answer rather than a duplicate.
  const ACCT_REG = [
    { vendor: 'ledgerco', entity: 'invoice', acct_alias: 'invoice' },
    { vendor: 'booksco', entity: 'invoice', acct_alias: 'invoice' },
  ] as unknown as Parameters<typeof buildCanonicalOpToolDescriptors>[0]['registry'];
  const TWO = buildCanonicalOpToolDescriptors({
    boundConnections: [
      { name: 'acme-corp', vendor: 'ledgerco' },
      { name: 'sf1', vendor: 'booksco' },
    ],
    registry: ACCT_REG,
  });
  const withTwo = (execute: (req: unknown) => Promise<unknown>) =>
    createChatRawOpDispatch({
      getCanonicalOpTools: () => TWO,
      scanInstalledPacks: undefined,
      getExecuteRecipe: () => execute as never,
    } as unknown as ChatToolHandlerDeps);

  it('🔑 an unnamed SEARCH runs once per serving connection and keeps provenance', async () => {
    const seen: string[] = [];
    const res = await withTwo(async (req) => {
      const conn = (req as { config: { connection: string } }).config.connection;
      seen.push(conn);
      return { success: true, from: conn };
    })(`${CANONICAL_OP_TOOL_PREFIX}invoice.search`, { args: { q: 'acme' } }, {} as never);

    expect(seen).toEqual(['acme-corp', 'sf1']);
    const out = (res as { result: { legs: { connection: string; ok: boolean }[]; partial: boolean } }).result;
    expect(out.legs.map((l) => l.connection)).toEqual(['acme-corp', 'sf1']);
    expect(out.partial).toBe(false);
  });

  it('⛔ ONE LEG FAILING DEGRADES THE ANSWER, NEVER REPLACES IT', async () => {
    // A CRM being down must not turn "here are Sandra's records" into an error —
    // and must not turn it into a silent partial either.
    const res = await withTwo(async (req) => {
      const conn = (req as { config: { connection: string } }).config.connection;
      if (conn === 'sf1') throw new Error('salesforce unreachable');
      return { success: true, from: conn };
    })(`${CANONICAL_OP_TOOL_PREFIX}invoice.search`, {}, {} as never);

    const out = (res as { result: { legs: { connection: string; ok: boolean; reason?: string }[]; partial: boolean } }).result;
    expect(res.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.legs.find((l) => l.connection === 'acme-corp')?.ok).toBe(true);
    const failed = out.legs.find((l) => l.connection === 'sf1');
    expect(failed?.ok).toBe(false);
    expect(failed?.reason).toContain('salesforce unreachable');
  });

  it('a NAMED search still runs exactly once, against that connection', async () => {
    const seen: string[] = [];
    await withTwo(async (req) => {
      seen.push((req as { config: { connection: string } }).config.connection);
      return { success: true };
    })(`${CANONICAL_OP_TOOL_PREFIX}invoice.search`, { connection: 'sf1' }, {} as never);
    expect(seen).toEqual(['sf1']);
  });

  it.each(['update', 'create', 'delete', 'read'])(
    '⛔ an unnamed %s REFUSES — fan-out is search-only',
    async (verb) => {
      // A write would hit every connected CRM; a `read` takes an id that belongs to
      // exactly one connection. Neither has a safe default.
      let calls = 0;
      const res = await withTwo(async () => { calls += 1; return {}; })(
        `${CANONICAL_OP_TOOL_PREFIX}invoice.${verb}`, { args: { id: 'c-1' } }, {} as never,
      );
      expect(JSON.stringify(res)).toContain("requires a 'connection'");
      expect(calls).toBe(0);
    },
  );

  it('⛔ refuses an unnamed search when no connection serves the alias', async () => {
    const none = createChatRawOpDispatch({
      getCanonicalOpTools: () => [],
      scanInstalledPacks: undefined,
      getExecuteRecipe: () => (async () => ({})) as never,
    } as unknown as ChatToolHandlerDeps);
    const res = await none(`${CANONICAL_OP_TOOL_PREFIX}invoice.search`, {}, {} as never);
    expect(JSON.stringify(res)).toContain('no connection serves');
  });
});
