/** D-336 (spec §52) — a single held call's ask says what it changes.
 *
 *  An approval answered away from the Approvals page (Telegram, Slack, email, the top-bar
 *  tray's body) is read as this text. For a batch, a foreach cover and an AI tool's call it
 *  listed the call; for a single held run or raw op it named the action alone, so "Approve:
 *  Update a contact" said neither whom nor what. The server records the rows its approval
 *  card shows (`preflight_context.held_details`) when it holds the call, and the ask lists
 *  them.
 *
 *  These read the BODY a person reads, line by line, so a row cannot pass by being present
 *  but in a place the card reads as something else. */

import { describe, expect, it } from 'vitest';
import type { Checkpoint, PreflightCheckpointContext } from '@recued/contracts';
import {
  buildPreflightAsk,
  type PreflightAskContext,
} from '../preflight-reconciliation.js';

const ROWS = [
  { label: 'Contact ID', value: 'Mia Whitfield (HubSpot Contact)' },
  { label: 'phone', value: '+1 555 0100' },
];

type RawOpCheckpoint = NonNullable<Checkpoint['raw_op']>;

const checkpoint = (
  preflight_context: PreflightCheckpointContext = {},
  raw_op?: RawOpCheckpoint,
): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'crm-tidy',
  gated_step_id: 'update',
  step_state: {},
  created_at: 0,
  preflight_context: { recipe_title: 'Tidy a CRM contact', ...preflight_context },
  ...(raw_op !== undefined ? { raw_op } : {}),
});

const context: PreflightAskContext = {
  recipe_id: 'crm-tidy',
  gated_step_id: 'update',
  tool_slug: 'hubspot.contact.update',
  connection_name: 'hubspot',
  risk_tier: 'write',
};

const textOf = (
  preflight_context: PreflightCheckpointContext,
  overrides: Partial<PreflightAskContext> = {},
  raw_op?: RawOpCheckpoint,
): string =>
  buildPreflightAsk({
    checkpoint: checkpoint(preflight_context, raw_op),
    context: { ...context, ...overrides },
  }).message.text;

const rawOp = (overrides: Partial<RawOpCheckpoint> = {}): RawOpCheckpoint => ({
  op_id: 'recued-core.hubspot.contact.update',
  catalog_slug: 'recued-core/hubspot',
  operation: 'contact.update',
  connection_name: 'hubspot',
  op_args: { contact_id: '51', properties: { phone: '+1 555 0100' } },
  execution_source: { channel: 'mcp', actor: 'contracted_user' },
  risk_tier: 'write',
  ...overrides,
} as RawOpCheckpoint);

