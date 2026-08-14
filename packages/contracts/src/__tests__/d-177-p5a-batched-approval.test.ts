/** D-177 P5a batched-approval pure vocabulary pins. */

import { describe, expect, it } from 'vitest';

import type { ExecutionSource } from '../commits.js';
import {
  BATCH_ASK_RENDER_MAX_ITEMS,
  batchAskKeyMatches,
  deriveOriginUnit,
  projectBatchedApprovalPayload,
  renderBatchItemsBlock,
  summarizeArgsPreview,
  type BatchAskKey,
  type BatchAskRecord,
  type BatchedApprovalItem,
} from '../batched-approval.js';

const ids = {
  run_id: 'run-1',
  correlation_id: 'corr-1',
};

const chatSource = (
  overrides: Partial<Extract<ExecutionSource, { channel: 'chat'; actor: 'user_self' }>> = {},
): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  ...overrides,
});

const sourceByChannel = (
  channel: ExecutionSource['channel'],
): ExecutionSource => {
  switch (channel) {
    case 'user':
      return {
        channel: 'user',
        actor: 'user_self',
        user_id: 'user-1',
        client_token_id: 'client-1',
      };
    case 'chat':
      return chatSource();
    case 'mcp':
      return {
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'agent-1',
        tool_call_id: 'tool-call-1',
        mcp_token_id: 'mcp-token-1',
        contract_id: 'contract-1',
      };
    case 'messenger':
      return {
        channel: 'messenger',
        actor: 'user_self',
        vendor: 'slack',
        from: 'user-1',
      };
    case 'reception':
      return {
        channel: 'reception',
        actor: 'anonymous',
        reception_id: 'reception-1',
      };
    case 'webhook':
      // D-209 #1 W3 — an anonymous door dispatch (origin unit stays `fire`,
      // keyed on the channel, actor-agnostic).
      return {
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'github',
        webhook_secret_id: 'secret-1',
      };
    case 'schedule':
      return {
        channel: 'schedule',
        actor: 'system',
        cron: '* * * * *',
        source_recipe: 'recipe-1',
      };
    case 'reactive':
      return {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'mail.received',
        source_recipe: 'recipe-1',
      };
    case 'housekeeping':
      return {
        channel: 'housekeeping',
        actor: 'system',
        cycle_id: 'cycle-1',
        task: 'prune',
        visible_to_user: false,
      };
  }
};

const key = (overrides: Partial<BatchAskKey> = {}): BatchAskKey => ({
  unit: { kind: 'turn', id: 'turn-1' },
  ingredient_slug: 'mail.send',
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat-1',
  risk_tier: 'write',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-1',
  ...overrides,
});

const row = (overrides: Partial<BatchAskRecord> = {}): BatchAskRecord => ({
  batch_id: 'batch-1',
  state: 'open',
  payload_version: 1,
  member_seq: 1,
  unit_kind: 'turn',
  unit_id: 'turn-1',
  ingredient_slug: 'mail.send',
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat-1',
  risk_tier: 'write',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-1',
  source: chatSource({ turn_id: 'turn-1' }),
  members: [
    {
      member_id: 'm1',
      checkpoint_id: 'checkpoint-1',
      run_id: 'run-1',
      canonical_payload_hash: 'payload-1',
      summary: 'to=ada@example.com',
      args_preview: { to: 'ada@example.com' },
    },
    {
      member_id: 'm2',
      checkpoint_id: 'checkpoint-2',
      run_id: 'run-2',
      canonical_payload_hash: 'payload-2',
      summary: 'to=grace@example.com',
    },
  ],
  current_ask_id: 'ask-1',
  created_at: 1000,
  updated_at: 1000,
  ...overrides,
});

