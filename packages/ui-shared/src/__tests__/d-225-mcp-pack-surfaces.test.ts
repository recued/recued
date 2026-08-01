/** D-225 Slice 2 — the presentation layer for the MCP generated-pack surfaces.
 *
 *  ⛔ These tests exist because this is the layer where the server's care can be
 *  quietly undone. Every guard the server built has a UI shape that defeats it
 *  while looking perfectly reasonable:
 *
 *   · the server refuses to let a `readOnlyHint` become the stored default —
 *     a form that PRE-SELECTS the suggestion hands that decision straight back;
 *   · the server distinguishes `unknown` from `current` — a badge that renders
 *     NOTHING for `unknown` turns "we cannot tell" into "all clear";
 *   · the server reports the connection an uninstall also deleted — wording that
 *     says only "pack removed" is what makes a credential deletion silent.
 */
import { describe, expect, it } from 'vitest';
import type { McpPackReviewRow } from '@recued/contracts';

import {
  mcpPackBadge,
  mcpPackReviewView,
  packRemovalConfirm,
  packRemovalMessage,
  type McpPackStatusView,
} from '../connections/mcp-pack.js';

const status = (over: Partial<McpPackStatusView> = {}): McpPackStatusView => ({
  pack_slug: 'mcp-' + 'a'.repeat(32),
  status: 'current',
  added: 0,
  removed: 0,
  ...over,
});

const row = (over: Partial<McpPackReviewRow> = {}): McpPackReviewRow => ({
  op: 'list_files_a1b2c3d4',
  tool: 'list_files',
  stored: { risk: 'write', approval: 'ask' },
  ...over,
});

describe('D-225 — the drift badge', () => {
  it('⛔ renders UNKNOWN VISIBLY, and as attention — never as silence', () => {
    // A blank badge is read as reassurance. `unknown` means the opposite: we
    // have not looked. And the connections most likely to have drifted are
    // exactly the ones nobody has probed.
    const badge = mcpPackBadge(status({ status: 'unknown' }));
    expect(badge.tone).toBe('attention');
    expect(badge.label).not.toBe('');
    expect(badge.detail).toMatch(/unknown/i);
    expect(badge.action).toBe('probe');
  });

  it('does NOT give `current` the attention tone', () => {
    // The paired direction — if everything were `attention` the badge would be
    // noise and an owner would learn to ignore the one that matters.
    const badge = mcpPackBadge(status({ status: 'current' }));
    expect(badge.tone).toBe('ok');
    expect(badge.action).toBeUndefined();
  });

  it('reports drift with counts and offers a re-review', () => {
    const badge = mcpPackBadge(status({ status: 'drifted', added: 2, removed: 1 }));
    expect(badge.tone).toBe('attention');
    expect(badge.detail).toContain('2 new or changed');
    expect(badge.detail).toContain('1 gone or replaced');
    expect(badge.action).toBe('review');
  });

  it('says the new tools are NOT granted — the reassuring half of the drift message', () => {
    // Drift is not an emergency: anything new or changed has no grant. Saying
    // so is what stops the badge reading as "you have been exposed".
    expect(mcpPackBadge(status({ status: 'drifted', added: 1 })).detail)
      .toMatch(/not granted until you do/);
  });

  it('offers to generate when there is no pack', () => {
    const badge = mcpPackBadge(status({ status: 'no_pack' }));
    expect(badge.tone).toBe('neutral');
    expect(badge.action).toBe('generate');
  });

  it('every status produces a non-empty label and detail', () => {
    // No status may render as a blank the eye slides past.
    for (const s of ['no_pack', 'unknown', 'current', 'drifted'] as const) {
      const badge = mcpPackBadge(status({ status: s, added: 1 }));
      expect(badge.label.length, s).toBeGreaterThan(0);
      expect(badge.detail.length, s).toBeGreaterThan(0);
    }
  });
});

