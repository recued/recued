import { describe, expect, it } from 'vitest';
import { type AIOutput, type AssetFactContext, type AssetRule, type ChatPriorToolCall } from '@recued/contracts';
import { attachSourceFacts, visibleSourceFacts, renderSourceFacts, sourceFactOutputSchema } from '../chat-source-facts.js';
import { sourceCitation } from '../chat-source-citations.js';
const at = Date.parse('2026-10-26T12:00:00Z');
const root = { kind: 'field' as const, asset_id: 'private_asset', group: 'readings' as const, field: 'length' };
const graph = (): AssetFactContext => ({ root, asset: { id: root.asset_id, name: 'Mara’s [hose](https://injection.test)' },
  read_at: at, freshness: 'current', completeness: 'complete', omitted: [], missing: [],
  writer_check: { scope: 'registered_bindings', field: 'readings.length', status: 'complete', enabled_count: 1, disabled_count: 0, manual_priority: true, execution_status: 'not_checked' },
  nodes: [{ kind: 'field', ref: root, label: 'Length', value: { value: 29, unit: 'm', as_of: at - 10000 }, known: true,
    source: { kind: 'owner', ref: 'owner:private', at } },
  { kind: 'writer', ref: { kind: 'writer', asset_id: root.asset_id, binding_id: 'private_binding' }, name: 'Gauge', enabled: true,
    delivery: { status: 'recorded', last_submission: { outcome: 'manual_priority', at, observation_at: at - 1000 }, last_accepted: { at: at - 3000, observation_at: at - 4000 } } }], edges: [] });
const call = (result: unknown): ChatPriorToolCall => ({ tool_name: 'situation.query', tier: 1, status: 'ok', args: {}, result, started_at: at, completed_at: at });
const fixture = (g = graph()) => {
  const context = sourceCitation({ kind: 'asset_projection', asset_id: root.asset_id, projection: { kind: 'context', root: { kind: 'field', group: 'readings', field: 'length' } } }, 'Graph', 'a'.repeat(64), at);
  const scalar = sourceCitation({ kind: 'asset_projection', asset_id: root.asset_id, projection: { kind: 'field', field: 'readings.length' } }, 'Value', 'b'.repeat(64), at);
  const result = attachSourceFacts({}, g, [context, scalar]); const observed = call(result);
  return { result, observed, selection: visibleSourceFacts([observed], [observed]), context, scalar };
};
const output = (facts: string[], response = ''): AIOutput => ({ response, events: [], tool_calls: [], source_answer: { facts } });

