import { describe, expect, it } from 'vitest';
import type { ServerRecipeListEntry, VariableDefault } from '@recued/contracts';
import {
  recipePagePrefill,
  runPageContextFromOutput,
  runPageObject,
  snapshotRunPageContext,
  type RunPageContext,
} from '../shell/run-page-context.js';

const revision = 'a'.repeat(64);
const owner = { publisher: 'owner', pack_slug: 'customers' };
const hint = (type: string, extra: Record<string, unknown> = {}): VariableDefault =>
  ({ label: type, type, ...extra }) as VariableDefault;
const recipe = (variables: Record<string, VariableDefault>, bundle = 'owner/customers'): ServerRecipeListEntry => ({
  recipe_id: 'follow-up', publisher_id: 'owner', version: 1, recipe_hash: 'hash',
  source: 'pair-sync', installed_at: 0,
  recipe: {
    recipe_id: 'follow-up', version: 1, ttl: 0,
    metadata: { name: 'Follow up', description: '', author: 'owner', supported_platforms: [], recipe_bundle: bundle },
    variables, output: { sidebar: [] }, requires: [],
  },
});
const customer = (id = 'customer-1', email = 'alice@example.test') =>
  runPageObject('customer', id, { id, name: 'Alice', email, active: true, count: 3, status: 'open', _record: { entity: 'customer', revision: 1 } }, owner);
const context = (...objects: RunPageContext['objects']): RunPageContext => ({ label: 'Current page', objects });