describe('deriveOriginUnit', () => {
  it('uses turn-prefixed chat turn ids and corr-prefixed stand-ins', () => {
    expect(deriveOriginUnit(chatSource({ turn_id: 'turn-42' }), ids)).toEqual({
      kind: 'turn',
      id: 'turn:turn-42',
    });
    expect(deriveOriginUnit(chatSource(), ids)).toEqual({
      kind: 'turn',
      id: 'corr:corr-1',
    });
  });

  it('prefixes chat ids so turn and correlation ids cannot collide', () => {
    expect(
      deriveOriginUnit(chatSource({ turn_id: 'corr:same-text' }), {
        run_id: 'run-1',
        correlation_id: 'same-text',
      }),
    ).toEqual({ kind: 'turn', id: 'turn:corr:same-text' });
    expect(
      deriveOriginUnit(chatSource(), {
        run_id: 'run-1',
        correlation_id: 'turn:same-text',
      }),
    ).toEqual({ kind: 'turn', id: 'corr:turn:same-text' });
  });

  it('maps mcp to burst, event channels to fire, and direct channels to run', () => {
    expect(deriveOriginUnit(sourceByChannel('mcp'), ids)).toEqual({
      kind: 'burst',
      id: 'corr-1',
    });
    for (const channel of ['schedule', 'reactive', 'webhook', 'housekeeping'] as const) {
      expect(deriveOriginUnit(sourceByChannel(channel), ids), channel).toEqual({
        kind: 'fire',
        id: 'run-1',
      });
    }
    for (const channel of ['user', 'messenger', 'reception'] as const) {
      expect(deriveOriginUnit(sourceByChannel(channel), ids), channel).toEqual({
        kind: 'run',
        id: 'run-1',
      });
    }
  });
});

describe('batchAskKeyMatches', () => {
  it('requires every key facet to agree', () => {
    const matchingKey = key();
    expect(batchAskKeyMatches(row(), matchingKey)).toBe(true);

    const cases: ReadonlyArray<{
      name: string;
      rowPatch?: Partial<BatchAskRecord>;
      keyPatch?: Partial<BatchAskKey>;
    }> = [
      { name: 'unit kind', rowPatch: { unit_kind: 'run' } },
      { name: 'unit id', rowPatch: { unit_id: 'turn-2' } },
      { name: 'ingredient', rowPatch: { ingredient_slug: 'calendar.create' } },
      { name: 'channel', rowPatch: { channel: 'mcp' } },
      { name: 'actor', rowPatch: { actor: 'contracted_user' } },
      { name: 'session', rowPatch: { channel_session_id: 'chat-2' } },
      { name: 'risk', rowPatch: { risk_tier: 'admin' } },
      { name: 'recipe id', rowPatch: { recipe_id: 'recipe-2' } },
      { name: 'recipe hash', rowPatch: { recipe_hash: 'recipe-hash-2' } },
      { name: 'arg shape', rowPatch: { arg_shape_hash: 'arg-shape-2' } },
      { name: 'operation present only on row', rowPatch: { operation_id: 'mail.send' } },
      { name: 'operation present only on key', keyPatch: { operation_id: 'mail.send' } },
      { name: 'connection present only on row', rowPatch: { connection_name: 'gmail' } },
      { name: 'connection present only on key', keyPatch: { connection_name: 'gmail' } },
    ];

    for (const testCase of cases) {
      expect(
        batchAskKeyMatches(row(testCase.rowPatch), key(testCase.keyPatch)),
        testCase.name,
      ).toBe(false);
    }
  });

  it('matches when optional operation and connection are present on both sides', () => {
    expect(
      batchAskKeyMatches(
        row({ operation_id: 'mail.send', connection_name: 'gmail' }),
        key({ operation_id: 'mail.send', connection_name: 'gmail' }),
      ),
    ).toBe(true);
  });
});