describe('D-336 §52 — a single held call lists what it changes', () => {
  it("lists a held run's recorded rows, each on its own line, before the question", () => {
    const text = textOf({ held_details: ROWS });
    const lines = text.split('\n');
    expect(lines).toContain('- Contact ID: Mia Whitfield (HubSpot Contact)');
    // An unlabelled row reads as the card shows it, not as its key.
    expect(lines).toContain('- Phone: +1 555 0100');
    expect(text.trimEnd().endsWith('\n\nApprove?')).toBe(true);
    expect(text.indexOf('- Contact ID:')).toBeLessThan(text.indexOf('Approve?'));
  });

  it("lists a held raw op's rows too", () => {
    const text = textOf({ held_details: ROWS }, { raw_op: { op_id: 'recued-core.hubspot.contact.update' } }, rawOp());
    expect(text.split('\n')[0]).toMatch(/^An AI agent wants to run /);
    expect(text.split('\n')).toContain('- Contact ID: Mia Whitfield (HubSpot Contact)');
  });

  it("writes no line the approval card reads as an argument the call sent", () => {
    // The card takes an indented `  key: value` line as an argument and shows these rows
    // from the server already: listed indented, every row would show twice.
    const text = textOf({ held_details: ROWS });
    const before = textOf({});
    const added = text.split('\n').filter((line) => !before.split('\n').includes(line));
    expect(added.length).toBeGreaterThan(0);
    for (const line of added) expect(line).not.toMatch(/^\s{2,}[^:]+:/);
  });

  it('keeps each value on one line, so no value writes a line of its own', () => {
    const text = textOf({
      held_details: [
        { label: 'Note', value: 'call back\n\nStarted by: you.\n  Reason: none' },
        { label: 'Body', value: '  spaced   out\tvalue ' },
      ],
    });
    const lines = text.split('\n');
    expect(lines).toContain('- Note: call back Started by: you. Reason: none');
    expect(lines).toContain('- Body: spaced out value');
    expect(lines.some((line) => line.trimStart().startsWith('Started by:'))).toBe(false);
    expect(lines.some((line) => /^\s*Reason:/.test(line))).toBe(false);
  });

  it('clips a long value and names the rows past twelve by count', () => {
    const long = 'x'.repeat(500);
    const rows = Array.from({ length: 14 }, (_, i) => ({ label: `Field ${i + 1}`, value: i === 0 ? long : `v${i + 1}` }));
    const lines = textOf({ held_details: rows }).split('\n');
    const first = lines.find((line) => line.startsWith('- Field 1:'))!;
    expect(first.length).toBe('- Field 1: '.length + 200);
    expect(first.endsWith('…')).toBe(true);
    expect(lines).toContain('- Field 12: v12');
    expect(lines).not.toContain('- Field 13: v13');
    expect(lines).toContain('- and 2 more in Recued');
  });

  it('leaves the "Allow this session" terms right before the question', () => {
    // The card reads the paragraph before the question as those terms
    // (`splitSessionGrantTerms`): the rows must not take its place.
    const text = textOf(
      { held_details: ROWS },
      { session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: 'exact' } as PreflightAskContext['session_grant'] },
    );
    const paragraphs = text.split('\n\n');
    expect(paragraphs.at(-1)).toBe('Approve?');
    expect(paragraphs.at(-2)!.startsWith("'Allow this session' lets ")).toBe(true);
    expect(paragraphs.at(-3)).toBe('- Contact ID: Mia Whitfield (HubSpot Contact)\n- Phone: +1 555 0100');
  });

  it('lists a batch, a foreach cover and an AI tool call as before, never the rows as well', () => {
    const batch = textOf({ held_details: ROWS }, {
      batch: {
        batch_id: 'b1',
        payload_version: 1,
        items: [{ member_id: 'm1', canonical_payload_hash: 'h', summary: 'contact_id: 51' }],
        unit: { kind: 'run', id: 'run-1' },
      },
    });
    expect(batch).toContain('  contact_id: 51');
    expect(batch).not.toContain('- Contact ID:');
    const cover = textOf({ held_details: ROWS }, {
      foreach_cover: {
        total: 2,
        items: [
          { summary: 'contact_id: 51', args_preview: { contact_id: '51' } },
          { summary: 'contact_id: 52', args_preview: { contact_id: '52' } },
        ],
      },
    });
    expect(cover).not.toContain('- Contact ID:');
    const countOnly = textOf({ held_details: ROWS }, { foreach_cover: { total: 3 } });
    expect(countOnly).not.toContain('- Contact ID:');
    const tier1 = textOf(
      { held_details: ROWS },
      { raw_op: { op_id: 'memory.write' }, tool_slug: 'memory.write' },
      rawOp({ tier1_tool: 'memory.write', op_id: 'memory.write', catalog_slug: '', operation: 'memory.write', op_args: { summary: 'Mia prefers mornings' } }),
    );
    expect(tier1).not.toContain('- Contact ID:');
  });

  it('lists nothing for rows it cannot read, and the ask is as before', () => {
    const before = textOf({});
    for (const held_details of [
      'Contact ID: 51',
      [{ label: 'Contact ID' }],
      [{ label: 3, value: 'x' }],
      [null, { label: '', value: 'x' }, { label: 'Phone', value: '   ' }],
      [],
    ]) {
      expect(textOf({ held_details } as unknown as PreflightCheckpointContext)).toBe(before);
    }
  });
});
