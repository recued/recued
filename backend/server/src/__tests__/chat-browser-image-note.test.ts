/** D-335 slice H — chat's model is told it is not shown a screenshot.
 *
 *  A screenshot's output carries a `BrowserImageRef`; an AI app over MCP gets the
 *  picture beside the result, Recued's chat does not show it to its model (a
 *  picture cannot be aliased the way chat aliases names and addresses). Through
 *  the real chat orchestrator, a tool answer holding a picture reference reaches
 *  the model's next packet marked `attached: false`, with the note saying so,
 *  and never as the picture. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createBrowserImageStore } from '../bridges/browser-images.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';

describe('a screenshot in chat', () => {
  it('reaches chat\'s model as a reference that says it is not shown, never as the picture', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'screenshot-note' });
    const picture = 'UElDVFVSRS1CWVRFUw==';
    const ref = createBrowserImageStore().put({ mime_type: 'image/jpeg', data: picture, width: 640, height: 480 });
    const tool: ToolEntry = { name: 'recued-core/screenshot-web-page', tier: 2, description: 'Take a screenshot of a web page.',
      arg_schema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'], additionalProperties: false },
      topic_tags: [], classification: 'read', concurrency_safe: true };
    const registry: InternalToolRegistry = { list: () => [tool], listByTier: tier => (tier === 2 ? [tool] : []),
      getByName: name => (name === tool.name ? tool : null), subscribeRefresh: () => () => {},
      dispatch: async () => ({ ok: true, result: { success: true, output: { render: [{ type: 'json', label: 'Screenshot',
        data: { page: '7:A', url: 'https://app.example.com/', title: 'App', width: 640, height: 480, image: ref } }] } } }) };
    const packets: Array<Record<string, unknown>> = [];
    let calls = 0;
    const orchestrator = createChatOrchestrator({ chatStore: store, registry,
      piiLedgerStore: piiEgress.createSessionLedgerStore(),
      fieldPrivacyResolver: createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
        CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS),
      selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'test' },
      broadcast: { emit: () => {} },
      executeAiCall: async (_manifest, input) => {
        const packet = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
        packets.push(packet);
        calls++;
        return { body: { response: calls === 1 ? '' : 'Here is what I could tell.', events: [],
          tool_calls: calls === 1 ? [{ tool: tool.name, args: { page: '7:A' } }] : [] } };
      },
    });
    await orchestrator.runTurn({ session_id: 'screenshot-note', message: 'Take a screenshot of the open app page.',
      picker_state: { current: 'self' } });

    const after = packets.find(packet => Array.isArray(packet.prior_tool_calls) && (packet.prior_tool_calls as unknown[]).length > 0);
    expect(after, 'the model saw the tool answer').toBeDefined();
    const said = JSON.stringify(after);
    expect(said).not.toContain(picture);
    expect(said).toContain(ref.image_id);
    expect(said).toContain('"attached":false');
    expect(said).toContain('Recued\'s chat does not show pictures to its model yet. An AI app connected over MCP receives the picture itself.');
    db.close();
  });
});
