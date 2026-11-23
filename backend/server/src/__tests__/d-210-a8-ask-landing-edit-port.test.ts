/** D-210 A.8 slice 3d-2c — the `/ask` POST routing + the approver authority.
 *
 *  Two boundaries:
 *    - the PORT must route an approval carrying `edit.*` to the approve funnel and
 *      NEVER fall through to `submitAnswer`, which takes an option and would
 *      release the hold with the ORIGINAL args while reporting success;
 *    - `handleReceptionInboxApprove` must accept the ask-landing capability
 *      as its OWN authority — never a synthesised `instance_id` — and the
 *      audit row must say which authority acted. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { PendingAsk } from '@recued/notification';

import {
  ASK_LANDING_EDIT_TTL_MS,
  ASK_LANDING_LINK_TTL_MS,
  createAskLandingPortHandler,
  type AskLandingPortHandlerDeps,
} from '../ask-landing-port.js';
import { createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';
import { createAskLandingEditApproval } from '../ask-landing-edit-approval.js';
import {
  allowingAskLandingAbuseDeps,
  attachAskTestSocket,
} from './ask-landing-test-helpers.js';

const NOW = 1_700_000_000_000;
const HOST = 'h.example.com';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: string;
  setHeader(k: string, v: string | number | readonly string[]): void;
  end(b?: string): void;
}

const makeRes = (): MockRes =>
  ({
    statusCode: 0,
    headers: {},
    ended: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    },
    end(b) {
      this.ended = b ?? '';
    },
  }) as MockRes;

const buildReq = (opts: {
  method: string;
  url: string;
  body?: string;
}): IncomingMessage => {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = opts.method;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { headers: Record<string, string> }).headers =
    opts.method === 'POST'
      ? {
          host: HOST,
          origin: `https://${HOST}`,
          'content-type': 'application/x-www-form-urlencoded',
        }
      : {};
  return attachAskTestSocket(stream);
};

const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-1',
  message: { title: 'Approve', text: 'Approve?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'cp-1' },
  fanout_channels: ['email'],
  status: 'open',
  created_at: NOW,
  ...over,
});

const harness = (over: {
  submitEditedApproval?: AskLandingPortHandlerDeps['submitEditedApproval'];
  wireEdit?: boolean;
  /** D-210 finding 6 — age the clock past the link TTL. */
  nowAt?: number;
} = {}) => {
  const current = ask();
  let clock = over.nowAt ?? NOW;
  const submitAnswer = vi.fn(async () => {});
  const submitEditedApproval = vi.fn(
    over.submitEditedApproval ?? (async () => ({ ok: true })),
  );
  const nonceStore = createInMemoryAskLandingNonceStore();
  const deps: AskLandingPortHandlerDeps = {
    getAsk: async (id) => (id === current.ask_id ? current : null),
    submitAnswer,
    getVerificationPhrase: async () => undefined,
    nonceStore,
    now: () => clock,
    abuse: allowingAskLandingAbuseDeps(),
    resolveDetails: async () => ({
      heading: 'Create a booking',
      details: [
        {
          label: 'Slot start',
          value: '20 Jul 2026, 19:30 CEST',
          edit: { key: 'start_at', control: 'datetime-local', value: '2026-07-20T19:30' },
        },
      ],
    }),
    ...(over.wireEdit === false ? {} : { submitEditedApproval }),
  };
  const handler = createAskLandingPortHandler(deps);
  const nonce = (): string => nonceStore.issue('ask-1', clock);
  return { handler, submitAnswer, submitEditedApproval, nonce, current, deps,
    setNow: (value: number) => { clock = value; },
  };
};

const post = async (
  h: ReturnType<typeof harness>,
  fields: Record<string, string>,
): Promise<MockRes> => {
  const res = makeRes();
  await h.handler(
    buildReq({ method: 'POST', url: '/ask/ask-1', body: form(fields) }),
    res as unknown as ServerResponse,
  );
  return res;
};

