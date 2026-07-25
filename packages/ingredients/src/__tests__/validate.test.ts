import { describe, it, expect } from 'vitest';
import {
  validateIngredient,
  isValidIngredient,
  assertValidIngredient,
  PER_KIND_REQUIRED_INPUT,
  PER_KIND_FORBIDDEN_PATTERNS,
} from '../validate.js';
import { INGREDIENT_KINDS } from '@recued/contracts';
import type { IngredientManifest } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Sample known-good manifests (one per adapter flavor)
// ────────────────────────────────────────────────────────────────

const httpSample: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'HubSpot Deal Reader',
  description: 'Reads a single deal from HubSpot including key fields and properties.',
  author: 'recued-core',
  kind: 'http',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  supported_platforms: ['hubspot'],
  tags: ['deal', 'crm', 'hubspot'],
  input: {
    method: 'GET',
    url: '{{vault.recued-core.hubspot_base_url}}/crm/v3/objects/deals/{deal_id}',
    'header.authorization': 'Bearer {{vault.recued-core.hubspot_token}}',
    deal_id: null,
  },
  output: {
    'id': 'deal_id',
    'properties.dealname': 'deal_name',
    'properties.amount': 'amount',
  },
};

const domSample: IngredientManifest = {
  slug: 'draft-email-reader-hubspot',
  name: 'HubSpot Draft Email Reader',
  description: 'Reads the currently open draft email subject and body from the HubSpot UI.',
  author: 'recued-core',
  kind: 'dom',
  category: 'data',
  risk_tier: 'read',
  supported_platforms: ['hubspot'],
  tags: ['email', 'dom', 'hubspot'],
  input: {
    'dom.match': 'app.hubspot.com/contacts/*/email*',
  },
  output: {
    'app.hubspot.com/contacts/*/email*': 'trigger',
    "[data-test-id='email-subject']": 'subject',
    "[data-test-id='email-body']": 'body',
  },
};

const mcpSample: IngredientManifest = {
  slug: 'search-exa-mcp',
  name: 'Exa Web Search',
  description: 'Runs a web search via the Exa MCP server and returns summaries.',
  author: 'exa-labs',
  kind: 'mcp',
  category: 'data',
  risk_tier: 'read',
  tags: ['search', 'web', 'vendor'],
  input: {
    'mcp.tool': 'web_search_exa',
    'mcp.args.query': null,
    'header.x-api-key': '{{vault.exa-labs.api_key}}',
  },
  output: {
    'results': 'results',
  },
};

const aiSample: IngredientManifest = {
  slug: 'ai-score',
  name: 'AI Score',
  description: 'Scores data against criteria using the configured LLM.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  tags: ['ai', 'scoring', 'evaluation'],
  input: {
    'llm.data': null,
    'llm.criteria': null,
    'llm.scale': 'low|medium|high',
  },
  output: {
    'score': 'score',
    'breakdown': 'breakdown',
    'reasoning': 'reasoning',
  },
};

const localSample: IngredientManifest = {
  slug: 'local/my-private-search',
  name: 'Private Search',
  description: 'User-local search ingredient that calls an internal API.',
  author: 'me',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  tags: ['local', 'search', 'private'],
  input: {
    url: 'https://internal.example.com/search?q={q}',
    q: null,
  },
  output: {
    results: 'results',
  },
};

const catalogSample = (
  operationOverrides: Record<string, unknown> = {},
  manifestOverrides: Record<string, unknown> = {},
): IngredientManifest => ({
  slug: 'catalog-issues',
  name: 'Issues Catalog',
  description: 'Catalog-form connection ingredient for issue operations.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  supported_platforms: ['github'],
  tags: ['issues', 'catalog', 'github'],
  input: {
    operation: null,
    args: null,
  },
  output: {
    result: 'result',
  },
  operations: {
    create: {
      operation_id: 'issues.create',
      risk_tier: 'write',
      ...operationOverrides,
    },
  },
  ...manifestOverrides,
} as unknown as IngredientManifest);

// ────────────────────────────────────────────────────────────────
// Known-good cases
// ────────────────────────────────────────────────────────────────

