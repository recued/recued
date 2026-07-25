/** D-119 Phase 15 — execution scope (recipe + ingredient install gate).
 *
 *  Covers:
 *    - `isValidExecutionScope` shape guard
 *    - `isExecutionScopeSubset` set-membership semantics
 *    - `sortExecutionScope` canonical ordering + dedup
 *    - `deriveIngredientScope` per-kind classification
 *    - `deriveExecutionScope` recipe-level intersection
 *    - `effectiveExecutionScope` narrower-of-(declared, derived)
 *    - `executionScopeLabel` user-facing text
 *    - error codes registered in ERR + ERROR_MESSAGES */

import { describe, it, expect } from 'vitest';
import {
  ALL_EXECUTION_SCOPES,
  ERR,
  ERROR_MESSAGES,
  deriveExecutionScope,
  deriveIngredientScope,
  effectiveExecutionScope,
  executionScopeLabel,
  isExecutionScopeSubset,
  isValidExecutionScope,
  sortExecutionScope,
  type ExecutionScope,
  type IngredientManifest,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Manifest fixtures — minimal shapes the deriver actually inspects
// ────────────────────────────────────────────────────────────────

const baseManifest: Omit<IngredientManifest, 'slug'> = {
  name: 'Test', description: 'Test', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  input: {}, output: {},
};

const httpIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'deal-reader-hubspot',
  input: { url: 'https://api.hubapi.com/deals', method: 'GET' },
  output: { id: 'id', amount: 'amount' },
};

const llmIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'ai-classify',
  kind: 'ai',
  category: 'ai', risk_tier: 'read',
  input: { 'llm.data': null, 'llm.categories': null },
  output: { category: 'category', confidence: 'confidence' },
};

const mcpIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'search-exa-mcp',
  kind: 'mcp',
  input: { 'mcp.server_url': 'https://mcp.exa.ai', 'mcp.tool': 'search', 'mcp.args': null },
  output: { results: 'results' },
};

const transformOnlyIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'kernel-noop',
  author: 'recued',
  kind: 'storage',
  input: { x: null },
  output: { y: 'y' },
};

const domWriteIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'email-composer-hubspot',
  kind: 'dom',
  category: 'action', risk_tier: 'write',
  input: { subject: null, body: null },
  output: { '[data-test-id="email-subject"]': 'dom.subject' },
};

const domTriggerIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'deal-reader-dom-hubspot',
  kind: 'dom',
  input: {},
  output: { 'app.hubspot.com/deals/*': 'trigger', '[data-test-id="amount"]': 'amount' },
};

const domInputIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'page-clicker',
  kind: 'dom',
  input: { 'dom.click_selector': null },
  output: { ok: 'ok' },
};

const webChatIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'web-chat-gemini',
  kind: 'chat',
  category: 'action', risk_tier: 'write',
  input: { 'chat.prompt': null },
  output: {
    'gemini.google.com/*': 'chat.target',
    '.response': 'chat.response',
  },
};

const serviceTemplateIngredient: IngredientManifest = {
  ...baseManifest,
  slug: 'cloudflared-linux',
  kind: 'service',
  input: { service: { platform: 'linux' } },
  output: {},
};

// ────────────────────────────────────────────────────────────────
// isValidExecutionScope
// ────────────────────────────────────────────────────────────────

