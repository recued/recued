import { describe, it, expect } from 'vitest';
import { formatResult } from '../console-output.js';
import type { ExecuteResponse } from '../types.js';

type RenderSection = NonNullable<ExecuteResponse['output']['render']>[number];

const renderOutput = (
  render: RenderSection[],
  sidebar: RenderSection[] = [],
): ExecuteResponse['output'] => ({ render, sidebar });

const base: ExecuteResponse = {
  recipe_id: 'test-recipe',
  recipe_hash: 'abc123',
  success: true,
  output: renderOutput([]),
  steps: [{ id: 's1', type: 'transform', skipped: false, duration_ms: 2, error: null }],
  errors: [],
  duration_ms: 5,
};

describe('formatResult', () => {
  it('renders success header', () => {
    const out = formatResult(base);
    expect(out).toContain('test-recipe');
    expect(out).toContain('success');
    expect(out).toContain('5ms');
  });

  it('renders failure with step source in errors', () => {
    const out = formatResult({
      ...base,
      success: false,
      steps: [
        { id: 'ok_step', type: 'transform', skipped: false, duration_ms: 1, error: null },
        { id: 'bad_step', type: 'ingredient', skipped: false, duration_ms: 3, error: { code: 'STEP_TIMEOUT', message: 'timed out' } },
      ],
      errors: [{ code: 'STEP_TIMEOUT', message: 'timed out', source: { step_id: 'bad_step' } } as unknown],
    });
    expect(out).toContain('failed');
    expect(out).toContain('[bad_step]');
    expect(out).toContain('STEP_TIMEOUT');
    expect(out).toContain('timed out');
    // Step trace on failure
    expect(out).toContain('Steps:');
    expect(out).toContain('ok_step');
    expect(out).toContain('bad_step');
  });

  it('renders summary section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'summary',
          data: { fields: [{ label: 'Risk Score', value: '72/100' }, { label: 'Stage', value: 'Negotiation' }] },
        }]),
    });
    expect(out).toContain('Risk Score');
    expect(out).toContain('72/100');
    expect(out).toContain('Stage');
    expect(out).toContain('Negotiation');
  });

  it('renders checklist section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'checklist',
          data: {
            title: 'Risk Assessment',
            items: [
              { label: 'Activity', status: 'ok', detail: 'Active recently' },
              { label: 'Close Date', status: 'issue', detail: 'Past due' },
              { label: 'Contacts', status: 'null', detail: 'No data' },
            ],
          },
        }]),
    });
    expect(out).toContain('Risk Assessment');
    expect(out).toContain('Activity');
    expect(out).toContain('Active recently');
    expect(out).toContain('Close Date');
    expect(out).toContain('Past due');
  });

  it('renders checklist actions as inert recipe action descriptors', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
        type: 'checklist',
        data: {
          items: [
            {
              label: 'Timed out reply',
              status: 'issue',
              detail: 'Needs owner review',
              action: {
                kind: 'recipe.run',
                label: 'Review reply',
                recipe_id: 'outbound-follow-up-timeout-review',
              },
            },
          ],
        },
      }]),
    });
    expect(out).toContain('Timed out reply');
    expect(out).toContain('Review reply');
    expect(out).toContain('recipe.run: outbound-follow-up-timeout-review');
  });

  it('renders table section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'table',
          data: {
            columns: [{ field: 'name', label: 'Name' }, { field: 'role', label: 'Role' }],
            rows: [
              { name: 'Alice', role: 'Champion' },
              { name: 'Bob', role: 'Blocker' },
            ],
          },
        }]),
    });
    expect(out).toContain('Name');
    expect(out).toContain('Role');
    expect(out).toContain('Alice');
    expect(out).toContain('Champion');
    expect(out).toContain('Bob');
  });

  it('renders table action columns as inert recipe action descriptors', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
        type: 'table',
        data: {
          columns: [
            { field: 'name', label: 'Name' },
            { field: 'actions', label: 'Actions', type: 'action' },
          ],
          rows: [
            {
              name: 'Timed out reply',
              actions: [
                {
                  kind: 'recipe.run',
                  label: 'Close watch',
                  recipe_id: 'outbound-follow-up-close-watch',
                },
              ],
            },
          ],
        },
      }]),
    });
    expect(out).toContain('Timed out reply');
    expect(out).toContain('Close watch');
    expect(out).toContain('recipe.run: outbound-follow-up-close-watch');
  });

  it('renders ai_analysis with known fields', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'ai_analysis',
          data: {
            summary: 'Deal is at moderate risk.',
            reasoning: 'Activity has stalled.',
            score: 72,
            key_points: ['No activity in 30 days', 'Close date past due'],
          },
        }]),
    });
    expect(out).toContain('Deal is at moderate risk.');
    expect(out).toContain('Reasoning');
    expect(out).toContain('Activity has stalled.');
    expect(out).toContain('Key Points');
    expect(out).toContain('No activity in 30 days');
  });

  it('renders ai_analysis string', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{ type: 'ai_analysis', data: 'This deal looks healthy.' }]),
    });
    expect(out).toContain('This deal looks healthy.');
  });

  it('renders text section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{ type: 'text', data: 'Hello from the recipe.' }]),
    });
    expect(out).toContain('Hello from the recipe.');
  });

  it('prefers canonical render sections over legacy sidebar sections', () => {
    const out = formatResult({
      ...base,
      output: renderOutput(
        [{ type: 'text', data: 'canonical render result' }],
        [{ type: 'text', data: 'legacy sidebar result' }],
      ),
    });
    expect(out).toContain('canonical render result');
    expect(out).not.toContain('legacy sidebar result');
  });

  it('falls back to legacy sidebar when render is absent', () => {
    const out = formatResult({
      ...base,
      output: { sidebar: [{ type: 'text', data: 'legacy sidebar result' }] } as unknown as ExecuteResponse['output'],
    });
    expect(out).toContain('legacy sidebar result');
  });

  it('renders button sections as inert recipe action descriptors', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
        type: 'button',
        data: [
          {
            kind: 'recipe.run',
            label: 'Review timed-out replies',
            recipe_id: 'outbound-follow-up-timeout-review',
          },
          { kind: 'url.open', label: 'Open link', url: 'https://example.test' },
        ],
      }]),
    });
    expect(out).toContain('Review timed-out replies');
    expect(out).toContain('recipe.run: outbound-follow-up-timeout-review');
    expect(out).toContain('Unsupported action');
    expect(out).not.toContain('https://example.test');
  });

  it('renders file artifact sections as exact metadata with inert decision actions', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
        type: 'file_artifact',
        data: {
          record_id: 'file:abcdef',
          filename: 'document.pdf',
          mime_type: 'application/pdf',
          size_bytes: 7_197,
          sha256: 'a'.repeat(64),
          approval_action: {
            kind: 'recipe.run',
            label: 'Approve and send exact PDF',
            recipe_id: 'approve-deliver-paid-document',
          },
          decision_actions: [{
            kind: 'recipe.run',
            label: 'Regenerate exact PDF',
            recipe_id: 'generate-paid-document',
          }],
        },
      }]),
    });

    expect(out).toContain('document.pdf');
    expect(out).toContain('file:abcdef');
    expect(out).toContain('7197 bytes');
    expect(out).toContain('Approve and send exact PDF');
    expect(out).toContain('Regenerate exact PDF');
    expect(out).toContain('recipe.run: approve-deliver-paid-document');
  });

  it('renders copyable section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{ type: 'copyable', data: 'copy this text', label: 'Email Draft' }]),
    });
    expect(out).toContain('Email Draft');
    expect(out).toContain('copy this text');
  });

  it('renders compact step count on success', () => {
    const out = formatResult({
      ...base,
      steps: [
        { id: 's1', type: 'transform', skipped: false, duration_ms: 1, error: null },
        { id: 's2', type: 'transform', skipped: true, duration_ms: 0, error: null },
        { id: 's3', type: 'ingredient', skipped: false, duration_ms: 3, error: null },
      ],
    });
    expect(out).toContain('3 steps');
    expect(out).toContain('1 skipped');
    // No step trace on success
    expect(out).not.toContain('Steps:');
  });

  it('renders timestamp section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{ type: 'timestamp', data: Date.now() - 7200_000, label: 'Last Contact' }]),
    });
    expect(out).toContain('Last Contact');
    expect(out).toContain('2 hours ago');
  });

  it('renders diff section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'diff',
          data: {
            fields: [
              { label: 'Stage', from: 'Discovery', to: 'Negotiation' },
              { label: 'Amount', from: 5000, to: 5000 },
            ],
          },
        }]),
    });
    expect(out).toContain('Stage');
    expect(out).toContain('Discovery');
    expect(out).toContain('Negotiation');
    expect(out).toContain('Amount');
  });

  it('renders actions section', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{
          type: 'actions',
          data: {
            buttons: [
              { label: 'View in CRM', action: 'open', value: 'https://crm.example.com/deal/123' },
              { label: 'Copy Summary', action: 'copy', value: 'Deal is healthy.' },
              { label: 'Re-run', action: 'rerun', value: 'test-recipe' },
            ],
          },
        }]),
    });
    expect(out).toContain('View in CRM');
    expect(out).toContain('https://crm.example.com/deal/123');
    expect(out).toContain('Copy Summary');
    expect(out).toContain('Re-run');
  });

  it('handles unknown block type gracefully', () => {
    const out = formatResult({
      ...base,
      output: renderOutput([{ type: 'future_type' as any, data: { x: 1 } }]),
    });
    expect(out).toContain('future_type');
  });

  it('handles empty render output', () => {
    const out = formatResult(base);
    expect(out).toContain('test-recipe');
    expect(out).toContain('1 steps');
  });
});
