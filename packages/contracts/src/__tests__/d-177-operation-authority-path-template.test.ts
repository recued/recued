/** D-177 N.2 — `collectOperationAuthorityPaths` path-template extraction +
 *  `operationPathTemplate` (the Codex review-of-fix MEDIUM-2 close).
 *
 *  A catalog write/destructive op carries its TARGET-RECORD id in the api
 *  binding's `path_template` (`PATCH /contacts/{{contact_id}}`,
 *  `DELETE /deals/{{deal_id}}`). The binding lives on the manifest's
 *  `surfaces.api.executes` map (keyed by op id), NOT on the op spec — so an op
 *  that declares no `path_scope` / `authority_args` (the live HubSpot/Salesforce
 *  shape) would otherwise leave that id OUT of the authority set, letting
 *  `hash_exclude_args: ['contact_id']` de-pin the target (a grant approved to
 *  update Alice updates Bob). The collector now folds the path-template
 *  `{{token}}` params into the authority set, fed via `operationPathTemplate`. */

import { describe, it, expect } from 'vitest';
import {
  collectOperationAuthorityPaths,
  operationPathTemplate,
} from '../ingredient-catalog.js';

describe('operationPathTemplate', () => {
  const manifest = {
    surfaces: {
      api: {
        executes: {
          'contact.update': { kind: 'rest', method: 'PATCH', path_template: '/crm/v3/objects/contacts/{{contact_id}}' },
          'deal.search': { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' },
        },
      },
    },
  };

  it('returns the op binding path_template', () => {
    expect(operationPathTemplate(manifest, 'contact.update')).toBe(
      '/crm/v3/objects/contacts/{{contact_id}}',
    );
  });

  it('returns undefined for an unknown op / missing surfaces / odd shape', () => {
    expect(operationPathTemplate(manifest, 'nope')).toBeUndefined();
    expect(operationPathTemplate({}, 'contact.update')).toBeUndefined();
    expect(operationPathTemplate(undefined, 'contact.update')).toBeUndefined();
    expect(operationPathTemplate({ surfaces: { api: { executes: { x: {} } } } }, 'x')).toBeUndefined();
  });
});

describe('collectOperationAuthorityPaths — path-template target ids (D-177 N.2)', () => {
  it('folds `{{token}}` path params into the authority set', () => {
    const paths = collectOperationAuthorityPaths(
      { operation_id: 'contact.update', risk_tier: 'write' },
      '/crm/v3/objects/contacts/{{contact_id}}',
    );
    expect(paths).toContain('contact_id');
  });

  it('extracts multiple params + tolerates single-brace + trims whitespace', () => {
    const paths = collectOperationAuthorityPaths(
      {},
      '/a/{{deal_id}}/b/{stage}/c/{{ owner_id }}',
    );
    expect(paths).toEqual(expect.arrayContaining(['deal_id', 'stage', 'owner_id']));
  });

  it('accepts an array of templates (multiple bindings)', () => {
    const paths = collectOperationAuthorityPaths({}, [
      '/x/{{a_id}}',
      '/y/{{b_id}}',
    ]);
    expect(paths).toEqual(expect.arrayContaining(['a_id', 'b_id']));
  });

  it('no template → unchanged (back-compat with the 1-arg call)', () => {
    const withArg = collectOperationAuthorityPaths({ operation_id: 'x' });
    const withNull = collectOperationAuthorityPaths({ operation_id: 'x' }, null);
    const withUndef = collectOperationAuthorityPaths({ operation_id: 'x' }, undefined);
    expect(withNull).toEqual(withArg);
    expect(withUndef).toEqual(withArg);
    // a path with no params contributes nothing.
    expect(collectOperationAuthorityPaths({}, '/crm/v3/objects/deals/search')).toEqual(
      collectOperationAuthorityPaths({}),
    );
  });

  it('still folds path_scope + authority_args + affects_target alongside', () => {
    const paths = collectOperationAuthorityPaths(
      {
        path_scope: { target_path_template: '{bucket}/x' },
        authority_args: ['to'],
        editable_args: [{ key: 'calendar_id', affects_target: true }, { key: 'note' }],
      },
      '/v/{{record_id}}',
    );
    expect(paths).toEqual(expect.arrayContaining(['bucket', 'to', 'calendar_id', 'record_id']));
    expect(paths).not.toContain('note');
  });
});
