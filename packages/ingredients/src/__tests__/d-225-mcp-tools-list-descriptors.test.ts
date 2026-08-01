/** D-225 Slice 2 — the `tools/list` page parser retains DESCRIPTORS.
 *
 *  ⚠ This function had no direct test before D-225, despite already owning the
 *  dispatch-time tool allow-list (`ConnectionHealth.tools`, which the
 *  `connection.mcp` handler pre-validates against). Slice 2 makes it carry more
 *  weight still: a generated pack is minted from what this returns, and the
 *  grant identity it derives is a hash over `{ name, input_schema }`. A parser
 *  that dropped the schema would leave the generator unable to tell a tool from
 *  the same tool with a different argument shape.
 *
 *  🔑 The back-compat claim is the one to be careful about: `tools` is
 *  PERSISTED, so widening its element type would have made every already-stored
 *  connection row unreadable. `descriptors` is a sibling, not a replacement —
 *  the same discipline as the approval_link read-path fix.
 */
import { describe, expect, it } from 'vitest';

import { parseMcpToolListPage } from '../connection-mcp.js';

const page = (tools: unknown[], rest: Record<string, unknown> = {}) => ({ tools, ...rest });

describe('D-225 Slice 2 — tools/list descriptors', () => {
  it('retains name + input_schema for each tool', () => {
    const r = parseMcpToolListPage(page([
      { name: 'project.list', description: 'List.', inputSchema: { type: 'object' } },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.descriptors).toEqual([
      { name: 'project.list', description: 'List.', input_schema: { type: 'object' } },
    ]);
  });

  it('preserves the NAME list verbatim alongside — it is persisted and read at dispatch', () => {
    const r = parseMcpToolListPage(page([{ name: 'a' }, { name: 'b' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tools).toEqual(['a', 'b']);
    expect(r.tools.every((t) => typeof t === 'string')).toBe(true);
  });

  it('captures destructiveHint for DISPLAY, from the annotations object', () => {
    const r = parseMcpToolListPage(page([
      { name: 'wipe', annotations: { destructiveHint: true, readOnlyHint: false } },
    ]));
    if (!r.ok) throw new Error('unreachable');
    expect(r.descriptors[0]!.destructive_hint).toBe(true);
  });

  it('omits destructive_hint when the server publishes no boolean', () => {
    // Absent must stay absent rather than defaulting to `false` — "the server
    // said nothing" and "the server said it is safe" are different facts, and
    // neither may be used for tiering anyway.
    const r = parseMcpToolListPage(page([
      { name: 'a' },
      { name: 'b', annotations: {} },
      { name: 'c', annotations: { destructiveHint: 'yes' } },
      { name: 'd', annotations: null },
    ]));
    if (!r.ok) throw new Error('unreachable');
    for (const d of r.descriptors) {
      expect(Object.prototype.hasOwnProperty.call(d, 'destructive_hint')).toBe(false);
    }
  });

  it('a tool declaring no schema yields a descriptor with no input_schema', () => {
    const r = parseMcpToolListPage(page([{ name: 'ping' }]));
    if (!r.ok) throw new Error('unreachable');
    expect(r.descriptors[0]).toEqual({ name: 'ping' });
  });

  it('still fails the WHOLE page on a malformed entry', () => {
    // Unchanged contract, and it matters more now. A partial page would produce
    // both an incomplete dispatch allow-list AND a generated pack missing tools
    // the server actually has — the second silently, at enrollment.
    expect(parseMcpToolListPage(page([{ name: 'ok' }, { name: 42 }])).ok).toBe(false);
    expect(parseMcpToolListPage(page([{ name: '' }])).ok).toBe(false);
    expect(parseMcpToolListPage(page([null])).ok).toBe(false);
    expect(parseMcpToolListPage(page([['nope']])).ok).toBe(false);
    expect(parseMcpToolListPage({ tools: 'nope' }).ok).toBe(false);
    expect(parseMcpToolListPage(null).ok).toBe(false);
  });

  it('carries the pagination cursor with the descriptors', () => {
    const r = parseMcpToolListPage(page([{ name: 'a' }], { nextCursor: 'c1' }));
    if (!r.ok) throw new Error('unreachable');
    expect(r.nextCursor).toBe('c1');
    expect(r.descriptors).toHaveLength(1);
    // An empty-string cursor is valid when the property is present.
    const empty = parseMcpToolListPage(page([{ name: 'a' }], { nextCursor: '' }));
    expect(empty.ok).toBe(true);
    // A non-string cursor is not.
    expect(parseMcpToolListPage(page([{ name: 'a' }], { nextCursor: 7 })).ok).toBe(false);
  });

  it('drops unknown fields rather than passing them through', () => {
    // A generated declaration should contain only what we chose to act on. A
    // pass-through would silently widen the descriptor hash preimage the first
    // time a server invented a key — moving every op id on that server.
    const r = parseMcpToolListPage(page([
      { name: 'a', inputSchema: {}, title: 'A', outputSchema: {}, vendorExtra: 'x' },
    ]));
    if (!r.ok) throw new Error('unreachable');
    expect(Object.keys(r.descriptors[0]!).sort()).toEqual(['input_schema', 'name']);
  });
});