describe('D-210 A.8 3d-2c — /ask POST routing', () => {
  it('routes a body carrying edits to the approve funnel, NOT submitAnswer', async () => {
    // ⛔ The failure this forbids: `submitAnswer` takes an option and nothing
    // else, so falling through would release the hold with the ORIGINAL args
    // while the page said "Response recorded: Approve".
    const h = harness();
    await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
      via: 'slack',
    });
    expect(h.submitEditedApproval).toHaveBeenCalledTimes(1);
    expect(h.submitAnswer).not.toHaveBeenCalled();
    const call = h.submitEditedApproval.mock.calls[0]![0]!;
    expect(call.option).toBe('approve');
    expect(call.via).toBe('slack');
    expect(call.rawEdits).toEqual({ start_at: '2026-07-20T20:00' });
    expect(call.ask.ask_id).toBe('ask-1');
  });

  it.each([
    ['inside the edit window', NOW],
    ['after editing closes', NOW + ASK_LANDING_EDIT_TTL_MS + 1],
  ] as const)('records Deny without applying submitted edit fields %s', async (_label, nowAt) => {
    const h = harness({ nowAt });
    const nonce = h.nonce();
    const res = await post(h, { form_nonce: nonce, ask_id: 'ask-1', option: 'deny',
      via: 'telegram', 'edit.start_at': 'not a date',
    });
    expect(res.statusCode).toBe(200);
    expect(h.submitAnswer).toHaveBeenCalledExactlyOnceWith({ ask_id: 'ask-1', option: 'deny', via: 'telegram' });
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    const replay = await post(h, { form_nonce: nonce, ask_id: 'ask-1', option: 'deny' });
    expect(replay.statusCode).toBe(403);
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps the link expiry guard on a denial carrying edit fields', async () => {
    const h = harness({ nowAt: NOW + ASK_LANDING_LINK_TTL_MS + 1 });
    const res = await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'deny',
      'edit.start_at': 'not a date',
    });
    expect(res.statusCode).toBe(404);
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
  });

  it('keeps an empty edit form combined with session allowance on the narrow approval path', async () => {
    const approve = vi.fn(async () => ({ released: true }));
    const h = harness({ submitEditedApproval: createAskLandingEditApproval({
      findHoldItem: async () => { throw new Error('Session allowance must be refused before lookup'); },
      approve, timeZone: 'UTC',
    }) });
    const res = await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'allow_session', edit_form: '1' });
    expect(res.ended).toContain('allowing this session');
    expect(h.submitEditedApproval).toHaveBeenCalledOnce();
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('routes a marked form with no edit fields through validation and consumes its nonce', async () => {
    const h = harness();
    const nonce = h.nonce();
    const fields = { form_nonce: nonce, ask_id: 'ask-1', option: 'approve', edit_form: '1' };
    const res = await post(h, fields);
    expect(res.statusCode).toBe(200);
    expect(h.submitEditedApproval).toHaveBeenCalledExactlyOnceWith({ ask: h.current, option: 'approve', rawEdits: {}, via: 'email' });
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect((await post(h, fields)).statusCode).toBe(403);
    expect(h.submitEditedApproval).toHaveBeenCalledOnce();
  });

  it('leaves an edit-less submission on the untouched submitAnswer path', async () => {
    const h = harness();
    await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'approve' });
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
  });

  it('re-renders the form WITH the refusal and a fresh nonce when approval fails', async () => {
    const h = harness({
      submitEditedApproval: async () => ({ ok: false, message: 'Slot start must be a date and time (in Europe/Paris).' }),
    });
    const res = await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': 'whenever',
    });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toContain('Slot start must be a date and time');
    // Still answerable — a refusal the owner cannot retry is a dead end.
    expect(res.ended).toContain('<form method="POST"');
    expect(res.ended).toContain('name="form_nonce"');
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('never reports success when the approve leg THROWS', async () => {
    const h = harness({
      submitEditedApproval: async () => {
        throw new Error('store exploded');
      },
    });
    const res = await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toContain('could not be approved');
    expect(res.ended).toContain('<form method="POST"');
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('REFUSES edits when no approve leg is wired — never silently drops them', async () => {
    // A page that renders controls always has this bound. Arriving here means
    // edits came for a page that never offered them.
    const h = harness({ wireEdit: false });
    const res = await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
    });
    expect(res.ended).toContain('cannot accept changes');
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('still rejects an unknown non-prefixed key at the decoder', async () => {
    const h = harness();
    const res = await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      hold_id: 'cp-other',
    });
    expect(res.statusCode).toBe(400);
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('consumes the single-use nonce before any edit reaches the funnel', async () => {
    const h = harness();
    const n = h.nonce();
    const fields = {
      form_nonce: n,
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
    };
    await post(h, fields);
    const replay = await post(h, fields);
    expect(replay.statusCode).toBe(403);
    expect(h.submitEditedApproval).toHaveBeenCalledTimes(1);
  });
});

