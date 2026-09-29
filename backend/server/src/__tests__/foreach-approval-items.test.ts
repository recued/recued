/** The calls ONE approval of a held foreach covers — and when this refuses to
 *  list them. It lists only what it can prove is what will run: the held item,
 *  computed here, must come out exactly as the gate attached it. */

import { describe, expect, it } from 'vitest';
import {
  hashForeachCheckpointSource,
  projectResolvedArgs,
  resolveDeep,
  type IngredientManifest,
  type NamespaceStores,
} from '@recued/contracts';

import { actionIdentityBasis } from '../action-identity-basis.js';
import { createNamespaceStores } from '../server-executor.js';
import { foreachApprovalCover } from '../foreach-approval-items.js';

const manifest = {
  slug: 'mail-send',
  name: 'Send mail',
  description: 'test',
  author: 'recued',
  kind: 'storage',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  input: { to: null, subject: null, connection: null },
  output: {},
} as unknown as IngredientManifest;

const people = [
  { email: 'dana@x.example', conn: 'work' },
  { email: 'priya@x.example', conn: 'work' },
  { email: 'omar@x.example', conn: 'work' },
];

const recipe = (connection?: string) => ({
  steps: [{
    id: 'send',
    ingredient: 'mail-send',
    foreach: '{{step.people}}',
    input: {
      to: ['{{item.email}}'],
      subject: 'Minutes',
      ...(connection !== undefined ? { connection } : {}),
    },
  }],
}) as never;

const storesWith = (list: readonly unknown[]): NamespaceStores => {
  const stores = createNamespaceStores({}, {}, {});
  (stores.step as Record<string, unknown>).people = list;
  return stores;
};

/** The gate's own preview of item `index`, as the commit gateway computes it. */
const gatePreview = (stores: NamespaceStores, input: Record<string, unknown>, item: unknown) => {
  const record = stores as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(record, 'item');
  const saved = record.item;
  record.item = item;
  const preview = projectResolvedArgs(actionIdentityBasis(
    manifest,
    input,
    (merged) => resolveDeep(merged, stores, { deferVault: true }) as Record<string, unknown>,
    { surfaceDispatch: false },
  ));
  if (had) record.item = saved;
  else delete record.item;
  return preview;
};

const progress = (list: readonly unknown[], next_index = 0) => ({
  step_id: 'send',
  next_index,
  source_length: list.length,
  source_hash: hashForeachCheckpointSource(list),
  results: [],
});

const cover = (over: {
  list?: readonly unknown[];
  held?: Record<string, unknown>;
  connection?: string;
  stores?: NamespaceStores;
  next_index?: number;
} = {}) => {
  const list = over.list ?? people;
  const stores = over.stores ?? storesWith(list);
  const r = recipe(over.connection);
  const input = (r as unknown as { steps: Array<{ input: Record<string, unknown> }> }).steps[0]!.input;
  const next = over.next_index ?? 0;
  return foreachApprovalCover({
    recipe: r,
    gated_step_id: 'send',
    progress: progress(list, next),
    held: over.held ?? { args_preview: gatePreview(stores, input, list[next]) },
    stores,
    manifest: (slug) => (slug === 'mail-send' ? manifest : undefined),
  });
};

describe('foreachApprovalCover', () => {
  it('lists every remaining call when the held one reproduces exactly', () => {
    const result = cover();
    expect(result?.total).toBe(3);
    expect(result?.items?.map((i) => i.args_preview.to)).toEqual([
      ['dana@x.example'], ['priya@x.example'], ['omar@x.example'],
    ]);
  });

  it('starts at the held item, not at the top of the list', () => {
    const result = cover({ next_index: 1 });
    expect(result?.items?.map((i) => i.args_preview.to)).toEqual([
      ['priya@x.example'], ['omar@x.example'],
    ]);
  });

  it('⛔ lists nothing — only the count — when the held call does not reproduce', () => {
    expect(cover({ held: { args_preview: { to: ['someone-else@x.example'], subject: 'Minutes' } } }))
      .toEqual({ total: 3 });
    // …or when the gate attached no preview at all.
    expect(cover({ held: {} })).toEqual({ total: 3 });
  });

  it('⛔ lists nothing when the list is no longer the one the hold paused on', () => {
    const stores = storesWith([...people, { email: 'late@x.example', conn: 'work' }]);
    expect(foreachApprovalCover({
      recipe: recipe(),
      gated_step_id: 'send',
      progress: progress(people),
      held: { args_preview: { to: ['dana@x.example'], subject: 'Minutes' } },
      stores,
      manifest: () => manifest,
    })).toEqual({ total: 3 });
  });

  it('leaves out an item aimed at another account — it will be asked about on its own', () => {
    const list = [
      { email: 'dana@x.example', conn: 'work' },
      { email: 'priya@x.example', conn: 'home' },
      { email: 'omar@x.example', conn: 'work' },
    ];
    const stores = storesWith(list);
    const r = recipe('{{item.conn}}');
    const input = (r as unknown as { steps: Array<{ input: Record<string, unknown> }> }).steps[0]!.input;
    const result = foreachApprovalCover({
      recipe: r,
      gated_step_id: 'send',
      progress: progress(list),
      held: { args_preview: gatePreview(stores, input, list[0]), connection_name: 'work' },
      stores,
      manifest: () => manifest,
    });
    expect(result?.total).toBe(2);
    expect(result?.items?.map((i) => i.args_preview.to)).toEqual([['dana@x.example'], ['omar@x.example']]);
  });

  it('is a single-call ask for a chunked gate, a last item, or a pause outside the steps', () => {
    expect(cover({ held: { args_preview: {}, egress_bound: { requests: 3, total_bytes: 1 } } })).toBeUndefined();
    expect(cover({ next_index: 2 })).toBeUndefined();
    expect(foreachApprovalCover({
      recipe: recipe(),
      gated_step_id: 'send',
      execution_phase: 'prefetch',
      progress: progress(people),
      held: {},
      stores: storesWith(people),
      manifest: () => manifest,
    })).toBeUndefined();
  });

  it('puts the run\'s `item` back exactly as it found it', () => {
    const fresh = storesWith(people);
    cover({ stores: fresh });
    expect(Object.prototype.hasOwnProperty.call(fresh, 'item')).toBe(false);

    const bound = storesWith(people);
    (bound as unknown as Record<string, unknown>).item = { outer: true };
    cover({ stores: bound });
    expect((bound as unknown as Record<string, unknown>).item).toEqual({ outer: true });
  });
});
