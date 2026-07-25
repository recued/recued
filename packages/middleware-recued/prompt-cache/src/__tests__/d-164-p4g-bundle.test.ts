import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import {
  runGate,
  type DataPresenceProbe,
  type DataSnapshot,
  type GateDeps,
} from '../index';
import type { SlotValue } from '../ner/index';
import {
  BUNDLE_POOL_NAME,
  BundlePoolError,
  computeBundleEntryHash,
  createBundlePool,
  createTemplateLibrary,
  createTemplateRenderer,
  validateBundleEntry,
  type BundleEntryInput,
  type BundleInvalidReason,
  type BundleValidation,
  type RegisteredTemplate,
} from '../templates/index';
import type {
  RenderTemplate,
  SlotName,
  StructuralPlan,
  Template,
} from '../types';

interface MakeRenderTemplateOptions {
  readonly body?: string;
  readonly locale?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
  readonly template_hash?: string;
}

const makeRenderTemplate = (
  opts: MakeRenderTemplateOptions = {},
): RenderTemplate => {
  const body = opts.body ?? 'Hello {{contact.name}}';
  const locale = opts.locale ?? 'en';
  const slotGrammar = [...(opts.slot_grammar ?? [])];
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

const makeBundleEntry = (
  opts: MakeRenderTemplateOptions = {},
): BundleEntryInput => {
  const locale = opts.locale ?? 'en';
  return {
    template: makeRenderTemplate({ ...opts, locale }),
    locale,
  };
};

const makeStructuralPlan = (
  overrides: Partial<Pick<StructuralPlan, 'template_hash' | 'slot_grammar'>> = {},
): StructuralPlan => ({
  template_hash: overrides.template_hash ?? 'tpl_structural',
  kind: 'structural_plan',
  slot_grammar: overrides.slot_grammar ?? [],
  action_class: 'read',
  short_circuit_eligible: false,
});

const makeInvalidActionEntry = (
  actionClass: unknown,
): BundleEntryInput => ({
  template: {
    ...makeRenderTemplate({ body: 'static body' }),
    action_class: actionClass,
  } as unknown as RenderTemplate,
  locale: 'en',
});

const makeInvalidShortCircuitEntry = (
  shortCircuitEligible: unknown,
): BundleEntryInput => ({
  template: {
    ...makeRenderTemplate({ body: 'static body' }),
    short_circuit_eligible: shortCircuitEligible,
  } as unknown as RenderTemplate,
  locale: 'en',
});

const makeHashMismatchEntry = (
  index: number,
  template_hash = `bad-${index}`,
): BundleEntryInput => makeBundleEntry({
  body: `static body ${index}`,
  template_hash,
});

const expectInvalid = (
  result: BundleValidation,
  reason: BundleInvalidReason,
): Extract<BundleValidation, { readonly kind: 'invalid' }> => {
  if (result.kind !== 'invalid') {
    throw new Error(`expected invalid ${reason}, got ok`);
  }
  expect(result.reason).toBe(reason);
  return result;
};

const expectOk = (
  result: BundleValidation,
): Extract<BundleValidation, { readonly kind: 'ok' }> => {
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  }
  return result;
};

