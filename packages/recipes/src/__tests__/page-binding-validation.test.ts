import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../index.js';

const errors = (page_binding: unknown, type = 'text', extra = {}) => parseRecipe({
  recipe_id: 'page-binding', version: 1, ttl: 0,
  metadata: { name: 'Page binding', description: 'x', author: 'test', supported_platforms: [] },
  variables: { recipient: { label: 'Recipient', type, page_binding, ...extra } }, prefetch_steps: [],
  steps: [{ id: 'value', transform: 'coalesce', values: ['{{config.recipient}}'] }],
  output: { render: [{ type: 'summary', source: 'step.value' }] },
}).issues?.filter(issue => issue.severity === 'error') ?? [];

describe('recipe page argument bindings', () => {
  it('admits renamed, nested and identity bindings', () => {
    for (const field of ['email', 'id', 'facts.dates.expires_on']) {
      expect(errors({ kind: 'contact', field })).toEqual([]);
    }
    expect(errors({ kind: 'customer', field: 'id' }, 'record_ref', { entity: 'customer' })).toEqual([]);
    expect(errors({ kind: 'contact', field: 'email', platform: 'hubspot' })).toEqual([]);
  });

  it.each([null, [], {}, 'contact.email', { kind: 'contact' }, { field: 'email' },
    { kind: '', field: 'email' }, { kind: 'contact', field: '_record.id' },
    { kind: 'contact', field: 'facts.__proto__.id' }, { kind: 'contact', field: 'constructor.name' },
    { kind: 'contact', field: 'email', fallback: 'name' }, { kind: 'contact', field: 'facts..email' },
    { kind: 'contact', field: 'email', platform: '' }, { kind: 'contact', field: 'email', platform: 3 }])(
    'refuses a malformed or unsafe binding: %j', binding => {
      expect(errors(binding).map(issue => issue.code)).toContain('variable_hint_invalid');
    });

  it('refuses setup fields and Records bindings that contradict the picker', () => {
    for (const type of ['secret', 'oauth', 'connection', 'mail_template', 'file_slug']) {
      expect(errors({ kind: 'contact', field: 'email' }, type).some(issue => issue.path === 'variables.recipient.page_binding')).toBe(true);
    }
    for (const binding of [{ kind: 'invoice', field: 'id' }, { kind: 'customer', field: 'email' },
      { kind: 'customer', field: 'id', platform: 'hubspot' }]) {
      expect(errors(binding, 'record_ref', { entity: 'customer' }).map(issue => issue.code)).toContain('variable_hint_invalid');
    }
  });
});
