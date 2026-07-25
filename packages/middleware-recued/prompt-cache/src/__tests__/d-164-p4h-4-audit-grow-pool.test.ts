import { describe, expect, it } from 'vitest';

import {
  validateAuditGrowEntry,
  type AuditGrowEntryInput,
  type AuditGrowInvalidReason,
  type AuditGrowValidation,
} from '../templates/audit-grow/validate';
import {
  AUDIT_GROW_POOL_NAME,
  AuditGrowPoolError,
  createAuditGrowPool,
  validateAuditGrowEntry as validateAuditGrowEntryFromAuditGrowBarrel,
} from '../templates/audit-grow/index';
import {
  AUDIT_GROW_POOL_NAME as AUDIT_GROW_POOL_NAME_FROM_PUBLIC_BARREL,
  AuditGrowPoolError as AuditGrowPoolErrorFromPublicBarrel,
  computeBundleEntryHash,
  createAuditGrowPool as createAuditGrowPoolFromPublicBarrel,
  validateAuditGrowEntry as validateAuditGrowEntryFromPublicBarrel,
  type RegisteredTemplate,
} from '../templates/index';
import type {
  RenderTemplate,
  SlotName,
  StructuralPlan,
  Template,
} from '../types';

const DEFAULT_SLOT_GRAMMAR: ReadonlyArray<SlotName> = ['entity.name'];
const DEFAULT_RENDER_STEP_KINDS: ReadonlyArray<string> = ['query', 'render'];
const DEFAULT_STRUCTURAL_STEP_KINDS: ReadonlyArray<string> = ['query', 'ai-extract'];

interface BuildRenderTemplateOptions {
  readonly body?: string;
  readonly locale?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
  readonly template_hash?: string;
}

interface BuildRenderEntryOptions extends BuildRenderTemplateOptions {
  readonly step_kinds?: ReadonlyArray<string>;
}

interface BuildStructuralPlanOptions {
  readonly template_hash?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
}

interface BuildStructuralEntryOptions extends BuildStructuralPlanOptions {
  readonly locale?: string;
  readonly step_kinds?: ReadonlyArray<string>;
}

const buildValidRenderTemplate = (
  opts: BuildRenderTemplateOptions = {},
): RenderTemplate => {
  const body = opts.body ?? 'Hello {{contact.name}}';
  const locale = opts.locale ?? 'en';
  const slotGrammar = [...(opts.slot_grammar ?? DEFAULT_SLOT_GRAMMAR)];

  return {
    template_hash: opts.template_hash ?? computeBundleEntryHash({
      body,
      locale,
      slot_grammar: slotGrammar,
    }),
    kind: 'render_template',
    slot_grammar: slotGrammar,
    action_class: 'read',
    short_circuit_eligible: true,
    body,
  };
};

const buildValidRenderEntry = (
  opts: BuildRenderEntryOptions = {},
): AuditGrowEntryInput => {
  const locale = opts.locale ?? 'en';

  return {
    template: buildValidRenderTemplate({ ...opts, locale }),
    locale,
    step_kinds: opts.step_kinds ?? DEFAULT_RENDER_STEP_KINDS,
  };
};

const buildValidStructuralPlan = (
  opts: BuildStructuralPlanOptions = {},
): StructuralPlan => ({
  template_hash: opts.template_hash ?? 'pinned',
  kind: 'structural_plan',
  slot_grammar: opts.slot_grammar ?? DEFAULT_SLOT_GRAMMAR,
  action_class: 'read',
  short_circuit_eligible: false,
});

const buildValidStructuralEntry = (
  opts: BuildStructuralEntryOptions = {},
): AuditGrowEntryInput => ({
  template: buildValidStructuralPlan(opts),
  locale: opts.locale ?? 'en',
  step_kinds: opts.step_kinds ?? DEFAULT_STRUCTURAL_STEP_KINDS,
});

const buildInvalidKindEntry = (
  kind = 'llm_template',
): AuditGrowEntryInput => ({
  template: {
    ...buildValidRenderTemplate(),
    kind,
  } as unknown as Template,
  locale: 'en',
  step_kinds: DEFAULT_RENDER_STEP_KINDS,
});

