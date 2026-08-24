/** The predicate that deletes evidence, driven from the `false` side.
 *
 *  ⛔ Every test here except the two happy paths asserts that a run KEEPS its
 *  audit row. That ratio is the point: the dangerous direction is exempting
 *  something, so the exempting branch gets two tests and the refusing branches
 *  get twenty. A regression that widens this predicate should red loudly.
 */
import { describe, expect, it } from 'vitest';

import { CHANNELS, ACTORS, type ExecutionSource } from '../commits.js';
import {
  AUDIT_EXEMPT_CHANNEL,
  NON_DISPATCHING_STEP_TYPES,
  runIsAuditExemptRender,
} from '../audit-exemption.js';

const ownerSource = {
  channel: 'user', actor: 'user_self',
  user_id: 'local', client_token_id: 'client-1',
} as ExecutionSource;

/** A clean, pure-transform, owner-manual run — the ONLY shape that exempts. */
const render = (over: Record<string, unknown> = {}) => ({
  source: ownerSource,
  trigger_source: 'manual',
  commit_status: 'succeeded',
  errors: [] as unknown[],
  steps: [{ type: 'transform', skipped: false }, { type: 'guard', skipped: false }],
  ...over,
});

describe('runIsAuditExemptRender — the exempting side (deliberately small)', () => {
  it('exempts an owner-manual pure-transform run', () => {
    expect(runIsAuditExemptRender(render())).toBe(true);
  });

  it('a SKIPPED dispatching step did nothing, so it does not block the exemption', () => {
    // `skipped` means the step never ran. Treating it as a dispatch would make
    // any recipe with a conditional op permanently unexemptable.
    expect(runIsAuditExemptRender(render({
      steps: [{ type: 'transform', skipped: false }, { type: 'ingredient', skipped: true }],
    }))).toBe(true);
  });
});

describe('runIsAuditExemptRender — every refusing branch', () => {
  it('⛔ EVERY channel except `user` keeps its audit row — derived, not listed', () => {
    // Derived from the real `CHANNELS` union so a NEW channel is audited by
    // default and this test notices it exists, rather than a hand-written list
    // silently omitting it.
    const exempted = CHANNELS.filter((channel) =>
      runIsAuditExemptRender(render({
        source: { ...ownerSource, channel } as ExecutionSource,
      })));
    expect(exempted).toEqual([AUDIT_EXEMPT_CHANNEL]);
    // Named explicitly too, because these four are the ones a careless widening
    // would take first, and a reader should see them refused by name.
    for (const channel of ['chat', 'messenger', 'mcp', 'reception'] as const) {
      expect(`${channel}:${runIsAuditExemptRender(render({
        source: { ...ownerSource, channel } as ExecutionSource,
      }))}`).toBe(`${channel}:false`);
    }
  });

  it('⛔ every actor except `user_self` keeps its row — derived', () => {
    const exempted = ACTORS.filter((actor) =>
      runIsAuditExemptRender(render({
        source: { ...ownerSource, actor } as ExecutionSource,
      })));
    expect(exempted).toEqual(['user_self']);
  });

  it('⛔ SELF-RESTRICTED mode keeps its row — a `contract_id` on the user channel', () => {
    expect(runIsAuditExemptRender(render({
      source: { ...ownerSource, contract_id: 'some-contract' } as ExecutionSource,
    }))).toBe(false);
  });

  it('⛔ a missing source keeps the row — we cannot tell who ran it', () => {
    expect(runIsAuditExemptRender(render({ source: undefined }))).toBe(false);
    expect(runIsAuditExemptRender(render({ source: null }))).toBe(false);
  });

  it('⛔ only `manual` exempts — every other trigger keeps its row', () => {
    for (const t of ['reactive', 'schedule', 'auto_run', 'webhook', '', undefined]) {
      expect(`${String(t)}:${runIsAuditExemptRender(render({ trigger_source: t }))}`)
        .toBe(`${String(t)}:false`);
    }
  });

  it('⛔ anything but a clean success keeps its row — failures are what people look for', () => {
    for (const s of ['failed', 'awaiting_approval', 'awaiting_peer', 'cancelled', undefined]) {
      expect(`${String(s)}:${runIsAuditExemptRender(render({ commit_status: s }))}`)
        .toBe(`${String(s)}:false`);
    }
  });

  it('⛔ a run carrying errors keeps its row even if it reports success', () => {
    expect(runIsAuditExemptRender(render({ errors: [{ code: 'x' }] }))).toBe(false);
  });

  it('⛔ absent / empty / malformed steps keep the row — "nothing to inspect" is not "nothing happened"', () => {
    expect(runIsAuditExemptRender(render({ steps: undefined }))).toBe(false);
    expect(runIsAuditExemptRender(render({ steps: [] }))).toBe(false);
    expect(runIsAuditExemptRender(render({ steps: [null] }))).toBe(false);
    expect(runIsAuditExemptRender(render({ steps: ['nope'] }))).toBe(false);
    expect(runIsAuditExemptRender(render({ steps: [{ skipped: false }] }))).toBe(false);
  });

  it('⛔ a DISPATCHING step keeps the row — ingredient, prefetch, and anything unknown', () => {
    for (const type of ['ingredient', 'prefetch', 'future_kind_nobody_classified']) {
      expect(`${type}:${runIsAuditExemptRender(render({
        steps: [{ type, skipped: false }],
      }))}`).toBe(`${type}:false`);
    }
  });

  it('⛔ PREFETCH is not a loophole — a prefetch-only run still audits', () => {
    // `capture-job-reply` reaches `core.mail.get` through `prefetch_steps`. A walk
    // that only considered sequential steps would call that run "nothing happened".
    expect(runIsAuditExemptRender(render({
      steps: [{ type: 'prefetch', skipped: false }, { type: 'transform', skipped: false }],
    }))).toBe(false);
  });
});

describe('the read-only classifier seam — absent means AUDIT', () => {
  const dispatching = { steps: [{ type: 'ingredient', skipped: false }] };

  it('⛔ absent classifier ⇒ a dispatching step audits (the shipped default)', () => {
    expect(runIsAuditExemptRender(render(dispatching))).toBe(false);
  });

  it('⛔ a classifier that does not return exactly `true` audits', () => {
    for (const ret of [false, undefined, null, 0, 'yes'] as unknown[]) {
      expect(runIsAuditExemptRender(render({
        ...dispatching, stepIsProvablyReadOnly: () => ret,
      }))).toBe(false);
    }
  });

  it('a classifier proving read-only exempts — the seam works when a host wires it', () => {
    expect(runIsAuditExemptRender(render({
      ...dispatching, stepIsProvablyReadOnly: () => true,
    }))).toBe(true);
  });

  it('⛔ …and it is consulted PER STEP — one unproven step is enough to audit', () => {
    expect(runIsAuditExemptRender(render({
      steps: [{ type: 'ingredient', skipped: false }, { type: 'ingredient', skipped: false }],
      stepIsProvablyReadOnly: (_s: unknown, i: number) => i === 0,
    }))).toBe(false);
  });
});

describe('ratchets — widening these is a decision about evidence', () => {
  it('the non-dispatching set is exactly transform + guard', () => {
    expect([...NON_DISPATCHING_STEP_TYPES].sort()).toEqual(['guard', 'transform']);
  });
  it('the exempt channel is exactly one, and it is `user`', () => {
    expect(AUDIT_EXEMPT_CHANNEL).toBe('user');
  });
});
