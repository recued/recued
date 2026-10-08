/** The approval ask says WHERE a held write lands.
 *
 *  ⛔ Every write ask said *"Write actions change data outside Recued"* — on a
 *  live drive (2026-10-07) that was a booking, a commitment and an event on
 *  the local calendar, none of which leave the server. The sentence is line 2
 *  of the body, and the approval card repeats it, so a wrong one is wrong on
 *  every surface at once.
 *
 *  The proof is `kernelWriteStaysInRecued` (contracts); these pin that the
 *  composer feeds it the RIGHT calls — the gated step's input for a single
 *  hold, every member for a batch, every item for a foreach cover — and keeps
 *  the outside wording whenever any of them is unknown. */

import { describe, expect, it } from 'vitest';
import type { BatchedApprovalItem, Checkpoint } from '@recued/contracts';
import {
  buildPreflightAsk,
  type PreflightAskContext,
} from '../preflight-reconciliation.js';

const LOCAL = 'Write actions change your data in Recued, so Recued held it for you.';
const OUTSIDE = 'Write actions change data outside Recued, so Recued held it for you.';

const checkpoint = (input?: Record<string, unknown>): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'add-invite-to-calendar',
  gated_step_id: 'created',
  step_state: input === undefined ? {} : { created: { input } },
  created_at: 0,
});

const context = (tool_slug: string, extra: Partial<PreflightAskContext> = {}): PreflightAskContext => ({
  recipe_id: 'add-invite-to-calendar',
  gated_step_id: 'created',
  tool_slug,
  risk_tier: 'write',
  ...extra,
});

const secondLine = (cp: Checkpoint, ctx: PreflightAskContext): string =>
  buildPreflightAsk({ checkpoint: cp, context: ctx }).message.text.split('\n')[1]!;

const item = (args_preview: Record<string, unknown>): BatchedApprovalItem => ({
  member_id: 'm', canonical_payload_hash: 'h', summary: 's', args_preview,
});

describe('the write ask says whether the write stays in Recued', () => {
  it('a booking stays in Recued', () => {
    expect(secondLine(checkpoint({ title: 'Dental' }), context('booking-create'))).toBe(LOCAL);
  });

  it('an event on the local calendar stays in Recued; one on Google does not', () => {
    expect(secondLine(checkpoint({ slug: 'local', event: {} }), context('calendar-create')))
      .toBe(LOCAL);
    expect(secondLine(checkpoint({ slug: 'work-google', event: {} }), context('calendar-create')))
      .toBe(OUTSIDE);
  });

  it('an unrecorded step input proves nothing for an arg-dependent write', () => {
    expect(secondLine(checkpoint(), context('calendar-create'))).toBe(OUTSIDE);
  });

  it('a batch is local only when EVERY member is', () => {
    const batch = (items: BatchedApprovalItem[]): Partial<PreflightAskContext> => ({
      batch: {
        batch_id: 'b', payload_version: 1, items, unit: { kind: 'fire', id: 'run-1' },
      },
    });
    // The checkpoint's own input says local; the members decide.
    const cp = checkpoint({ slug: 'local' });
    const body = (items: BatchedApprovalItem[]): string =>
      buildPreflightAsk({ checkpoint: cp, context: context('calendar-create', batch(items)) })
        .message.text;
    expect(body([item({ slug: 'local' }), item({ slug: 'local' })]))
      .toContain('Write actions change your data in Recued, so Recued held them for you.');
    expect(body([item({ slug: 'local' }), item({ slug: 'work-google' })]))
      .toContain('Write actions change data outside Recued, so Recued held them for you.');
    // A member whose args are unknown is not proven local by the others.
    const unread: BatchedApprovalItem = { member_id: 'm2', canonical_payload_hash: 'h2', summary: 's' };
    expect(body([item({ slug: 'local' }), unread]))
      .toContain('Write actions change data outside Recued, so Recued held them for you.');
  });

  it('a foreach cover with unlisted items keeps the outside wording', () => {
    expect(secondLine(
      checkpoint({ slug: 'local' }),
      context('calendar-create', { foreach_cover: { total: 3 } }),
    )).toBe('Write actions change data outside Recued, so Recued held them for you.');
  });

  it('a send keeps the outside wording, and other tiers keep theirs', () => {
    expect(secondLine(checkpoint({ to: 'a@b.test' }), context('mail-send'))).toBe(OUTSIDE);
    expect(secondLine(checkpoint({ id: 'x' }), context('booking-delete', { risk_tier: 'destructive' })))
      .toBe('Destructive actions permanently remove data and cannot be undone, so Recued held it for you.');
  });
});