describe('isValidExecutionScope', () => {
  it('accepts the canonical singletons', () => {
    expect(isValidExecutionScope(['device'])).toBe(true);
    expect(isValidExecutionScope(['server'])).toBe(true);
  });

  it('accepts both members in either order', () => {
    expect(isValidExecutionScope(['device', 'server'])).toBe(true);
    expect(isValidExecutionScope(['server', 'device'])).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(isValidExecutionScope([])).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(isValidExecutionScope(['device', 'device'])).toBe(false);
  });

  it('rejects unknown values', () => {
    expect(isValidExecutionScope(['device', 'cloud'])).toBe(false);
    expect(isValidExecutionScope(['DEVICE'])).toBe(false);
  });

  it('rejects non-array inputs', () => {
    expect(isValidExecutionScope('device')).toBe(false);
    expect(isValidExecutionScope(null)).toBe(false);
    expect(isValidExecutionScope(undefined)).toBe(false);
    expect(isValidExecutionScope({ 0: 'device' })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// isExecutionScopeSubset
// ────────────────────────────────────────────────────────────────

describe('isExecutionScopeSubset', () => {
  it('empty subset is a subset of anything', () => {
    expect(isExecutionScopeSubset([], ['device', 'server'])).toBe(true);
    expect(isExecutionScopeSubset([], [])).toBe(true);
  });

  it('singleton subset matches when present in superset', () => {
    expect(isExecutionScopeSubset(['device'], ['device', 'server'])).toBe(true);
    expect(isExecutionScopeSubset(['server'], ['device', 'server'])).toBe(true);
  });

  it('singleton subset rejected when absent', () => {
    expect(isExecutionScopeSubset(['device'], ['server'])).toBe(false);
    expect(isExecutionScopeSubset(['server'], ['device'])).toBe(false);
  });

  it('full subset accepted, partial-with-extra rejected', () => {
    expect(isExecutionScopeSubset(['device', 'server'], ['device', 'server'])).toBe(true);
    expect(isExecutionScopeSubset(['device', 'server'], ['device'])).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// sortExecutionScope
// ────────────────────────────────────────────────────────────────

describe('sortExecutionScope', () => {
  it('puts device before server', () => {
    expect(sortExecutionScope(['server', 'device'])).toEqual(['device', 'server']);
  });

  it('dedupes', () => {
    expect(sortExecutionScope(['device', 'device', 'server'])).toEqual(['device', 'server']);
  });

  it('returns a fresh array, never mutates', () => {
    const original: ExecutionScope[] = ['server', 'device'];
    const sorted = sortExecutionScope(original);
    expect(original).toEqual(['server', 'device']);
    expect(sorted).not.toBe(original);
  });
});

// ────────────────────────────────────────────────────────────────
// deriveIngredientScope — per-manifest classification
// ────────────────────────────────────────────────────────────────

describe('deriveIngredientScope', () => {
  it('HTTP ingredients run on either runtime', () => {
    expect(deriveIngredientScope(httpIngredient)).toEqual(['device', 'server']);
  });

  it('LLM (ai-* category) ingredients run on either runtime', () => {
    expect(deriveIngredientScope(llmIngredient)).toEqual(['device', 'server']);
  });

  it('MCP ingredients run on either runtime', () => {
    expect(deriveIngredientScope(mcpIngredient)).toEqual(['device', 'server']);
  });

  it('kernel transform-shaped ingredients run on either runtime', () => {
    // No DOM signal, no service kind, no web-chat slug → both.
    expect(deriveIngredientScope(transformOnlyIngredient)).toEqual(['device', 'server']);
  });

  it('DOM-write ingredients (output starts with dom.) are device-only', () => {
    expect(deriveIngredientScope(domWriteIngredient)).toEqual(['device']);
  });

  it('DOM-trigger ingredients (output value === "trigger") are device-only', () => {
    expect(deriveIngredientScope(domTriggerIngredient)).toEqual(['device']);
  });

  it('DOM-input ingredients (input.dom.* keys) are device-only', () => {
    expect(deriveIngredientScope(domInputIngredient)).toEqual(['device']);
  });

  it('web-chat-* ingredients are device-only', () => {
    expect(deriveIngredientScope(webChatIngredient)).toEqual(['device']);
  });

  it('kind: service templates are server-only', () => {
    expect(deriveIngredientScope(serviceTemplateIngredient)).toEqual(['server']);
  });

  it('ignores any author-declared `execution_scope` on the manifest', () => {
    // Derivation is pure — never reads the manifest's own declaration.
    const declaredWide: IngredientManifest = {
      ...domWriteIngredient,
      execution_scope: ['device', 'server'],
    };
    expect(deriveIngredientScope(declaredWide)).toEqual(['device']);
  });
});

// ────────────────────────────────────────────────────────────────
// deriveExecutionScope — recipe-level intersection
// ────────────────────────────────────────────────────────────────

describe('deriveExecutionScope', () => {
  it('zero ingredients (transform-only recipe) yields the full scope', () => {
    expect(deriveExecutionScope([])).toEqual(['device', 'server']);
  });

  it('all-HTTP recipe yields the full scope', () => {
    expect(deriveExecutionScope([httpIngredient, llmIngredient])).toEqual(['device', 'server']);
  });

  it('any DOM ingredient narrows to device', () => {
    expect(deriveExecutionScope([httpIngredient, domWriteIngredient])).toEqual(['device']);
  });

  it('any web-chat ingredient narrows to device', () => {
    expect(deriveExecutionScope([httpIngredient, webChatIngredient])).toEqual(['device']);
  });

  it('any service-kind ingredient narrows to server', () => {
    expect(deriveExecutionScope([httpIngredient, serviceTemplateIngredient])).toEqual(['server']);
  });

  it('mixing device-only + server-only yields the empty set', () => {
    // Uninstallable on either runtime — surfaces the conflict at validate time.
    expect(deriveExecutionScope([webChatIngredient, serviceTemplateIngredient])).toEqual([]);
    expect(deriveExecutionScope([domWriteIngredient, serviceTemplateIngredient])).toEqual([]);
  });

  it('result is canonical-sorted regardless of input order', () => {
    const result = deriveExecutionScope([llmIngredient, httpIngredient]);
    expect(result).toEqual(['device', 'server']);
  });
});

// ────────────────────────────────────────────────────────────────
// effectiveExecutionScope — narrower-of-(declared, derived)
// ────────────────────────────────────────────────────────────────

describe('effectiveExecutionScope', () => {
  it('returns derived when no declaration', () => {
    expect(effectiveExecutionScope(undefined, ['device', 'server'])).toEqual(['device', 'server']);
    expect(effectiveExecutionScope(undefined, ['device'])).toEqual(['device']);
  });

  it('returns derived when declared is empty', () => {
    expect(effectiveExecutionScope([], ['device', 'server'])).toEqual(['device', 'server']);
  });

  it('declared narrows derived to the intersection', () => {
    expect(effectiveExecutionScope(['device'], ['device', 'server'])).toEqual(['device']);
    expect(effectiveExecutionScope(['server'], ['device', 'server'])).toEqual(['server']);
  });

  it('declaring a scope outside derived narrows away (but is invalid input — caught by validator)', () => {
    // effectiveExecutionScope is intersection-based; the validator is what
    // rejects too-wide declarations. If declared exceeds derived, the
    // intersection drops the invalid members rather than returning them.
    expect(effectiveExecutionScope(['device', 'server'], ['device'])).toEqual(['device']);
    expect(effectiveExecutionScope(['server'], ['device'])).toEqual([]);
  });

  it('result is canonical-sorted', () => {
    expect(effectiveExecutionScope(['server', 'device'], ['device', 'server'])).toEqual(['device', 'server']);
  });
});

// ────────────────────────────────────────────────────────────────
// executionScopeLabel — user-facing text
// ────────────────────────────────────────────────────────────────

describe('executionScopeLabel', () => {
  it('renders the canonical labels', () => {
    expect(executionScopeLabel(['device'])).toBe('Device only');
    expect(executionScopeLabel(['server'])).toBe('Server only');
    expect(executionScopeLabel(['device', 'server'])).toBe('Device + server');
  });

  it('orders both arrangements identically', () => {
    expect(executionScopeLabel(['server', 'device'])).toBe('Device + server');
  });

  it('renders empty as "Incompatible" so the install gate has a label', () => {
    expect(executionScopeLabel([])).toBe('Incompatible');
  });
});

// ────────────────────────────────────────────────────────────────
// Constants + error codes
// ────────────────────────────────────────────────────────────────

describe('ALL_EXECUTION_SCOPES', () => {
  it('lists both canonical members', () => {
    expect(ALL_EXECUTION_SCOPES).toEqual(['device', 'server']);
  });
});

describe('error codes', () => {
  it('EXECUTION_SCOPE_TOO_WIDE registered as fatal with a default message', () => {
    expect(ERR.EXECUTION_SCOPE_TOO_WIDE).toBe('fatal');
    expect(ERROR_MESSAGES.EXECUTION_SCOPE_TOO_WIDE).toMatch(/scope/i);
  });

  it('EXECUTION_SCOPE_INCOMPATIBLE registered as fatal with a default message', () => {
    expect(ERR.EXECUTION_SCOPE_INCOMPATIBLE).toBe('fatal');
    expect(ERROR_MESSAGES.EXECUTION_SCOPE_INCOMPATIBLE).toMatch(/(device|runtime)/i);
  });
});
