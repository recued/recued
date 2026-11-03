/** D-335 slice H — a screenshot's picture is held by the server, by reference,
 *  and reaches an AI app over MCP as an image beside the result's text. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BROWSER_IMAGE_TTL_MS, isBrowserImageRef } from '@recued/contracts';
import type { InternalToolRegistry, RecipeDefinition, ToolEntry } from '@recued/contracts';

import { createBrowserImageStore, browserImages } from '../bridges/browser-images.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { _testing } from '../mcp-server.js';
import { liftBrowserImages, MCP_MAX_IMAGES_PER_RESULT, noteBrowserImagesForChat } from '../mcp-browser-images.js';
import { createRecipeStore } from '../recipe-store.js';

const picture = (data = 'SlBFRw==') => ({ mime_type: 'image/jpeg' as const, data, width: 640, height: 480 });

describe('the server holds a screenshot for a while, by reference', () => {
  it('answers a reference with no picture in it, and the picture for that reference', () => {
    const store = createBrowserImageStore();
    const ref = store.put(picture());
    expect(isBrowserImageRef(ref)).toBe(true);
    expect(JSON.stringify(ref)).not.toContain('SlBFRw==');
    expect(store.get(ref.image_id)).toEqual(picture());
  });

  it('forgets a picture once it is older than the hold', () => {
    let now = 1_000;
    const store = createBrowserImageStore({ now: () => now });
    const ref = store.put(picture());
    now += BROWSER_IMAGE_TTL_MS - 1;
    expect(store.get(ref.image_id)).toBeDefined();
    now += 2;
    expect(store.get(ref.image_id)).toBeUndefined();
  });

  it('drops the oldest first when it holds too much', () => {
    const store = createBrowserImageStore({ maxHeld: 10 });
    const first = store.put(picture('AAAA'));
    const second = store.put(picture('BBBB'));
    const third = store.put(picture('CCCC'));
    expect(store.get(first.image_id)).toBeUndefined();
    expect(store.get(second.image_id)).toBeDefined();
    expect(store.get(third.image_id)).toBeDefined();
  });

  it('names each picture with an id nobody could guess', () => {
    const store = createBrowserImageStore();
    const ids = new Set(Array.from({ length: 50 }, () => store.put(picture()).image_id));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('an AI app over MCP receives the picture as an image', () => {
  it('lifts each picture out beside the text, and the text says it is attached', () => {
    const store = createBrowserImageStore();
    const ref = store.put(picture());
    const lifted = liftBrowserImages({ success: true, output: { render: [{ data: { page: '7:A', image: ref } }] } }, store);
    expect(lifted.images).toEqual([{ type: 'image', data: 'SlBFRw==', mimeType: 'image/jpeg' }]);
    expect(JSON.stringify(lifted.data)).not.toContain('SlBFRw==');
    expect(lifted.data).toEqual({ success: true, output: { render: [{ data: { page: '7:A', image: { ...ref, attached: true,
      note: 'The picture is attached to this result as image 1.' } } }] } });
  });

  it('a picture no longer held is said to be gone, and nothing is attached', () => {
    const lifted = liftBrowserImages({ image: { type: 'image', image_id: '00000000-0000-0000-0000-000000000000',
      mime_type: 'image/png', width: 1, height: 1 } }, createBrowserImageStore());
    expect(lifted.images).toEqual([]);
    expect(lifted.data).toMatchObject({ image: { attached: false, note: 'The picture is no longer held: take the screenshot again.' } });
  });

  it(`attaches at most ${MCP_MAX_IMAGES_PER_RESULT} pictures to one result`, () => {
    const store = createBrowserImageStore();
    const refs = Array.from({ length: MCP_MAX_IMAGES_PER_RESULT + 2 }, () => store.put(picture()));
    const lifted = liftBrowserImages({ shots: refs }, store);
    expect(lifted.images).toHaveLength(MCP_MAX_IMAGES_PER_RESULT);
    expect((lifted.data as { shots: Array<{ attached: boolean }> }).shots.map(s => s.attached))
      .toEqual([true, true, true, true, false, false]);
  });

  it('a picture named twice in one result is attached once, and both references say which', () => {
    const store = createBrowserImageStore();
    const ref = store.put(picture());
    const lifted = liftBrowserImages({ output: { image: ref }, steps: [{ output: { image: ref } }] }, store);
    expect(lifted.images).toHaveLength(1);
    expect(JSON.stringify(lifted.data).match(/attached to this result as image 1/g)).toHaveLength(2);
  });

  it('a result with no picture is returned as it was', () => {
    const data = { success: true, when: new Date(0), nested: [{ type: 'image', image_id: 'too-short' }] };
    const lifted = liftBrowserImages(data, createBrowserImageStore());
    expect(lifted.data).toBe(data);
    expect(lifted.images).toEqual([]);
  });

  it('chat\'s model is told it is not shown the picture', () => {
    const ref = createBrowserImageStore().put(picture());
    expect(noteBrowserImagesForChat({ image: ref })).toEqual({ image: { ...ref, attached: false,
      note: 'Recued\'s chat does not show pictures to its model yet. An AI app connected over MCP receives the picture itself.' } });
  });

  // Through the real MCP tool calls. A recipe run whose output holds a picture
  // reference answers an image block beside its text, on both paths an AI app
  // takes: the generic run tool, and a recipe's own tool through the registry
  // (the toolkit's), whose dispatch answers `{ ok, result }`.
  const said = (res: unknown) => res as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean };
  const expectPictureBeside = (res: unknown, data: string, image_id: string) => {
    const response = said(res);
    expect(response.isError, JSON.stringify(response).slice(0, 400)).not.toBe(true);
    expect(response.content.filter(c => c.type === 'image')).toEqual([{ type: 'image', data, mimeType: 'image/jpeg' }]);
    const textPart = response.content.find(c => c.type === 'text')!.text!;
    expect(textPart).not.toContain(data);
    expect(textPart).toContain(image_id);
    expect(textPart).toContain('The picture is attached to this result as image 1.');
  };

  it('the generic run tool: a real run whose output refers to a picture answers it as an MCP image', async () => {
    const ref = browserImages.put(picture('UElDVFVSRQ=='));
    const recipe = {
      recipe_id: 'picture-holder', version: 1, chat_exposed: true, ttl: 0,
      metadata: { name: 'Picture holder', description: 'Answers a picture reference.', author: 'recued-core',
        supported_platforms: [], tags: [] },
      variables: {}, requires: [], depends_on: [],
      steps: [{ id: 'shot', transform: 'coalesce', values: [ref] }],
      output: { render: [{ type: 'json', source: 'step.shot', label: 'Screenshot' }] },
    } as unknown as RecipeDefinition;
    const recipeStore = createRecipeStore('/nonexistent', new Database(':memory:'));
    recipeStore.save(recipe, 'recued-core', 'inline');
    const deps = {
      inboundTokenAuthorize: () => true,
      recipeStore,
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];
    expectPictureBeside(await _testing.handleToolCall({ name: 'recued_runRecipe', arguments: { recipe_id: 'picture-holder' } }, deps),
      'UElDVFVSRQ==', ref.image_id);
  });

  it('a recipe\'s own tool, through the registry as the toolkit\'s are, answers its picture as an MCP image', async () => {
    const ref = browserImages.put(picture('U0NSRUVOU0hPVA=='));
    const tool: ToolEntry = { name: 'recued-core/screenshot-web-page', tier: 2, description: 'Take a screenshot of a web page.',
      arg_schema: { type: 'object', properties: { page: { type: 'string' } }, additionalProperties: false },
      topic_tags: [], classification: 'read', concurrency_safe: false };
    const registry: InternalToolRegistry = {
      list: () => [tool], listByTier: tier => (tier === 2 ? [tool] : []), getByName: name => (name === tool.name ? tool : null),
      dispatch: async () => ({ ok: true, result: { success: true, output: { render: [{ type: 'json', label: 'Screenshot',
        data: { page: '7:A', url: 'https://app.example.com/', title: 'App', width: 640, height: 480, image: ref } }] } } }),
      subscribeRefresh: () => () => undefined,
    };
    const deps = {
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      internalRegistry: registry,
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];
    expectPictureBeside(await _testing.handleToolCall({ name: tool.name, arguments: { page: '7:A' } }, deps),
      'U0NSRUVOU0hPVA==', ref.image_id);
  });
});
