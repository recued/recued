/** A federated Source consumes a Tier-2 recipe through MCP. The registry-routed
 * tool result must keep text for humans/models and carry the same object
 * structurally for result_path traversal by the Source reconciler. */
import type { IngredientManifest, ToolEntry } from '@recued/contracts';
import { searchToolCatalog } from '@recued/recipes';
import { describe, expect, it } from 'vitest';

import { _testing } from '../mcp-server.js';
import { buildRawOpToolDescriptors, rawOpToolEntriesFrom } from '../raw-op-tool-catalog.js';

/** The assertions below exercise the generic installed-op projection. Carry
 * only the agenda operation's public contract here instead of importing the
 * separately distributed marketplace pack as a test fixture. */
const PEER_CATALOG: IngredientManifest = {
  slug: 'federated-project-peer',
  name: 'Federated project peer test catalog',
  description: 'Minimal federated agenda catalog for MCP projection tests.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['test', 'federation'],
  input: {},
  output: {},
  operations: {
    'task.agenda': {
      operation_id: 'task.agenda',
      risk_tier: 'read',
      description:
        'Answer "What are my tasks?" and "What do I need to do today?" '
        + 'with a contract-scoped open task agenda.',
      request_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['project_ref', 'day_start_at', 'day_end_at', 'scope'],
        properties: {
          project_ref: { type: 'string', minLength: 1, maxLength: 256 },
          day_start_at: {
            type: 'string',
            minLength: 20,
            maxLength: 40,
            pattern:
              '^\\d{4}-\\d{2}-\\d{2}[Tt]00:00:00(?:\\.0{1,3})?(?:[Zz]|[+-]\\d{2}:?\\d{2})$',
          },
          day_end_at: {
            type: 'string',
            minLength: 20,
            maxLength: 40,
            pattern:
              '^\\d{4}-\\d{2}-\\d{2}[Tt]00:00:00(?:\\.0{1,3})?(?:[Zz]|[+-]\\d{2}:?\\d{2})$',
          },
          scope: { type: 'string', enum: ['today', 'all_open'] },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          dependency_cursor: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
    },
  },
};

describe('federated-project MCP structured result', () => {
  it('publishes a Tier-2 recipe result as text and structuredContent', async () => {
    const execution = {
      success: true,
      output: {
        render: [{ type: 'json', data: [{ id: 'project-1', title: 'Shared' }] }],
      },
    };
    const toolName = 'recued-core/peer-list-federated-projects';
    const deps = {
      ownerAdmitAll: true,
      executorConfig: {
        manifests: {
          slugs: () => [],
          get: () => null,
        },
      },
      recipeStore: {
        ids: () => [],
        get: () => null,
      },
      internalRegistry: {
        list: () => [],
        listByTier: () => [],
        getByName: (name: string) => name === toolName
          ? {
              name,
              tier: 2,
              description: 'Federated project receiver',
              arg_schema: { type: 'object' },
              topic_tags: ['federation'],
              classification: 'read',
              concurrency_safe: false,
            }
          : null,
        dispatch: async () => ({ ok: true, result: execution }),
        subscribeRefresh: () => () => undefined,
      },
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const result = await _testing.handleToolCall(
      { name: toolName, arguments: { project_ref: 'project-1' } },
      deps,
    ) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.structuredContent).toEqual(execution);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('advertises the real installed agenda raw op with its closed argument contract', () => {
    const descriptors = buildRawOpToolDescriptors(
      (() => [{
        segments: ['federated-project-peer'],
        value: {
          publisher: 'recued-core',
          ingredient_ids: [PEER_CATALOG.slug],
        },
      }]) as never,
      (slug) => slug === PEER_CATALOG.slug ? PEER_CATALOG : null,
    );
    const entries = rawOpToolEntriesFrom(descriptors) as ToolEntry[];
    const name = 'recued_op_recued-core.federated-project-peer.task.agenda';
    const agenda = entries.find((entry) => entry.name === name);

    expect(agenda).toBeDefined();
    expect(agenda?.arg_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        connection: { type: 'string' },
        project_ref: { type: 'string' },
        day_start_at: { type: 'string', pattern: expect.stringContaining('00:00:00') },
        day_end_at: { type: 'string', pattern: expect.stringContaining('00:00:00') },
        scope: { enum: ['today', 'all_open'] },
        limit: { type: 'integer', maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        dependency_cursor: { type: 'string' },
      },
      required: expect.arrayContaining([
        'connection', 'project_ref', 'day_start_at', 'day_end_at', 'scope',
      ]),
    });
    for (const prompt of ['What are my tasks?', 'What do I need to do today?']) {
      expect(searchToolCatalog(entries, prompt, 5)[0]?.name, prompt).toBe(name);
    }
  });
});
