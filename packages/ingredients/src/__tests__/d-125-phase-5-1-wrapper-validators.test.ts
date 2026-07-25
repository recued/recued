/** D-125 Phase 5.1 — wrapper manifest semantics + per-kind validators.
 *
 *  Pins the contract `validateConnectionWrapper` enforces on
 *  `kind: 'connection'` third-party wrapper manifests:
 *
 *    1. `input.connection_kind` must name a known transport
 *       (`api | mcp | notification`).
 *    2. `input.connection` must carry a `{{config.<X>}}` interpolation
 *       (the picker config var is auto-derived from this field).
 *    3. Per-`connection_kind` required input keys per spec § 5.1
 *       (api → method+path; mcp → tool; notification → text).
 *
 *  Plus boundary tests:
 *    - Kernel `connection` ingredient (`author: 'recued'`) is exempt —
 *      its per-kind shape arrives flat on the recipe step input
 *      rather than the manifest, and its own `connection_kind` /
 *      `connection` are intentionally `null`.
 *    - The `kind: 'connection'` forbidden-pattern table no longer
 *      blocks `method` (api wrappers legitimately stamp it as a
 *      manifest default the recipe never overrides).
 *
 *  Skipped at install for kernel by `isKernelManifest`; never gates
 *  any current ingredient because P5.1 ships before P5.2's wrapper
 *  rollout. */

import { describe, it, expect } from 'vitest';
import {
  validateIngredient,
  PER_KIND_FORBIDDEN_PATTERNS,
  CONNECTION_PICKER_REGEX,
} from '../validate.js';
import type { IngredientManifest } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Sample wrapper manifests — one per connection_kind
// ────────────────────────────────────────────────────────────────

const apiWrapper: IngredientManifest = {
  slug: 'ticket-reader-hubspot',
  name: 'HubSpot Ticket Reader (connection wrapper)',
  description: 'Reads a single HubSpot ticket via a connection-bound credential.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['ticket', 'crm', 'hubspot'],
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'GET',
    path: '/crm/v3/objects/tickets/{{ticket_id}}',
    ticket_id: null,
  },
  output: {
    'id': 'ticket_id',
    'properties.subject': 'subject',
  },
};

const mcpWrapper: IngredientManifest = {
  slug: 'search-exa-via-connection',
  name: 'Exa MCP Search (connection wrapper)',
  description: 'Search Exa via a user-bound MCP connection.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['search', 'web', 'mcp'],
  input: {
    connection_kind: 'mcp',
    connection: '{{config.exa}}',
    tool: 'web_search_exa',
    query: null,
  },
  output: {
    'results': 'results',
  },
};

const notificationWrapper: IngredientManifest = {
  slug: 'slack-post-connection',
  name: 'Slack Post (connection wrapper)',
  description: 'Posts a message via a user-bound Slack connection.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  permission: 'notification_send',
  tags: ['notification', 'slack', 'messaging'],
  input: {
    connection_kind: 'notification',
    connection: '{{config.slack}}',
    text: null,
    title: null,
  },
  output: {
    'status': 'status',
  },
} as IngredientManifest;

const kernelConnection: IngredientManifest = {
  slug: 'connection',
  name: 'Connection (direct)',
  description: 'Direct adapter access for outbound api / mcp / notification calls keyed off enrolled connection records.',
  author: 'recued',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'admin',
  permission: 'connection.direct',
  tags: ['kernel', 'connection', 'advanced'],
  input: {
    connection_kind: null,
    connection: null,
    params: null,
  },
  output: {
    'result': 'result',
    'status': 'status',
    'headers': 'headers',
  },
} as IngredientManifest;

// ────────────────────────────────────────────────────────────────
// Known-good wrapper manifests
// ────────────────────────────────────────────────────────────────

