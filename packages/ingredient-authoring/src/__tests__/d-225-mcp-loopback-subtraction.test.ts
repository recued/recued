/** D-225 auto-mint — THE LOOPBACK DIFF.
 *
 *  Two Recued servers that enrol each other each publish the other's tools, so a
 *  naive mint of B pulls A's own tools back into A's pack. `subtractReflectedMcpTools`
 *  removes exactly that reflection.
 *
 *  ⛔ The claims here are about WHAT MUST SURVIVE, not about what is removed.
 *  Every wrong version of this filter removes the reflection too — the ones that
 *  are wrong are wrong because they ALSO remove something they had no business
 *  touching, or because they remove it for a reason that does not hold. So each
 *  case below is a survivor with a name:
 *
 *    - the peer's own native verb, which SHARES A NAME with ours;
 *    - the peer's honest relay of a THIRD server;
 *    - everything at all, when there is no relationship to reflect through.
 */
import { describe, expect, it } from 'vitest';
import type { McpToolDescriptor } from '@recued/contracts';

import {
  mcpToolOpSegment,
  subtractReflectedMcpTools,
} from '../mcp-pack.js';

const tool = (name: string): McpToolDescriptor => ({ name });

/** A generated-pack slug shape — 32 hex, per `mcpGeneratedPackSlug`. */
const PACK_A_ON_B = 'mcp-0123456789abcdef0123456789abcdef';
const PACK_THIRD_ON_B = 'mcp-fedcba9876543210fedcba9876543210';

/** How a peer republishes an upstream tool: the upstream name becomes an op
 *  segment inside that peer's own generated pack. Built with the REAL derivation
 *  so the test cannot pass against a hand-written shape the minter never emits. */
const relayed = async (pack: string, upstream: McpToolDescriptor): Promise<McpToolDescriptor> =>
  tool(`recued_op_recued-local.${pack}.${await mcpToolOpSegment(upstream)}`);

describe('subtractReflectedMcpTools — the loopback diff', () => {
  it('drops OUR tool relayed back at us, and keeps the peer’s own tools', async () => {
    const ours = tool('recued_op_recued-core.crm.create_deal');
    const reflection = await relayed(PACK_A_ON_B, ours);
    const peerOwn = tool('summarise_thread');

    const { kept, dropped } = subtractReflectedMcpTools(
      [peerOwn, reflection],
      [ours.name],
    );

    expect(dropped.map((d) => d.name)).toEqual([reflection.name]);
    expect(kept.map((d) => d.name)).toEqual([peerOwn.name]);
  });

  it('⛔ KEEPS the peer’s own native verb even though it shares OUR tool’s name', async () => {
    // The trap a bare-name subtraction falls into, and it fails BOTH ways at
    // once: `recued_listRecipes` on the peer is the peer's own tool (keep), and
    // the reflection of ours is named nothing like it (drop). A name filter
    // deletes the first and leaves the second.
    const ours = tool('recued_listRecipes');
    const peerOwnSameName = tool('recued_listRecipes');
    const reflection = await relayed(PACK_A_ON_B, ours);

    const { kept, dropped } = subtractReflectedMcpTools(
      [peerOwnSameName, reflection],
      [ours.name],
    );

    expect(kept.map((d) => d.name)).toEqual(['recued_listRecipes']);
    expect(dropped.map((d) => d.name)).toEqual([reflection.name]);
  });

  it('⛔ KEEPS the peer’s honest relay of a THIRD server', async () => {
    // The reason the name filter (`recued_op_recued-local.mcp-*`) is the
    // fallback and not the plan: this descriptor has the exact shape of a
    // reflection and is not one. Only the contract-derived exposed set tells
    // them apart.
    const third = await relayed(PACK_THIRD_ON_B, tool('stripe_refund'));

    const { kept, dropped } = subtractReflectedMcpTools(
      [third],
      ['recued_op_recued-core.crm.create_deal'],
    );

    expect(dropped).toEqual([]);
    expect(kept.map((d) => d.name)).toEqual([third.name]);
  });

  it('degrades to minting EVERYTHING when there is no relationship', async () => {
    // An ordinary third-party MCP server carries no `peer_contract_id`, so
    // nothing is exposed to it, so nothing may be subtracted — including a tool
    // that happens to wear the relay shape.
    const shaped = await relayed(PACK_A_ON_B, tool('recued_listRecipes'));

    const { kept, dropped } = subtractReflectedMcpTools([tool('echo'), shaped], []);

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(2);
  });

  it('ignores names that only LOOK like a relay', async () => {
    const ours = tool('recued_listRecipes');
    const segment = await mcpToolOpSegment(ours);
    const notRelays = [
      // a marketplace pack op, not a generated one
      tool(`recued_op_recued-core.${PACK_A_ON_B}.${segment}`),
      // generated publisher, but the pack slug is not a generated slug
      tool(`recued_op_recued-local.some-pack.${segment}`),
      // right shape, but the op segment carries no descriptor hash
      tool('recued_op_recued-local.' + PACK_A_ON_B + '.recued_listrecipes'),
      // not a raw op at all
      tool(`recued-local.${PACK_A_ON_B}.${segment}`),
      // a fourth segment — a shape the minter never emits
      tool(`recued_op_recued-local.${PACK_A_ON_B}.${segment}.extra`),
    ];

    const { kept, dropped } = subtractReflectedMcpTools(notRelays, [ours.name]);

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(notRelays.length);
  });

  it('matches through the label CLAMP, so a long tool name still subtracts', async () => {
    // `readableLabel` lowercases, substitutes and clamps to 48 chars. Both sides
    // run the same reduction, so a name long enough to be truncated must still
    // match — if this ever regresses, the longest (and most op-shaped) names are
    // exactly the ones that stop being subtracted.
    const ours = tool('recued_op_recued-core.a-very-long-pack-name.an_even_longer_operation_name');
    const reflection = await relayed(PACK_A_ON_B, ours);

    const { dropped } = subtractReflectedMcpTools([reflection], [ours.name]);

    expect(dropped.map((d) => d.name)).toEqual([reflection.name]);
  });
});