describe('Run palette page argument binding', () => {
  it('matches the actual text and list controls, including choices and multiline values', () => {
    const selected = runPageObject('contact', 'c1', { count: 3, active: false,
      title: 'First line\nSecond line', tags: [{ name: 'work' }], days: [1, 99], status: ['open'] });
    const result = recipePagePrefill(recipe({ count: null, active: null, title: hint('text'),
      contact_title: hint('long_text'), tags: hint('array'), days: hint('array', { options: ['@weekdays'] }),
      status: hint('array', { options: ['closed'] }) }), context(selected));
    expect(result.config).toEqual({ contact_title: 'First line\nSecond line' });
    expect(recipePagePrefill(recipe({ days: hint('array', { options: ['@weekdays'] }), status: hint('array') }),
      context(runPageObject('contact', 'c1', { days: [1, 7], status: ['open'] }))).config)
      .toEqual({ days: [1, 7], status: ['open'] });
    for (const tags of [[1], ['One, two'], ['[]'], [' leading '], ['']]) {
      expect(recipePagePrefill(recipe({ tags: hint('array') }),
        context(runPageObject('contact', 'c1', { tags }))).config).toEqual({});
    }
  });
  it('maps renamed and nested fields without guessing a second role', () => {
    const selected = runPageObject('contact', 'contact-1', { email: 'alice@example.test', profile: { website: 'https://example.test' } });
    const result = recipePagePrefill(recipe({
      person_a_email: hint('text', { page_binding: { kind: 'contact', field: 'email' } }),
      person_b_email: hint('text'),
      website_url: hint('url', { page_binding: { kind: 'contact', field: 'profile.website' } }),
      id: hint('text', { page_binding: { kind: 'contact', field: 'id' } }),
    }), context(selected));
    expect(result.config).toEqual({ person_a_email: 'alice@example.test', website_url: 'https://example.test', id: 'contact-1' });
  });

  it('leaves an unavailable explicit binding manual, including a same-named decoy', () => {
    const selected = runPageObject('contact', 'contact-1', { email: 'decoy@example.test', count: 3 });
    expect(recipePagePrefill(recipe({
      email: hint('text', { page_binding: { kind: 'customer', field: 'email' } }),
      count: hint('number', { page_binding: { kind: 'contact', field: 'missing' } }),
    }), context(selected)).config).toEqual({});
  });

  it('does not confuse local identities with a vendor object of the same kind', () => {
    const local = runPageObject('asset', 'local-passport', { name: 'Passport' });
    const entry = recipe({ asset_id: hint('text'), name: hint('text') });
    entry.recipe.metadata.supported_platforms = ['canva'];
    expect(recipePagePrefill(entry, context(local)).config).toEqual({});
    expect(recipePagePrefill(entry, context({ ...local, platforms: ['canva'] })).config).toEqual({});
    const vendor = { ...local, apiSource: { kind: 'api' as const, connection_revision: revision, platform: 'canva', connection_name: 'design', entity: 'asset' } };
    const slots = [{ slot: 'canva', connections: [{ connection_name: 'design', connection_revision: revision }] }];
    expect(recipePagePrefill(entry, context(vendor), slots).config)
      .toEqual({ asset_id: 'local-passport', name: 'Passport' });
    entry.recipe.variables.asset_id = hint('text', { page_binding: { kind: 'asset', field: 'id' } });
    expect(recipePagePrefill(entry, context(local)).config).toEqual({ asset_id: 'local-passport' });
    entry.recipe.metadata.supported_platforms = [];
    expect(recipePagePrefill(entry, context(vendor), slots).config).toEqual({});
    entry.recipe.variables.asset_id = hint('text', { page_binding: { kind: 'asset', field: 'id', platform: 'canva' } });
    expect(recipePagePrefill(entry, context(vendor), slots).config).toEqual({ asset_id: 'local-passport' });
    expect(recipePagePrefill(entry, context(local)).config).toEqual({ name: 'Passport' });
  });

  it('binds API arguments and their source account together, only on an unambiguous compatible slot', () => {
    const api = (connection_name: string) => ({ ...runPageObject('contact', '42', { email: 'ana@example.test' }),
      origin: 'api' as const, apiSource: { kind: 'api' as const, connection_revision: revision, platform: 'hubspot', connection_name, entity: 'contact' } });
    const entry = recipe({ person: hint('text', { page_binding: { kind: 'contact', field: 'id', platform: 'hubspot' } }) });
    const slots = [{ slot: 'crm', connections: [{ connection_name: 'sales', connection_revision: revision }, { connection_name: 'personal', connection_revision: revision }] }];
    expect(recipePagePrefill(entry, context(api('sales')), slots)).toMatchObject({
      config: { person: '42' }, connections: { crm: 'sales' },
      connectionFields: { crm: { config: ['person'], context: [] } },
    });
    for (const choices of [[], [{ slot: 'crm', connections: [{ connection_name: 'personal', connection_revision: revision }] }],
      [...slots, { ...slots[0]!, slot: 'other' }]]) {
      expect(recipePagePrefill(entry, context(api('sales')), choices).config).toEqual({});
    }
    expect(recipePagePrefill(entry, context(api('sales'), api('personal')), slots).config).toEqual({});
    expect(recipePagePrefill(entry, context({ ...api('sales'), apiSource: { ...api('sales').apiSource, entity: 'company' } }), slots).config).toEqual({});
  });

  it('tracks account dependencies separately for config and context', () => {
    const selected = { ...runPageObject('contact', '42', { email: 'ana@example.test' }),
      origin: 'api' as const, apiSource: { kind: 'api' as const, connection_revision: revision, platform: 'hubspot', connection_name: 'sales', entity: 'contact' } };
    const entry = { ...recipe({ contact_id: hint('text') }), run_context_targets: ['contact_email'] };
    entry.recipe.metadata.supported_platforms = ['hubspot'];
    expect(recipePagePrefill(entry, context(selected), [{ slot: 'crm', connections: [{ connection_name: 'sales', connection_revision: revision }] }]))
      .toMatchObject({ config: { contact_id: '42' }, context: { contact_email: 'ana@example.test' },
        connectionFields: { crm: { config: ['contact_id'], context: ['contact_email'] } } });
  });

  it('leaves API arguments manual when the page or current account has no matching revision', () => {
    const entry = recipe({ person: hint('text', { page_binding: { kind: 'contact', field: 'id', platform: 'hubspot' } }) });
    const api = { ...runPageObject('contact', '42', {}), origin: 'api' as const,
      apiSource: { kind: 'api' as const, platform: 'hubspot', connection_name: 'sales', entity: 'contact', connection_revision: revision } };
    for (const current of [undefined, 'b'.repeat(64)]) {
      expect(recipePagePrefill(entry, context(api), [{ slot: 'crm', connections: [
        { connection_name: 'sales', ...(current ? { connection_revision: current } : {}) },
      ] }]).config).toEqual({});
    }
    const { connection_revision: _, ...legacy } = api.apiSource;
    expect(recipePagePrefill(entry, context({ ...api, apiSource: legacy }), [{ slot: 'crm', connections: [
      { connection_name: 'sales', connection_revision: revision },
    ] }]).config).toEqual({});
  });

  it('requires local file identity even when an API returns file-shaped IDs', () => {
    const local = runPageObject('file', 'file:42', { file_refs: ['file:42'] });
    const vendor = { ...local, origin: 'api' as const,
      apiSource: { kind: 'api' as const, connection_revision: revision, platform: 'drive', connection_name: 'documents', entity: 'file' } };
    const entry = recipe({ file_ref: hint('file_ref'),
      bound: hint('file_ref', { page_binding: { kind: 'file', field: 'id', platform: 'drive' } }),
      file_refs: hint('file_ref[]') });
    entry.recipe.metadata.supported_platforms = ['drive'];
    const slots = [{ slot: 'drive', connections: [{ connection_name: 'documents', connection_revision: revision }] }];
    expect(recipePagePrefill(entry, context(vendor), slots).config).toEqual({});
    expect(recipePagePrefill(entry, context(local), slots).config).toEqual({ file_ref: 'file:42', file_refs: ['file:42'] });
  });

  it('applies defaults, types, ambiguity and setup exclusions to explicit bindings', () => {
    const binding = { kind: 'customer', field: 'email' };
    expect(recipePagePrefill(recipe({
      saved: hint('text', { default: 'saved', page_binding: binding }),
      wrong_type: hint('number', { page_binding: binding }),
      secret: hint('secret', { page_binding: binding }),
      another_email: hint('text', { page_binding: binding }),
    }), context(customer(), customer('customer-2', 'bob@example.test'))).config).toEqual({});
  });

  it('ignores malformed bindings and prototype or internal paths even from an older server', () => {
    for (const page_binding of [null, [], { kind: 'customer' },
      { kind: 'customer', field: '_record.entity' }, { kind: 'customer', field: 'constructor.name' },
      { kind: 'customer', field: 'email', fallback: 'name' }]) {
      expect(recipePagePrefill(recipe({ email: hint('text', { page_binding }) }), context(customer())).config).toEqual({});
    }
  });

  it('allows one explicitly bound Records role while preserving namespace and scope', () => {
    const variables = {
      billing: hint('record_ref', { entity: 'customer', page_binding: { kind: 'customer', field: 'id' } }),
      shipping: hint('record_ref', { entity: 'customer' }),
    };
    expect(recipePagePrefill(recipe(variables), context(customer())).config).toEqual({ billing: 'customer-1' });
    expect(recipePagePrefill(recipe(variables, 'other/customers'), context(customer())).config).toEqual({});
    expect(recipePagePrefill(recipe({ billing: hint('record_ref', {
      entity: 'customer', page_binding: { kind: 'customer', field: 'id' }, entity_filter: { status: 'closed' },
    }) }), context(customer())).config).toEqual({});
  });

  it('binds a renamed durable file argument and uses projected step-only targets', () => {
    const file = runPageObject('file', 'file:42', { filename: 'roster.csv' });
    expect(recipePagePrefill(recipe({ file: hint('file_ref', { page_binding: { kind: 'file', field: 'id' } }) }), context(file)).config)
      .toEqual({ file: 'file:42' });
    const entry = { ...recipe({}), run_context_targets: ['customer_id'] };
    expect(recipePagePrefill(entry, context(customer())).context).toEqual({ customer_id: 'customer-1' });
  });

  it('fills named arguments, typed references, and a declared object from the selected record', () => {
    const result = recipePagePrefill(recipe({
      customer_id: null, customer_email: hint('text'), name: '',
      customer: hint('object'), active: hint('boolean'), count: hint('number'),
      selected: hint('record_ref', { entity: 'customer' }),
      unrelated_id: null, id: null,
    }), context(customer()));
    expect(result.config).toMatchObject({ customer_id: 'customer-1', customer_email: 'alice@example.test', name: 'Alice', active: true, count: 3, selected: 'customer-1' });
    expect(result.config.customer).toEqual({ id: 'customer-1', name: 'Alice', email: 'alice@example.test', active: true, count: 3, status: 'open' });
    expect(result.config).not.toHaveProperty('unrelated_id');
    expect(result.config).not.toHaveProperty('id');
    expect(result.source).toBe('Alice');
  });

  it('keeps declared defaults and refuses incompatible values, credentials, and setup settings', () => {
    const result = recipePagePrefill(recipe({
      name: 'Saved name', email: hint('text', { default: 'saved@example.test' }),
      active: hint('number'), count: hint('text'), status: hint('enum', { options: ['closed'] }),
      customer_email: hint('secret'), customer_id: hint('connection'),
    }), context(customer()));
    expect(result).toEqual({ config: {}, context: {}, source: null });
    expect(recipePagePrefill(recipe({ status: hint('enum', { options: ['open', 'closed'] }) }), context(customer())).config).toEqual({ status: 'open' });
  });

  it('keeps Records identities within the recipe owner, even with identical entity names', () => {
    for (const bundle of ['another/customers', 'owner/another-pack', '']) {
      expect(recipePagePrefill(recipe({ customer_id: null, selected: hint('record_ref', { entity: 'customer' }) }, bundle), context(customer())).config).toEqual({});
    }
  });

  it('respects the record reference entity and equality scope', () => {
    const variables = {
      wrong_kind: hint('record_ref', { entity: 'invoice' }),
      wrong_scope: hint('record_ref', { entity: 'customer', entity_filter: { status: 'closed' } }),
    };
    expect(recipePagePrefill(recipe(variables), context(customer())).config).toEqual({});
    expect(recipePagePrefill(recipe({ selected: hint('record_ref', { entity: 'customer', entity_filter: { status: 'open' } }) }), context(customer())).config).toEqual({ selected: 'customer-1' });
    const unowned = { ...customer(), owner: undefined };
    expect(recipePagePrefill(recipe({ selected: hint('record_ref', { entity: 'customer' }) }), context(unowned)).config).toEqual({});
    expect(recipePagePrefill(recipe({ id: hint('record_ref', { entity: 'customer' }) }), context(customer())).config).toEqual({ id: 'customer-1' });
  });

  it('leaves multiple possible records and multiple same-entity roles for the owner to choose', () => {
    expect(recipePagePrefill(recipe({ customer_id: null, customer_email: hint('text') }), context(customer(), customer('customer-2', 'bob@example.test'))).config).toEqual({});
    expect(recipePagePrefill(recipe({
      billing: hint('record_ref', { entity: 'customer' }), shipping: hint('record_ref', { entity: 'customer' }),
    }), context(customer())).config).toEqual({});
  });

  it('fills only recipe-derived context targets and excludes engine context and generic entity IDs', () => {
    const entry = recipe({});
    entry.recipe.output = { sidebar: [{ type: 'text', source: '{{context.customer_id}} {{context.entity_id}} {{context.server}} {{context.tabs}}' }] };
    expect(recipePagePrefill(entry, context(customer()))).toEqual({ config: {}, context: { customer_id: 'customer-1' }, source: 'Alice' });
  });

  it('uses the loaded file reference without inventing unrelated IDs', () => {
    const file = runPageObject('file', 'file:42', { filename: 'invoice.pdf', mime_type: 'application/pdf' });
    expect(recipePagePrefill(recipe({ file_ref: hint('file_ref'), file_id: null, customer_id: null }), context(file)).config).toEqual({ file_ref: 'file:42', file_id: 'file:42' });
  });

  it('has no prefill without a selection', () => {
    expect(recipePagePrefill(recipe({ customer_id: null }), null)).toEqual({ config: {}, context: {}, source: null });
  });

  it('prefers an explicit argument field over a synthesized identity alias', () => {
    const selected = runPageObject('customer', 'internal-id', { customer_id: 'external-id' });
    expect(recipePagePrefill(recipe({ customer_id: hint('text') }), context(selected)).config).toEqual({ customer_id: 'external-id' });
  });

  it('leaves invalid date, instant, and durable-file values manual', () => {
    const entry = recipe({ date: hint('date'), when: hint('datetime'), file_ref: hint('file_ref') });
    const selected = runPageObject('file', 'vendor-file-id', { date: '2026-02-30', when: '2026-10-18T12:00' });
    expect(recipePagePrefill(entry, context(selected))).toEqual({ config: {}, context: {}, source: null });
    const valid = runPageObject('file', 'file:42', { date: '2026-10-18', when: '2026-10-18T12:00:00-07:00' });
    expect(recipePagePrefill(entry, context(valid)).config).toEqual({ date: '2026-10-18', when: '2026-10-18T12:00:00-07:00', file_ref: 'file:42' });
  });

  it('does not lock untyped JSON context targets into a read-only prefill', () => {
    const entry = recipe({});
    entry.recipe.output = { sidebar: [{ type: 'text', source: '{{context.count}} {{context.active}} {{context.customer}}' }] };
    expect(recipePagePrefill(entry, context(runPageObject('customer', 'c1', { count: 3, active: true, customer: { name: 'Alice' } })))).toEqual({ config: {}, context: {}, source: null });
  });
});

