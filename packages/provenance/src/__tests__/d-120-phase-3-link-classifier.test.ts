/** D-120 Phase 3 — `link-classifier` module.
 *
 *  Three exported helpers:
 *    - `inferExternalCallHost(manifest)` — derive host string from
 *      manifest.input shape (HTTP url / chat.tab / mcp.server_url).
 *    - `stepEmitsLinks(desc)` — gate that decides whether the step
 *      is side-effecting enough to emit any provenance link rows.
 *    - `classifyKind(desc, touch)` — pick a `LinkKind` per touch.
 */

import { describe, expect, it } from 'vitest';
import type { EntityTouch, IngredientManifest } from '@recued/contracts';
import {
  classifyKind,
  inferExternalCallHost,
  stepEmitsLinks,
  type StepTouchDescriptor,
} from '../link-classifier.js';

const baseManifest = (
  partial: Partial<IngredientManifest> = {},
): IngredientManifest => ({
  slug: 'test-ingredient',
  name: 'Test',
  description: 'Test ingredient',
  author: 'test',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  ...partial,
});

describe('inferExternalCallHost', () => {
  it('returns undefined when manifest is missing', () => {
    expect(inferExternalCallHost(undefined)).toBeUndefined();
  });

  it('returns undefined when manifest declares no input shape', () => {
    expect(inferExternalCallHost(baseManifest({ input: {} as Record<string, unknown> }))).toBeUndefined();
  });

  it('parses http url hostname', () => {
    const m = baseManifest({ input: { url: 'https://api.hubspot.com/crm/v3/objects/deals' } });
    expect(inferExternalCallHost(m)).toBe('api.hubspot.com');
  });

  it('returns chat.tab verbatim (the tab name is the host-of-interest)', () => {
    const m = baseManifest({ input: { chat: { tab: 'gemini' } } });
    expect(inferExternalCallHost(m)).toBe('gemini');
  });

  it('parses mcp.server_url hostname', () => {
    const m = baseManifest({
      input: { mcp: { server_url: 'http://localhost:9000/sse' } },
    });
    expect(inferExternalCallHost(m)).toBe('localhost');
  });

  it('returns undefined for templated urls (no literal host to extract)', () => {
    const m = baseManifest({ input: { url: '{{config.api_base}}/v1/items' } });
    expect(inferExternalCallHost(m)).toBeUndefined();
  });
});

describe('stepEmitsLinks', () => {
  const desc = (overrides: Partial<StepTouchDescriptor> = {}): StepTouchDescriptor => ({
    ingredient_slug: 'test',
    ...overrides,
  });

  it('emits when external_call is set (HTTP / chat / MCP-call ingredients)', () => {
    expect(
      stepEmitsLinks(desc({ external_call: 'api.hubspot.com', manifest: baseManifest({ category: 'data' }) })),
    ).toBe(true);
  });

  it('emits for action-category ingredients', () => {
    expect(
      stepEmitsLinks(desc({ manifest: baseManifest({ category: 'action', risk_tier: 'write' }) })),
    ).toBe(true);
  });

  it('emits for ai-prompt (escape-hatch custom prompt)', () => {
    expect(
      stepEmitsLinks(desc({
        ingredient_slug: 'ai-prompt',
        manifest: baseManifest({ slug: 'ai-prompt', category: 'ai' }),
      })),
    ).toBe(true);
  });

  it('does NOT emit for contracted ai-* analyses (deterministic, observational)', () => {
    expect(
      stepEmitsLinks(desc({
        ingredient_slug: 'ai-classify',
        manifest: baseManifest({ slug: 'ai-classify', category: 'ai' }),
      })),
    ).toBe(false);
  });

  it('does NOT emit for data-category reads (no causal effect)', () => {
    expect(
      stepEmitsLinks(desc({ manifest: baseManifest({ category: 'data', risk_tier: 'read' }) })),
    ).toBe(false);
  });

  it('does NOT emit when descriptor lacks a manifest and no external_call', () => {
    expect(stepEmitsLinks(desc({}))).toBe(false);
  });
});

describe('classifyKind', () => {
  const baseDesc: StepTouchDescriptor = {
    ingredient_slug: 'send-email',
    manifest: baseManifest({ slug: 'send-email', category: 'action' }),
  };
  const touch = (overrides: Partial<EntityTouch> = {}): EntityTouch => ({
    collection: 'mail',
    entity_id: 'msg-1',
    access: 'read',
    ...overrides,
  });

  it('returns execution.action when descriptor has external_call', () => {
    const desc = { ...baseDesc, external_call: 'api.slack.com' };
    expect(classifyKind(desc, touch())).toBe('execution.action');
  });

  it('returns execution.action regardless of touch.access when external_call is set', () => {
    const desc = { ...baseDesc, external_call: 'mail.example.com' };
    expect(classifyKind(desc, touch({ access: 'write' }))).toBe('execution.action');
    expect(classifyKind(desc, touch({ access: 'read' }))).toBe('execution.action');
  });

  it('returns execution.derived for cross-collection write touches', () => {
    const desc = { ...baseDesc, source_collection: 'mail' };
    const t = touch({ collection: 'calendar', access: 'write' });
    expect(classifyKind(desc, t)).toBe('execution.derived');
  });

  it('returns execution.write for same-collection writes', () => {
    const desc = { ...baseDesc, source_collection: 'mail' };
    const t = touch({ collection: 'mail', access: 'write' });
    expect(classifyKind(desc, t)).toBe('execution.write');
  });

  it('returns execution.write when source_collection is unknown', () => {
    expect(classifyKind(baseDesc, touch({ access: 'write' }))).toBe('execution.write');
  });

  it('returns execution.write by default for read access touches', () => {
    expect(classifyKind(baseDesc, touch({ access: 'read' }))).toBe('execution.write');
  });
});
