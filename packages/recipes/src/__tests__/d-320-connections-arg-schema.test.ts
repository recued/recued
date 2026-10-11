/** D-320 slice 2d / ruling 12 — a recipe tool's `connections` argument.
 *
 *  Offered only where the owner has a choice (two or more connections on a slot's
 *  list), so a recipe whose packs sign in once costs the catalog nothing. The
 *  owner's own chat sees each slot's connections by name and alias, so it can
 *  match "the other connection" (or "account") to one; anyone else sees the slots only. */

import { describe, expect, it } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';

import {
  buildTier2Catalog,
  buildTier2ToolEntry,
  deriveTier2ArgSchema,
  type Tier2ConnectionSlot,
} from '../chat-catalog.js';

const recipe = (variables: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id: 'read-the-deal',
  version: 1,
  metadata: { name: 'Read the deal', description: 'One HubSpot read.', author: 'recued-core', tags: [] },
  chat_exposed: true,
  variables: { deal_id: { label: 'Deal', type: 'string' }, ...variables },
  steps: [],
} as unknown as RecipeDefinition);

const HUBSPOT: Tier2ConnectionSlot = {
  slot: 'hubspot',
  connections: [
    { connection_name: 'hubspot-app', display_name: 'Sales app', is_default: false },
    { connection_name: 'hubspot-key', display_name: 'Service Key', is_default: true },
  ],
};

const connectionsOf = (schema: Record<string, unknown>) =>
  (schema.properties as Record<string, Record<string, unknown>>).connections;

describe('D-320 slice 2d — the `connections` argument', () => {
  it('is absent with no choice to make', () => {
    expect(connectionsOf(deriveTier2ArgSchema(recipe()))).toBeUndefined();
    expect(connectionsOf(deriveTier2ArgSchema(recipe(), [], true))).toBeUndefined();
  });

  it("names the owner's connections, aliases and default", () => {
    expect(connectionsOf(deriveTier2ArgSchema(recipe(), [HUBSPOT], true))).toEqual({
      type: 'object',
      description: "Which of the owner's connections this run uses, per sign-in. Leave it out to use the default; "
        + 'set it when the user names another connection (they may call it an account). This run only.',
      properties: {
        hubspot: {
          type: 'string',
          enum: ['hubspot-app', 'hubspot-key'],
          description: 'hubspot-app: Sales app; hubspot-key: Service Key (default)',
        },
      },
      additionalProperties: false,
    });
  });

  it('shows anyone else the slots and no names', () => {
    const schema = deriveTier2ArgSchema(recipe(), [HUBSPOT], false);
    expect(connectionsOf(schema)).toEqual({
      type: 'object',
      description: expect.stringContaining("owner's default"),
      properties: { hubspot: { type: 'string' } },
      additionalProperties: false,
    });
    expect(JSON.stringify(schema)).not.toMatch(/hubspot-app|hubspot-key|Sales app|Service Key/);
  });

  it('is never required, and the tool stays closed to anything else', () => {
    const schema = deriveTier2ArgSchema(recipe(), [HUBSPOT], true);
    expect(schema.required ?? []).not.toContain('connections');
    expect(schema.additionalProperties).toBe(false);
  });

  it("leaves a recipe's own setting called `connections` as that setting", () => {
    const own = recipe({ connections: { label: 'Connections', type: 'number' } });
    expect(connectionsOf(deriveTier2ArgSchema(own, [HUBSPOT], true))).toEqual(
      connectionsOf(deriveTier2ArgSchema(own)),
    );
  });

  it('reaches the tool entry: names in the owner\'s catalog only', () => {
    const entry = { recipe_id: 'read-the-deal', publisher_id: 'recued-core', recipe: recipe(), connection_slots: [HUBSPOT] };
    const lookup = () => null;
    const owner = buildTier2ToolEntry(entry, lookup, undefined, true, true)!;
    const door = buildTier2ToolEntry(entry, lookup)!;
    expect(JSON.stringify(owner.arg_schema)).toContain('hubspot-app');
    expect(connectionsOf(door.arg_schema as Record<string, unknown>)).toBeDefined();
    expect(JSON.stringify(door.arg_schema)).not.toContain('hubspot-app');
    expect(JSON.stringify(buildTier2Catalog([entry], lookup, undefined, true, true)[0]!.arg_schema))
      .toContain('hubspot-app');
    expect(JSON.stringify(buildTier2Catalog([entry], lookup)[0]!.arg_schema)).not.toContain('hubspot-app');
  });
});
