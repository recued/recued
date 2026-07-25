/** Connection-agnostic op dispatch (slice 3; §5 tool-op pack seam) — validator
 *  acceptance.
 *
 *  The recipe validator accepts a `CanonicalOpStep` (`{ op: '<family>.<verb>' }`) as
 *  a fourth step discriminant alongside transform / ingredient / guard, so a
 *  connection-agnostic canonical recipe can be authored + published. Only the SHAPE
 *  is checked: a CRM op (family ∈ crm_alias) must use a canonical CRM verb; a §5 TOOL
 *  op (any other family — `web.search`) has an open vocabulary and is shape-checked
 *  only (`op_step_unknown_entity` retired). Binding-time failures (the pack doesn't
 *  declare the op) surface in the install resolver, not here. Op-steps are rejected
 *  in prefetch_steps + trigger_steps (the R1 resolver rewrites `steps` only).
 *  Spec: internal design notes.
 */
import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../validate.js';

type R = Record<string, unknown>;

const codes = (input: unknown): string[] => validateRecipe(input).issues.map((i) => i.code);
const errorCodes = (input: unknown): string[] =>
  validateRecipe(input).issues.filter((i) => i.severity === 'error').map((i) => i.code);

/** Minimal valid recipe; `steps` (and other top-level keys) overridable. */
const mkRecipe = (overrides: R = {}): R => ({
  recipe_id: 'surface-open-deals-canonical',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Surface open deals',
    description: 'A connection-agnostic canonical recipe over a CRM-conformant pack.',
    author: 'recued-core',
    supported_platforms: [],
    tags: ['deal', 'crm', 'pipeline'],
  },
  variables: {},
  steps: [
    { id: 'deals', op: 'deal.search', args: { limit: 200 } },
  ],
  // Step 3b enforce: an op-step recipe must declare its capability deps. The
  // default covers the default `deal.search` step; tests that override `steps`
  // with a different op also override `dependencies`.
  dependencies: [{ capability: 'deal', ops: ['search'] }],
  output: { sidebar: [] },
  ...overrides,
});

describe('validateRecipe — canonical op-step acceptance (slice 3)', () => {
  it('accepts a well-formed op-step as a step discriminant', () => {
    const result = validateRecipe(mkRecipe());
    expect(result.valid).toBe(true);
    expect(errorCodes(mkRecipe())).not.toContain('step_no_discriminator');
    expect(errorCodes(mkRecipe())).toHaveLength(0);
  });

  it('an op-step with no args is valid (args is optional)', () => {
    const r = mkRecipe({ steps: [{ id: 'deals', op: 'deal.search' }] });
    expect(validateRecipe(r).valid).toBe(true);
  });

  it('a downstream step may reference an op-step id ({{step.<op-step>}})', () => {
    const r = mkRecipe({
      steps: [
        { id: 'deals', op: 'deal.search', args: { limit: 50 } },
        { id: 'open', transform: 'filter', array: '{{step.deals}}', field: 'stage', operator: 'not_equal', value: 'closed_won' },
      ],
      output: { sidebar: [{ type: 'table', source: 'step.open' }] },
    });
    expect(validateRecipe(r).valid).toBe(true);
    expect(errorCodes(r)).not.toContain('undeclared_step_ref');
  });

  it('an op-step id is a valid output.source (declared like any step)', () => {
    const r = mkRecipe({ output: { sidebar: [{ type: 'table', source: 'step.deals' }] } });
    expect(validateRecipe(r).valid).toBe(true);
    expect(errorCodes(r)).not.toContain('output_source_not_a_step');
  });

  it('accepts every crm_alias × canonical verb combination', () => {
    for (const entity of ['deal', 'contact', 'account']) {
      for (const verb of ['read', 'search', 'create', 'update', 'delete']) {
        const r = mkRecipe({
          steps: [{ id: 's', op: `${entity}.${verb}` }],
          dependencies: [{ capability: entity, ops: [verb] }],
        });
        expect(validateRecipe(r).valid, `${entity}.${verb}`).toBe(true);
      }
    }
  });
});