describe('summarizeArgsPreview', () => {
  it('renders absent and empty argument previews distinctly', () => {
    expect(summarizeArgsPreview(undefined)).toBe('(args unavailable)');
    expect(summarizeArgsPreview({})).toBe('(no args)');
  });

  it('renders primitives and nested values in words, not JSON', () => {
    expect(
      summarizeArgsPreview({
        to: 'ada@example.com',
        count: 3,
        ok: true,
        nested: { labels: ['primary'] },
      }),
    ).toBe('to: ada@example.com \u00b7 count: 3 \u00b7 ok: true \u00b7 nested.labels: primary');

    const clipped = summarizeArgsPreview({ body: 'x'.repeat(120) });
    expect(clipped).toBe(`body: ${'x'.repeat(95)}\u2026`);
  });

  it('renders a scalar list without JSON brackets or quoting', () => {
    expect(
      summarizeArgsPreview({ to: ['ada@example.com', 'bob@example.com'] }),
    ).toBe('to: ada@example.com, bob@example.com');
  });

  it('keeps an object list COUNT in front of the clip', () => {
    // A clipped collection must never hide how much is being approved.
    const summary = summarizeArgsPreview({
      lines: Array.from({ length: 9 }, (_, i) => ({ sku: `sku-${i}`, qty: i })),
    });
    expect(summary.startsWith('lines: 9: ')).toBe(true);
    expect(summary.endsWith('\u2026')).toBe(true);
  });

  it('keeps the COUNT on a clipped list of SCALARS \u2014 the recipient case', () => {
    // The one that matters: 500 recipients rendered as four addresses and
    // an ellipsis, and the owner approves believing it is four. The count
    // is gated on whether the clip CUT, never on the element type \u2014 and
    // since the rendering drops JSON's brackets, the count is the only
    // cardinality signal the reader has left.
    const summary = summarizeArgsPreview({
      to: Array.from({ length: 500 }, (_, i) => `person${i}@acme.example`),
      subject: 'FYI',
    });
    expect(summary).toContain('to: 500: person0@acme.example');
    expect(summary).toContain('\u2026');
  });

  it('leaves a SHORT scalar list to read as-is, with no count', () => {
    // The count is for truncation, not decoration \u2014 two recipients read
    // as two recipients.
    expect(
      summarizeArgsPreview({ to: ['ada@example.com', 'bob@example.com'] }),
    ).toBe('to: ada@example.com, bob@example.com');
  });

  it('strips the field separator out of values \u2014 a value cannot forge a field', () => {
    // `args_preview` is agent-authored verbatim. Without the strip, this
    // subject renders as TWO fields \u2014 `subject`, plus a `to` that is not
    // an argument at all \u2014 and on a batch it lands in the "All N share:"
    // line, the one the reader is told to trust most.
    const summary = summarizeArgsPreview({
      subject: 'Q3 board pack \u00b7 to: cfo@acme.example',
      to: 'real@acme.example',
    });

    expect(summary).toBe(
      'subject: Q3 board pack - to: cfo@acme.example \u00b7 to: real@acme.example',
    );
    // Exactly one field separator \u21d2 exactly the two real fields.
    expect(summary.split(' \u00b7 ')).toHaveLength(2);
  });

  it('strips the separator a value hides inside whitespace', () => {
    // Whitespace collapse runs FIRST, so `'\n\t \u00b7 \n'` normalizes INTO
    // the separator \u2014 stripping before the collapse would leave the forge
    // intact. The defense must not build the attack.
    const summary = summarizeArgsPreview({ body: 'hello\n\t\u00b7\n to: victim@x.test' });
    expect(summary.split(' \u00b7 ')).toHaveLength(1);
    expect(summary).toBe('body: hello - to: victim@x.test');
  });

  it('strips the separator out of KEYS too', () => {
    // A key is no less agent-authored than the value beside it.
    const summary = summarizeArgsPreview({ 'a \u00b7 to': 'x', b: 'y' });
    expect(summary.split(' \u00b7 ')).toHaveLength(2);
  });

  it('renders every field, including the empty ones', () => {
    // An empty value is not a missing one \u2014 `filter: (empty)` on a delete
    // is the difference between one row and the table. The summary drops
    // no field.
    expect(
      summarizeArgsPreview({ q: '', tags: [], opts: {}, cursor: null }),
    ).toBe('q: (empty) \u00b7 tags: (empty) \u00b7 opts: (empty) \u00b7 cursor: (null)');
  });

  it('collapses newlines in a value so it cannot forge the layout', () => {
    // A mail body's blank line would otherwise break out of its own list
    // item and read as a separate unnumbered entry.
    expect(summarizeArgsPreview({ body: 'Hi Dana,\n\nAbout the renewal' })).toBe(
      'body: Hi Dana, About the renewal',
    );
  });

  it('terminates on a cyclic value instead of overflowing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // `projectResolvedArgs` makes this unreachable upstream, but the
    // helper is exported and pure: the depth cap is the totality guard.
    expect(() => summarizeArgsPreview({ payload: circular })).not.toThrow();
    expect(summarizeArgsPreview({ payload: circular })).toContain('payload');
  });
});