describe('D-225 — the review screen model', () => {
  it('⛔ PRE-SELECTS the floor, never the server’s suggestion', () => {
    // The exploit, at the UI layer: a server claims read-only on a destructive
    // tool. The server already refuses to store that; a form that pre-selected
    // it would carry the claim into Save anyway.
    const view = mcpPackReviewView([
      row({
        tool: 'delete_everything',
        suggested: { risk: 'read', approval: 'never' },
        server_says: { read_only: true },
      }),
    ]);
    expect(view.rows[0]!.selected).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('still OFFERS the suggestion — it is a button, not a default', () => {
    // The permitting half. Dropping the offer entirely would make a 40-tool
    // server unusable, which is its own failure.
    const view = mcpPackReviewView([
      row({ suggested: { risk: 'read', approval: 'never' }, server_says: { read_only: true } }),
    ]);
    expect(view.rows[0]!.offer).toMatchObject({ risk: 'read', approval: 'never' });
    expect(view.rows[0]!.offer!.label.length).toBeGreaterThan(0);
  });

  it('⛔ renders the claim as ATTRIBUTED speech, not as a fact', () => {
    // "The server describes this as read-only" and "read-only" are different
    // sentences, and the difference is whether the UI is showing evidence or
    // laundering it.
    const view = mcpPackReviewView([row({ server_says: { read_only: true } })]);
    expect(view.rows[0]!.claim).toMatch(/^The server describes/);
    expect(view.rows[0]!.claim).not.toBe('Read-only');
  });

  it('surfaces a contradictory claim rather than picking a side', () => {
    const view = mcpPackReviewView([
      row({ server_says: { read_only: true, destructive: true } }),
    ]);
    expect(view.rows[0]!.claim).toMatch(/both read-only and destructive/);
    expect(view.rows[0]!.offer).toBeUndefined();
  });

  it('a silent server yields no claim and no offer', () => {
    const view = mcpPackReviewView([row()]);
    expect(view.rows[0]!.claim).toBeUndefined();
    expect(view.rows[0]!.offer).toBeUndefined();
    expect(view.rows[0]!.selected).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('EVERY row pre-selects the floor whatever the server claims', () => {
    const view = mcpPackReviewView([
      row({ op: 'a_1', server_says: { read_only: true }, suggested: { risk: 'read', approval: 'never' } }),
      row({ op: 'b_2', server_says: { destructive: true } }),
      row({ op: 'c_3' }),
    ]);
    for (const r of view.rows) expect(r.selected).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('carries reviewed_ops for the commit’s TOCTOU check', () => {
    const view = mcpPackReviewView([row({ op: 'a_1' }), row({ op: 'b_2' })]);
    expect(view.reviewed_ops).toEqual(['a_1', 'b_2']);
  });

  it('does not leak unknown server-side fields into the form', () => {
    // Built field by field rather than spread, so a field added server-side
    // reaches the form only when someone decides it should.
    const view = mcpPackReviewView([
      { ...row(), unexpected: 'x' } as unknown as McpPackReviewRow,
    ]);
    expect(Object.keys(view.rows[0]!).sort()).toEqual(['op', 'selected', 'tool']);
  });

  it('tells the owner nothing was classified for them', () => {
    // The honest disclosure: the pack is askable, not correctly tiered.
    expect(mcpPackReviewView([row(), row({ op: 'b_2' })]).summary)
      .toMatch(/nothing here is classified for you/);
  });

  it('a server with no tools says so plainly', () => {
    const view = mcpPackReviewView([]);
    expect(view.rows).toEqual([]);
    expect(view.reviewed_ops).toEqual([]);
    expect(view.summary).toMatch(/no tools/);
  });
});

describe('D-225 — removal wording', () => {
  it('⛔ NAMES the connection and the credential when one was deleted', () => {
    // From a button labelled "remove pack", deleting an enrolled credential
    // reads far smaller than it is. Saying nothing is what makes it silent.
    const message = packRemovalMessage({ removed_connection: 'recued_peer' });
    expect(message).toContain('recued_peer');
    expect(message).toMatch(/credential/i);
  });

  it('stays plain for an ordinary pack', () => {
    // The paired direction — every marketplace uninstall must not claim to have
    // deleted a connection.
    const message = packRemovalMessage({});
    expect(message).toBe('Pack removed.');
    expect(message).not.toMatch(/credential|connection/i);
  });

  it('warns BEFORE the irreversible step, not only after', () => {
    const confirm = packRemovalConfirm('recued_peer');
    expect(confirm).toContain('recued_peer');
    expect(confirm).toMatch(/credential/i);
    expect(confirm).toMatch(/enroll it again/);
  });

  it('the ordinary confirm makes no such claim', () => {
    expect(packRemovalConfirm()).toBe('Remove this pack?');
  });
});