describe('validateRecipe — canonical op-step shape errors (slice 3)', () => {
  it('rejects a malformed op (no dot)', () => {
    const r = mkRecipe({ steps: [{ id: 'deals', op: 'dealsearch' }] });
    expect(errorCodes(r)).toContain('op_step_malformed');
  });

  it('accepts a three-segment id as a D-182 Tier-P op (binding checked at install)', () => {
    // D-182 Slice 4 — a 3-segment id is `<publisher>.<pack>.<operation>` (a valid
    // Tier-P SHAPE), no longer "malformed two dots". `deal.search.extra` parses as
    // publisher=deal / pack=search / op=extra; whether that pack/op is installed is
    // an INSTALL-time check (the op-step lowering), not authoring.
    const three = mkRecipe({ steps: [{ id: 'do', op: 'recued-core.gdrive.download' }], dependencies: [] });
    expect(errorCodes(three)).not.toContain('op_step_malformed');
    // …and a 4-segment id (dotted operation `audio.transcribe`) is equally valid.
    const four = mkRecipe({ steps: [{ id: 'do', op: 'recued-core.whisper.audio.transcribe' }], dependencies: [] });
    expect(errorCodes(four)).not.toContain('op_step_malformed');
  });

  it('accepts a kernel core.<domain>.<op> two-tier op', () => {
    const r = mkRecipe({
      steps: [{ id: 'do', op: 'core.ai.summarize' }],
      dependencies: [],
    });
    expect(errorCodes(r)).not.toContain('op_step_malformed');
    expect(errorCodes(r)).not.toContain('op_step_unknown_verb');
  });

  it('still rejects a genuinely malformed multi-segment op (empty / uppercase segment)', () => {
    // `parseOpId` fails closed for an empty segment, a non-SLUG head, or a
    // trailing dot, so these fall through to the bare-canonical one-dot check and
    // error — a 3-segment id is only valid when every segment is well-formed.
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 'deal..search' }] }))).toContain('op_step_malformed');
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 'Deal.Pack.Op' }] }))).toContain('op_step_malformed');
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 'a.b.' }] }))).toContain('op_step_malformed');
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: '.a.b.c' }] }))).toContain('op_step_malformed');
  });

  it('accepts a tool op-step (non-crm-alias family) — §5 tool-op pack seam', () => {
    // `web.search`'s family is not a crm_alias, so it is a TOOL op, not an error:
    // `op_step_unknown_entity` is retired. Whether the installed pack declares the
    // operation is an install-time check (the resolver's tool path), not authoring —
    // so the structural validator raises no op-step error here.
    const r = mkRecipe({ steps: [{ id: 'w', op: 'web.search' }] });
    expect(errorCodes(r)).not.toContain('op_step_unknown_entity');
    expect(errorCodes(r)).not.toContain('op_step_unknown_verb');
    expect(errorCodes(r)).not.toContain('op_step_malformed');
  });

  it('rejects a non-canonical verb (vendor-specific op not reachable)', () => {
    const r = mkRecipe({ steps: [{ id: 'd', op: 'deal.batchUpsert' }] });
    expect(errorCodes(r)).toContain('op_step_unknown_verb');
  });

  it('rejects a non-string / empty op', () => {
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 42 }] }))).toContain('op_step_shape');
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: '' }] }))).toContain('op_step_shape');
  });

  it('rejects non-object args', () => {
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 'deal.search', args: [1, 2] }] })))
      .toContain('op_step_args_shape');
    expect(errorCodes(mkRecipe({ steps: [{ id: 'd', op: 'deal.search', args: 'nope' }] })))
      .toContain('op_step_args_shape');
  });

  it('a step carrying op AND a concrete discriminant is multi-discriminator (op shape not also checked)', () => {
    const r = mkRecipe({ steps: [{ id: 'd', op: 'deal.search', transform: 'filter', array: '{{step.x}}' }] });
    const cs = errorCodes(r);
    expect(cs).toContain('step_multi_discriminator');
    expect(cs).not.toContain('op_step_malformed');
  });
});

describe('validateRecipe — foreach on tool op-steps only; optional never (§5 brick 3)', () => {
  it('accepts foreach on a TOOL op-step (single pass-through fetch)', () => {
    const r = mkRecipe({
      steps: [
        { id: 'src', transform: 'to_list', value: [] },
        {
          id: 'searches',
          op: 'web.search',
          foreach: '{{step.src}}',
          args: { 'body.query': '{{item.q}}' },
        },
      ],
      dependencies: [{ capability: 'web', ops: ['search'] }],
    });
    const cs = errorCodes(r);
    expect(cs).not.toContain('op_step_iteration_unsupported');
    expect(cs).not.toContain('op_step_optional_unsupported');
  });

  it('rejects foreach on a CRM op-step (fetch+projection pair can\'t iterate)', () => {
    const r = mkRecipe({
      steps: [{ id: 'd', op: 'deal.search', foreach: '{{step.x}}' }],
    });
    expect(errorCodes(r)).toContain('op_step_iteration_unsupported');
  });

  it('rejects optional on ANY op-step — it is a prefetch-only knob, dead on sequential op-steps', () => {
    // tool op-step
    expect(errorCodes(mkRecipe({
      steps: [{ id: 'w', op: 'web.search', optional: true }],
      dependencies: [{ capability: 'web', ops: ['search'] }],
    }))).toContain('op_step_optional_unsupported');
    // CRM op-step
    expect(errorCodes(mkRecipe({
      steps: [{ id: 'd', op: 'deal.search', optional: true }],
    }))).toContain('op_step_optional_unsupported');
  });
});