const buildInvalidActionEntry = (
  kind: 'render_template' | 'structural_plan',
  actionClass: unknown,
): AuditGrowEntryInput => ({
  template: kind === 'render_template'
    ? {
        ...buildValidRenderTemplate(),
        action_class: actionClass,
      } as unknown as Template
    : {
        ...buildValidStructuralPlan(),
        action_class: actionClass,
      } as unknown as Template,
  locale: 'en',
  step_kinds: kind === 'render_template'
    ? DEFAULT_RENDER_STEP_KINDS
    : DEFAULT_STRUCTURAL_STEP_KINDS,
});

const buildInvalidShortCircuitEntry = (
  kind: 'render_template' | 'structural_plan',
  shortCircuitEligible: unknown,
): AuditGrowEntryInput => ({
  template: kind === 'render_template'
    ? {
        ...buildValidRenderTemplate(),
        short_circuit_eligible: shortCircuitEligible,
      } as unknown as Template
    : {
        ...buildValidStructuralPlan(),
        short_circuit_eligible: shortCircuitEligible,
      } as unknown as Template,
  locale: 'en',
  step_kinds: kind === 'render_template'
    ? DEFAULT_RENDER_STEP_KINDS
    : DEFAULT_STRUCTURAL_STEP_KINDS,
});

const buildHashMismatchEntry = (
  index = 0,
  template_hash = `bad-${index}`,
): AuditGrowEntryInput => buildValidRenderEntry({
  body: `Hello {{contact.name}} ${index}`,
  template_hash,
});

const toRegisteredEntry = (
  entry: AuditGrowEntryInput,
): RegisteredTemplate => ({
  template: entry.template,
  locale: entry.locale,
});

const expectInvalid = (
  result: AuditGrowValidation,
  reason: AuditGrowInvalidReason,
): Extract<AuditGrowValidation, { readonly kind: 'invalid' }> => {
  if (result.kind !== 'invalid') {
    throw new Error(`expected invalid ${reason}, got ok`);
  }
  expect(result.reason).toBe(reason);
  return result;
};

const expectOk = (
  result: AuditGrowValidation,
): Extract<AuditGrowValidation, { readonly kind: 'ok' }> => {
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  }
  return result;
};

const expectAuditGrowPoolError = (
  entries: ReadonlyArray<AuditGrowEntryInput>,
): AuditGrowPoolError => {
  try {
    createAuditGrowPool({ entries });
  } catch (err) {
    expect(err).toBeInstanceOf(AuditGrowPoolError);
    return err as AuditGrowPoolError;
  }
  throw new Error('expected AuditGrowPoolError');
};

const requireFirst = <T>(items: ReadonlyArray<T>): T => {
  const first = items[0];
  if (first === undefined) throw new Error('expected first item');
  return first;
};

const expectBlockedMutation = (mutation: () => void): void => {
  try {
    mutation();
  } catch (err) {
    expect(err).toBeInstanceOf(TypeError);
  }
};

