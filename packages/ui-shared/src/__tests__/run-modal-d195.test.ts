import { describe, expect, it } from 'vitest';
import type {
  RecipeDefinition,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  initialRunModalState,
  renderRunModal,
  RUN_MODAL_CONTEXT_ATTR,
  RUN_MODAL_IDENTITY_ATTR,
  RUN_MODAL_RESULT_ATTR,
  runTargetGate,
} from '../run-modal/index.js';

const recipeDefinition = (): RecipeDefinition => ({
  recipe_id: 'reply-action',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Reply action',
    description: 'Draft a reply.',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  variables: { tone: { label: 'Tone', type: 'text' } },
  prefetch_steps: [],
  steps: [],
  output: {
    render: [{ type: 'text', source: '{{context.entity_id}}' }],
  },
  requires: ['read_memory'],
});

const recipeEntry = (): ServerRecipeListEntry => ({
  recipe_id: 'reply-action',
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: 'hash-reply-action',
  recipe: recipeDefinition(),
  source: 'pair-sync',
  installed_at: 1,
});

const executeResponse = (
  overrides: Partial<ServerExecuteResponse>,
): ServerExecuteResponse => ({
  recipe_id: 'reply-action',
  recipe_hash: 'hash-reply-action',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 7,
  ...overrides,
});

const caps = { canExecute: true, canSchedule: false, canTrigger: false };

describe('RunModal D-195 action review and status semantics', () => {
  it('preserves JSON-typed author context while assessing target fields', () => {
    const context = {
      entity_id: 42,
      review: { mode: 'draft', recipients: ['owner', 'legal'] },
      notify: true,
    };

    const gate = runTargetGate(recipeDefinition(), '{}', {}, context);

    expect(gate.assessment.ok).toBe(true);
    expect(gate.context).toEqual(context);
    expect(gate.context.entity_id).toBe(42);
    expect(gate.context.review).toEqual({
      mode: 'draft',
      recipients: ['owner', 'legal'],
    });
  });

  it('shows the true target identity plus config and typed context before run', () => {
    const state = {
      ...initialRunModalState('run', ''),
      config_text: '{\n  "tone": "warm"\n}',
      context_values: {
        entity_id: 42,
        review: { mode: 'draft' },
      },
    };

    const html = renderRunModal(state, recipeEntry(), caps);

    expect(html).toContain(RUN_MODAL_IDENTITY_ATTR);
    expect(html).toContain('Target recipe: <code>reply-action</code>');
    expect(html).toContain('Publisher: <code>recued-core</code>');
    expect(html).toContain('<details class="run-modal-advanced" open>');
    expect(html).toContain('&quot;tone&quot;: &quot;warm&quot;');
    expect(html).toContain(RUN_MODAL_CONTEXT_ATTR);
    expect(html).toContain('&quot;entity_id&quot;: 42');
    expect(html).toContain('&quot;mode&quot;: &quot;draft&quot;');
    expect(html).toContain('Prefilled in action context');
  });

  it.each<[string, ServerExecuteResponse, string]>([
    ['completed', executeResponse({ success: true }), 'Run completed'],
    [
      'held',
      executeResponse({ success: false, awaiting_approval: true }),
      'Awaiting approval',
    ],
    [
      'terminated',
      executeResponse({ success: false, run_terminated: 'killed' }),
      'Run terminated',
    ],
  ])('announces a %s async result', (_name, result, label) => {
    const state = {
      ...initialRunModalState('run', ''),
      result,
    };

    const html = renderRunModal(state, recipeEntry(), caps);

    expect(html).toContain(RUN_MODAL_RESULT_ATTR);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain(label);
  });
});