describe('D-125 P5.1 — known-good wrappers pass', () => {
  it('api wrapper validates clean', () => {
    const result = validateIngredient(apiWrapper);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('mcp wrapper validates clean', () => {
    const result = validateIngredient(mcpWrapper);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('notification wrapper validates clean', () => {
    const result = validateIngredient(notificationWrapper);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('kernel connection ingredient validates clean (exempt from wrapper rules)', () => {
    const result = validateIngredient(kernelConnection);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_KIND_INVALID
// ────────────────────────────────────────────────────────────────

describe('D-125 P5.1 — CONNECTION_KIND_INVALID', () => {
  it('missing connection_kind emits CONNECTION_KIND_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input } };
    delete (m.input as Record<string, unknown>).connection_kind;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_INVALID');
    expect(issue, 'expected CONNECTION_KIND_INVALID').toBeDefined();
    expect(issue?.path).toBe('input.connection_kind');
    expect(result.valid).toBe(false);
  });

  it('null connection_kind emits CONNECTION_KIND_INVALID for wrappers', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection_kind: null } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_INVALID');
    expect(issue).toBeDefined();
  });

  it('unknown connection_kind value emits CONNECTION_KIND_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection_kind: 'webhook' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_INVALID');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('webhook');
  });

  it('valid connection_kind values pass (api / mcp / notification)', () => {
    for (const kind of ['api', 'mcp', 'notification'] as const) {
      const sample = kind === 'api'
        ? apiWrapper
        : kind === 'mcp'
          ? mcpWrapper
          : notificationWrapper;
      const result = validateIngredient(sample);
      const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_INVALID');
      expect(issue, `kind=${kind} should not emit CONNECTION_KIND_INVALID`).toBeUndefined();
    }
  });

  it('CONNECTION_KIND_MISSING_FIELD is suppressed when CONNECTION_KIND_INVALID fires', () => {
    const m = { ...apiWrapper, input: { connection_kind: 'webhook', connection: '{{config.x}}' } };
    const result = validateIngredient(m);
    expect(result.issues.find((i) => i.code === 'CONNECTION_KIND_INVALID')).toBeDefined();
    expect(result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_PICKER_INVALID
// ────────────────────────────────────────────────────────────────

describe('D-125 P5.1 — CONNECTION_PICKER_INVALID', () => {
  it('missing connection field emits CONNECTION_PICKER_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input } };
    delete (m.input as Record<string, unknown>).connection;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID');
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('input.connection');
  });

  it('null connection field emits CONNECTION_PICKER_INVALID for wrappers', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection: null } };
    const result = validateIngredient(m);
    expect(result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID')).toBeDefined();
  });

  it('hardcoded literal connection name emits CONNECTION_PICKER_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection: 'hubspot-prod' } };
    const result = validateIngredient(m);
    expect(result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID')).toBeDefined();
  });

  it('non-config interpolation (vault.X) emits CONNECTION_PICKER_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection: '{{vault.recued-core.hubspot}}' } };
    const result = validateIngredient(m);
    expect(result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID')).toBeDefined();
  });

  it('non-config interpolation (step.X) emits CONNECTION_PICKER_INVALID', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, connection: '{{step.input.conn}}' } };
    const result = validateIngredient(m);
    expect(result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID')).toBeDefined();
  });

  it('valid {{config.<X>}} picker passes', () => {
    const result = validateIngredient(apiWrapper);
    expect(result.issues.find((i) => i.code === 'CONNECTION_PICKER_INVALID')).toBeUndefined();
  });

  it('CONNECTION_PICKER_REGEX extracts the picker var name', () => {
    const match = '{{config.hubspot}}'.match(CONNECTION_PICKER_REGEX);
    expect(match?.[1]).toBe('hubspot');
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_KIND_MISSING_FIELD
// ────────────────────────────────────────────────────────────────

describe('D-125 P5.1 — CONNECTION_KIND_MISSING_FIELD', () => {
  it('api wrapper missing method emits CONNECTION_KIND_MISSING_FIELD', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input } };
    delete (m.input as Record<string, unknown>).method;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD' && i.path === 'input.method');
    expect(issue).toBeDefined();
  });

  it('api wrapper missing path emits CONNECTION_KIND_MISSING_FIELD', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input } };
    delete (m.input as Record<string, unknown>).path;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD' && i.path === 'input.path');
    expect(issue).toBeDefined();
  });

  it('api wrapper does not satisfy required path from input prototype', () => {
    const input = Object.assign(
      Object.create({ path: '/proto' }),
      { ...apiWrapper.input, path: undefined },
    ) as IngredientManifest['input'];
    delete (input as Record<string, unknown>).path;
    const result = validateIngredient({ ...apiWrapper, input });
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD' && i.path === 'input.path');
    expect(issue).toBeDefined();
  });

  it('api wrapper missing both method + path emits two CONNECTION_KIND_MISSING_FIELD', () => {
    const m = { ...apiWrapper, input: { connection_kind: 'api', connection: '{{config.hubspot}}' } };
    const result = validateIngredient(m);
    const issues = result.issues.filter((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD');
    const paths = new Set(issues.map((i) => i.path));
    expect(paths).toEqual(new Set(['input.method', 'input.path']));
  });

  it('mcp wrapper missing tool emits CONNECTION_KIND_MISSING_FIELD', () => {
    const m = { ...mcpWrapper, input: { ...mcpWrapper.input } };
    delete (m.input as Record<string, unknown>).tool;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD' && i.path === 'input.tool');
    expect(issue).toBeDefined();
  });

  it('notification wrapper missing text emits CONNECTION_KIND_MISSING_FIELD', () => {
    const m = { ...notificationWrapper, input: { ...notificationWrapper.input } };
    delete (m.input as Record<string, unknown>).text;
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'CONNECTION_KIND_MISSING_FIELD' && i.path === 'input.text');
    expect(issue).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Forbidden-pattern alignment with wrapper required fields
// ────────────────────────────────────────────────────────────────

describe('D-125 P5.1 — connection forbidden patterns no longer block method', () => {
  it("`method` is no longer forbidden on kind: 'connection' (api wrappers stamp it)", () => {
    expect(PER_KIND_FORBIDDEN_PATTERNS.connection.some((p) => p.source === '^method$')).toBe(false);
  });

  it('`url` stays forbidden — wrappers compose URLs via path + base_url', () => {
    expect(PER_KIND_FORBIDDEN_PATTERNS.connection.some((p) => p.source === '^url$')).toBe(true);
  });

  it('api wrapper with bare url still emits INGREDIENT_KIND_FIELD_FORBIDDEN', () => {
    const m = { ...apiWrapper, input: { ...apiWrapper.input, url: 'https://api.hubspot.com' } };
    const result = validateIngredient(m);
    const issue = result.issues.find(
      (i) => i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.url',
    );
    expect(issue).toBeDefined();
  });
});
