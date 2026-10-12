import { describe, expect, it } from 'vitest';
import { collectFormValueRefs, collectWholeFormRecordRefs, resolveDeep } from '@recued/contracts';
import type { ExecutionContext } from '../types.js';
import { runStep } from '../step-runner.js';

const records = [
  { _id: 's1', _collection: 'form_response', submission_id: 's1', values: { full_name: 'Ada', private_note: 'visitor secret' } },
  { _id: 's2', _collection: 'form_response', submission_id: 's2', values: { full_name: 'Bo', private_note: 'another secret' } },
];
const list = { id: 'pending', ingredient: 'form-response-list', input: { endpoint_id: 'door' } };
const get = { id: 'accepted', ingredient: 'form-response-get', input: { submission_id: 's1' } };
const run = async (steps: unknown[], config: Record<string, unknown> = {}) => {
  const ctx: ExecutionContext = {
    recipe: { id: 'r', prefetch_steps: [], steps, output: { render: [] } } as unknown as ExecutionContext['recipe'],
    stores: { vault: {}, config, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => {
      if (slug === 'form-response-list') return { records };
      if (slug === 'form-response-get') {
        const resolved = resolveDeep(input, ctx.stores) as Record<string, unknown>;
        return { record: records.find((record) => record.submission_id === resolved.submission_id) };
      }
      throw new Error(`Unexpected ingredient: ${slug}`);
    },
  };
  for (const step of steps) {
    expect((await runStep(step as Parameters<typeof runStep>[0], ctx)).error).toBeNull();
  }
  return ctx.stores.step as Record<string, unknown>;
};

describe('selected form fields match real engine output', () => {
  it('exports only selected CSV cells from records that contain private answers', async () => {
    const steps = [list, { id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns: [null, { field: '' }, { field: 'values.full_name', label: 'Name' }] }];
    expect(collectFormValueRefs({ steps })).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    const result = await run(steps);
    expect(result.csv).toBe('Name\nAda\nBo');
    expect(result.csv).not.toContain('secret');
    expect(result.pending).toEqual({ records });
  });

  it('serializes a named pick without exporting the other answers', async () => {
    const steps = [get,
      { id: 'picked', transform: 'pick', source: '{{step.accepted.record.values}}', fields: ['full_name'] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ];
    expect(collectFormValueRefs({ steps })).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    const result = await run(steps);
    expect(JSON.parse(result.body as string)).toEqual({ full_name: 'Ada' });
    expect(result.body).not.toContain('secret');
  });

  it('detects whitespace interpolation that turns a pick source into an unrestricted string', async () => {
    const steps = [get,
      { id: 'picked', transform: 'pick', source: ' {{step.accepted.record.values}} ', fields: ['full_name'] },
    ];
    expect(collectWholeFormRecordRefs({ steps })).toEqual(['{{step.accepted.record.values}}']);
    expect((await run(steps)).picked).toBe(' {"full_name":"Ada","private_note":"visitor secret"} ');
  });

  it('preserves canonical metadata and uses shallow keys rather than CSV paths', async () => {
    const steps = [get,
      { id: 'picked', transform: 'pick', source: '{{step.accepted.record}}', fields: ['submission_id', 'values.full_name'] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ];
    expect(collectFormValueRefs({ steps })).toEqual([]);
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    const result = await run(steps);
    expect(result.picked).toEqual({ _id: 's1', _collection: 'form_response', submission_id: 's1' });
    expect(result.body).not.toContain('secret');
  });

  it('exports foreach pick results while detecting a later export of their original items', async () => {
    const steps = [list,
      { id: 'picked', foreach: '{{step.pending.records}}', transform: 'pick', source: '{{item.values}}', fields: ['full_name'] },
      { id: 'csv', transform: 'to_csv', array: '{{step.picked}}', columns: [{ field: 'result.full_name', label: 'Name' }] },
    ];
    expect(collectFormValueRefs({ steps })).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    const result = await run(steps);
    expect(result.csv).toBe('Name\nAda\nBo');
    const leak = [...steps, { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' }];
    expect(collectWholeFormRecordRefs({ steps: leak })).toEqual(['{{step.picked}}']);
    expect((await run(leak)).body).toContain('visitor secret');
  });

  it.each([undefined, [], [null, {}, { field: '' }], ['values']].map((columns) => [columns]))(
    'detects CSV exports that actually expose private answers: %j', async (columns) => {
      const steps = [list, { id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns }];
      expect(collectWholeFormRecordRefs({ steps })).toHaveLength(1);
      expect((await run(steps)).csv).toContain('visitor secret');
    },
  );

  it('does not mistake an empty string column for automatic column derivation', async () => {
    const steps = [list, { id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns: [''] }];
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    expect((await run(steps)).csv).toBe('\n\n');
  });

  it('detects configurable CSV and pick selectors that choose a private answer', async () => {
    const steps = [list, get,
      { id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns: '{{config.columns}}' },
      { id: 'picked', transform: 'pick', source: '{{step.accepted.record.values}}', fields: '{{config.fields}}' },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ];
    expect(collectWholeFormRecordRefs({ steps })).toEqual(['{{step.pending.records}}', '{{step.accepted.record.values}}', '{{step.picked}}']);
    const result = await run(steps, { columns: ['values.private_note'], fields: ['private_note'] });
    expect(result.csv).toContain('visitor secret');
    expect(JSON.parse(result.body as string)).toEqual({ private_note: 'visitor secret' });
  });

  it('detects the full answer object implicitly preserved under a canonical key', async () => {
    const steps = [get,
      { id: 'wrapper', transform: 'defaults', fields: { _id: { value: '{{step.accepted.record.values}}', fallback: {} } } },
      { id: 'picked', transform: 'pick', source: '{{step.wrapper}}', fields: [] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ];
    expect(collectWholeFormRecordRefs({ steps })).toEqual(['picked.source._id (preserved field)', '{{step.picked}}']);
    expect((await run(steps)).body).toContain('visitor secret');
  });

  it.each(['+0', '0e0', ''])('reads nested CSV array indices as the runtime does: %j', async (index) => {
    const steps = [list,
      { id: 'groups', transform: 'default', value: [{ children: '{{step.pending.records}}' }], fallback: [] },
      { id: 'csv', transform: 'to_csv', array: '{{step.groups}}', columns: [{ field: `children.${index}.values.full_name`, label: 'Name' }] },
    ];
    expect(collectFormValueRefs({ steps })).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs({ steps })).toEqual([]);
    expect((await run(steps)).csv).toBe('Name\nAda');
  });
});
