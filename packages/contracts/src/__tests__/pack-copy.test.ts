/** D-333 — a pack's copy, and a recipe switched between the original and the copy. */
import { describe, expect, it } from 'vitest';
import { packCopyFor, repointRecipePack, PACK_REF_RE } from '../pack-copy.js';
import type { BulkPackManifest } from '../bulk-pack.js';
import type { RecipeDefinition } from '../recipe.js';

const original = 'recued-core.freshdesk';
const copy = 'local-authoring.freshdesk-copy';
const recipe = {
  recipe_id: 'ticket-review-brief-freshdesk',
  metadata: { name: 'Ticket review brief', description: `Uses ${original} to read a ticket.`,
    local_automation: { catalog: original } },
  depends_on: [original, 'recued-core.slack'],
  variables: {},
  trigger_steps: [{ id: 'watch', op: `${original}.ticket.watch` }],
  prefetch_steps: [{ id: 'agent', op: `${original}.agent.current` }],
  steps: [
    { id: 'ticket', op: `${original}.ticket.read`, input: { ticket_id: '{{config.ticket}}' } },
    { id: 'post', op: 'recued-core.slack.message.post' },
    { id: 'card', transform: 'to_summary', fields: [{ label: 'Approval path', value: `${original}.ticket.update` }] },
    // Another pack whose name only starts the same way is not this one.
    { id: 'other', op: 'recued-core.freshdesk-extra.thing.read' },
  ],
  output: { render: [] },
} as unknown as RecipeDefinition;

describe('D-333 — switching a recipe between a pack and its copy', () => {
  it('names the copy everywhere the recipe named the original, and nowhere else', () => {
    const switched = repointRecipePack(recipe, original, copy) as unknown as typeof recipe & Record<string, never>;
    const r = switched as unknown as {
      depends_on: string[]; metadata: { description: string; local_automation: { catalog: string } };
      trigger_steps: Array<{ op: string }>; prefetch_steps: Array<{ op: string }>;
      steps: Array<{ op?: string; fields?: Array<{ value: string }>; input?: unknown }>;
    };
    expect(r.depends_on).toEqual([copy, 'recued-core.slack']);
    expect(r.trigger_steps[0]!.op).toBe(`${copy}.ticket.watch`);
    expect(r.prefetch_steps[0]!.op).toBe(`${copy}.agent.current`);
    expect(r.steps[0]!.op).toBe(`${copy}.ticket.read`);
    expect(r.steps[0]!.input).toEqual({ ticket_id: '{{config.ticket}}' });
    expect(r.steps[1]!.op).toBe('recued-core.slack.message.post');
    expect(r.steps[2]!.fields![0]!.value).toBe(`${copy}.ticket.update`);
    expect(r.steps[3]!.op).toBe('recued-core.freshdesk-extra.thing.read');
    expect(r.metadata.local_automation.catalog).toBe(copy);
    // Prose that mentions it is the author's text, not a reference.
    expect(r.metadata.description).toBe(`Uses ${original} to read a ticket.`);
    // And back again, exactly.
    expect(repointRecipePack(switched as unknown as RecipeDefinition, copy, original)).toEqual(recipe);
  });

  it('records what a copy copies, as recipes name it', () => {
    const manifest = {
      manifest_version: 2, slug: 'freshdesk', publisher: 'recued-core', name: 'Freshdesk', description: 'Tickets.',
      version: 3, recipes: [], requires: ['install_bulk_pack'], tags: ['support'],
      contents: [{ type: 'composition', composition: {
        schema_version: 1, slug: 'freshdesk', catalog_kind: 'official',
        ingredients: [{ slug: 'freshdesk', kind: 'http', http: { base: 'https://x.freshdesk.com', connection: 'freshdesk' } }],
        operations: [{ op: 'ticket.read', ingredient: 'freshdesk', risk: 'read', approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/api/v2/tickets/{id}' } }],
      } }],
    } as unknown as BulkPackManifest;
    const made = packCopyFor(manifest)!;
    expect(made.pack).toMatchObject({ slug: 'freshdesk-copy', publisher: 'local-authoring', copy_of: original });
    expect(PACK_REF_RE.test(made.pack.copy_of as string)).toBe(true);
    expect(PACK_REF_RE.test('freshdesk')).toBe(false);
  });
});