/** D-210 code audit, finding 6 — the public bearer LINK expires, the DECISION does not.
 *
 *  ⚠ The audit's headline ("an open ask is immortal") was WRONG: `checkpoint-retention.ts`
 *  cancels an open ask past `preflight.stale_after_days` (default 30d, wired sweep). The
 *  real defect was that ONE knob served TWO purposes — an approval-staleness policy was
 *  also the lifetime of a forwardable URL that renders the held op's args — and `0`,
 *  documented only as "keep paused runs waiting forever", made that URL immortal.
 *
 *  These now have separate bounds, and that separation is what these pin. */
describe('D-210 finding 6 — the /ask link TTL', () => {
  const AGED = NOW + ASK_LANDING_LINK_TTL_MS + 1;

  it('GET past the TTL renders the generic page and leaks NO held-op details', async () => {
    const h = harness({ nowAt: AGED });
    const res = makeRes();
    await h.handler(
      buildReq({ method: 'GET', url: '/ask/ask-1' }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
    // ⛔ The disclosure half: a forwarded stale link must not keep rendering the
    // operation's values. `resolveDetails` supplies a slot + heading in this harness.
    expect(res.ended).not.toContain('Create a booking');
    expect(res.ended).not.toContain('20 Jul 2026');
    // …and it must not say the decision is still waiting — that would tell a stale
    // holder the owner has not acted yet.
    expect(res.ended).toContain('No longer available');
  });

  it('a plain answer POST past the TTL records NOTHING', async () => {
    // The common path — an ordinary approve carries no edits.
    const h = harness({ nowAt: AGED });
    await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'approve' });

    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
  });

  it('an EDIT POST past the TTL approves nothing', async () => {
    const h = harness({ nowAt: AGED });
    await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
    });

    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('⛔ does NOT cancel the ask — the decision stays answerable elsewhere', async () => {
    // 🔑 The whole point of separating the two lifetimes. The link dying must not
    // consume the owner's pending decision: it is still `open`, still in the Inbox,
    // still answerable by reply. Expiring the DECISION is `preflight.stale_after_days`'
    // job, and only the retention sweep may do it.
    const h = harness({ nowAt: AGED });
    const res = makeRes();
    await h.handler(
      buildReq({ method: 'GET', url: '/ask/ask-1' }),
      res as unknown as ServerResponse,
    );

    expect(h.current.status).toBe('open');
  });

  it('still works INSIDE the window — the guard is a bound, not a break', async () => {
    // The over-tightening guard. Just inside the TTL everything behaves as before.
    const h = harness({ nowAt: NOW + ASK_LANDING_LINK_TTL_MS - 1 });
    await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'approve' });

    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
  });
});

