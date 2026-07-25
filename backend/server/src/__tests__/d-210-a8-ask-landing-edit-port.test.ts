/** D-210 A.8 slice 3d-2c — the `/ask` POST routing + the approver authority.
 *
 *  Two boundaries:
 *    - the PORT must route a body carrying `edit.*` to the approve funnel and
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
  createAskLandingPortHandler,
  type AskLandingPortHandlerDeps,
} from '../ask-landing-port.js';
import { createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';

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
  return stream;
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
} = {}) => {
  const current = ask();
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
    now: () => NOW,
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
  const nonce = (): string => nonceStore.issue('ask-1', NOW);
  return { handler, submitAnswer, submitEditedApproval, nonce };
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
    });
    expect(h.submitEditedApproval).toHaveBeenCalledTimes(1);
    expect(h.submitAnswer).not.toHaveBeenCalled();
    const call = h.submitEditedApproval.mock.calls[0]![0]!;
    expect(call.option).toBe('approve');
    expect(call.rawEdits).toEqual({ start_at: '2026-07-20T20:00' });
    expect(call.ask.ask_id).toBe('ask-1');
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