describe('native relationship fact readout', () => {
  it('binds values to scalar scope and ownership, clocks and historical receipts to graph scope', () => {
    const f = fixture(); const rows = [...f.selection.facts.values()];
    const value = rows.find(row => row.text.includes('saved reading'))!;
    const owner = rows.find(row => row.text.includes('saved manually'))!;
    const submitted = rows.find(row => row.text.includes('latest settled'))!;
    const accepted = rows.find(row => row.text.includes('latest accepted'))!;
    expect(value.sources[0]!.id).toBe(f.scalar.id); expect(owner.sources[0]!.id).toBe(f.context.id);
    const rendered = renderSourceFacts(output([value.id, owner.id, submitted.id, accepted.id]), f.selection)!;
    expect(rendered).toContain(`saved manually by you. It was saved at 2026-10-26 12:00:00.000 UTC. [relationships](#source/${f.context.id})`);
    expect(rendered).toContain('saved reading 29 m, observed at 2026-10-26 11:59:50.000 UTC.');
    expect(rendered).toContain('historical acceptance, not proof of the current entry');
    expect(rendered).toContain('Current running state, scheduling and whole-recipe success have not been checked.');
    for (const secret of ['owner:private', 'private_binding', 'manual_priority', String(at), '[hose](https://injection.test)']) expect(rendered).not.toContain(secret);
    const schema = JSON.stringify(sourceFactOutputSchema(f.selection));
    for (const secret of ['Mara', 'private_asset', 'owner:private', 'Gauge', 'private_binding']) expect(schema).not.toContain(secret);
  });
  it('rejects free claims, bare labels, forged selectors, extra keys, duplicates and extraction side channels', () => {
    const f = fixture(); const id = [...f.selection.facts.keys()][0]!;
    for (const bad of [output([id], 'It came from the updater [source].'), output(['fact_' + 'c'.repeat(24)]), output([id, id]),
      { ...output([id]), source_answer: { facts: [id], claim: 'Updater owns it' } },
      { ...output([id]), events: [{ type: 'invented' }] }]) expect(renderSourceFacts(bad as AIOutput, f.selection)).toBeUndefined();
  });
  it('requires native origin and visible exact options; a later partial read supersedes the older scope', () => {
    const f = fixture(); const cloned = call(structuredClone(f.result));
    expect(visibleSourceFacts([cloned], [cloned]).active).toBe(false);
    expect(visibleSourceFacts([f.observed], [call({ __omitted: true, preview: JSON.stringify(f.result) })]).facts.size).toBe(0);
    const changed = graph(); changed.completeness = 'partial'; changed.nodes[0]!.kind === 'field' && (changed.nodes[0].value = { value: 30, unit: 'm', as_of: at });
    const newer = fixture(changed);
    expect(visibleSourceFacts([f.observed, newer.observed], [f.observed]).facts.size).toBe(0);
    const selected = visibleSourceFacts([f.observed, newer.observed], [newer.observed]);
    const value = [...selected.facts.values()].find(row => row.text.includes('saved reading'))!;
    const rendered = renderSourceFacts(output([value.id]), selected)!;
    expect(rendered).toContain(`absence. [relationships](#source/${newer.context.id})`);
    expect(rendered).not.toContain(`absence. [source](#source/${newer.scalar.id})`);
  });
  it('renders a native comparison with both input scopes and mandatory limits, including a disabled recurring rule', () => {
    const g = graph();
    const rule: AssetRule = { id: 'limit', title: 'Mara’s target', enabled: false, muted: true, pinned: true, consequence: 'routine',
      when: { kind: 'objective', field: root.field, target: 30, unit: 'm', direction: 'falling', mode: 'usage', lead_days: 0, every: 10 },
      reaction: { notify: true, occurrence: 'action', emit: false }, expiry_policy: 'strict_expire', schedule: { before: [], on_day: true } };
    const ref = { kind: 'rule' as const, asset_id: root.asset_id, rule_id: rule.id };
    g.nodes.push({ kind: 'rule', ref, title: rule.title, rule }); g.edges.push({ kind: 'uses', from: ref, to: root });
    const f = fixture(g); const comparison = [...f.selection.facts.values()].find(row => row.kind === 'comparison')!;
    expect(comparison.sources.map(source => source.id)).toEqual([f.scalar.id, f.context.id]);
    const rendered = renderSourceFacts(output([comparison.id]), f.selection)!;
    expect(rendered).toContain(`1 m below the declared falling target of 30 m. [source](#source/${f.scalar.id}) [relationships](#source/${f.context.id})`);
    expect(rendered).toContain('saved length reading 29 m');
    expect(rendered).toContain('The rule is disabled and muted.'); expect(rendered).toContain('observed at 2026-10-26 11:59:50.000 UTC');
    expect(rendered).toContain('This compares saved numbers only.'); expect(rendered).toContain('Recurring or skipped usage targets have not been resolved');
    expect(rendered).not.toMatch(/Enabled writers|saved manually|manual entry has priority|latest settled/u);
    // A mixed question can still select provenance and policy. Brevity must
    // not suppress requested facts or their authority limitations.
    const owner = [...f.selection.facts.values()].find(row => row.text.includes('saved manually'))!;
    const priority = [...f.selection.facts.values()].find(row => row.text.includes('manual entry has priority'))!;
    const mixed = renderSourceFacts(output([comparison.id, owner.id, priority.id]), f.selection)!;
    expect(mixed).toContain('saved manually by you'); expect(mixed).toContain('manual entry has priority');
    expect(mixed).toContain('Current running state, scheduling and whole-recipe success have not been checked.');
    expect(mixed).toContain('This compares saved numbers only.');
    const changed = structuredClone(g); changed.nodes[0]!.kind === 'field' && (changed.nodes[0].value = null);
    const missing = fixture(changed); const unavailable = [...missing.selection.facts.values()].find(row => row.kind === 'comparison')!;
    expect(renderSourceFacts(output([unavailable.id]), missing.selection)).toContain('numeric comparison is unavailable because the saved reading is unknown');
  });
  it('preserves the inclusive handoff boundary in a native declined-submission answer', () => {
    const g = graph(); const writer = g.nodes[1]!;
    if (writer.kind !== 'writer' || writer.delivery?.status !== 'recorded') throw new Error('fixture');
    writer.delivery.last_submission.outcome = 'before_handoff';
    const f = fixture(g); const fact = [...f.selection.facts.values()].find(row => row.text.includes('latest settled'))!;
    expect(renderSourceFacts(output([fact.id]), f.selection)).toContain('dated at or before automatic updates were allowed');
  });
  it('bounds the actual option packet and stays guarded when all native text exceeds the budget', () => {
    const g = graph();
    g.asset.name = 'Long owner content '.repeat(1000);
    const f = fixture(g);
    expect(f.selection.active).toBe(true); expect(f.selection.facts.size).toBe(0);
    expect(Buffer.byteLength(JSON.stringify((f.result as any).source_facts))).toBeLessThanOrEqual(8000);
    expect(renderSourceFacts(output(['invented']), f.selection)).toBeUndefined();
  });
  it('keeps no-receipt uncertainty and leaves ordinary scalar results unchanged', () => {
    const g = graph(); const writer = g.nodes[1]!; if (writer.kind !== 'writer') throw new Error('fixture'); writer.delivery = { status: 'no_receipt' };
    const f = fixture(g); const noReceipt = [...f.selection.facts.values()].find(row => row.text.includes('no field-submission receipt'))!;
    expect(renderSourceFacts(output([noReceipt.id]), f.selection)).toContain('does not prove the updater never ran');
    const scalar = graph(); scalar.nodes = scalar.nodes.slice(0, 1); scalar.writer_check!.enabled_count = 0;
    const evidence = { collection: 'asset', id: root.asset_id, field: 'attributes.length', value: 'about 29 meters' };
    const ref = { kind: 'evidence' as const, asset_id: root.asset_id, evidence };
    scalar.nodes.push({ kind: 'evidence', ref, evidence });
    scalar.edges.push({ from: root, to: ref, kind: 'supported_by' });
    const empty = fixture(scalar); expect(empty.result).not.toHaveProperty('source_facts'); expect(empty.selection.active).toBe(false);
  });
});
