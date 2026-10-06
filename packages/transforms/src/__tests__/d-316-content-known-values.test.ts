/**
 * D-316 amendment (2026-10-05) — a recipe's `content` PII tag gets the chat's
 * known-value match for that call.
 *
 * Recipe PII stays authored, but a `content` tag used to be lookup-only: it hid
 * nothing the same call's identifier tags had not seeded, so a Slack thread or a
 * mail body tagged `content` went to the model whole. With a host source the
 * tagged content is matched against the warehouse's known names / orgs and every
 * email in it, exactly as the chat seeds a tool result.
 *
 * The source here is the chat resolver's SHAPE over the real `buildKnownValueIndex`;
 * `resolveIdentifiers` returns every email in the text, which is what the server's
 * store-free email leg does (`chat-recall-index.ts`). The server suite drives the
 * real builder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTransform,
  _resetPiiLedgerState,
  aliasFields,
  aliasFieldsBatch,
  buildKnownValueIndex,
  createLedger,
  PiiKnownValuesUnavailableError,
  type PiiKnownValueSource,
} from '../index.js';
import type { TransformContext } from '../types.js';

const protect = getTransform('pii-protect')!;
const restore = getTransform('pii-restore')!;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;

const sourceOf = (
  known: ReadonlyArray<{ value: string; kind: 'name' | 'org' | 'address' }>,
  degraded = false,
): PiiKnownValueSource => ({
  nameOrgIndex: { index: buildKnownValueIndex(known) },
  resolveIdentifiers: (text) => [...text.matchAll(EMAIL)].map((m) => ({ kind: 'email' as const, value: m[0] })),
  isDegraded: () => degraded,
});

const WAREHOUSE = sourceOf([
  { value: 'Dana Whitfield', kind: 'name' },
  { value: 'Northwind Traders', kind: 'org' },
]);

const ctxWith = (piiKnownValues?: () => PiiKnownValueSource | undefined): TransformContext => ({
  resolve: () => undefined,
  evaluate: () => false,
  now: () => new Date(),
  ...(piiKnownValues ? { piiKnownValues } : {}),
} as unknown as TransformContext);

type ProtectOut = { aliased: Record<string, unknown>; ledger_handle: string };

const MAIL = {
  from: 'dana@northwind.example',
  subject: 'Renewal',
  body: 'Dana Whitfield at Northwind Traders asked for the addendum; cc mira.patel@example.com.',
};

beforeEach(() => _resetPiiLedgerState());

describe('pii-protect — a `content` tag matched against the host\'s known values', () => {
  it('hides the known names, orgs and every email in the tagged content, and restores them', () => {
    const ctx = ctxWith(() => WAREHOUSE);
    const out = protect({ data: MAIL, fields: [{ path: 'body', kind: 'content' }] }, ctx) as ProtectOut;
    const body = out.aliased.body as string;
    expect(body).not.toContain('Dana Whitfield');
    expect(body).not.toContain('Northwind Traders');
    expect(body).not.toContain('mira.patel@example.com');
    expect(body).toMatch(/pii\.Person\d/u);
    expect(body).toMatch(/pii\.Org\d/u);
    expect(body).toMatch(/m\d+@d\d+\.invalid/u);
    // Only the TAGGED field: recipe PII stays authored, so an untagged field keeps its value
    // even when it holds a value the match found elsewhere.
    expect(out.aliased.from).toBe(MAIL.from);
    expect(out.aliased.subject).toBe(MAIL.subject);
    const back = restore({ data: out.aliased, ledger_handle: out.ledger_handle }, ctx) as { restored: unknown };
    expect(back.restored).toEqual(MAIL);
  });

  it('without a host source a content-only tag hides nothing — the behaviour before the amendment', () => {
    const out = protect({ data: MAIL, fields: [{ path: 'body', kind: 'content' }] }, ctxWith()) as ProtectOut;
    expect(out.aliased).toEqual(MAIL);
  });

  it('ABSENCE IS NOT FAILURE: a host whose warehouse is unwired lends undefined, and nothing throws', () => {
    const out = protect(
      { data: MAIL, fields: [{ path: 'body', kind: 'content' }] },
      ctxWith(() => undefined),
    ) as ProtectOut;
    expect(out.aliased).toEqual(MAIL);
  });

  it('a nested thread is matched leaf by leaf', () => {
    const data = {
      channel_id: 'C1',
      thread: [
        { user_id: 'U01MIRA2Q', text: 'Dana Whitfield is waiting on the SSO ticket.' },
        { user_id: 'U01JANE7X', text: 'On it — Northwind Traders sent logs from mira.patel@example.com.' },
      ],
    };
    const out = protect(
      { data, fields: [{ path: 'thread', kind: 'content' }] },
      ctxWith(() => WAREHOUSE),
    ) as ProtectOut;
    const text = JSON.stringify(out.aliased.thread);
    for (const raw of ['Dana Whitfield', 'Northwind Traders', 'mira.patel@example.com']) {
      expect(text).not.toContain(raw);
    }
    // A Slack id is no contact name or email: the match is the warehouse's, never a guess.
    expect(text).toContain('U01MIRA2Q');
  });

  it('builds the source only for a step that tags present content (it reads the whole warehouse)', () => {
    let builds = 0;
    const ctx = ctxWith(() => {
      builds += 1;
      return WAREHOUSE;
    });
    protect({ data: MAIL, fields: [{ path: 'from', kind: 'email' }] }, ctx);
    protect({ data: MAIL, fields: [{ path: 'missing', kind: 'content' }] }, ctx);
    protect({ data: { body: null }, fields: [{ path: 'body', kind: 'content' }] }, ctx);
    expect(builds).toBe(0);
    protect({ data: MAIL, fields: [{ path: 'body', kind: 'content' }] }, ctx);
    expect(builds).toBe(1);
  });

  it('a tagged identifier keeps the alias it has without the match', () => {
    const fields = [{ path: 'from', kind: 'email' }, { path: 'body', kind: 'content' }];
    const without = protect({ data: MAIL, fields }, ctxWith()) as ProtectOut;
    _resetPiiLedgerState();
    const withMatch = protect({ data: MAIL, fields }, ctxWith(() => WAREHOUSE)) as ProtectOut;
    expect(withMatch.aliased.from).toBe(without.aliased.from);
  });

  it('⛔ a degraded source stops before anything is aliased or emitted, and names no value', () => {
    const ctx = ctxWith(() => sourceOf([{ value: 'Dana Whitfield', kind: 'name' }], true));
    let thrown: unknown;
    try {
      protect({ data: MAIL, fields: [{ path: 'body', kind: 'content' }] }, ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PiiKnownValuesUnavailableError);
    const message = (thrown as Error).message;
    for (const raw of ['Dana', 'Northwind', 'mira.patel', 'example.com']) expect(message).not.toContain(raw);
  });
});

describe('aliasFields / aliasFieldsBatch with `knownValues`', () => {
  it('a batch is matched list-wide, so the same person gets one alias in every element', () => {
    const items = [
      { id: 'm1', body: 'Call Dana Whitfield back.' },
      { id: 'm2', body: 'Dana Whitfield signed for Northwind Traders.' },
    ];
    const out = aliasFieldsBatch(
      createLedger('t'), items, [{ path: 'body', kind: 'content' }], undefined, () => WAREHOUSE,
    ) as Array<{ id: string; body: string }>;
    const alias = /pii\.Person\d+/u.exec(out[0]!.body)?.[0];
    expect(alias).toBeDefined();
    expect(out[1]!.body).toContain(alias!);
    expect(out.map((o) => o.id)).toEqual(['m1', 'm2']);
  });

  it('the chat egress\'s call shape (no `knownValues`) is unchanged', () => {
    const data = { body: 'Dana Whitfield' };
    expect(aliasFields(createLedger('t'), data, [{ path: 'body', kind: 'content' }])).toEqual(data);
  });
});