describe('Run palette context lifecycle', () => {
  it('uses host source metadata over payload metadata and keeps friendly field values', () => {
    const selected = runPageContextFromOutput([{
      type: 'record_fields', data: { id: '42', _record: { entity: 'contact' }, properties: { email: 'ana@example.test' } },
      record_fields: { entity: 'contact', fields: [{ key: 'email', present: true, value: 'ana@example.test' }] },
      record_source: { kind: 'api', connection_revision: revision, platform: 'hubspot', connection_name: 'sales', entity: 'contact' },
    }], recipe({}));
    expect(selected?.objects[0]?.owner).toBeUndefined();
    const entry = recipe({ contact_id: null, contact_email: hint('text') });
    entry.recipe.metadata.supported_platforms = ['hubspot'];
    expect(recipePagePrefill(entry, selected, [{ slot: 'hubspot', connections: [{ connection_name: 'sales', connection_revision: revision }] }]))
      .toMatchObject({ config: { contact_id: '42', contact_email: 'ana@example.test' }, connections: { hubspot: 'sales' } });
    for (const record_source of [undefined, { kind: 'api', connection_revision: revision, platform: 'hubspot', connection_name: 'sales', entity: 'company' },
      { kind: 'api', connection_revision: revision, platform: 'hubspot', connection_name: 'sales', entity: 'contact', guess: true }]) {
      const unproven = runPageContextFromOutput([{
        type: 'record_fields', data: { id: '42', record_source: selected?.objects[0]?.apiSource },
        record_fields: { entity: 'contact', fields: [] }, ...(record_source ? { record_source } : {}),
      }], recipe({}));
      expect(recipePagePrefill(entry, unproven, [{ slot: 'hubspot', connections: [{ connection_name: 'sales', connection_revision: revision }] }]).config).toEqual({});
    }
  });
  it('captures values before a route refresh can mutate the selected object', () => {
    const selected = customer();
    const values = selected.values as Record<string, unknown>;
    const snapshot = snapshotRunPageContext(() => context(selected));
    values.email = 'changed@example.test';
    expect(snapshot?.objects[0]?.values.email).toBe('alice@example.test');
  });

  it('leaves Run available when context is missing or its provider fails', () => {
    expect(snapshotRunPageContext()).toBeNull();
    expect(snapshotRunPageContext(() => { throw new Error('Disposed route'); })).toBeNull();
    expect(snapshotRunPageContext(() => context())).toBeNull();
  });

  it('derives selected objects from current record_fields blocks, preserving their owner', () => {
    const entry = recipe({});
    const result = runPageContextFromOutput([
      { type: 'record_fields', data: customer().values, record_fields: { entity: 'customer', fields: [] } },
      { type: 'table', data: { rows: [customer().values] } },
      { type: 'record_fields', data: { id: 'gone' }, record_fields: { entity: 'customer', unresolved: 'no_record' } },
    ], entry);
    expect(result?.objects).toEqual([customer()]);
    expect(runPageContextFromOutput([{ type: 'table', data: { rows: [customer().values] } }], entry)).toBeNull();
    expect(runPageContextFromOutput([{ type: 'record_fields', data: customer().values, record_fields: { entity: 'customer' } }], undefined)).toBeNull();
  });

  it('unwraps Records get/search envelopes and uses the displayed field names', () => {
    const row = { id: 'job-1', _record: { entity: 'job' } };
    for (const data of [{ record: row }, { records: [row] }]) {
      const selected = runPageContextFromOutput([{
        type: 'record_fields', data,
        record_fields: { entity: 'job', fields: [{ key: 'title', present: true, value: 'Prepare quote' }] },
      }], recipe({}));
      expect(selected?.objects[0]?.values).toEqual({ ...row, title: 'Prepare quote' });
      expect(recipePagePrefill(recipe({ job_id: null, title: hint('text') }), selected).config).toEqual({ job_id: 'job-1', title: 'Prepare quote' });
    }
    expect(runPageContextFromOutput([{
      type: 'record_fields', data: { records: [{ id: 'job-1' }, { id: 'job-2' }] },
      record_fields: { entity: 'job', fields: [] },
    }], recipe({}))).toBeNull();
  });

  it('preserves a vendor record ID for display while leaving unproven bindings manual', () => {
    const selected = runPageContextFromOutput([{
      type: 'record_fields', data: { id: 42 }, record_fields: { entity: 'ticket', fields: [] },
    }], recipe({}));
    expect(selected?.objects[0]?.id).toBe(42);
    expect(recipePagePrefill(recipe({ ticket_id: hint('number') }), selected).config).toEqual({});
  });

  it('does not treat an API record as a pack-owned Records reference', () => {
    for (const metadata of [undefined, { entity: 'invoice' }]) {
      const selected = runPageContextFromOutput([{
        type: 'record_fields', data: { id: 'vendor-customer', ...(metadata ? { _record: metadata } : {}) },
        record_fields: { entity: 'customer', fields: [] },
      }], recipe({}));
      expect(selected?.objects[0]?.owner).toBeUndefined();
      expect(recipePagePrefill(recipe({ selected: hint('record_ref', { entity: 'customer' }) }), selected).config).toEqual({});
    }
  });

  it('never treats recipe compatibility metadata as the provenance of an API result', () => {
    const entry = recipe({ asset_id: hint('text') });
    entry.recipe.metadata.supported_platforms = ['canva', 'hubspot'];
    const selected = runPageContextFromOutput([{
      type: 'record_fields', data: { id: 'canva-42' }, record_fields: { entity: 'asset', fields: [] },
    }], entry);
    expect(selected?.objects[0]?.origin).toBe('api');
    expect(selected?.objects[0]?.platforms).toBeUndefined();
    expect(recipePagePrefill(entry, selected).config).toEqual({});
    expect(recipePagePrefill(recipe({ asset_id: hint('text') }), selected).config).toEqual({});
    for (const platform of [undefined, 'canva', 'hubspot']) {
      expect(recipePagePrefill(recipe({ asset_id: hint('text', {
        page_binding: { kind: 'asset', field: 'id', ...(platform ? { platform } : {}) },
      }) }), selected).config).toEqual({});
    }
  });
});
