/** D-145 PB5 — AI-cooperative substrate validator-gate tests.
 *
 *  Per § B.6.11. Cover the action-with-conflict-potential pattern
 *  detector + manifest declaration shape + opt-out rationale rules.
 */

import { describe, it, expect } from 'vitest';

import { validateIngredient } from '../validate.js';

/** Base manifest matching the action-with-conflict-potential pattern.
 *  Uses `kind: 'connection'` with the D-125 P5.1 wrapper-required input
 *  shape (connection_kind / connection / per-kind required keys) so the
 *  base manifest passes every other validator and only the
 *  `ai_cooperative_*` issues remain to assert against. */
const baseManifest = {
  slug: 'create-deal-hubspot',
  name: 'Create Deal (HubSpot)',
  description: 'Creates a deal in HubSpot.',
  author: 'recued-core',
  category: 'action' as const,
  risk_tier: 'write' as const,
  kind: 'connection' as const,
  version: 1,
  tags: ['hubspot', 'deal', 'create'],
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'POST',
    path: '/crm/v3/objects/deals',
    'body.properties.dealname': null,
  },
  output: { id: 'response.id' },
};

describe('D-145 PB5 — validateAiCooperative: pattern detector', () => {
  it('flags action-with-conflict-potential pattern when no declaration → warn', () => {
    const result = validateIngredient(baseManifest);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warn');
    // PB5 issues warn (not error) so the kernel catalog can migrate.
    expect(result.valid).toBe(true);
  });

  it('does NOT flag read-tier action ingredients (no conflict surface)', () => {
    const m = { ...baseManifest, risk_tier: 'read' as const, slug: 'read-deal-hubspot' };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeUndefined();
  });

  it('does NOT flag data-category ingredients (read by default)', () => {
    const m = { ...baseManifest, category: 'data' as const, risk_tier: 'read' as const };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeUndefined();
  });

  it('does NOT flag ai-category ingredients (pure inference, read-only)', () => {
    const m = {
      slug: 'ai-summarize',
      name: 'AI Summarize',
      description: 'Summarizes text via AI.',
      author: 'recued',
      category: 'ai' as const,
      risk_tier: 'read' as const,
      kind: 'ai' as const,
      version: 1,
      tags: ['ai', 'summary', 'text'],
      input: { llm: { data: null, max_length: 100 } },
      output: { summary: 'summary' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeUndefined();
  });

  it('does NOT flag dom-kind ingredients (publishing surfaces — § B.6 doesnt apply)', () => {
    const m = {
      slug: 'draft-email-reader-hubspot',
      name: 'HubSpot Draft Email Reader',
      description: 'Reads draft email content from HubSpot UI.',
      author: 'recued-core',
      category: 'data' as const,
      risk_tier: 'read' as const,
      kind: 'dom' as const,
      version: 1,
      tags: ['hubspot', 'email', 'dom'],
      input: { trigger: 'app.hubspot.com/contacts/*' },
      output: { 'app.hubspot.com/contacts/*': 'trigger', '[data-test-id="email"]': 'body' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeUndefined();
  });

  it('does NOT flag chat-kind ingredients (web-chat tabs are friendly-gesture)', () => {
    const m = {
      slug: 'web-chat-gemini',
      name: 'Web Chat Gemini',
      description: 'Web-chat tab AI for Gemini.',
      author: 'recued',
      category: 'action' as const,
      risk_tier: 'write' as const,
      kind: 'chat' as const,
      version: 1,
      tags: ['ai', 'chat', 'gemini'],
      input: { 'chat.tab': 'gemini', prompt: null },
      output: { response: 'response' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeUndefined();
  });

  it('flags http-kind admin-tier action ingredients', () => {
    const m = {
      slug: 'rotate-key-hubspot',
      name: 'Rotate HubSpot key',
      description: 'Rotates HubSpot API key via direct HTTP call.',
      author: 'recued-core',
      category: 'action' as const,
      risk_tier: 'admin' as const,
      kind: 'http' as const,
      version: 1,
      tags: ['hubspot', 'admin', 'rotate'],
      input: {
        method: 'POST',
        url: 'https://api.hubapi.com/oauth/v1/refresh-tokens',
        'header.authorization': 'Bearer {{vault.token}}',
        'body.refresh_token': null,
      },
      output: { token: 'response.access_token' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeDefined();
  });

  it('flags destructive-tier mcp-kind action ingredients', () => {
    const m = {
      slug: 'delete-thread-mcp',
      name: 'Delete Thread (MCP)',
      description: 'Deletes a thread via MCP server tool.',
      author: 'recued-core',
      category: 'action' as const,
      risk_tier: 'destructive' as const,
      kind: 'mcp' as const,
      version: 1,
      tags: ['mcp', 'delete', 'admin'],
      input: {
        'mcp.server_url': 'https://example.com/mcp',
        'mcp.tool': 'delete_thread',
        thread_id: null,
      },
      output: { ok: 'response.ok' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_missing');
    expect(issue).toBeDefined();
  });
});

describe('D-145 PB5 — validateAiCooperative: declaration shape', () => {
  it('accepts { declares_alternatives: true, fixed_slots_honored: true }', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: true, fixed_slots_honored: true },
    };
    const result = validateIngredient(m);
    const aiCoopIssues = result.issues.filter((i) => i.code.startsWith('ai_cooperative_'));
    expect(aiCoopIssues).toEqual([]);
  });

  it('rejects { declares_alternatives: true } without fixed_slots_honored: true', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: true },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_fixed_slots_not_honored');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('rejects { declares_alternatives: true, fixed_slots_honored: false }', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: true, fixed_slots_honored: false },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_fixed_slots_not_honored');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('accepts { declares_alternatives: false, opt_out_rationale: <16+ chars> }', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: {
        declares_alternatives: false,
        opt_out_rationale: 'reads HubSpot record by exact id, no ambiguity surface',
      },
    };
    const result = validateIngredient(m);
    const aiCoopIssues = result.issues.filter((i) => i.code.startsWith('ai_cooperative_'));
    expect(aiCoopIssues).toEqual([]);
  });

  it('rejects { declares_alternatives: false } without opt_out_rationale', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: false },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_opt_out_rationale_required');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('rejects under-length opt_out_rationale (placeholder strings)', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: false, opt_out_rationale: 'TODO' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_opt_out_rationale_required');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('rejects whitespace-only opt_out_rationale', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: {
        declares_alternatives: false,
        opt_out_rationale: '                ',
      },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_opt_out_rationale_required');
    expect(issue).toBeDefined();
  });

  it('rejects contradictory declaration (declares=true + opt_out_rationale set)', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: {
        declares_alternatives: true,
        fixed_slots_honored: true,
        opt_out_rationale: 'should not be set',
      },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_contradictory');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('rejects non-boolean declares_alternatives', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: { declares_alternatives: 'true' },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declares_alternatives_required');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('rejects non-object ai_cooperative field', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: 'declared',
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_invalid_shape');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('warns when declares=false + fixed_slots_honored set (meaningless combo)', () => {
    const m = {
      ...baseManifest,
      ai_cooperative: {
        declares_alternatives: false,
        fixed_slots_honored: true,
        opt_out_rationale: 'pure id-based read, no ambiguity surface',
      },
    };
    const result = validateIngredient(m);
    const issue = result.issues.find((i) => i.code === 'ai_cooperative_declaration_contradictory');
    expect(issue?.severity).toBe('warn');
  });
});

describe('D-145 PB5 — validateAiCooperative: pattern non-matches accept declaration too', () => {
  it('non-matching ingredient with valid declaration → no issues', () => {
    // A `read` action manifest may still optionally declare AI-cooperative
    // (substrate doesn't reject extra declarations).
    const m = {
      ...baseManifest,
      risk_tier: 'read' as const,
      ai_cooperative: { declares_alternatives: true, fixed_slots_honored: true },
    };
    const result = validateIngredient(m);
    const aiCoopIssues = result.issues.filter((i) => i.code.startsWith('ai_cooperative_'));
    expect(aiCoopIssues).toEqual([]);
  });
});
