/** A federated Source consumes a Tier-2 recipe through MCP. The registry-routed
 * tool result must keep text for humans/models and carry the same object
 * structurally for result_path traversal by the Source reconciler. */
import { describe, expect, it } from 'vitest';

import { _testing } from '../mcp-server.js';

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
});