/** Appendix B's carry — approving and MOVING are not the same blast radius. */
describe('D-210 finding 6b — the EDIT window closes before the link does', () => {
  const PAST_EDIT = NOW + ASK_LANDING_EDIT_TTL_MS + 1;

  it('refuses expired edits and offers a fresh plain-answer retry without silently approving', async () => {
    // ⛔ The asymmetry: same capability, same 48h URL — but changing the
    // operation's args stops being available first.
    expect(PAST_EDIT).toBeLessThan(NOW + ASK_LANDING_LINK_TTL_MS);
    const h = harness({ nowAt: PAST_EDIT });
    const originalNonce = h.nonce();
    const res = await post(h, {
      form_nonce: originalNonce,
      ask_id: 'ask-1',
      option: 'approve',
      via: 'telegram',
      'edit.start_at': '2026-07-20T20:00',
    });

    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    // …and it must not silently fall through to an un-edited approve, which
    // would release the hold with the ORIGINAL args while the owner believed
    // their change had landed.
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(res.ended).toContain('no longer be used to change');
    expect(res.ended).toContain('20 Jul 2026, 19:30 CEST');
    expect(res.ended).not.toContain('name="edit.');
    expect(res.ended).toContain('name="via" value="telegram"');
    const retryNonce = res.ended.match(/name="form_nonce" value="([^"]+)"/)?.[1];
    expect(retryNonce).toBeTruthy();
    expect(retryNonce).not.toBe(originalNonce);
    await post(h, { form_nonce: retryNonce!, ask_id: 'ask-1', option: 'approve', via: 'telegram' });
    expect(h.submitAnswer).toHaveBeenCalledExactlyOnceWith({ ask_id: 'ask-1', option: 'approve', via: 'telegram' });
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    const replay = await post(h, { form_nonce: originalNonce, ask_id: 'ask-1', option: 'approve' });
    expect(replay.statusCode).toBe(403);
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty edit form after the deadline and offers an unmarked plain-answer retry', async () => {
    const h = harness({ nowAt: PAST_EDIT });
    const originalNonce = h.nonce();
    const res = await post(h, { form_nonce: originalNonce, ask_id: 'ask-1', option: 'approve', edit_form: '1' });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toContain('no longer be used to change');
    expect(res.ended).not.toContain('name="edit_form"');
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
    const retryNonce = res.ended.match(/name="form_nonce" value="([^"]+)"/)?.[1];
    expect(retryNonce).toBeTruthy();
    expect(retryNonce).not.toBe(originalNonce);
    await post(h, { form_nonce: retryNonce!, ask_id: 'ask-1', option: 'approve' });
    expect(h.submitAnswer).toHaveBeenCalledOnce();
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
  });

  it('renders original values read-only after the edit deadline while keeping the answer form', async () => {
    const h = harness({ nowAt: NOW + ASK_LANDING_EDIT_TTL_MS });
    // The resolver can cache immutable rows. Closing the edit window must not
    // mutate those rows, which remain editable for an in-window caller.
    const detail = Object.freeze({ label: 'Slot start', value: '20 Jul 2026, 19:30 CEST',
      edit: Object.freeze({ key: 'start_at', control: 'datetime-local' as const, value: '2026-07-20T19:30' }),
    });
    h.deps.resolveDetails = async () => ({ heading: 'Create a booking', details: Object.freeze([detail]) });
    const get = async () => {
      const res = makeRes();
      await h.handler(buildReq({ method: 'GET', url: '/ask/ask-1' }), res as unknown as ServerResponse);
      return res;
    };
    const atDeadline = await get();
    expect(atDeadline.ended).toContain('name="edit.start_at"');
    h.setNow(PAST_EDIT);
    const afterDeadline = await get();
    expect(afterDeadline.statusCode).toBe(200);
    expect(afterDeadline.ended).toContain('Create a booking');
    expect(afterDeadline.ended).toContain('20 Jul 2026, 19:30 CEST');
    expect(afterDeadline.ended).not.toContain('name="edit.');
    expect(afterDeadline.ended).toContain('value="approve"');
    expect(afterDeadline.ended).toContain('value="deny"');
    expect(afterDeadline.ended).toContain('name="form_nonce"');
    expect(detail.edit.value).toBe('2026-07-20T19:30');
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.submitEditedApproval).not.toHaveBeenCalled();
  });

  it.each(['details', 'state'] as const)('closes editing when the deadline passes during the final %s read', async boundary => {
    const h = harness({ nowAt: NOW + ASK_LANDING_EDIT_TTL_MS - 1 });
    if (boundary === 'details') {
      const resolveDetails = h.deps.resolveDetails!;
      h.deps.resolveDetails = async current => {
        const details = await resolveDetails(current);
        h.setNow(PAST_EDIT);
        return details;
      };
    } else {
      let reads = 0;
      h.deps.getAsk = async () => {
        reads++;
        await Promise.resolve();
        if (reads === 2) h.setNow(PAST_EDIT);
        return structuredClone(h.current);
      };
    }
    const res = makeRes();
    await h.handler(buildReq({ method: 'GET', url: '/ask/ask-1' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toContain('20 Jul 2026, 19:30 CEST');
    expect(res.ended).not.toContain('name="edit.');
    expect(res.ended).toContain('<form method="POST"');
    expect(res.ended).toContain('name="form_nonce"');
  });

  it('a plain approve in the SAME window still works', async () => {
    // The whole point of two windows rather than one: answering is unaffected.
    const h = harness({ nowAt: PAST_EDIT });
    await post(h, { form_nonce: h.nonce(), ask_id: 'ask-1', option: 'approve' });

    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
  });

  it('an edit INSIDE 24h is untouched', async () => {
    const h = harness({ nowAt: NOW + ASK_LANDING_EDIT_TTL_MS - 1 });
    await post(h, {
      form_nonce: h.nonce(),
      ask_id: 'ask-1',
      option: 'approve',
      'edit.start_at': '2026-07-20T20:00',
    });

    expect(h.submitEditedApproval).toHaveBeenCalledTimes(1);
  });
});
