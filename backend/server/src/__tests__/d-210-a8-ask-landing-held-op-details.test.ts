/** D-210 A.8 slice 3d-2b — `/ask` renders the held operation's details.
 *
 *  Three units:
 *    - `buildAskLandingDetails` — the value formatting. Every case here is a
 *      CLAIM about what the held operation will do, so each is pinned:
 *      especially the zone rules, where the difference between re-expressing
 *      an instant and shifting a wall clock is a missed appointment.
 *    - `createAskLandingDetailResolver` — the `PendingAsk` → hold gates. Each
 *      null is a distinct fact, not a fallback.
 *    - the `/ask` port — the block reaches the page, and a failure to resolve
 *      it never costs the ask its answerability. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ArgEditField, InboxItem } from '@recued/contracts';
import type { PendingAsk } from '@recued/notification';

import {
  buildAskLandingDetails,
  createAskLandingDetailResolver,
} from '../ask-landing-held-op-details.js';
import {
  createAskLandingPortHandler,
  type AskLandingPortHandlerDeps,
} from '../ask-landing-port.js';
import { createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';
import {
  allowingAskLandingAbuseDeps,
  attachAskTestSocket,
} from './ask-landing-test-helpers.js';

const PARIS = 'Europe/Paris';
// 17:30Z — 19:30 in Paris on a SUMMER day (CEST), 18:30 in WINTER (CET).
const SUMMER_MS = Date.UTC(2026, 6, 20, 17, 30);
const WINTER_MS = Date.UTC(2026, 0, 20, 17, 30);

const field = (over: Partial<ArgEditField> & { key: string }): ArgEditField =>
  ({ type: 'string', ...over }) as ArgEditField;

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  hold_id: 'cp-1',
  operation_id: 'reception-scheduling.scheduling.materialize',
  top_tier_kind: 'booking',
  source: { kind: 'scheduling_link', record_ref: 'req-1' },
  args: {},
  arg_schema: { fields: [] },
  preview: { title: 'A reservation' },
  proposed_action: 'Create a booking',
  status: 'pending',
  ...over,
});

/** Format ONE field/value pair — the workhorse for the formatting cases. */
const oneValue = (
  f: Partial<ArgEditField> & { key: string },
  value: unknown,
  timeZone = PARIS,
): string =>
  buildAskLandingDetails(
    item({
      arg_schema: { fields: [field(f)] },
      args: value === undefined ? {} : { [f.key]: value },
    }),
    { timeZone },
  ).details[0]!.value;

// ────────────────────────────────────────────────────────────────
// buildAskLandingDetails — the formatting claims
// ────────────────────────────────────────────────────────────────