describe('validateRecipe — op-steps are sequential-only (slice 3)', () => {
  it('rejects an op-step in prefetch_steps', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'pf', op: 'deal.search', args: {} }],
      steps: [{ id: 's', transform: 'count', array: '{{step.pf}}' }],
    });
    const cs = errorCodes(r);
    expect(cs).toContain('op_step_in_prefetch');
    // the generic "prefetch must reference an ingredient" message is NOT also raised.
    expect(cs).not.toContain('prefetch_ingredient_required');
  });

  it('rejects an op-step in trigger_steps', () => {
    const r = mkRecipe({
      auto_run: { interval_ms: 3_600_000 },
      trigger_steps: [{ id: 'tg', op: 'deal.search' }],
      steps: [{ id: 'deals', op: 'deal.search' }],
    });
    const cs = errorCodes(r);
    expect(cs).toContain('op_step_in_trigger_steps');
    expect(cs).not.toContain('trigger_step_no_discriminator');
  });
});

describe('validateRecipe — core.watch.* is trigger-position only (D-182 watcher)', () => {
  const watchTrigger = { id: 'morning', op: 'core.watch.time', args: { weekdays: [1, 2, 3, 4, 5] } };

  it('ACCEPTS a core.watch.time op-step in trigger_steps (the trigger-position op)', () => {
    // The exception to "op-steps are sequential-only": a watcher op produces the
    // reactive should_run gate and lowers to its backing watcher ingredient.
    const r = mkRecipe({
      auto_run: { interval_ms: 600_000 },
      trigger_steps: [watchTrigger],
    });
    const cs = errorCodes(r);
    expect(cs).not.toContain('op_step_in_trigger_steps');
    expect(cs).not.toContain('watch_op_outside_trigger_steps');
    expect(cs).toHaveLength(0);
  });

  it('still rejects a NON-watcher op-step in trigger_steps', () => {
    const r = mkRecipe({
      auto_run: { interval_ms: 3_600_000 },
      trigger_steps: [{ id: 'tg', op: 'deal.search' }],
    });
    expect(errorCodes(r)).toContain('op_step_in_trigger_steps');
  });

  it('rejects a core.watch.* op-step in sequential steps (trigger-position only)', () => {
    const r = mkRecipe({ steps: [watchTrigger], dependencies: [] });
    expect(errorCodes(r)).toContain('watch_op_outside_trigger_steps');
  });

  it('rejects a core.watch.* op-step in prefetch_steps (trigger-position only)', () => {
    const r = mkRecipe({ prefetch_steps: [watchTrigger] });
    expect(errorCodes(r)).toContain('watch_op_outside_trigger_steps');
  });

  it('rejects a MIXED-discriminator trigger step (op + ingredient) — would silently drop the watch op at lowering', () => {
    // `isOpStep` is false when a co-discriminator is present, so a mixed step
    // lowers as the concrete ingredient and the watch op vanishes. The validator
    // must catch it as a multi-discriminator error, not wave it through.
    const r = mkRecipe({
      auto_run: { interval_ms: 600_000 },
      trigger_steps: [{ id: 'morning', op: 'core.watch.time', ingredient: 'mail-watcher', args: {} }],
    });
    const cs = errorCodes(r);
    expect(cs).toContain('trigger_step_multi_discriminator');
  });
});

describe('validateRecipe — prefetch_steps is read-tier (D-182 core.dom write guard)', () => {
  it('rejects a write-tier kernel op-step in prefetch_steps (no approval gate runs there)', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'pf', op: 'core.dom.write', args: { target: '*://x/*', selector: '#a', value: 'v' } }],
      steps: [{ id: 's', transform: 'count', array: '{{step.pf}}' }],
    });
    expect(errorCodes(r)).toContain('write_op_in_prefetch');
  });

  it('rejects a destructive kernel op-step in prefetch_steps', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'pf', op: 'core.storage.file.delete', args: { path: 'x' } }],
      steps: [{ id: 's', transform: 'count', array: '{{step.pf}}' }],
    });
    expect(errorCodes(r)).toContain('write_op_in_prefetch');
  });

  it('ACCEPTS a read-tier kernel op-step in prefetch_steps (core.dom.read — the intended use)', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'pf', op: 'core.dom.read', args: { target: '*://x/*', selector: '#a' } }],
      steps: [{ id: 's', transform: 'count', array: '{{step.pf}}' }],
    });
    const cs = errorCodes(r);
    expect(cs).not.toContain('write_op_in_prefetch');
    expect(cs).not.toContain('op_step_in_prefetch');
  });
});