describe('D-164 P4h-4 audit-grow validator', () => {
  it('rejects empty step_kinds before classification', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildValidRenderEntry({ step_kinds: [] })),
      'step_kinds_empty',
    );

    expect(invalid.detail).toContain('step_kinds');
  });

  it('rejects a template kind outside render_template and structural_plan', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildInvalidKindEntry('bundle_template')),
      'kind_invalid',
    );

    expect(invalid.detail).toContain('"bundle_template"');
  });

  it('rejects invalid action_class on render_template', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildInvalidActionEntry('render_template', 'write')),
      'action_class_invalid',
    );

    expect(invalid.detail).toBe('expected action_class \'read\', got "write"');
  });

  it('rejects invalid action_class on structural_plan', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildInvalidActionEntry('structural_plan', 'write')),
      'action_class_invalid',
    );

    expect(invalid.detail).toBe('expected action_class \'read\', got "write"');
  });

  it.each([
    ['render_template', false, 'true'],
    ['render_template', null, 'true'],
    ['structural_plan', true, 'false'],
    ['structural_plan', null, 'false'],
  ] as const)(
    'rejects invalid short_circuit_eligible for %s when value is %s',
    (kind, shortCircuitEligible, expected) => {
      const invalid = expectInvalid(
        validateAuditGrowEntry(buildInvalidShortCircuitEntry(
          kind,
          shortCircuitEligible,
        )),
        'short_circuit_eligible_invalid',
      );

      expect(invalid.detail).toContain(
        `expected short_circuit_eligible ${expected}`,
      );
    },
  );

  it('rejects render_template when replayability classifies the steps as structural_plan', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildValidRenderEntry({
        step_kinds: ['query', 'ai-extract', 'render'],
      })),
      'step_kinds_mismatch_render_template',
    );

    expect(invalid.detail).toContain('ai-extract');
    expect(invalid.detail).toContain('disqualifying');
  });

  it('rejects malformed render_template bodies', () => {
    const invalid = expectInvalid(
      validateAuditGrowEntry(buildValidRenderEntry({ body: '{{foo' })),
      'body_malformed',
    );

    expect(invalid.detail).toBe(`malformed placeholder ${JSON.stringify('{{foo')}`);
  });

  it.each([
    ['__proto__', '{{__proto__.X}}', '__proto__.X', '__proto__'],
    ['constructor', '{{constructor.name}}', 'constructor.name', 'constructor'],
    ['prototype', '{{prototype.Y}}', 'prototype.Y', 'prototype'],
  ] as const)(
    'rejects render_template placeholder paths containing %s',
    (_name, body, path, segment) => {
      const invalid = expectInvalid(
        validateAuditGrowEntry(buildValidRenderEntry({ body })),
        'forbidden_path',
      );

      expect(invalid.detail).toBe(
        `placeholder ${JSON.stringify(path)} contains forbidden segment ${JSON.stringify(segment)}`,
      );
    },
  );

  it('rejects render_template hash mismatches', () => {
    const entry = buildValidRenderEntry({
      body: 'Hello {{contact.name}}',
      slot_grammar: ['entity.name'],
      template_hash: 'declared-hash',
    });
    const computed = computeBundleEntryHash({
      body: 'Hello {{contact.name}}',
      locale: 'en',
      slot_grammar: ['entity.name'],
    });

    const invalid = expectInvalid(
      validateAuditGrowEntry(entry),
      'hash_mismatch',
    );

    expect(invalid.detail).toBe(
      `expected ${JSON.stringify('declared-hash')}, computed ${JSON.stringify(computed)}`,
    );
  });

  it('accepts a valid render_template with the correct hash', () => {
    const entry = buildValidRenderEntry();
    const ok = expectOk(validateAuditGrowEntry(entry));

    expect(ok.entry.template).toBe(entry.template);
    expect(ok.entry.locale).toBe('en');
  });

  it('accepts structural_plan without body or hash validation', () => {
    const template = {
      ...buildValidStructuralPlan({ template_hash: 'not-a-content-hash' }),
      body: '{{{{broken}}}}',
    } as unknown as StructuralPlan;
    const entry: AuditGrowEntryInput = {
      template,
      locale: 'en',
      step_kinds: ['query'],
    };

    const ok = expectOk(validateAuditGrowEntry(entry));

    expect(ok.entry.template).toBe(template);
    expect(ok.entry.locale).toBe('en');
  });
});

