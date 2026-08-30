/** D-255 — the canonical op tools AT THE DOOR: listed, gated, dispatched.
 *
 *  ⛔ DRIVEN THROUGH `handleToolsList` / `handleToolCall`, not through the
 *  descriptor builder. The builder has its own tests; what these prove is that the
 *  DOOR consults it, gates it on the same predicate as every other tool, and turns
 *  a call into the transient recipe the R2 path runs. A green builder with an
 *  unwired door looks identical from the unit side.
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_OP_TOOL_PREFIX } from '@recued/contracts';

import { _testing } from '../mcp-server.js';

const CONNECTIONS = [
  { name: 'acme-corp', config_json: JSON.stringify({ vendor: 'hubspot' }) },
  { name: 'sf1', config_json: JSON.stringify({ vendor: 'salesforce' }) },
];

const depsWith = (over: Record<string, unknown> = {}) => ({
  inboundTokenAuthorize: () => true,
  connectionStore: { list: () => CONNECTIONS },
  executorConfig: { manifests: { get: () => null, slugs: () => [] } },
  recipeStore: { get: () => null },
  baseVault: {},
  ...over,
} as unknown as Parameters<typeof _testing.handleToolsList>[0]);

const listNames = async (deps: Parameters<typeof _testing.handleToolsList>[0]) => {
  const res = await _testing.handleToolsList(deps) as { tools: Array<{ name: string }> };
  return res.tools.map((t) => t.name);
};

const textOf = (result: unknown): string =>
  JSON.stringify((result as { content?: unknown }).content ?? result);

describe('canonical op tools — listing', () => {
  it('lists one tool per (alias, verb) for the bound connections', async () => {
    const names = await listNames(depsWith());
    expect(names).toContain(`${CANONICAL_OP_TOOL_PREFIX}contact.update`);
    // ⚠ NOT `deal.search` — a Tier-1 `deal.search` already fans out wider, so the
    // canonical one is suppressed. CRUD is what this layer uniquely provides.
    expect(names).toContain(`${CANONICAL_OP_TOOL_PREFIX}deal.update`);
    // ⛔ The connection is an ARG, never part of the name.
    expect(names.filter((n) => n.includes('contact.update'))).toHaveLength(1);
    for (const n of names) expect(n).not.toMatch(/acme-corp|sf1/);
  });

  it('⛔ lists none when no connection is bound', async () => {
    const names = await listNames(depsWith({ connectionStore: { list: () => [] } }));
    expect(names.filter((n) => n.startsWith(CANONICAL_OP_TOOL_PREFIX))).toEqual([]);
  });

  it('⛔ lists none when no connection store is wired (dbless posture)', async () => {
    const names = await listNames(depsWith({ connectionStore: undefined }));
    expect(names.filter((n) => n.startsWith(CANONICAL_OP_TOOL_PREFIX))).toEqual([]);
  });

  it('⛔ THE ENUMERATION MIRRORS THE DISPATCH GATE — an ungranted tool is hidden', async () => {
    // The listing filter and the call gate must stay ONE predicate: a tool the
    // checklist admits but the catalog hides is a door that works only for a
    // caller who already knew the name.
    const names = await listNames(depsWith({
      inboundTokenAuthorize: (t: string) => t !== `${CANONICAL_OP_TOOL_PREFIX}contact.update`,
    }));
    expect(names).not.toContain(`${CANONICAL_OP_TOOL_PREFIX}contact.update`);
    expect(names).toContain(`${CANONICAL_OP_TOOL_PREFIX}contact.read`);
  });
});

describe('canonical op tools — dispatch', () => {
  const call = async (name: string, args: Record<string, unknown>, over = {}) =>
    _testing.handleToolCall({ name, arguments: args }, depsWith(over) as never);

  it('🔑 reaches R2 — built, executed, and resolved against the NAMED connection', async () => {
    // ⛔ A POSITIVE PROOF OF WIRING, not "did not refuse". The call gets past the
    // door, becomes a transient recipe, enters `handleExecute`, and reaches R2's
    // canonical resolution — which fails CLOSED here because this harness binds no
    // operation profile. The message naming BOTH the op-step and the connection is
    // what proves every stage in between ran: an earlier refusal, or a missing
    // branch, produces an entirely different string.
    const res = await call(
      `${CANONICAL_OP_TOOL_PREFIX}contact.update`,
      { connection: 'acme-corp', args: { id: 'c-1', jobtitle: 'CTO' } },
    );
    const out = textOf(res);
    expect(out).toContain('canonical op-step');
    expect(out).toContain("connection 'acme-corp'");
    expect(out).toContain('could not be resolved at dispatch');
  });

  it('⛔ refuses a call with no connection, and never defaults one', async () => {
    // Picking a connection would choose which account a write lands in — the one
    // decision this surface must not make for the caller.
    const res = await call(`${CANONICAL_OP_TOOL_PREFIX}contact.update`, { args: { id: 'c-1' } });
    expect(textOf(res)).toContain("requires a 'connection' argument");
  });

  it('⛔ refuses an empty-string connection the same way', async () => {
    const res = await call(`${CANONICAL_OP_TOOL_PREFIX}contact.update`, { connection: '' });
    expect(textOf(res)).toContain("requires a 'connection' argument");
  });

  it('⛔ refuses an unknown alias, naming it', async () => {
    const res = await call(`${CANONICAL_OP_TOOL_PREFIX}ticket.update`, { connection: 'acme-corp' });
    expect(textOf(res)).toContain('unknown canonical alias');
  });

  it('⛔ refuses an unknown verb', async () => {
    const res = await call(`${CANONICAL_OP_TOOL_PREFIX}contact.upsert`, { connection: 'acme-corp' });
    expect(textOf(res)).toContain('unknown canonical verb');
  });

  it('⛔ refuses a malformed wire name with no verb segment', async () => {
    const res = await call(`${CANONICAL_OP_TOOL_PREFIX}contact`, { connection: 'acme-corp' });
    expect(textOf(res)).toContain('Unknown canonical operation tool');
  });
});