describe('validateIngredient — known-good manifests', () => {
  it('HTTP ingredient passes with zero errors', () => {
    const result = validateIngredient(httpSample);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('DOM ingredient passes with zero errors', () => {
    const result = validateIngredient(domSample);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('MCP ingredient passes with zero errors', () => {
    const result = validateIngredient(mcpSample);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('AI ingredient passes with zero errors', () => {
    const result = validateIngredient(aiSample);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('local/ ingredient passes with zero errors', () => {
    const result = validateIngredient(localSample);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // D-125 P5.2 retired the `account_scoped` field + the `{{account.*}}`
  // resolver. The slack-post wrapper now declares `kind: 'connection'`
  // and resolves credentials via the per-pair Connection store.
  it('connection-kind slack-post wrapper passes with zero errors', () => {
    const slackWrapper: IngredientManifest = {
      slug: 'slack-post',
      name: 'Slack Post Message',
      description: "Posts a message to a Slack channel via an enrolled Slack connection.",
      author: 'recued-core',
      kind: 'connection',
      category: 'action',
      risk_tier: 'write',
      tags: ['slack', 'notify', 'channel-delivery'],
      input: {
        connection_kind: 'notification',
        connection: '{{config.slack}}',
        text: null,
      },
      output: {
        'result.ts': 'message_ts',
        'result.channel': 'channel',
      },
    };
    const result = validateIngredient(slackWrapper);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Top-level shape
// ────────────────────────────────────────────────────────────────

describe('top-level shape', () => {
  it('null → manifest_not_object', () => {
    const result = validateIngredient(null);
    expect(result.valid).toBe(false);
    expect(codesOf(result)).toContain('manifest_not_object');
  });

  it('array → manifest_not_object', () => {
    const result = validateIngredient([]);
    expect(codesOf(result)).toContain('manifest_not_object');
  });

  it('empty object → multiple required_* errors', () => {
    const result = validateIngredient({});
    const codes = codesOf(result);
    expect(codes).toEqual(expect.arrayContaining([
      'slug_required', 'name_required', 'description_required', 'author_required',
      'category_invalid', 'risk_tier_invalid', 'input_required', 'output_required',
    ]));
  });

  it('ignores required top-level fields inherited through the prototype chain', () => {
    const manifest = Object.create(httpSample) as IngredientManifest;

    const codes = codesOf(validateIngredient(manifest));

    expect(codes).toEqual(expect.arrayContaining([
      'slug_required',
      'name_required',
      'description_required',
      'author_required',
      'category_invalid',
      'risk_tier_invalid',
      'input_required',
      'output_required',
    ]));
  });
});

// ────────────────────────────────────────────────────────────────
// Slug format
// ────────────────────────────────────────────────────────────────

describe('slug format', () => {
  it('uppercase → slug_not_lowercase', () => {
    const m = { ...httpSample, slug: 'Deal-Reader-Hubspot' };
    expect(codesOf(validateIngredient(m))).toContain('slug_not_lowercase');
  });

  it('whitespace → slug_has_whitespace', () => {
    const m = { ...httpSample, slug: 'deal reader hubspot' };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('slug_has_whitespace');
  });

  it('invalid chars → slug_invalid_chars', () => {
    const m = { ...httpSample, slug: 'deal@reader!hubspot' };
    expect(codesOf(validateIngredient(m))).toContain('slug_invalid_chars');
  });

  it('slash outside local/ → slug_contains_slash', () => {
    const m = { ...httpSample, slug: 'recued/deal-reader' };
    expect(codesOf(validateIngredient(m))).toContain('slug_contains_slash');
  });

  it('nested local/ → slug_local_nested', () => {
    const m = { ...localSample, slug: 'local/sub/path' };
    expect(codesOf(validateIngredient(m))).toContain('slug_local_nested');
  });

  it('empty local/ → slug_local_empty', () => {
    const m = { ...localSample, slug: 'local/' };
    expect(codesOf(validateIngredient(m))).toContain('slug_local_empty');
  });
});

// ────────────────────────────────────────────────────────────────
// Enums
// ────────────────────────────────────────────────────────────────

describe('enums', () => {
  it('bad category → category_invalid', () => {
    const m = { ...httpSample, category: 'weird' as unknown as 'data' };
    expect(codesOf(validateIngredient(m))).toContain('category_invalid');
  });

  it('bad risk_tier → risk_tier_invalid', () => {
    const m = { ...httpSample, risk_tier: 'yolo' as unknown as 'read' };
    expect(codesOf(validateIngredient(m))).toContain('risk_tier_invalid');
  });
});

// ────────────────────────────────────────────────────────────────
// Target-scope attestation
// ────────────────────────────────────────────────────────────────

describe('target scope attestation', () => {
  it('url: null → target_scope_null', () => {
    const m = { ...httpSample, input: { ...httpSample.input, url: null } };
    expect(codesOf(validateIngredient(m))).toContain('target_scope_null');
  });

  it('mcp.tool: null → target_scope_null', () => {
    const m = { ...mcpSample, input: { ...mcpSample.input, 'mcp.tool': null } };
    expect(codesOf(validateIngredient(m))).toContain('target_scope_null');
  });

  it('dom.match: null → target_scope_null', () => {
    const m = { ...domSample, input: { ...domSample.input, 'dom.match': null } };
    expect(codesOf(validateIngredient(m))).toContain('target_scope_null');
  });

  it('llm.system_prompt is NOT attested — ai-prompt may set it null for recipe control', () => {
    // llm.system_prompt is deliberately excluded from TARGET_SCOPE so the
    // ai-prompt escape-hatch ingredient can let recipes supply custom
    // system prompts at call time. Contracted AI functions write their
    // own prompts in code via buildContractedPrompt and ignore whatever
    // the manifest declares for llm.system_prompt.
    const m = {
      ...aiSample,
      slug: 'ai-prompt',
      input: {
        'llm.system_prompt': null,
        'llm.prompt': null,
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).not.toContain('target_scope_null');
    expect(codes).not.toContain('target_scope_not_string');
  });

  it('HTTP ingredient with url: null → http_url_null + target_scope_null', () => {
    const m = { ...httpSample, input: { ...httpSample.input, url: null } };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('http_url_null');
    expect(codes).toContain('target_scope_null');
  });

  it('method: null → http_method_null', () => {
    const m = { ...httpSample, input: { ...httpSample.input, method: null } };
    expect(codesOf(validateIngredient(m))).toContain('http_method_null');
  });
});

// ────────────────────────────────────────────────────────────────
// Category consistency
// ────────────────────────────────────────────────────────────────

describe('category consistency', () => {
  it('ai- slug + category=data → slug_ai_category_mismatch', () => {
    const m = { ...aiSample, category: 'data' as const };
    expect(codesOf(validateIngredient(m))).toContain('slug_ai_category_mismatch');
  });

  it('ai category without llm.* keys → ai_no_llm_input', () => {
    const m = {
      ...aiSample,
      input: { data: null, criteria: null },
    };
    expect(codesOf(validateIngredient(m))).toContain('ai_no_llm_input');
  });

  it('data category without url/dom/mcp → executor_ambiguous', () => {
    const m = {
      ...httpSample,
      input: { deal_id: null },
    };
    expect(codesOf(validateIngredient(m))).toContain('executor_ambiguous');
  });

  it('DOM ingredient without trigger in output → dom_no_trigger', () => {
    const m = {
      ...domSample,
      output: {
        "[data-test-id='email-subject']": 'subject',
      },
    };
    expect(codesOf(validateIngredient(m))).toContain('dom_no_trigger');
  });

  it('DOM ingredient with multiple triggers → dom_multiple_triggers warn', () => {
    const m = {
      ...domSample,
      output: {
        'app.hubspot.com/a/*/email*': 'trigger',
        'app.hubspot.com/b/*/email*': 'trigger',
        "[data-test-id='email-subject']": 'subject',
      },
    };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('dom_multiple_triggers');
    expect(result.valid).toBe(true); // warn, not error
  });

  it('DOM write entries must have matching input field', () => {
    const m: IngredientManifest = {
      ...domSample,
      slug: 'email-writer-hubspot',
      category: 'action',
      risk_tier: 'write',
      input: {
        'dom.match': 'app.hubspot.com/contacts/*/email*',
        subject: null,
        // body intentionally missing
      },
      output: {
        'app.hubspot.com/contacts/*/email*': 'trigger',
        "[data-test-id='subj']": 'dom.subject',  // OK — subject in input
        "[data-test-id='body']": 'dom.body',     // BAD — body not in input
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('dom_write_field_not_in_input');
  });

  it('DOM write with wrong category → dom_write_wrong_category', () => {
    const m: IngredientManifest = {
      ...domSample,
      category: 'data',  // wrong — should be 'action'
      risk_tier: 'read',
      input: { 'dom.match': 'x.com/*', subject: null },
      output: {
        'x.com/*': 'trigger',
        "[name='s']": 'dom.subject',
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('dom_write_wrong_category');
  });

  it('DOM write with read risk_tier → dom_write_wrong_risk_tier', () => {
    const m: IngredientManifest = {
      ...domSample,
      category: 'action',
      risk_tier: 'read',  // wrong — should be write/admin/destructive
      input: { 'dom.match': 'x.com/*', subject: null },
      output: {
        'x.com/*': 'trigger',
        "[name='s']": 'dom.subject',
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('dom_write_wrong_risk_tier');
  });

  it('DOM write with empty field name after dom. → dom_write_field_empty', () => {
    const m: IngredientManifest = {
      ...domSample,
      category: 'action',
      risk_tier: 'write',
      input: { 'dom.match': 'x.com/*', subject: null },
      output: {
        'x.com/*': 'trigger',
        "[name='s']": 'dom.',  // empty field name after prefix
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).toContain('dom_write_field_empty');
  });

  it('DOM write with all fields matched and action category → clean', () => {
    const m: IngredientManifest = {
      ...domSample,
      slug: 'email-writer-hubspot',
      name: 'HubSpot Email Writer',
      description: 'Writes into the HubSpot email composer at call time.',
      category: 'action',
      risk_tier: 'write',
      tags: ['email', 'dom', 'hubspot'],
      input: {
        'dom.match': 'app.hubspot.com/contacts/*/email*',
        subject: null,
        body: null,
      },
      output: {
        'app.hubspot.com/contacts/*/email*': 'trigger',
        "[data-test-id='email-subject']": 'dom.subject',
        "[data-test-id='email-body']": 'dom.body',
      },
    };
    const result = validateIngredient(m);
    const relevantErrors = result.issues.filter(i =>
      i.severity === 'error' && i.code.startsWith('dom_'),
    );
    expect(relevantErrors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('read-only DOM ingredient still works (no write entries)', () => {
    const result = validateIngredient(domSample);
    expect(result.valid).toBe(true);
    const writeErrors = codesOf(result).filter((c) => c.startsWith('dom_write_'));
    expect(writeErrors).toEqual([]);
  });

  it('destructive tier passes without any manifest-level confirmation text', () => {
    // risk_tier alone is enough — the approval UI composes the confirmation
    // prompt at call time from the live ingredient name + input values.
    const m = { ...httpSample, risk_tier: 'destructive' as const };
    const result = validateIngredient(m);
    expect(result.valid).toBe(true);
    // Sanity: no confirmation_prompt-related code is emitted
    for (const code of codesOf(result)) {
      expect(code).not.toContain('confirmation_prompt');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Recipe-namespace leak
// ────────────────────────────────────────────────────────────────

describe('recipe namespace leak', () => {
  it('{{config.X}} in input → recipe_namespace_ref', () => {
    const m = {
      ...httpSample,
      input: { ...httpSample.input, 'query.limit': '{{config.limit}}' },
    };
    expect(codesOf(validateIngredient(m))).toContain('recipe_namespace_ref');
  });

  it('{{step.X}} in input → recipe_namespace_ref', () => {
    const m = {
      ...httpSample,
      input: { ...httpSample.input, 'query.id': '{{step.deal.id}}' },
    };
    expect(codesOf(validateIngredient(m))).toContain('recipe_namespace_ref');
  });

  it('{{context.X}} in input → recipe_namespace_ref', () => {
    const m = {
      ...httpSample,
      input: { ...httpSample.input, 'query.user': '{{context.user_id}}' },
    };
    expect(codesOf(validateIngredient(m))).toContain('recipe_namespace_ref');
  });

  it('{{meta.X}} in input → recipe_namespace_ref', () => {
    const m = {
      ...httpSample,
      input: { ...httpSample.input, 'query.recipe': '{{meta.recipe_id}}' },
    };
    expect(codesOf(validateIngredient(m))).toContain('recipe_namespace_ref');
  });

  it('{{vault.X}} in input → allowed', () => {
    const m = {
      ...httpSample,
      input: {
        ...httpSample.input,
        'header.x-api-key': '{{vault.recued-core.api_key}}',
      },
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).not.toContain('recipe_namespace_ref');
  });
});

// ────────────────────────────────────────────────────────────────
// Vault scoping
// ────────────────────────────────────────────────────────────────

describe('vault scoping', () => {
  it('cross-publisher vault ref → vault_scope_cross_publisher', () => {
    const m = {
      ...httpSample,
      input: {
        ...httpSample.input,
        'header.authorization': 'Bearer {{vault.other-author.token}}',
      },
    };
    expect(codesOf(validateIngredient(m))).toContain('vault_scope_cross_publisher');
  });

  it('matching publisher vault ref → allowed', () => {
    const m = {
      ...httpSample,
      input: {
        ...httpSample.input,
        'header.authorization': 'Bearer {{vault.recued-core.token}}',
      },
    };
    expect(codesOf(validateIngredient(m))).not.toContain('vault_scope_cross_publisher');
  });

  it('local ingredient with local vault ref → allowed', () => {
    const m = {
      ...localSample,
      input: {
        ...localSample.input,
        'header.authorization': 'Bearer {{vault.local.private_token}}',
      },
    };
    expect(codesOf(validateIngredient(m))).not.toContain('vault_scope_cross_publisher');
  });

  it('local ingredient with non-local vault ref → vault_scope_cross_publisher', () => {
    const m = {
      ...localSample,
      input: {
        ...localSample.input,
        'header.authorization': 'Bearer {{vault.recued-core.token}}',
      },
    };
    expect(codesOf(validateIngredient(m))).toContain('vault_scope_cross_publisher');
  });
});

// ────────────────────────────────────────────────────────────────
// Versions
// ────────────────────────────────────────────────────────────────

describe('versions', () => {
  it('version 0 → version_invalid', () => {
    const m = { ...httpSample, version: 0 };
    expect(codesOf(validateIngredient(m))).toContain('version_invalid');
  });

  it('version as string → version_invalid', () => {
    const m = { ...httpSample, version: '1' as unknown as number };
    expect(codesOf(validateIngredient(m))).toContain('version_invalid');
  });

  it('min_version > version → min_version_gt_version', () => {
    const m = { ...httpSample, version: 2, min_version: 3 };
    expect(codesOf(validateIngredient(m))).toContain('min_version_gt_version');
  });

  it('min_version == version → allowed', () => {
    const m = { ...httpSample, version: 3, min_version: 3 };
    expect(codesOf(validateIngredient(m))).not.toContain('min_version_gt_version');
  });

  it('service manifest with string version → version_invalid (now uniform integer)', () => {
    const m = {
      slug: 'svc',
      kind: 'service',
      author: 'recued-core',
      name: 'Svc',
      description: 'test service',
      category: 'data',
      risk_tier: 'read',
      version: '1.0.0',
      input: { service: { platform: 'macos' } },
      output: {},
    };
    expect(codesOf(validateIngredient(m))).toContain('version_invalid');
  });

  it('service manifest with valid integer version + string binary_version → no version_invalid', () => {
    const m = {
      slug: 'svc',
      kind: 'service',
      author: 'recued-core',
      name: 'Svc',
      description: 'test service',
      category: 'data',
      risk_tier: 'read',
      version: 1,
      input: { service: { platform: 'macos', binary_version: '1.2.3' } },
      output: {},
    };
    const codes = codesOf(validateIngredient(m));
    expect(codes).not.toContain('version_invalid');
    expect(codes).not.toContain('binary_version_invalid');
  });

  it('service manifest with empty binary_version → binary_version_invalid', () => {
    const m = {
      slug: 'svc',
      kind: 'service',
      author: 'recued-core',
      name: 'Svc',
      description: 'test service',
      category: 'data',
      risk_tier: 'read',
      version: 1,
      input: { service: { platform: 'macos', binary_version: '' } },
      output: {},
    };
    expect(codesOf(validateIngredient(m))).toContain('binary_version_invalid');
  });

  it('service manifest with non-string binary_version → binary_version_invalid', () => {
    const m = {
      slug: 'svc',
      kind: 'service',
      author: 'recued-core',
      name: 'Svc',
      description: 'test service',
      category: 'data',
      risk_tier: 'read',
      version: 1,
      input: { service: { platform: 'macos', binary_version: 1.2 } },
      output: {},
    };
    expect(codesOf(validateIngredient(m))).toContain('binary_version_invalid');
  });
});

// ────────────────────────────────────────────────────────────────
// Tags + metadata
// ────────────────────────────────────────────────────────────────

describe('metadata', () => {
  it('missing tags → warn tags_missing', () => {
    const { tags, ...rest } = httpSample;
    void tags;
    const result = validateIngredient(rest);
    expect(codesOf(result)).toContain('tags_missing');
    expect(result.valid).toBe(true);
  });

  it('thin tags (2) → info tags_thin', () => {
    const m = { ...httpSample, tags: ['crm', 'hubspot'] };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('tags_thin');
    expect(result.valid).toBe(true);
  });

  it('tags not an array → tags_shape', () => {
    const m = { ...httpSample, tags: 'crm,hubspot' as unknown as string[] };
    expect(codesOf(validateIngredient(m))).toContain('tags_shape');
  });

  it('author placeholder → warn', () => {
    // Use a manifest with no vault refs so the only signal is the placeholder
    const m: IngredientManifest = {
      slug: 'simple-reader-hubspot',
      name: 'Simple Reader',
      description: 'A simple reader that demonstrates the structure.',
      author: 'TODO',
      kind: 'http',
      category: 'data',
      risk_tier: 'read',
      tags: ['simple', 'reader', 'hubspot'],
      input: { url: 'https://api.example.com/simple', id: null },
      output: { 'response.id': 'id' },
    };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('author_placeholder');
    expect(result.valid).toBe(true);
  });

  it('short description → description_thin info', () => {
    const m = { ...httpSample, description: 'Read deals.' };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('description_thin');
    expect(result.valid).toBe(true);
  });

  it('rejects manifests carrying a `kernel` field (true)', () => {
    const m = { ...httpSample, kernel: true } as unknown;
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('kernel_field_disallowed');
    expect(result.valid).toBe(false);
  });

  it('rejects manifests carrying a `kernel` field (false)', () => {
    // Even falsy is rejected — the field has no place in the schema.
    const m = { ...httpSample, kernel: false } as unknown;
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('kernel_field_disallowed');
  });

  it('rejects `kernel` even when author is the reserved kernel handle', () => {
    // Kernel routing keys off `author === recued`. A `kernel` field is
    // meaningless noise for kernel manifests too — reject it everywhere.
    const m = { ...httpSample, author: 'recued', kernel: true } as unknown;
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('kernel_field_disallowed');
  });

  it('manifest without `kernel` field passes (sanity)', () => {
    const result = validateIngredient(httpSample);
    expect(codesOf(result)).not.toContain('kernel_field_disallowed');
  });
});

// ────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────

describe('output', () => {
  it('empty output → output_empty', () => {
    const m = { ...httpSample, output: {} };
    expect(codesOf(validateIngredient(m))).toContain('output_empty');
  });

  it('output value not a string → output_value_not_string', () => {
    const m = { ...httpSample, output: { id: 42 as unknown as string } };
    expect(codesOf(validateIngredient(m))).toContain('output_value_not_string');
  });

  it('output field name empty → output_field_empty', () => {
    const m = { ...httpSample, output: { id: '' } };
    expect(codesOf(validateIngredient(m))).toContain('output_field_empty');
  });
});

// ────────────────────────────────────────────────────────────────
// Fallback
// ────────────────────────────────────────────────────────────────

describe('fallback', () => {
  it('fallback not an object → fallback_shape', () => {
    const m = { ...httpSample, fallback: ['x'] as unknown as Record<string, string> };
    expect(codesOf(validateIngredient(m))).toContain('fallback_shape');
  });

  it('fallback orphan field → warn fallback_orphan', () => {
    const m = {
      ...httpSample,
      fallback: { 'properties.dealname_legacy': 'not_in_output' },
    };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('fallback_orphan');
    expect(result.valid).toBe(true);
  });

  it('fallback with matching field → clean', () => {
    const m = {
      ...httpSample,
      fallback: { 'properties.name': 'deal_name' },
    };
    expect(codesOf(validateIngredient(m))).not.toContain('fallback_orphan');
  });
});

// ────────────────────────────────────────────────────────────────
// D-177 P1b hash_exclude_args
// ────────────────────────────────────────────────────────────────

describe('D-177 P1b hash_exclude_args validation', () => {
  it('accepts manifest-level volatile exclusions on simple-form manifests', () => {
    const result = validateIngredient({
      ...httpSample,
      hash_exclude_args: ['client_ts', 'body.trace_id'],
    });

    expect(codesOf(result)).not.toContain('HASH_EXCLUDE_INVALID');
    expect(result.valid).toBe(true);
  });

  it('rejects manifest-level authority-bearing exclusions on simple-form manifests', () => {
    for (const path of ['mcp.tool', 'dom.match', 'url', 'method', 'connection']) {
      const result = validateIngredient({
        ...httpSample,
        hash_exclude_args: [path],
      });
      const issue = result.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID');

      expect(issue, `expected HASH_EXCLUDE_INVALID for ${path}`).toBeDefined();
      expect(issue?.message).toContain(path);
      expect(issue?.message).toContain('authority_bearing');
    }
  });

  it('rejects non-array manifest-level hash_exclude_args', () => {
    const result = validateIngredient({
      ...httpSample,
      hash_exclude_args: 'client_ts' as unknown as string[],
    });

    expect(codesOf(result)).toContain('HASH_EXCLUDE_INVALID');
  });

  it('rejects manifest-level hash_exclude_args on catalog-form manifests', () => {
    const result = validateIngredient(catalogSample({}, {
      hash_exclude_args: ['client_ts'],
    }));

    expect(codesOf(result)).toContain('HASH_EXCLUDE_MISPLACED');
    expect(result.issues.find((i) => i.code === 'HASH_EXCLUDE_MISPLACED')?.path)
      .toBe('hash_exclude_args');
  });

  it('rejects per-op exclusions that target a path_scope template token', () => {
    const result = validateIngredient(catalogSample({
      path_scope: { target_path_template: '{bucket}/x' },
      hash_exclude_args: ['bucket'],
    }));
    const issue = result.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID');

    expect(issue).toBeDefined();
    expect(issue?.path).toBe('operations.create.hash_exclude_args');
    expect(issue?.message).toContain('bucket');
    expect(issue?.message).toContain('authority_bearing');
  });

  it('rejects target-affecting editable args but allows non-target editable args', () => {
    const editableArgs = [
      { key: 'target_id', affects_target: true },
      { key: 'note' },
    ];
    const rejected = validateIngredient(catalogSample({
      editable_args: editableArgs,
      hash_exclude_args: ['target_id'],
    }));
    const allowed = validateIngredient(catalogSample({
      editable_args: editableArgs,
      hash_exclude_args: ['note'],
    }));

    expect(rejected.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID')?.message)
      .toContain('authority_bearing');
    expect(codesOf(allowed)).not.toContain('HASH_EXCLUDE_INVALID');
  });

  it('rejects an UNDECLARED destination-name exclusion (D-177 N.2 backstop)', () => {
    // `to` is not a wire target, not a path_scope token, not affects_target,
    // and not in authority_args — the old gate would have allowed excluding it,
    // dropping the recipient out of the grant hash. The backstop rejects it.
    const rejected = validateIngredient(catalogSample({
      hash_exclude_args: ['to'],
    }));
    const issue = rejected.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID');
    expect(issue, 'undeclared `to` exclusion must be rejected').toBeDefined();
    expect(issue?.message).toContain("'to'");
    expect(issue?.message).toContain('recipient');

    // a nested undeclared recipient (matched on the leaf) is rejected too.
    expect(codesOf(validateIngredient(catalogSample({
      hash_exclude_args: ['body.recipient'],
    })))).toContain('HASH_EXCLUDE_INVALID');

    // a genuinely-volatile token still validates (no over-restriction).
    expect(codesOf(validateIngredient(catalogSample({
      hash_exclude_args: ['client_ts', 'trace_id'],
    })))).not.toContain('HASH_EXCLUDE_INVALID');
  });

  it('rejects excluding a path-template target id even with no path_scope (D-177 N.2)', () => {
    // The live HubSpot/SF shape: the target-record id rides the api binding's
    // `path_template` ({{record_id}}), and the op declares NO path_scope /
    // authority_args. Excluding it would de-pin the target record.
    const rejected = validateIngredient(catalogSample(
      { hash_exclude_args: ['record_id'] },
      {
        surfaces: {
          api: {
            executes: {
              create: {
                kind: 'rest',
                method: 'PATCH',
                path_template: '/v3/objects/things/{{record_id}}',
              },
            },
          },
        },
      },
    ));
    const issue = rejected.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID');
    expect(issue, 'undeclared path-param id exclusion must be rejected').toBeDefined();
    expect(issue?.message).toContain('record_id');

    // a volatile token that is NOT a path param still validates.
    expect(codesOf(validateIngredient(catalogSample(
      { hash_exclude_args: ['client_ts'] },
      {
        surfaces: {
          api: {
            executes: {
              create: { kind: 'rest', method: 'PATCH', path_template: '/v3/objects/things/{{record_id}}' },
            },
          },
        },
      },
    )))).not.toContain('HASH_EXCLUDE_INVALID');
  });

  it('rejects array traversal and reserved prototype segments per operation', () => {
    const arrayTraversal = validateIngredient(catalogSample({
      hash_exclude_args: ['items.0'],
    }));
    const reservedSegment = validateIngredient(catalogSample({
      hash_exclude_args: ['__proto__'],
    }));

    expect(arrayTraversal.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID')?.message)
      .toContain('array_traversal');
    expect(reservedSegment.issues.find((i) => i.code === 'HASH_EXCLUDE_INVALID')?.message)
      .toContain('reserved_segment');
  });
});

// ────────────────────────────────────────────────────────────────
// fork_of
// ────────────────────────────────────────────────────────────────

describe('fork_of', () => {
  it('not an object → fork_of_shape', () => {
    const m = { ...httpSample, fork_of: 'some-slug' as unknown as IngredientManifest['fork_of'] };
    expect(codesOf(validateIngredient(m))).toContain('fork_of_shape');
  });

  it('missing version → fork_of_version', () => {
    const m = {
      ...httpSample,
      fork_of: { slug: 'x', author: 'y' } as IngredientManifest['fork_of'],
    };
    expect(codesOf(validateIngredient(m))).toContain('fork_of_version');
  });

  it('complete fork_of → clean', () => {
    const m = {
      ...httpSample,
      fork_of: { slug: 'original', author: 'other', version: 2 },
    };
    const result = validateIngredient(m);
    const forkCodes = codesOf(result).filter((c) => c.startsWith('fork_of_'));
    expect(forkCodes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Timeout defaults
// ────────────────────────────────────────────────────────────────

describe('timeout_ms validation', () => {
  it('HTTP manifest with no timeout_ms → clean', () => {
    const result = validateIngredient(httpSample);
    expect(codesOf(result)).not.toContain('timeout_not_number');
    expect(codesOf(result)).not.toContain('timeout_too_high');
  });

  it('HTTP manifest with timeout_ms as string → timeout_not_number', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: '30000' } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_not_number');
  });

  it('HTTP manifest with timeout_ms as NaN → timeout_not_number', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: NaN } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_not_number');
  });

  it('HTTP manifest with timeout_ms = 0 → timeout_too_low', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: 0 } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_too_low');
  });

  it('HTTP manifest with timeout_ms = 50 → timeout_too_low', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: 50 } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_too_low');
  });

  it('HTTP manifest with timeout_ms = 200000 → timeout_too_high', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: 200_000 } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_too_high');
  });

  it('HTTP manifest with timeout_ms = 75000 → warn timeout_above_soft_ceiling', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: 75_000 } };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('timeout_above_soft_ceiling');
    expect(result.valid).toBe(true); // warn does not block
  });

  it('HTTP manifest with timeout_ms = 15000 → clean (in range)', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: 15_000 } };
    const codes = codesOf(validateIngredient(m));
    expect(codes.filter((c) => c.startsWith('timeout_'))).toEqual([]);
  });

  it('null timeout_ms (recipe-supplied) is allowed', () => {
    const m = { ...httpSample, input: { ...httpSample.input, timeout_ms: null } };
    const codes = codesOf(validateIngredient(m));
    expect(codes.filter((c) => c.startsWith('timeout_'))).toEqual([]);
  });

  it('MCP manifest validates mcp.timeout_ms independently', () => {
    const m = { ...mcpSample, input: { ...mcpSample.input, 'mcp.timeout_ms': 300_000 } };
    expect(codesOf(validateIngredient(m))).toContain('timeout_too_high');
  });

  it('MCP manifest with mcp.timeout_ms = 45000 → clean', () => {
    const m = { ...mcpSample, input: { ...mcpSample.input, 'mcp.timeout_ms': 45_000 } };
    const codes = codesOf(validateIngredient(m));
    expect(codes.filter((c) => c.startsWith('timeout_'))).toEqual([]);
  });

  it('MCP manifest with mcp.timeout_ms = 80000 → warn above soft ceiling', () => {
    const m = { ...mcpSample, input: { ...mcpSample.input, 'mcp.timeout_ms': 80_000 } };
    const result = validateIngredient(m);
    expect(codesOf(result)).toContain('timeout_above_soft_ceiling');
    expect(result.valid).toBe(true);
  });

  it('ignores timeout defaults inherited through input prototype', () => {
    const input = Object.assign(
      Object.create({ timeout_ms: 0 }),
      httpSample.input,
    ) as IngredientManifest['input'];
    const m = { ...httpSample, input };

    const codes = codesOf(validateIngredient(m));

    expect(codes).not.toContain('timeout_too_low');
  });
});

// ────────────────────────────────────────────────────────────────
// Convenience wrappers
// ────────────────────────────────────────────────────────────────

describe('isValidIngredient', () => {
  it('returns true for valid manifest', () => {
    expect(isValidIngredient(httpSample)).toBe(true);
  });

  it('returns false for invalid manifest', () => {
    expect(isValidIngredient({ slug: 'x' })).toBe(false);
  });
});

describe('assertValidIngredient', () => {
  it('returns manifest on success', () => {
    const result = assertValidIngredient(httpSample);
    expect(result).toBe(httpSample);
  });

  it('throws on failure', () => {
    expect(() => assertValidIngredient({ slug: 'Bad Slug' })).toThrow(/validation failed/);
  });

  it('error message includes the first code + path', () => {
    try {
      assertValidIngredient({ slug: 'x', input: {}, output: {} });
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/\[[a-z_]+\]/);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// D-126 P4.1 — per-kind input shape validators
// ────────────────────────────────────────────────────────────────

describe('D-126 P4.1 — per-kind tables', () => {
  it('PER_KIND_REQUIRED_INPUT covers every IngredientKind', () => {
    const keys = new Set(Object.keys(PER_KIND_REQUIRED_INPUT));
    for (const kind of INGREDIENT_KINDS) {
      expect(keys.has(kind), `PER_KIND_REQUIRED_INPUT missing '${kind}'`).toBe(true);
    }
    expect(keys.size).toBe(INGREDIENT_KINDS.size);
  });

  it('PER_KIND_FORBIDDEN_PATTERNS covers every IngredientKind', () => {
    const keys = new Set(Object.keys(PER_KIND_FORBIDDEN_PATTERNS));
    for (const kind of INGREDIENT_KINDS) {
      expect(keys.has(kind), `PER_KIND_FORBIDDEN_PATTERNS missing '${kind}'`).toBe(true);
    }
    expect(keys.size).toBe(INGREDIENT_KINDS.size);
  });
});

describe('D-126 P4.1 — INGREDIENT_KIND_MISSING_FIELD', () => {
  it('http manifest missing url emits INGREDIENT_KIND_MISSING_FIELD', () => {
    const m = { ...httpSample, input: { method: 'GET', deal_id: null } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_MISSING_FIELD');
    expect(issue, 'expected INGREDIENT_KIND_MISSING_FIELD').toBeDefined();
    expect(issue?.path).toBe('input.url');
    expect(result.valid).toBe(false);
  });

  it('http manifest does not satisfy required url from input prototype', () => {
    const input = Object.assign(
      Object.create({ url: 'https://api.example.com/proto' }),
      { method: 'GET', deal_id: null },
    ) as IngredientManifest['input'];
    const result = validateIngredient({ ...httpSample, input });

    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_MISSING_FIELD');

    expect(issue, 'expected INGREDIENT_KIND_MISSING_FIELD').toBeDefined();
    expect(issue?.path).toBe('input.url');
  });

  it('chat manifest missing chat.prompt emits INGREDIENT_KIND_MISSING_FIELD', () => {
    const chatSample: IngredientManifest = {
      slug: 'web-chat-mock',
      name: 'Mock chat',
      description: 'Stand-in chat manifest used to exercise kind:chat shape rules.',
      author: 'recued-core',
      kind: 'chat',
      version: 1,
      category: 'ai',
      risk_tier: 'read',
      tags: ['chat', 'mock', 'test'],
      input: {},
      output: { response: 'response' },
    };
    const result = validateIngredient(chatSample);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_MISSING_FIELD');
    expect(issue, 'expected INGREDIENT_KIND_MISSING_FIELD').toBeDefined();
    expect(issue?.path).toBe('input.chat.prompt');
  });

  it('mcp manifest missing mcp.tool emits INGREDIENT_KIND_MISSING_FIELD', () => {
    const m = { ...mcpSample, input: { 'mcp.args.query': null, 'header.x-api-key': '{{vault.exa-labs.api_key}}' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_MISSING_FIELD');
    expect(issue, 'expected INGREDIENT_KIND_MISSING_FIELD').toBeDefined();
    expect(issue?.path).toBe('input.mcp.tool');
  });

  it('kinds with empty required list never emit MISSING_FIELD (dom / ai / service / storage / connection)', () => {
    const result = validateIngredient(domSample);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_MISSING_FIELD')).toBe(false);
  });
});

describe('D-126 P4.1 — INGREDIENT_KIND_FIELD_FORBIDDEN', () => {
  it("kind:'http' with chat.tab in input is forbidden", () => {
    const m = { ...httpSample, input: { ...httpSample.input, 'chat.tab': 'gemini' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.chat.tab'
    );
    expect(issue, 'expected forbidden chat.tab on http').toBeDefined();
  });

  it("kind:'http' with mcp.server_url in input is forbidden", () => {
    const m = { ...httpSample, input: { ...httpSample.input, 'mcp.server_url': 'https://x' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.mcp.server_url'
    );
    expect(issue).toBeDefined();
  });

  it("kind:'dom' with bare url is forbidden", () => {
    const m = { ...domSample, input: { ...domSample.input, url: 'https://x' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.url'
    );
    expect(issue).toBeDefined();
  });

  it("kind:'ai' with chat.tab specifically (not all chat.*) is forbidden", () => {
    const m = { ...aiSample, input: { ...aiSample.input, 'chat.tab': 'gemini' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.chat.tab'
    );
    expect(issue).toBeDefined();
  });

  it("kind:'ai' with chat.prompt (not chat.tab) is allowed", () => {
    // ai's forbidden pattern is /^chat\.tab$/, not /^chat\./, so chat.prompt
    // wouldn't match — confirm by checking no FIELD_FORBIDDEN fires.
    const m = { ...aiSample, input: { ...aiSample.input, 'chat.prompt': 'hi' } };
    const result = validateIngredient(m);
    const forbidden = result.issues.filter((i) => i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN');
    expect(forbidden).toEqual([]);
  });

  it("kind:'chat' with method/url is forbidden", () => {
    const chatSample: IngredientManifest = {
      slug: 'web-chat-mock',
      name: 'Mock chat',
      description: 'Stand-in chat manifest used to exercise kind:chat shape rules.',
      author: 'recued-core',
      kind: 'chat',
      version: 1,
      category: 'ai',
      risk_tier: 'read',
      tags: ['chat', 'mock', 'test'],
      input: { 'chat.prompt': null, url: 'https://x', method: 'POST' },
      output: { response: 'response' },
    };
    const result = validateIngredient(chatSample);
    const codes = result.issues
      .filter((i) => i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN')
      .map((i) => i.path);
    expect(codes).toContain('input.url');
    expect(codes).toContain('input.method');
  });

  it("kind:'mcp' with chat.* is forbidden", () => {
    const m = { ...mcpSample, input: { ...mcpSample.input, 'chat.prompt': 'hi' } };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.chat.prompt'
    );
    expect(issue).toBeDefined();
  });

  it("kind:'storage' with mcp.* is forbidden", () => {
    const storageSample: IngredientManifest = {
      slug: 'shared-mock',
      name: 'Mock storage',
      description: 'Stand-in storage manifest used to exercise kind:storage shape rules.',
      author: 'recued-core',
      kind: 'storage',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      tags: ['storage', 'mock', 'test'],
      input: { key: null, 'mcp.tool': 'x' },
      output: { value: 'value' },
    };
    const result = validateIngredient(storageSample);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.mcp.tool'
    );
    expect(issue).toBeDefined();
  });

  it("kind:'service' (D-118 template) with chat.* is forbidden", () => {
    const serviceSample = {
      slug: 'mock-service-macos',
      name: 'Mock service',
      description: 'Stand-in service template used to exercise kind:service shape rules.',
      author: 'recued-core',
      kind: 'service' as const,
      version: 1,
      category: 'data',
      risk_tier: 'write',
      tags: ['service', 'mock', 'test'],
      input: {
        service: { platform: 'macos', variant_group: 'mock' },
        'chat.prompt': 'should not be here',
      },
      output: {},
    };
    const result = validateIngredient(serviceSample);
    const issue = result.issues.find((i) =>
      i.code === 'INGREDIENT_KIND_FIELD_FORBIDDEN' && i.path === 'input.chat.prompt'
    );
    expect(issue).toBeDefined();
  });
});

describe('D-126 P4.1 — kernel exemption', () => {
  it('kernel manifest skips required + forbidden checks regardless of kind shape', () => {
    // http-watcher uses `target_url` not `url`; would fail kind:'http'
    // required-input check if the kernel exemption weren't honored.
    const httpWatcher: IngredientManifest = {
      slug: 'http-watcher-mock',
      name: 'Mock kernel watcher',
      description: 'Stand-in kernel watcher to exercise the kernel-author exemption.',
      author: 'recued',
      kind: 'http',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      tags: ['kernel', 'watcher', 'http'],
      input: { target_url: null },
      output: { etag: 'etag', body: 'body' },
    };
    const result = validateIngredient(httpWatcher);
    const codes = result.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.code);
    expect(codes).not.toContain('INGREDIENT_KIND_MISSING_FIELD');
    expect(codes).not.toContain('INGREDIENT_KIND_FIELD_FORBIDDEN');
  });
});

describe('D-126 P4.1 — known-good catalog still validates', () => {
  it('aiSample (no llm.prompt — relies on contracted fields) passes', () => {
    expect(isValidIngredient(aiSample)).toBe(true);
  });

  it('domSample passes', () => {
    expect(isValidIngredient(domSample)).toBe(true);
  });

  it('mcpSample (with mcp.tool) passes', () => {
    expect(isValidIngredient(mcpSample)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// D-126 P4.2 — risk_tier × kind gate
// ────────────────────────────────────────────────────────────────

describe('D-126 P4.2 — INGREDIENT_KIND_TIER_MISMATCH', () => {
  it("kind:'ai' with risk_tier:'destructive' is forbidden", () => {
    const m = { ...aiSample, risk_tier: 'destructive' as const };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH');
    expect(issue, 'expected INGREDIENT_KIND_TIER_MISMATCH').toBeDefined();
    expect(issue?.path).toBe('risk_tier');
    expect(issue?.message).toMatch(/ai/);
    expect(result.valid).toBe(false);
  });

  it("kind:'ai' with risk_tier:'write' is forbidden (ai is read-only)", () => {
    const m = { ...aiSample, risk_tier: 'write' as const };
    const result = validateIngredient(m);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(true);
  });

  it("kind:'chat' with risk_tier:'admin' is forbidden", () => {
    // chat allows read+write (web-chat tab is DOM-driven) but not admin/destructive.
    const chatSample: IngredientManifest = {
      slug: 'web-chat-mock',
      name: 'Mock chat',
      description: 'Stand-in chat manifest used to exercise kind:chat tier rules.',
      author: 'recued-core',
      kind: 'chat',
      version: 1,
      category: 'action',
      risk_tier: 'admin',
      tags: ['chat', 'mock', 'test'],
      input: { 'chat.prompt': null },
      output: { response: 'response' },
    };
    const result = validateIngredient(chatSample);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(true);
  });

  it("kind:'storage' with risk_tier:'admin' is forbidden", () => {
    // storage allows read+write+destructive (warehouse delete ops) but no admin.
    const storageSample: IngredientManifest = {
      slug: 'shared-mock',
      name: 'Mock storage',
      description: 'Stand-in storage manifest used to exercise kind:storage tier rules.',
      author: 'recued-core',
      kind: 'storage',
      version: 1,
      category: 'data',
      risk_tier: 'admin',
      tags: ['storage', 'mock', 'test'],
      input: { key: null },
      output: { value: 'value' },
    };
    const result = validateIngredient(storageSample);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(true);
  });

  it("kind:'mcp' with risk_tier:'destructive' is forbidden (reserved for connection)", () => {
    const m = { ...mcpSample, risk_tier: 'destructive' as const };
    const result = validateIngredient(m);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(true);
  });
});

describe('D-126 P4.2 — happy paths', () => {
  it("kind:'storage' with risk_tier:'destructive' is allowed (file-delete pattern)", () => {
    const storageSample: IngredientManifest = {
      slug: 'shared-mock-delete',
      name: 'Mock destructive storage op',
      description: 'Stand-in storage manifest used to exercise destructive-tier allowance.',
      author: 'recued-core',
      kind: 'storage',
      version: 1,
      category: 'action',
      risk_tier: 'destructive',
      tags: ['storage', 'delete', 'test'],
      input: { key: null },
      output: { deleted: 'deleted' },
    };
    const result = validateIngredient(storageSample);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(false);
  });

  it("kind:'chat' with risk_tier:'write' is allowed (matches web-chat-* catalog)", () => {
    const chatSample: IngredientManifest = {
      slug: 'web-chat-mock',
      name: 'Mock chat',
      description: 'Stand-in chat manifest matching the web-chat-* catalog pattern.',
      author: 'recued-core',
      kind: 'chat',
      version: 1,
      category: 'action',
      risk_tier: 'write',
      tags: ['chat', 'mock', 'test'],
      input: { 'chat.prompt': null },
      output: { response: 'response' },
    };
    const result = validateIngredient(chatSample);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(false);
  });
});

describe('D-126 P4.2 — kernel exemption', () => {
  it('kernel manifest with otherwise-forbidden tier is allowed', () => {
    // A hypothetical recued-authored ai-* kernel ingredient with
    // risk_tier='write' would normally fail the kind:ai tier gate
    // (ai is read-only), but kernel ingredients are exempt — they
    // route through the kernel adapter and the tier gate is the
    // engine's concern, not the validator's.
    const kernelAi: IngredientManifest = {
      slug: 'ai-kernel-mock',
      name: 'Mock kernel AI',
      description: 'Stand-in kernel ingredient exercising the kind:ai tier exemption.',
      author: 'recued',
      kind: 'ai',
      version: 1,
      category: 'ai',
      risk_tier: 'write',
      tags: ['kernel', 'ai', 'mock'],
      input: { 'llm.prompt': null },
      output: { result: 'result' },
    };
    const result = validateIngredient(kernelAi);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_TIER_MISMATCH')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// D-126 P4.3 — kind field presence + membership gate
// ────────────────────────────────────────────────────────────────

describe('D-126 P4.3 — INGREDIENT_KIND_MISSING', () => {
  it('manifest without a kind field emits INGREDIENT_KIND_MISSING', () => {
    const { kind: _kind, ...withoutKind } = httpSample;
    const result = validateIngredient(withoutKind);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_MISSING');
    expect(issue, 'expected INGREDIENT_KIND_MISSING').toBeDefined();
    expect(issue?.path).toBe('kind');
    expect(issue?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('kernel manifests are NOT exempt from the missing-kind check', () => {
    // The P4.1 / P4.2 kernel exemption is for per-kind shape rules,
    // not for the field itself. Every manifest must declare kind,
    // kernel or not.
    const kernelMissing = {
      slug: 'kernel-missing',
      name: 'Mock kernel ingredient with no kind',
      description: 'Stand-in kernel ingredient missing the required kind field.',
      author: 'recued',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      tags: ['kernel', 'mock', 'test'],
      input: { something: null },
      output: { x: 'x' },
    };
    const result = validateIngredient(kernelMissing);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_MISSING')).toBe(true);
  });

  it('manifest with kind:undefined emits INGREDIENT_KIND_MISSING', () => {
    const m = { ...httpSample, kind: undefined };
    const result = validateIngredient(m);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_MISSING')).toBe(true);
  });
});

describe('D-126 P4.3 — INGREDIENT_KIND_INVALID', () => {
  it('manifest with unknown kind emits INGREDIENT_KIND_INVALID', () => {
    const m = { ...httpSample, kind: 'webhook' };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'INGREDIENT_KIND_INVALID');
    expect(issue, 'expected INGREDIENT_KIND_INVALID').toBeDefined();
    expect(issue?.path).toBe('kind');
    expect(issue?.message).toMatch(/webhook/);
  });

  it('manifest with non-string kind emits INGREDIENT_KIND_INVALID', () => {
    const m = { ...httpSample, kind: 123 };
    const result = validateIngredient(m);
    expect(result.issues.some((i) => i.code === 'INGREDIENT_KIND_INVALID')).toBe(true);
  });

  it('shape + tier validators short-circuit when kind is invalid (no spurious errors)', () => {
    // When kind is invalid, downstream per-kind validators should
    // skip rather than emit errors against an arbitrary kind table
    // entry. INGREDIENT_KIND_INVALID is the actionable code.
    const m = { ...httpSample, kind: 'bogus' };
    const result = validateIngredient(m);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('INGREDIENT_KIND_INVALID');
    expect(codes).not.toContain('INGREDIENT_KIND_MISSING_FIELD');
    expect(codes).not.toContain('INGREDIENT_KIND_FIELD_FORBIDDEN');
    expect(codes).not.toContain('INGREDIENT_KIND_TIER_MISMATCH');
  });
});

// ────────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────────

const codesOf = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);