describe('D-210 A.8 3d-2b — buildAskLandingDetails', () => {
  it('projects the arg_schema allowlist in order, and NOT the raw args bag', () => {
    // The pack author declared exactly these as the reviewable surface, and
    // they are the set 3d-2c makes editable. An arg outside it is immutable
    // and is not the page's business.
    const built = buildAskLandingDetails(
      item({
        arg_schema: {
          fields: [
            field({ key: 'title', label: 'Summary' }),
            field({ key: 'body', label: 'Details' }),
          ],
        },
        args: { title: 'Table for four', body: 'Window seat', secret_internal: 'nope' },
      }),
      { timeZone: PARIS },
    );
    expect(built.details).toEqual([
      { label: 'Summary', value: 'Table for four' },
      { label: 'Details', value: 'Window seat' },
    ]);
    expect(JSON.stringify(built)).not.toContain('nope');
  });

  it('carries the item proposed_action as the heading', () => {
    expect(
      buildAskLandingDetails(
        item({ arg_schema: { fields: [field({ key: 'title' })] } }),
        { timeZone: PARIS },
      ).heading,
    ).toBe('Create a booking');
  });

  it('falls back to the key when a field declares no label', () => {
    expect(
      buildAskLandingDetails(
        item({ arg_schema: { fields: [field({ key: 'start_at' })] }, args: { start_at: 'x' } }),
        { timeZone: PARIS },
      ).details[0]!.label,
    ).toBe('start_at');
  });

  it('distinguishes an absent arg from a present-but-empty one', () => {
    // "the pack declared this and nothing filled it" and "this is
    // deliberately blank" are different facts about what approve commits.
    expect(oneValue({ key: 'body' }, undefined)).toBe('(not set)');
    expect(oneValue({ key: 'body' }, '')).toBe('(empty)');
    expect(oneValue({ key: 'body' }, null)).toBe('(not set)');
  });

  it('reads absence and emptiness the same way whatever the declared type', () => {
    // Decided once, before the type dispatch. An empty `datetime` used to
    // render a blank <dd> while an empty `string` said `(empty)` — the same
    // fact about the held op reading two different ways.
    for (const type of ['string', 'datetime', 'number', 'json'] as const) {
      expect(oneValue({ key: 'k', type }, '')).toBe('(empty)');
      expect(oneValue({ key: 'k', type }, undefined)).toBe('(not set)');
      expect(oneValue({ key: 'k', type }, null)).toBe('(not set)');
    }
  });

  it('renders a non-scalar datetime through the generic path, not [object Object]', () => {
    expect(oneValue({ key: 'start_at', type: 'datetime' }, { at: 1 })).toBe('{"at":1}');
  });

  it('renders a boolean as Yes/No, and an ABSENT boolean as No', () => {
    // Absent means unchecked: the webclient inbox renders `value === true`
    // into a checkbox and the projection reads `input.notify_visitor ===
    // true`. `(not set)` here would contradict both — and contradict the
    // unchecked box 3d-2c puts on this very page.
    expect(oneValue({ key: 'notify_visitor', type: 'boolean' }, true)).toBe('Yes');
    expect(oneValue({ key: 'notify_visitor', type: 'boolean' }, false)).toBe('No');
    expect(oneValue({ key: 'notify_visitor', type: 'boolean' }, undefined)).toBe('No');
  });

  it('renders numbers verbatim', () => {
    expect(oneValue({ key: 'seats', type: 'number' }, 4)).toBe('4');
    expect(oneValue({ key: 'seats', type: 'number' }, 0)).toBe('0');
  });

  // ── the zone rules ──────────────────────────────────────────────

  it('renders an epoch-ms datetime in the display zone and NAMES the zone', () => {
    // Raw epoch-ms is unreadable and an unlabelled wall clock is how a
    // booking is missed — this page is read on a phone that may be nowhere
    // near the server.
    expect(oneValue({ key: 'start_at', type: 'datetime' }, SUMMER_MS)).toBe(
      '20 Jul 2026, 19:30 CEST',
    );
    expect(oneValue({ key: 'start_at', type: 'datetime' }, SUMMER_MS, 'UTC')).toBe(
      '20 Jul 2026, 17:30 UTC',
    );
    expect(
      oneValue({ key: 'start_at', type: 'datetime' }, SUMMER_MS, 'America/New_York'),
    ).toBe('20 Jul 2026, 13:30 GMT-4');
  });

  it('tracks DST rather than pinning one offset for the zone', () => {
    expect(oneValue({ key: 'start_at', type: 'datetime' }, WINTER_MS)).toBe(
      '20 Jan 2026, 18:30 CET',
    );
  });

  it('re-expresses a ZONE-BEARING datetime string in the display zone', () => {
    // It names an instant, so it may be moved.
    for (const raw of ['2026-07-20T17:30:00Z', '2026-07-20T18:30:00+01:00']) {
      expect(oneValue({ key: 'start_at', type: 'datetime' }, raw)).toBe(
        '20 Jul 2026, 19:30 CEST',
      );
    }
  });

  it('prints a ZONE-LESS datetime string VERBATIM — never shifted', () => {
    // `Date.parse` would read it in the SERVER's zone, so a 19:30 typed in
    // Paris, parsed on a UTC host and rendered back in Paris, becomes 21:30.
    // Showing what the operation literally holds cannot be wrong.
    expect(oneValue({ key: 'start_at', type: 'datetime' }, '2026-07-20T19:30')).toBe(
      '2026-07-20T19:30',
    );
    expect(
      oneValue({ key: 'start_at', type: 'datetime' }, '2026-07-20T19:30', 'UTC'),
    ).toBe('2026-07-20T19:30');
  });

  it('falls back to UTC for an unknown IANA zone instead of throwing the row away', () => {
    expect(oneValue({ key: 'start_at', type: 'datetime' }, SUMMER_MS, 'Not/AZone')).toBe(
      '20 Jul 2026, 17:30 UTC',
    );
  });

  it('echoes an unformattable datetime rather than printing a value it does not hold', () => {
    // `JSON.stringify(NaN)` is the string `null` — a value nothing holds.
    expect(oneValue({ key: 'start_at', type: 'datetime' }, Number.NaN)).toBe('NaN');
  });

  // ── json, truncation, key resolution ────────────────────────────

  it('serialises a json value, and says so when it cannot', () => {
    expect(oneValue({ key: 'meta', type: 'json' }, { a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(oneValue({ key: 'meta', type: 'json' }, cyclic)).toBe('(unreadable value)');
  });

  it('cuts a long value and makes the cut VISIBLE', () => {
    // A silent cut would misreport what the operation carries.
    const long = 'x'.repeat(500);
    const rendered = oneValue({ key: 'body' }, long);
    expect(rendered.endsWith('…')).toBe(true);
    expect(rendered.length).toBe(401);
    expect(oneValue({ key: 'body' }, 'x'.repeat(400))).not.toContain('…');
  });

  it('reads a dotted key literally first, then walks nested objects', () => {
    // `edits` are keyed by the declared key verbatim, so a literal hit IS
    // the value the operation dispatches with.
    expect(
      buildAskLandingDetails(
        item({
          arg_schema: { fields: [field({ key: 'request.email' })] },
          args: { 'request.email': 'flat@example.com', request: { email: 'nested@example.com' } },
        }),
        { timeZone: PARIS },
      ).details[0]!.value,
    ).toBe('flat@example.com');
    expect(
      buildAskLandingDetails(
        item({
          arg_schema: { fields: [field({ key: 'request.email' })] },
          args: { request: { email: 'nested@example.com' } },
        }),
        { timeZone: PARIS },
      ).details[0]!.value,
    ).toBe('nested@example.com');
  });

  it('yields no rows for an empty allowlist (an op with no editable args)', () => {
    expect(buildAskLandingDetails(item(), { timeZone: PARIS }).details).toEqual([]);
  });

  it('renders a picker field READ-ONLY even when editable — no empty control', () => {
    // An `options_source` field is a picker over a live list and this page has
    // no resolver for one. A control that cannot express a valid answer is
    // worse than not offering the field: the owner would see an empty input
    // and either leave it (fine) or type into it (a value nothing accepts).
    // The webclient's own fallback for the same case renders a DISABLED
    // "picker unavailable" select.
    const built = buildAskLandingDetails(
      item({
        arg_schema: {
          fields: [
            field({ key: 'calendar_id', label: 'Calendar', options_source: 'calendars' }),
            field({ key: 'title', label: 'Summary' }),
          ],
        },
        args: { calendar_id: 'cal-1', title: 'Table for four' },
      }),
      { timeZone: PARIS, editable: true },
    );
    expect(built.details[0]!.edit).toBeUndefined();
    expect(built.details[0]!.value).toBe('cal-1');
    // …and a normal field beside it still IS editable, so the assertion above
    // is about the picker and not about `editable` being ignored wholesale.
    expect(built.details[1]!.edit?.control).toBe('text');
  });

  it('emits no edit controls at all unless editable is asked for', () => {
    const built = buildAskLandingDetails(
      item({
        arg_schema: { fields: [field({ key: 'title', label: 'Summary' })] },
        args: { title: 'Table for four' },
      }),
      { timeZone: PARIS },
    );
    expect(built.details[0]!.edit).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// createAskLandingDetailResolver — the gates
// ────────────────────────────────────────────────────────────────

const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-1',
  message: { title: 'Approve', text: 'Approve?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'cp-1' },
  fanout_channels: ['email'],
  status: 'open',
  // D-210 finding 6 — a REALISTIC mint time. `1` was an arbitrary placeholder
  // (nothing here asserts on it), but the port now bounds the public link's life
  // to ASK_LANDING_LINK_TTL_MS from `created_at`, and an epoch-1 ask is ~53 years
  // stale against this file's NOW. Production always stamps `now()` at mint and the
  // field is required on `PendingAsk`, so the placeholder — not the guard — was the
  // unrealistic part.
  created_at: NOW,
  ...over,
});

const HELD = item({
  arg_schema: { fields: [field({ key: 'title', label: 'Summary' })] },
  args: { title: 'Table for four' },
});

describe('D-210 A.8 3d-2b — createAskLandingDetailResolver', () => {
  const resolverOver = (findHoldItem: (id: string) => Promise<InboxItem | null>) =>
    createAskLandingDetailResolver({ findHoldItem, timeZone: PARIS });

  it('resolves the held op addressed by handler_payload.checkpoint_id', async () => {
    const findHoldItem = vi.fn(async () => HELD);
    const out = await resolverOver(findHoldItem)(ask());
    expect(findHoldItem).toHaveBeenCalledWith('cp-1');
    expect(out).toEqual({
      heading: 'Create a booking',
      details: [{ label: 'Summary', value: 'Table for four' }],
    });
  });

  it('returns null for a NON-preflight ask — it holds no operation at all', async () => {
    const findHoldItem = vi.fn(async () => HELD);
    expect(await resolverOver(findHoldItem)(ask({ handler_kind: 'noop' }))).toBeNull();
    expect(findHoldItem).not.toHaveBeenCalled();
  });

  // ── the batch gate: MEMBER COUNT, not batch detection ──
  //
  // ⛔ This block replaces a single `returns null for a BATCHED preflight ask`.
  // That predicate was far wider than its own reason: `buildPreflightAsk`
  // stamps `batch_id` for ANY batch including ONE member, and `deriveOriginUnit`
  // maps `reception` to a run-scoped unit — so EVERY reception hold is a
  // one-member batch and the `/ask` page rendered no details and no edit
  // controls on its own main path, while the messenger text for the same hold
  // DID enumerate the args. "One member's values as if they were the whole
  // approval" is true for N>1 and vacuous for N=1.
  const batchAsk = (batch_id: unknown = 'b-1'): PendingAsk =>
    ask({ handler_payload: { checkpoint_id: 'cp-1', batch_id } });
  const withBatch = (
    findHoldItem: (id: string) => Promise<InboxItem | null>,
    getBatch?: (batch_id: string) => Promise<{ members: readonly unknown[] } | null>,
  ) =>
    createAskLandingDetailResolver({
      findHoldItem,
      timeZone: PARIS,
      ...(getBatch !== undefined ? { getBatch } : {}),
    });

  it('returns null for a MULTI-MEMBER batch — one member is not the approval', async () => {
    // Both original claims preserved: null, and the hold is never even read.
    const findHoldItem = vi.fn(async () => HELD);
    const out = await withBatch(findHoldItem, async () => ({ members: [1, 2] }))(batchAsk());
    expect(out).toBeNull();
    expect(findHoldItem).not.toHaveBeenCalled();
  });

  it('RESOLVES a single-member batch — the reception norm', async () => {
    const findHoldItem = vi.fn(async () => HELD);
    const getBatch = vi.fn(async () => ({ members: ['only'] }));
    const out = await withBatch(findHoldItem, getBatch)(batchAsk());
    expect(getBatch).toHaveBeenCalledWith('b-1');
    expect(findHoldItem).toHaveBeenCalledWith('cp-1');
    expect(out).toEqual({
      heading: 'Create a booking',
      details: [{ label: 'Summary', value: 'Table for four' }],
    });
  });

  it('FAILS CLOSED on every uncertainty about membership', async () => {
    // A count we cannot establish must never render — the pre-fix behaviour is
    // the floor, not a regression. [[complete_the_fence_dont_predict_the_default]]
    const findHoldItem = vi.fn(async () => HELD);
    const cases: Array<[string, ReturnType<typeof withBatch>]> = [
      // No reader wired at all (a composition that cannot count members).
      ['no getBatch', withBatch(findHoldItem)],
      // Reader throws (store down).
      ['throws', withBatch(findHoldItem, async () => { throw new Error('down'); })],
      // Row gone (pruned while the ask was outstanding).
      ['row null', withBatch(findHoldItem, async () => null)],
      // Zero members — not a shape that should render either.
      ['zero members', withBatch(findHoldItem, async () => ({ members: [] }))],
    ];
    for (const [label, resolve] of cases) {
      expect([label, await resolve(batchAsk())]).toEqual([label, null]);
    }
    // A non-string / empty batch_id is refused before the reader is consulted.
    const getBatch = vi.fn(async () => ({ members: ['only'] }));
    for (const bad of [42, '', null]) {
      expect(await withBatch(findHoldItem, getBatch)(batchAsk(bad))).toBeNull();
    }
    expect(getBatch).not.toHaveBeenCalled();
    expect(findHoldItem).not.toHaveBeenCalled();
  });

  it('reads membership LIVE — an open batch accumulates members', async () => {
    // ⛔ Why the count is not stamped at ask-build time: the row is mutable
    // while `open`, so a build-time count goes stale in the one direction that
    // matters. Same ask, two renders, second one has grown.
    const findHoldItem = vi.fn(async () => HELD);
    let members: unknown[] = ['only'];
    const resolve = withBatch(findHoldItem, async () => ({ members }));
    expect(await resolve(batchAsk())).not.toBeNull();
    members = ['only', 'joined'];
    expect(await resolve(batchAsk())).toBeNull();
  });

  it('returns null when the payload carries no usable checkpoint_id', async () => {
    const findHoldItem = vi.fn(async () => HELD);
    for (const payload of [{}, { checkpoint_id: '' }, { checkpoint_id: 42 }]) {
      expect(await resolverOver(findHoldItem)(ask({ handler_payload: payload }))).toBeNull();
    }
    expect(findHoldItem).not.toHaveBeenCalled();
  });

  it('returns null for an unknown / consumed / non-reception hold', async () => {
    // `findReceptionHoldItem` applies the inbox origin fence, so an AI
    // agent's held MCP write can never surface on a URL-bearer page.
    expect(await resolverOver(async () => null)(ask())).toBeNull();
  });

  it('returns null — not an empty block — when the op declares no editable args', async () => {
    expect(await resolverOver(async () => item())(ask())).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// the /ask port — the block reaches the page, and never costs the ask
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

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

const getReq = (url: string): IncomingMessage => {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = 'GET';
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  return attachAskTestSocket(stream);
};

const portHarness = (
  resolveDetails?: AskLandingPortHandlerDeps['resolveDetails'],
  status: PendingAsk['status'] = 'open',
) => {
  const current = ask({
    status,
    ...(status === 'open' ? {} : { answer: { option: 'approve', answered_at: NOW } }),
  });
  const deps: AskLandingPortHandlerDeps = {
    getAsk: async (id) => (id === current.ask_id ? current : null),
    submitAnswer: async () => {},
    getVerificationPhrase: async () => undefined,
    nonceStore: createInMemoryAskLandingNonceStore(),
    now: () => NOW,
    abuse: allowingAskLandingAbuseDeps(),
    ...(resolveDetails !== undefined ? { resolveDetails } : {}),
  };
  return createAskLandingPortHandler(deps);
};

describe('D-210 A.8 3d-2b — /ask port renders the details', () => {
  it('renders the resolved block on an open ask', async () => {
    const res = makeRes();
    await portHarness(async () => ({
      heading: 'Create a booking',
      details: [{ label: 'Slot start', value: '20 Jul 2026, 19:30 CEST' }],
    }))(getReq('/ask/ask-1'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toContain('Create a booking');
    expect(res.ended).toContain('<dt>Slot start</dt>');
    expect(res.ended).toContain('20 Jul 2026, 19:30 CEST');
  });

  it('still renders an ANSWERABLE page when the resolver THROWS', async () => {
    // The details enrich a decision surface; they are never a precondition
    // for it. A failure costs the block and never the ask.
    const res = makeRes();
    await portHarness(async () => {
      throw new Error('catalog read exploded');
    })(getReq('/ask/ask-1'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.ended).not.toContain('class="details"');
    // The form — the thing the page exists for — is intact.
    expect(res.ended).toContain('<form method="POST"');
    expect(res.ended).toContain('name="option" value="approve"');
    expect(res.ended).toContain('name="form_nonce"');
  });

  it('never consults the resolver for an already-answered ask', async () => {
    const resolveDetails = vi.fn(async () => ({
      details: [{ label: 'Slot start', value: 'never rendered' }],
    }));
    const res = makeRes();
    await portHarness(resolveDetails, 'answered')(
      getReq('/ask/ask-1'),
      res as unknown as ServerResponse,
    );
    expect(resolveDetails).not.toHaveBeenCalled();
    expect(res.ended).not.toContain('never rendered');
  });

  it('renders the pre-3d-2b page when no resolver is wired', async () => {
    const res = makeRes();
    await portHarness(undefined)(getReq('/ask/ask-1'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.ended).not.toContain('class="details"');
    expect(res.ended).toContain('<form method="POST"');
  });
});
