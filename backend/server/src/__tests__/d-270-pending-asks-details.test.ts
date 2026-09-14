/** D-270 — `notification.pending_asks` forwards the detail rows, and bounds the
 *  cost the landing page never had.
 *
 *  ⛔ THE COPIER IS THE FILTER. The projection in `handlePendingAsks` is an
 *  enumerating literal — its own comments say so twice, for `link_url` and
 *  `note_prompt` — so a field it does not NAME is dropped however well the
 *  server resolved it. That is what the first test guards. */

import { describe, expect, it, vi } from 'vitest';

import {
  handlePendingAsks,
  PENDING_ASK_DETAIL_RESOLVE_MAX,
} from '../history-handler.js';

const pending = (id: string): never => ({
  ask_id: id,
  message: { text: `ask ${id}` },
  options: [{ id: 'approve', label: 'Approve' }],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: `cp-${id}` },
  status: 'open',
  created_at: 1_000,
  fanout_channels: [],
} as never);

const ROWS = [{ label: 'to', value: 'a@b.c' }];

describe('D-270 pending_asks details', () => {
  it('forwards the resolved rows onto the wire shape', async () => {
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('a1')],
      resolveAskDetails: async () => ROWS,
    } as never);
    expect(out.asks[0]!.details).toEqual(ROWS);
  });

  it('omits the key entirely when the resolver returns null — no empty block', async () => {
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('a1')],
      resolveAskDetails: async () => null,
    } as never);
    expect(out.asks[0]).not.toHaveProperty('details');
  });

  it('omits it when no resolver is wired — the pre-D-270 card, unchanged', async () => {
    const out = await handlePendingAsks({ listOpenAsks: async () => [pending('a1')] } as never);
    expect(out.asks[0]).not.toHaveProperty('details');
  });

  it('⛔ an EMPTY array is not "details" — it must not reach the wire', async () => {
    // An empty array is TRUTHY in JS, so a naive guard ships `details: []` — an
    // empty block where the contract says ABSENT means "render the ordinary
    // card". The resolver returns null for this case today; the guard lives at
    // the boundary that states the rule so a future one cannot break it quietly.
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('a1')],
      resolveAskDetails: async () => [],
    } as never);
    expect(out.asks[0]).not.toHaveProperty('details');
  });

  it('⛔ pairs rows to asks by POSITION, and the list is re-sorted before resolving', async () => {
    // The projection sorts newest-first and then indexes; resolving against the
    // UNSORTED list would attach one ask's values to another's card — which is
    // the worst possible defect in a surface whose whole job is "what will
    // happen", and it would look perfectly fine.
    const older = { ...(pending('old') as object), created_at: 1 } as never;
    const newer = { ...(pending('new') as object), created_at: 9 } as never;
    const out = await handlePendingAsks({
      listOpenAsks: async () => [older, newer],
      resolveAskDetails: async (p: { ask_id: string }) => [
        { label: 'which', value: p.ask_id },
      ],
    } as never);
    expect(out.asks.map((a) => a.ask_id)).toEqual(['new', 'old']);
    expect(out.asks.map((a) => a.details?.[0]?.value)).toEqual(['new', 'old']);
  });

  it('one unresolvable ask costs its rows, never the whole list', async () => {
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('a1'), pending('a2')],
      resolveAskDetails: async (p: { ask_id: string }) => {
        if (p.ask_id === 'a1') throw new Error('boom');
        return ROWS;
      },
    } as never);
    expect(out.asks).toHaveLength(2);
    expect(out.asks.find((a) => a.ask_id === 'a1')).not.toHaveProperty('details');
    expect(out.asks.find((a) => a.ask_id === 'a2')!.details).toEqual(ROWS);
  });

  it('⛔ above the cap the rows are omitted and the resolver is never called', async () => {
    // `/ask` resolves ONE hold per page load; this returns every open ask and
    // the card re-fetches. A pathological backlog must degrade to the pre-D-270
    // card rather than to a slow one.
    const resolveAskDetails = vi.fn(async () => ROWS);
    const many = Array.from(
      { length: PENDING_ASK_DETAIL_RESOLVE_MAX + 1 },
      (_, i) => pending(`a${i}`),
    );
    const out = await handlePendingAsks({
      listOpenAsks: async () => many, resolveAskDetails,
    } as never);
    expect(resolveAskDetails).not.toHaveBeenCalled();
    expect(out.asks.every((a) => !('details' in a))).toBe(true);
  });

  it('at exactly the cap it still resolves — the boundary is inclusive', async () => {
    const resolveAskDetails = vi.fn(async () => ROWS);
    const many = Array.from(
      { length: PENDING_ASK_DETAIL_RESOLVE_MAX },
      (_, i) => pending(`a${i}`),
    );
    await handlePendingAsks({ listOpenAsks: async () => many, resolveAskDetails } as never);
    expect(resolveAskDetails).toHaveBeenCalledTimes(PENDING_ASK_DETAIL_RESOLVE_MAX);
  });
});