const expectBundlePoolError = (
  entries: ReadonlyArray<BundleEntryInput>,
): BundlePoolError => {
  try {
    createBundlePool({ entries });
  } catch (err) {
    expect(err).toBeInstanceOf(BundlePoolError);
    return err as BundlePoolError;
  }
  throw new Error('expected BundlePoolError');
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

const makeSlot = (
  kind: SlotName,
  value: string = kind,
  position = 0,
): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const makeSessionEntry = (
  role: SessionEntry['role'],
  text: string,
  ts = 0,
): SessionEntry => ({
  session_id: 's',
  surface: 'chat',
  role,
  text,
  ts,
});

const makeTurnContext = (history: readonly SessionEntry[]) => {
  const resolve = vi.fn();
  const ctx = {
    history,
    prompt: {
      contribute: vi.fn(),
      parts: () => [],
    },
    resolve,
    state: new Map<string, unknown>(),
  } as unknown as TurnContext;

  return { ctx, resolve };
};

describe('D-164 P4g bundle hash', () => {
  it('is deterministic for the same inputs', () => {
    const input = {
      body: 'Hello {{contact.name}}',
      locale: 'en',
      slot_grammar: ['entity.name'] as const,
    };

    expect(computeBundleEntryHash(input)).toBe(computeBundleEntryHash(input));
  });

  it('changes when the body changes', () => {
    const base = {
      locale: 'en',
      slot_grammar: ['entity.email'] as const,
    };

    expect(computeBundleEntryHash({ ...base, body: 'Email {{email}}' }))
      .not.toBe(computeBundleEntryHash({ ...base, body: 'Name {{email}}' }));
  });

  it('changes when the locale changes', () => {
    const base = {
      body: 'Hello {{contact.name}}',
      slot_grammar: ['entity.name'] as const,
    };

    expect(computeBundleEntryHash({ ...base, locale: 'en' }))
      .not.toBe(computeBundleEntryHash({ ...base, locale: 'fr' }));
  });

  it('sorts slot_grammar before hashing', () => {
    const base = {
      body: '{{name}} <{{email}}>',
      locale: 'en',
    };

    expect(computeBundleEntryHash({
      ...base,
      slot_grammar: ['entity.name', 'entity.email'],
    })).toBe(computeBundleEntryHash({
      ...base,
      slot_grammar: ['entity.email', 'entity.name'],
    }));
  });

  it('preserves duplicate slot_grammar entries while hashing', () => {
    const base = {
      body: '{{name}}',
      locale: 'en',
    };

    expect(computeBundleEntryHash({ ...base, slot_grammar: ['entity.name'] }))
      .not.toBe(computeBundleEntryHash({
        ...base,
        slot_grammar: ['entity.name', 'entity.name'],
      }));
  });

  it('hashes an empty body and empty slot_grammar', () => {
    const hash = computeBundleEntryHash({
      body: '',
      locale: 'en',
      slot_grammar: [],
    });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-char lowercase hex string', () => {
    const hash = computeBundleEntryHash({
      body: 'Hello {{contact.name}}',
      locale: 'en',
      slot_grammar: ['entity.name'],
    });

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is sensitive to a single-character body change', () => {
    const base = {
      locale: 'en',
      slot_grammar: ['entity.email'] as const,
    };

    expect(computeBundleEntryHash({ ...base, body: 'Email {{email}}.' }))
      .not.toBe(computeBundleEntryHash({ ...base, body: 'Email {{email}}!' }));
  });
});

describe('D-164 P4g bundle validator', () => {
  it('accepts a valid render_template with the correct hash', () => {
    const entry = makeBundleEntry({
      body: 'Hello {{contact.name}}',
      slot_grammar: ['entity.name'],
    });

    const result = expectOk(validateBundleEntry(entry));

    expect(result.entry.template).toBe(entry.template);
    expect(result.entry.locale).toBe('en');
  });

  it('rejects structural plans', () => {
    const result = validateBundleEntry({
      template: makeStructuralPlan(),
      locale: 'en',
    });

    const invalid = expectInvalid(result, 'kind_not_render_template');
    expect(invalid.detail).toContain('"structural_plan"');
  });

  it('rejects a render template with a runtime-invalid action_class', () => {
    const result = validateBundleEntry(makeInvalidActionEntry('write'));

    const invalid = expectInvalid(result, 'action_class_invalid');
    expect(invalid.detail).toBe('expected action_class \'read\', got "write"');
  });

  it('rejects a render template with a runtime-invalid short_circuit_eligible value', () => {
    const result = validateBundleEntry(makeInvalidShortCircuitEntry(false));

    const invalid = expectInvalid(result, 'short_circuit_eligible_invalid');
    expect(invalid.detail).toBe('expected short_circuit_eligible true, got false');
  });

  it.each([
    ['leading digit', '{{1foo}}'],
    ['dash in path', '{{a-b}}'],
    ['nested braces', '{{{{foo}}}}'],
    ['unclosed placeholder', '{{foo'],
  ] as const)('rejects malformed body placeholders: %s', (_name, body) => {
    const result = validateBundleEntry(makeBundleEntry({ body }));

    const invalid = expectInvalid(result, 'body_malformed');
    expect(invalid.detail).toBe(`malformed placeholder ${JSON.stringify(body)}`);
  });

  it.each([
    ['root __proto__', '{{__proto__.X}}', '__proto__.X', '__proto__'],
    ['constructor', '{{constructor.name}}', 'constructor.name', 'constructor'],
    ['prototype', '{{prototype.Y}}', 'prototype.Y', 'prototype'],
    ['mid-path __proto__', '{{a.__proto__.b}}', 'a.__proto__.b', '__proto__'],
  ] as const)('rejects forbidden placeholder paths: %s', (_name, body, path, segment) => {
    const result = validateBundleEntry(makeBundleEntry({ body }));

    const invalid = expectInvalid(result, 'forbidden_path');
    expect(invalid.detail).toBe(
      `placeholder ${JSON.stringify(path)} contains forbidden segment ${JSON.stringify(segment)}`,
    );
  });

  it('rejects hash mismatches with declared and computed values in the detail', () => {
    const entry = makeBundleEntry({
      body: 'Hello {{contact.name}}',
      slot_grammar: ['entity.name'],
      template_hash: 'declared-hash',
    });
    const computed = computeBundleEntryHash({
      body: 'Hello {{contact.name}}',
      locale: 'en',
      slot_grammar: ['entity.name'],
    });

    const invalid = expectInvalid(validateBundleEntry(entry), 'hash_mismatch');

    expect(invalid.detail).toBe(
      `expected ${JSON.stringify('declared-hash')}, computed ${JSON.stringify(computed)}`,
    );
  });

  it('escapes special characters in hash mismatch details', () => {
    const forgedHash = 'bad\nhash\tvalue\u0000';
    const invalid = expectInvalid(
      validateBundleEntry(makeBundleEntry({
        body: 'static body',
        template_hash: forgedHash,
      })),
      'hash_mismatch',
    );

    expect(invalid.detail).not.toContain('\n');
    expect(invalid.detail).not.toContain('\t');
    expect(invalid.detail).toContain('"bad\\nhash\\tvalue\\u0000"');
  });

  it('swallows missing_path dry-run errors for well-formed placeholder bodies', () => {
    const result = validateBundleEntry(makeBundleEntry({
      body: '{{contact.name}}',
      slot_grammar: ['entity.name'],
    }));

    expectOk(result);
  });

  it('accepts an empty body when the hash matches', () => {
    const result = validateBundleEntry(makeBundleEntry({
      body: '',
      slot_grammar: [],
    }));

    expectOk(result);
  });
});

describe('D-164 P4g bundle pool', () => {
  it('accepts empty entries', () => {
    const pool = createBundlePool({ entries: [] });

    expect(pool.name).toBe(BUNDLE_POOL_NAME);
    expect(pool.list()).toEqual([]);
  });

  it('exports the stable bundle pool name', () => {
    expect(BUNDLE_POOL_NAME).toBe('bundle');
  });

  it('returns a single valid entry from list()', () => {
    const entry = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
    const pool = createBundlePool({ entries: [entry] });

    expect(pool.list()).toEqual([entry]);
  });

  it('aggregates mixed valid and invalid entries with exact indices and reasons', () => {
    const validEmail = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
    const validName = makeBundleEntry({
      body: 'Name {{contact.name}}',
      slot_grammar: ['entity.name'],
    });
    const structural: BundleEntryInput = {
      template: makeStructuralPlan(),
      locale: 'en',
    };

    const error = expectBundlePoolError([
      validEmail,
      makeInvalidActionEntry('write'),
      validName,
      structural,
    ]);

    expect(error.failures.map(({ index, reason }) => ({ index, reason }))).toEqual([
      { index: 1, reason: 'action_class_invalid' },
      { index: 3, reason: 'kind_not_render_template' },
    ]);
  });

  it('aggregates all-invalid entries', () => {
    const error = expectBundlePoolError([
      { template: makeStructuralPlan(), locale: 'en' },
      makeInvalidShortCircuitEntry(false),
      makeHashMismatchEntry(0),
    ]);

    expect(error.failures.map(({ index, reason }) => ({ index, reason }))).toEqual([
      { index: 0, reason: 'kind_not_render_template' },
      { index: 1, reason: 'short_circuit_eligible_invalid' },
      { index: 2, reason: 'hash_mismatch' },
    ]);
  });

  it('accepts all valid entries and preserves their order', () => {
    const entries = [
      makeBundleEntry({ body: 'Email {{contact.email}}', slot_grammar: ['entity.email'] }),
      makeBundleEntry({ body: 'Name {{contact.name}}', slot_grammar: ['entity.name'] }),
      makeBundleEntry({ body: 'Static answer', slot_grammar: [] }),
    ];

    const pool = createBundlePool({ entries });

    expect(pool.list()).toEqual(entries);
  });

  it('reports entry_unprocessable when validator property access throws', () => {
    const boom = new Error('kind getter exploded');
    const throwingTemplate = {
      get kind(): never {
        throw boom;
      },
    } as unknown as Template;

    const error = expectBundlePoolError([{
      template: throwingTemplate,
      locale: 'en',
    }]);

    expect(error.failures).toEqual([{
      index: 0,
      reason: 'entry_unprocessable',
      detail: 'validator threw: kind getter exploded',
    }]);
  });

  it('reports every entry_unprocessable validator throw', () => {
    const firstTemplate = {
      get kind(): never {
        throw new Error('first exploded');
      },
    } as unknown as Template;
    const secondTemplate = {
      get kind(): never {
        throw new Error('second exploded');
      },
    } as unknown as Template;

    const error = expectBundlePoolError([
      { template: firstTemplate, locale: 'en' },
      { template: secondTemplate, locale: 'en' },
    ]);

    expect(error.failures.map(({ index, reason, detail }) => ({ index, reason, detail })))
      .toEqual([
        {
          index: 0,
          reason: 'entry_unprocessable',
          detail: 'validator threw: first exploded',
        },
        {
          index: 1,
          reason: 'entry_unprocessable',
          detail: 'validator threw: second exploded',
        },
      ]);
  });

  it('caps BundlePoolError messages at ten failures with an overflow row', () => {
    const error = expectBundlePoolError(
      Array.from({ length: 12 }, (_unused, index) => makeHashMismatchEntry(index)),
    );

    expect(error.message).toContain('bundle pool: 12 invalid entries');
    expect(error.message).toContain('[0] hash_mismatch');
    expect(error.message).toContain('[9] hash_mismatch');
    expect(error.message).not.toContain('[10] hash_mismatch');
    expect(error.message).toContain('... and 2 more');
  });

  it('keeps BundlePoolError.failures uncapped', () => {
    const error = expectBundlePoolError(
      Array.from({ length: 12 }, (_unused, index) => makeHashMismatchEntry(index)),
    );

    expect(error.failures).toHaveLength(12);
    expect(error.failures[10]).toMatchObject({
      index: 10,
      reason: 'hash_mismatch',
    });
    expect(error.failures[11]).toMatchObject({
      index: 11,
      reason: 'hash_mismatch',
    });
  });

  it('escapes failure details in BundlePoolError messages', () => {
    const error = expectBundlePoolError([
      makeHashMismatchEntry(0, 'bad\n  [99] forged-row'),
    ]);

    expect(error.message.split('\n')).toHaveLength(2);
    expect(error.message).toContain('forged-row');
    expect(error.message).not.toContain('\n  [99] forged-row');
  });

  it('freezes an independent copy so caller mutations cannot affect the pool', () => {
    const entry = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
    const pool = createBundlePool({ entries: [entry] });
    const pooledBefore = requireFirst(pool.list());

    (entry as { locale: string }).locale = 'fr';
    (entry.template as { body: string }).body = 'mutated';
    (entry.template.slot_grammar as SlotName[]).push('date');

    const pooledAfter = requireFirst(pool.list());
    expect(pooledAfter).toBe(pooledBefore);
    expect(pooledAfter.locale).toBe('en');
    expect(pooledAfter.template).toMatchObject({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
  });

  it('deep-freezes the list, entries, templates, and slot grammar arrays', () => {
    const pool = createBundlePool({
      entries: [makeBundleEntry({
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
      (list as RegisteredTemplate[]).push(makeBundleEntry());
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

    expect(first.locale).toBe('en');
    expect(first.template.kind).toBe('render_template');
    if (first.template.kind !== 'render_template') {
      throw new Error('expected render_template');
    }
    expect(first.template.body).toBe('Email {{contact.email}}');
    expect(first.template.slot_grammar).toEqual(['entity.email']);
  });

  it('integrates with the template library matcher', () => {
    const pool = createBundlePool({
      entries: [makeBundleEntry({
        body: 'Email {{contact.email}}',
        slot_grammar: ['entity.email'],
      })],
    });
    const library = createTemplateLibrary({ pools: [pool] });
    const pooledEntry = requireFirst(pool.list());

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com', 6)],
      locale: 'en',
    })).toBe(pooledEntry.template);
  });

  it('preserves bundle pool iteration order through the template library', () => {
    const entries = [
      makeBundleEntry({
        body: 'first {{contact.email}}',
        slot_grammar: ['entity.email'],
      }),
      makeBundleEntry({
        body: 'second {{contact.email}}',
        slot_grammar: ['entity.email'],
      }),
    ];
    const pool = createBundlePool({ entries });
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com', 6)],
      locale: 'en',
    })).toBe(requireFirst(pool.list()).template);
  });

  it('integrates with the gate for an end-to-end short-circuit', async () => {
    const pool = createBundlePool({
      entries: [makeBundleEntry({
        body: 'Alice email is {{contact.email}}',
        slot_grammar: ['entity.email'],
      })],
    });
    const library = createTemplateLibrary({ pools: [pool] });
    const snapshot: DataSnapshot = Object.freeze({
      data: Object.freeze({
        contact: Object.freeze({
          email: 'alice@example.com',
        }),
      }),
    });
    const probeData = vi.fn<DataPresenceProbe>(() => snapshot);
    const deps: GateDeps = {
      matchTemplate: (query) => library.match(query),
      probeData,
      renderTemplate: createTemplateRenderer(),
    };
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', 'email alice@example.com', 1),
    ]);

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: 'Alice email is alice@example.com',
    });
    expect(resolve).toHaveBeenCalledWith('Alice email is alice@example.com');
    expect(probeData).toHaveBeenCalledWith({
      template: requireFirst(pool.list()).template,
      slots: [makeSlot('entity.email', 'alice@example.com', 6)],
    });
  });
});
