import { describe, expect, it } from 'vitest';
import { OPERATION_IDEMPOTENCIES } from '@recued/contracts';
import { validateCompositionStructure } from '../validators.js';

const composition = () => ({ schema_version: 1, slug: 'policy-test',
  ingredients: [{ slug: 'policy-test', kind: 'http', http: { base: 'https://example.test', connection: 'policy-test' } }],
  operations: [{ op: 'item.list', ingredient: 'policy-test', risk: 'read', approval: 'never', args: [], bind: { kind: 'rest', method: 'GET', path_template: '/items' } }] });
const findings = (body: unknown) => validateCompositionStructure(body).filter(issue => issue.code === 'composition_operation_idempotency_invalid');
describe('authored operation repeat-call policy admission', () => {
  it('keeps omission legal and accepts each explicit contract classification', () => {
    const body = composition(); expect(findings(body)).toEqual([]);
    for (const idempotency of OPERATION_IDEMPOTENCIES) { Object.assign(body.operations[0], { idempotency }); expect(findings(body)).toEqual([]); }
  });
  it('rejects malformed explicit classifications on the indexed operation field', () => {
    for (const idempotency of ['idempoten', '', null, false, {}, ['safe']]) {
      const body = composition(); Object.assign(body.operations[0], { idempotency });
      expect(findings(body).map(issue => [issue.severity, issue.path])).toEqual([['error', 'operations[0].idempotency']]);
    }
  });
});