describe('validateRecipe — per-operand connection slots (R2 step 5)', () => {
  const connVar = { label: 'CRM', type: 'connection', connection_kind: 'api', default: '' };

  it('accepts an explicit slot naming a declared connection variable', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar },
      steps: [{ id: 'deals', op: 'deal.search', connection: '{{config.crm_a}}' }],
    });
    expect(errorCodes(r)).toHaveLength(0);
  });

  it('accepts a multi-operand recipe whose op-steps are all explicitly slotted', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar, crm_b: connVar },
      steps: [
        { id: 'a_deals', op: 'deal.search', connection: '{{config.crm_a}}' },
        { id: 'b_deals', op: 'deal.search', connection: '{{config.crm_b}}' },
      ],
    });
    expect(errorCodes(r)).toHaveLength(0);
  });

  it('keeps a slot-less op-step valid with zero connection variables (composition pack-default path)', () => {
    const r = mkRecipe({ variables: {} });
    expect(errorCodes(r)).toHaveLength(0);
  });

  it.each([
    ['a literal connection name', 'hubspot1'],
    ['another namespace', '{{step.target}}'],
    ['interpolation', 'crm {{config.crm_a}}'],
    ['a dotted config path', '{{config.crm_a.name}}'],
    ['a non-string', 7],
  ])('op_step_connection_shape on %s', (_label, slot) => {
    const r = mkRecipe({
      variables: { crm_a: connVar },
      steps: [{ id: 'deals', op: 'deal.search', connection: slot }],
    });
    expect(errorCodes(r)).toContain('op_step_connection_shape');
  });

  it('op_step_connection_unknown_variable when the slot names an undeclared variable', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar },
      steps: [{ id: 'deals', op: 'deal.search', connection: '{{config.ghost}}' }],
    });
    expect(errorCodes(r)).toContain('op_step_connection_unknown_variable');
  });

  it('op_step_connection_unknown_variable when the named variable is not type:connection', () => {
    const r = mkRecipe({
      variables: { top_n: { label: 'n', type: 'number', default: 10 } },
      steps: [{ id: 'deals', op: 'deal.search', connection: '{{config.top_n}}' }],
    });
    expect(errorCodes(r)).toContain('op_step_connection_unknown_variable');
  });

  it('op_step_connection_ambiguous when >1 connection variables and an op-step has no slot', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar, crm_b: connVar },
      steps: [{ id: 'deals', op: 'deal.search' }],
    });
    expect(errorCodes(r)).toContain('op_step_connection_ambiguous');
  });

  it('op_step_connection_ambiguous fires PER slot-less op-step — a slotted sibling does not cover it', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar, crm_b: connVar },
      steps: [
        { id: 'a_deals', op: 'deal.search', connection: '{{config.crm_a}}' },
        { id: 'b_deals', op: 'deal.search' },
      ],
    });
    const issues = validateRecipe(r).issues.filter(
      (i) => i.code === 'op_step_connection_ambiguous',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('steps[1]');
  });

  it('no ambiguity error with exactly one connection variable and a slot-less op-step', () => {
    const r = mkRecipe({
      variables: { crm: connVar },
      steps: [{ id: 'deals', op: 'deal.search' }],
    });
    expect(errorCodes(r)).toHaveLength(0);
  });

  it('a shape error short-circuits the unknown-variable check (one issue per slot)', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar },
      steps: [{ id: 'deals', op: 'deal.search', connection: 'config.ghost' }],
    });
    const cs = errorCodes(r);
    expect(cs).toContain('op_step_connection_shape');
    expect(cs).not.toContain('op_step_connection_unknown_variable');
  });

  it('slot checks do not run on a multi-discriminator step (already errored)', () => {
    const r = mkRecipe({
      variables: { crm_a: connVar, crm_b: connVar },
      steps: [{ id: 'deals', op: 'deal.search', transform: 'count', array: '{{step.x}}' }],
    });
    const cs = errorCodes(r);
    expect(cs).toContain('step_multi_discriminator');
    expect(cs).not.toContain('op_step_connection_ambiguous');
  });
});