describe('D-164 P4h-4 audit-grow pool', () => {
  it('accepts empty entries', () => {
    const pool = createAuditGrowPool({ entries: [] });

    expect(pool.name).toBe(AUDIT_GROW_POOL_NAME);
    expect(pool.list()).toEqual([]);
  });

  it('exports the stable audit-grow pool name', () => {
    expect(AUDIT_GROW_POOL_NAME).toBe('audit-grown');
  });

  it('accepts all valid entries and preserves their order', () => {
    const entries = [
      buildValidRenderEntry({
        body: 'Hello {{contact.name}}',
        slot_grammar: ['entity.name'],
      }),
      buildValidStructuralEntry({
        template_hash: 'structural-pinned',
        slot_grammar: ['entity.email'],
      }),
    ];

    const pool = createAuditGrowPool({ entries });

    expect(pool.list()).toEqual(entries.map(toRegisteredEntry));
  });

  it('aggregates mixed valid and invalid entries with exact indices and reasons', () => {
    const error = expectAuditGrowPoolError([
      buildValidRenderEntry(),
      buildInvalidActionEntry('render_template', 'write'),
      buildValidStructuralEntry(),
      buildHashMismatchEntry(3),
      buildInvalidKindEntry(),
      buildValidRenderEntry({ step_kinds: [] }),
    ]);

    expect(error.failures.map(({ index, reason }) => ({ index, reason }))).toEqual([
      { index: 1, reason: 'action_class_invalid' },
      { index: 3, reason: 'hash_mismatch' },
      { index: 4, reason: 'kind_invalid' },
      { index: 5, reason: 'step_kinds_empty' },
    ]);
  });

  it('throws AuditGrowPoolError with an uncapped failures array', () => {
    const error = expectAuditGrowPoolError([buildHashMismatchEntry()]);
    const failure = requireFirst(error.failures);

    expect(error.name).toBe('AuditGrowPoolError');
    expect(Array.isArray(error.failures)).toBe(true);
    expect(error.failures).toHaveLength(1);
    expect(failure).toMatchObject({
      index: 0,
      reason: 'hash_mismatch',
    });
    expect(failure.detail).toContain('computed');
  });

  it('reports entry_unprocessable when validator property access throws', () => {
    const throwingTemplate = {
      get kind(): never {
        throw new Error('kind getter exploded');
      },
    } as unknown as Template;

    const error = expectAuditGrowPoolError([{
      template: throwingTemplate,
      locale: 'en',
      step_kinds: ['query'],
    }]);

    expect(error.failures).toEqual([{
      index: 0,
      reason: 'entry_unprocessable',
      detail: 'validator threw: kind getter exploded',
    }]);
  });

  it('caps AuditGrowPoolError messages at ten failures with an overflow row', () => {
    const error = expectAuditGrowPoolError(
      Array.from({ length: 12 }, (_unused, index) => buildHashMismatchEntry(index)),
    );

    expect(error.message).toContain('audit-grow pool: 12 invalid entries');
    expect(error.message).toContain('[0] hash_mismatch');
    expect(error.message).toContain('[9] hash_mismatch');
    expect(error.message).not.toContain('[10] hash_mismatch');
    expect(error.message).toContain('... and 2 more');
    expect(error.failures).toHaveLength(12);
  });

  it('deep-freezes the list, entries, templates, and slot grammar arrays', () => {
    const pool = createAuditGrowPool({
      entries: [buildValidRenderEntry({
        body: 'Email {{contact.email}}',
        slot_grammar: ['entity.email'],
      })],
    });
    const list = pool.list();
    const first = requireFirst(list);

    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.template)).toBe(true);
    expect(Object.isFrozen(first.template.slot_grammar)).toBe(true);

    expectBlockedMutation(() => {
      (list as RegisteredTemplate[]).push(toRegisteredEntry(buildValidRenderEntry()));
    });
    expectBlockedMutation(() => {
      (first as { locale: string }).locale = 'fr';
    });
    expectBlockedMutation(() => {
      (first.template as { body: string }).body = 'mutated';
    });
    expectBlockedMutation(() => {
      (first.template.slot_grammar as SlotName[]).push('date');
    });

    expect(list).toHaveLength(1);
    expect(first.locale).toBe('en');
    expect(first.template.kind).toBe('render_template');
    if (first.template.kind !== 'render_template') {
      throw new Error('expected render_template');
    }
    expect(first.template.body).toBe('Email {{contact.email}}');
    expect(first.template.slot_grammar).toEqual(['entity.email']);
  });
});

describe('D-164 P4h-4 audit-grow export surface', () => {
  it('re-exports validateAuditGrowEntry via templates/audit-grow/index', () => {
    expect(validateAuditGrowEntryFromAuditGrowBarrel).toBe(validateAuditGrowEntry);
  });

  it('re-exports validateAuditGrowEntry via templates/index public barrel', () => {
    expect(validateAuditGrowEntryFromPublicBarrel).toBe(validateAuditGrowEntry);
  });

  it('re-exports createAuditGrowPool via templates/index public barrel', () => {
    expect(createAuditGrowPoolFromPublicBarrel).toBe(createAuditGrowPool);
  });

  it('re-exports AuditGrowPoolError via templates/index public barrel', () => {
    expect(AuditGrowPoolErrorFromPublicBarrel).toBe(AuditGrowPoolError);
  });

  it('re-exports AUDIT_GROW_POOL_NAME via templates/index public barrel', () => {
    expect(AUDIT_GROW_POOL_NAME_FROM_PUBLIC_BARREL).toBe(AUDIT_GROW_POOL_NAME);
  });
});