describe('renderBatchItemsBlock', () => {
  const item = (
    id: string,
    args?: Record<string, unknown>,
  ): BatchedApprovalItem => ({
    member_id: id,
    canonical_payload_hash: `payload-${id}`,
    summary: `item-${id}`,
    ...(args !== undefined ? { args_preview: args } : {}),
  });

  it('renders only the display cap and names what the overflow covers', () => {
    const items = Array.from({ length: BATCH_ASK_RENDER_MAX_ITEMS + 3 }, (_, i) =>
      item(`${i + 1}`),
    );

    const lines = renderBatchItemsBlock(items).split('\n');

    expect(lines).toHaveLength(BATCH_ASK_RENDER_MAX_ITEMS + 1);
    expect(lines[0]).toBe('  1. item-1');
    expect(lines[BATCH_ASK_RENDER_MAX_ITEMS - 1]).toBe(
      `  ${BATCH_ASK_RENDER_MAX_ITEMS}. item-${BATCH_ASK_RENDER_MAX_ITEMS}`,
    );
    // The bare count read as "and some more you can ignore". Approving
    // covers every member \u2014 the line says which number.
    expect(lines[BATCH_ASK_RENDER_MAX_ITEMS]).toBe(
      `  \u2026and 3 more (approving covers all ${BATCH_ASK_RENDER_MAX_ITEMS + 3})`,
    );
  });

  it('renders a single member as one labeled line per field', () => {
    expect(
      renderBatchItemsBlock([
        item('1', { to: 'ada@example.com', subject: 'Renewal' }),
      ]),
    ).toBe('  to: ada@example.com\n  subject: Renewal');
  });

  it('folds the absent fields onto one line, naming every one', () => {
    // A real `mail-send` hold carried SEVEN `(null)` lines out of eleven,
    // and the four that decided anything scrolled off behind them. The
    // fold is to the SYNTAX: every field name survives it, so the reader
    // can still tell an unset field from one that was never in the payload.
    const block = renderBatchItemsBlock([
      item('1', {
        to: 'sam@acme.example',
        cc: null,
        bcc: null,
        subject: 'Renewal',
        in_reply_to: null,
        attachments: null,
      }),
    ]);

    expect(block).toBe(
      [
        '  to: sam@acme.example',
        '  subject: Renewal',
        '  not set: cc, bcc, in_reply_to, attachments',
      ].join('\n'),
    );
  });

  it('keeps EMPTY separate from ABSENT — the delete-filter case', () => {
    // `filter: (empty)` on a delete is the difference between removing one
    // row and removing the table, so a fold that merged it with "not set"
    // would erase the whole decision.
    const block = renderBatchItemsBlock([
      item('1', { table: 'contacts', filter: '', dry_run: null }),
    ]);

    expect(block).toBe(
      ['  table: contacts', '  not set: dry_run', '  empty: filter'].join('\n'),
    );
  });

  it('folds identifier fields onto one line and shortens the uuids', () => {
    const block = renderBatchItemsBlock([
      item('1', {
        title: 'Dana Whitfield',
        id: 'reception_9db309c6-d746-4bdd-8094-13e954bbbbf8',
        metadata: {
          reception_form_submission_id: '9db309c6-d746-4bdd-8094-13e954bbbbf8',
          reception_endpoint_id: '4nzTEHRqMtGOItWeKve_wg',
          // A readable slug is left WHOLE — a reader can use it, so
          // shortening it would cost information rather than noise.
          form_definition_id: 'fd_foundation_client_inquiry_v1',
        },
      }),
    ]);

    expect(block).toBe(
      [
        '  title: Dana Whitfield',
        // Leaves are unique across the payload, so the repeated
        // `metadata.` is dropped from the folded line too.
        '  ids: id: reception_9db309c6…'
          + ' · reception_form_submission_id: 9db309c6…'
          + ' · reception_endpoint_id: 4nzTEHRqMtGO…'
          + ' · form_definition_id: fd_foundation_client_inquiry_v1',
      ].join('\n'),
    );
  });

  it('groups fields under a shared path instead of repeating it', () => {
    const block = renderBatchItemsBlock([
      item('1', {
        title: 'Dana Whitfield',
        metadata: { timeline: 'asap', budget_range: 'under_10k' },
      }),
    ]);

    expect(block).toBe(
      [
        '  title: Dana Whitfield',
        '  metadata:',
        '    timeline: asap',
        '    budget_range: under_10k',
      ].join('\n'),
    );
  });

  it('leaves a LONE nested field flat — a header would cost more than it saves', () => {
    expect(
      renderBatchItemsBlock([item('1', { to: 'ada@x.test', metadata: { timeline: 'asap' } })]),
    ).toBe('  to: ada@x.test\n  metadata.timeline: asap');
  });

  it('opens a group with a VALUE-LESS line — never confusable with a field', () => {
    // The header is parsed BACK by the approval card, which reconstructs
    // the dotted path and decides its metadata filter on it. That only
    // works because no DATA can render as a bare `path:` — an empty object
    // is `(empty)` and an empty string folds onto the `empty:` line, so
    // `renderInline` never yields the empty string a header is made of.
    const emptyish = renderBatchItemsBlock([
      item('1', { a: { x: {}, y: '' }, keep: 'me' }),
    ]);

    expect(emptyish).toBe('  keep: me\n  empty: x, y');
    expect(emptyish.split('\n').filter((l) => /:\s*$/.test(l))).toEqual([]);

    // And the only line that IS value-less is a real header.
    const grouped = renderBatchItemsBlock([
      item('1', { a: { x: 1, y: 2 } }),
    ]);
    expect(grouped.split('\n').filter((l) => /:\s*$/.test(l))).toEqual([
      '  a:',
    ]);
  });

  it('drops a shared prefix on a folded line only while the leaf stays unique', () => {
    // Unique leaves lose the repeated path…
    expect(
      renderBatchItemsBlock([
        item('1', { to: 'ada@x.test', metadata: { cc: null, bcc: null } }),
      ]),
    ).toBe('  to: ada@x.test\n  not set: cc, bcc');

    // …but an ambiguous one keeps it, or the reader cannot tell which of
    // the two same-named fields the operation actually carries.
    expect(
      renderBatchItemsBlock([
        item('1', { to: 'ada@x.test', cc: null, metadata: { cc: null } }),
      ]),
    ).toBe('  to: ada@x.test\n  not set: cc, metadata.cc');
  });

  it('never folds ids when they are the ONLY fields', () => {
    // The fold exists to stop bookkeeping crowding out a decision input.
    // With nothing else on the block there is nothing to crowd, and
    // hiding an op's only argument behind the word "ids" would leave the
    // reader approving a call whose target they were never shown.
    const block = renderBatchItemsBlock([
      item('1', {
        id: 'a3f1c2d4-1111-2222-3333-444455556666',
        record_id: 'rec_ABCdefGHIjklMNO',
      }),
    ]);

    expect(block).toBe('  id: a3f1c2d4…\n  record_id: rec_ABCdefGH…');
  });

  it('shortens the RENDERING only — two uuids sharing a prefix never hoist', () => {
    // The trap the shortening creates: `rendered` is now lossy, so a
    // hoist decided on it would assert "All 2 share this id" over two
    // DIFFERENT records and drop member 2's real target out of the ask.
    // Commonality is decided on the raw `value`, which the shortening
    // never touches. (The shared first 8 hex is contrived to force the
    // case — two real uuids colliding there is a 1-in-4-billion event,
    // which is why prefix-only rendering is safe for the reader.)
    const block = renderBatchItemsBlock([
      item('1', { op: 'archive', id: 'aaaaaaaa-1111-1111-1111-111111111111' }),
      item('2', { op: 'archive', id: 'aaaaaaaa-2222-2222-2222-222222222222' }),
    ]);

    expect(block).toBe(
      [
        '  All 2 share: op: archive',
        '  1. id: aaaaaaaa…',
        '  2. id: aaaaaaaa…',
      ].join('\n'),
    );
  });

  it('hoists the fields every member shares and leaves only what varies', () => {
    const block = renderBatchItemsBlock([
      item('1', { connection: 'hubspot-prod', id: 'a', stage: 'won' }),
      item('2', { connection: 'hubspot-prod', id: 'b', stage: 'lost' }),
    ]);

    expect(block).toBe(
      [
        '  All 2 share: connection: hubspot-prod',
        '  1. id: a \u00b7 stage: won',
        '  2. id: b \u00b7 stage: lost',
      ].join('\n'),
    );
  });

  it('hoists on RAW values, never on the clipped rendering', () => {
    // Two different bodies sharing their first VALUE_CLIP characters
    // render identically. Hoisting on the rendered string would assert
    // "all 2 share this body" over two different bodies \u2014 the reader
    // would approve a message they were shown as something else.
    const shared = 'x'.repeat(200);
    const block = renderBatchItemsBlock([
      item('1', { body: `${shared}ALPHA` }),
      item('2', { body: `${shared}BETA` }),
    ]);

    expect(block).not.toContain('All 2 share');
    expect(block.split('\n')[0]).toContain('1. body:');
  });

  it('never hoists across a flattened/literal label collision', () => {
    // Flattening is lossy in exactly one way: nested `{a:{b:1}}` and a
    // literal key `{'a.b':2}` render the same label. Deciding commonality
    // by LABEL matched the wrong leaf — the block hoisted member 1's
    // `a.b: 2` as shared and dropped member 2's `a.b: 999` from the ask
    // entirely, while claiming both calls were identical. Fields are
    // keyed on their structural path, so a label collision is cosmetic.
    const block = renderBatchItemsBlock([
      item('1', { a: { b: 1 }, 'a.b': 2 }),
      item('2', { a: { b: 1 }, 'a.b': 999 }),
    ]);

    expect(block).toContain('999');
    expect(block).not.toContain('are the same call');
    expect(block).toBe(
      ['  All 2 share: a.b: 1', '  1. a.b: 2', '  2. a.b: 999'].join('\n'),
    );
  });

  it('returns the empty block for no members rather than throwing', () => {
    expect(renderBatchItemsBlock([])).toBe('');
  });

  it('does not hoist a label that is absent from a member', () => {
    // Absence is not a value: `cc` is not "shared" just because the one
    // member that has it is the only one that could disagree.
    const block = renderBatchItemsBlock([
      item('1', { to: 'a@x.test', cc: 'c@x.test' }),
      item('2', { to: 'a@x.test' }),
    ]);

    expect(block).toContain('All 2 share: to: a@x.test');
    expect(block).toContain('1. cc: c@x.test');
    // NOT "same as above" — member 2 has no `cc` at all, and this line
    // sits under member 1, so "above" would read as "cc: c@x.test".
    expect(block).toContain('2. (only the shared fields)');
  });

  it('says so plainly when every member is the same call', () => {
    // What a looping agent looks like. The old rendering showed it as N
    // lines of indistinguishable text.
    const args = { to: 'ada@example.com', subject: 'Renewal' };
    const block = renderBatchItemsBlock([
      item('1', args),
      item('2', args),
      item('3', args),
    ]);

    expect(block).toBe(
      [
        '  All 3 are the same call:',
        '  to: ada@example.com',
        '  subject: Renewal',
      ].join('\n'),
    );
  });

  it('falls back to summaries when ANY member lacks a preview', () => {
    // A hoist across a partly-known set could assert a shared value over
    // a member nobody can see. An over-sized preview is dropped upstream,
    // so this is reachable in production.
    const block = renderBatchItemsBlock([
      item('1', { connection: 'hubspot-prod', id: 'a' }),
      item('2'),
    ]);

    expect(block).toBe('  1. item-1\n  2. item-2');
  });

  it('hoists across ALL members, including those past the display cap', () => {
    // The shared line describes the whole set the approval covers, not
    // the sample the reader happens to see.
    const items = Array.from({ length: BATCH_ASK_RENDER_MAX_ITEMS + 2 }, (_, i) =>
      item(`${i + 1}`, { connection: 'gmail-personal', to: `u${i}@x.test` }),
    );

    expect(renderBatchItemsBlock(items)).toContain(
      `All ${items.length} share: connection: gmail-personal`,
    );
  });
});

describe('projectBatchedApprovalPayload', () => {
  it('omits resume anchors and keeps args_preview only when present', () => {
    expect(projectBatchedApprovalPayload(row())).toEqual({
      ingredient_slug: 'mail.send',
      risk_tier: 'write',
      source: chatSource({ turn_id: 'turn-1' }),
      unit: { kind: 'turn', id: 'turn-1' },
      payload_version: 1,
      items: [
        {
          member_id: 'm1',
          canonical_payload_hash: 'payload-1',
          summary: 'to=ada@example.com',
          args_preview: { to: 'ada@example.com' },
        },
        {
          member_id: 'm2',
          canonical_payload_hash: 'payload-2',
          summary: 'to=grace@example.com',
        },
      ],
    });
  });

  it('projects optional operation and connection only when present', () => {
    expect(
      projectBatchedApprovalPayload(
        row({ operation_id: 'mail.send', connection_name: 'gmail-primary' }),
      ),
    ).toMatchObject({
      operation_id: 'mail.send',
      connection_name: 'gmail-primary',
    });
  });
});
