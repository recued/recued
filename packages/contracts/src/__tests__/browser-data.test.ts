import { describe, expect, it } from 'vitest';
import { browserActReadsOnly, parseBrowserActSteps } from '../browser-act.js';
import { parseBrowserDataStep } from '../browser-data.js';

describe('browser data step contract', () => {
  it('accepts collect then pure computation, while preserving the boundary against later browser actions', () => {
    const collect = { do: 'collect', items: 'article', fields: { name: 'b' }, max_pages: 1 };
    const data = { do: 'data', pipeline: [{ transform: 'count' }] };
    const parsed = parseBrowserActSteps([collect, data]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(browserActReadsOnly(parsed.steps)).toBe(true);
    expect(parseBrowserActSteps([collect, data, { do: 'click', text: 'Next' }])).toMatchObject({ ok: false });
    expect(parseBrowserActSteps([{ do: 'table', ref: 'e2' }, data])).toMatchObject({ ok: true });
    expect(parseBrowserActSteps([{ ...data, page: '1:DOC' }])).toMatchObject({ ok: false });
    expect(parseBrowserActSteps([{ do: 'table', ref: 'e2', selector: 'table' }])).toMatchObject({ ok: false });
  });
  it('rejects side effects, ambiguous output names, malformed references and excessive plans', () => {
    for (const value of [
      { pipeline: [{ transform: 'wait' }] }, { pipeline: [{ transform: 'map', apply: 'pii-restore' }] },
      { pipeline: [{ transform: 'count', id: 'input' }] }, { pipeline: [{ transform: 'count', id: 'n' }, { transform: 'count', id: 'n' }] },
      { pipeline: [{ transform: 'count' }], return: ['absent'] }, { source: 'guessed', pipeline: [{ transform: 'count' }] },
      { describe: ['count'], pipeline: [{ transform: 'count' }] }, { pipeline: new Array(21).fill({ transform: 'count' }) },
      JSON.parse('{"pipeline":[{"transform":"set","field":"x","value":{"__proto__":1}}]}'),
    ]) expect(parseBrowserDataStep({ do: 'data', ...value })).toMatchObject({ ok: false });
    expect(parseBrowserDataStep({ do: 'data', describe: [] })).toMatchObject({ ok: true });
    expect(parseBrowserDataStep({ do: 'data', source: 'latest', pipeline: [{ transform: 'count' }] })).toMatchObject({ ok: true, step: { source: 'latest' } });
  });

  it('rejects misleading code/text projections with a usable repair while retaining data templates and arithmetic', () => {
    const parse = (expression: unknown) => parseBrowserDataStep({ do: 'data', pipeline: [{ transform: 'map', expression }] });
    expect(parse('{"family": {{item.group}}, "count": {{item.count}}}')).toMatchObject({ ok: false, error: expect.stringContaining('actual JSON object') });
    for (const expression of ['parseInt({{item.text}}.split(" ")[0])', '{{item.text}}.replace("x", "")',
      { code: 'Math.floor({{item.amount}})' }, '{{item.text.replace("x", "")}}']) {
      expect(parse(expression)).toMatchObject({ ok: false, error: expect.stringContaining('JavaScript') });
    }
    for (const expression of [{ name: '{{item.text}}', count: '{{item.count}}' }, ['{{item.text}}', '{{item.count}}'],
      { name: '{{item["Student Name"]}}' },
      'Label ({{item.id}})', 'docs/{{item.id}}', '[{{item.id}}]', '{{item.amount}} / 100', 'floor({{item.amount}} / 100)', '{"literal":1}']) {
      expect(parse(expression)).toMatchObject({ ok: true });
    }
  });
  it('attaches only bounded known transform discovery to data authoring failures, including unknown names', () => {
    const failed = parseBrowserActSteps([{ do: 'data', pipeline: [{ transform: 'map', expression: '{{item.parts[0]}}' }, { transform: 'map' }, { transform: 'count' }] }]);
    expect(failed).toMatchObject({ ok: false, data_schema_step: { do: 'data', describe: ['map', 'count'] } });
    expect(parseBrowserActSteps([{ do: 'data', pipeline: [{ transform: 'made-up' }] }])).toMatchObject({ ok: false, data_schema_step: { do: 'data', describe: [] } });
    expect(parseBrowserActSteps([{ do: 'wait', gone: '#unknown' }])).not.toHaveProperty('data_schema_step');
  });
});
