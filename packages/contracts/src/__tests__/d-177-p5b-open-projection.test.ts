/** D-177 P5b open-ended session grant projection walker tests. */

import { describe, expect, it } from 'vitest';

import {
  OPEN_PROJECTION_MAX_BYTES,
  OPEN_PROJECTION_MAX_NODES,
  WIRE_AUTHORITY_ARG_PATHS,
  computeOpenProjection,
  isOpenProjectionRefusal,
  isWellFormedOpenProjection,
  type ComputeOpenProjectionArgs,
  type OpenProjection,
  type OpenProjectionComputation,
} from '../open-projection.js';

type FixtureStore = Record<string, unknown>;

const baseStore = (): FixtureStore => ({
  meta: { to: 'meta@example.test' },
  config: {
    x: 'config@example.test',
    src: 'source@example.test',
    fwd: 'forward@example.test',
    list: [{ email: 'item@example.test' }],
  },
  connection: {
    email: { address: 'connection@example.test' },
  },
  data: {
    contact: {
      x: { email: 'stored@example.test' },
    },
  },
  shared: { x: 'shared@example.test' },
  context: {
    event: {
      payload: { to: 'event@example.test' },
    },
  },
  item: { email: 'item@example.test' },
  step: {
    extract: { email: 'derived@example.test' },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fixtureStore = (overrides: FixtureStore = {}): FixtureStore => {
  const store = baseStore();
  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(store[key]) && isRecord(value)) {
      store[key] = { ...(store[key] as Record<string, unknown>), ...value };
    } else {
      store[key] = value;
    }
  }
  return store;
};

const normalizeRef = (ref: string): string =>
  ref.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();

const lookupRef = (store: FixtureStore, ref: string): unknown => {
  const normalized = normalizeRef(ref);
  let current: unknown = store;
  for (const segment of normalized.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const resolveValue = (store: FixtureStore, value: unknown): unknown => {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (whole !== null) return lookupRef(store, whole[1]!);
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, ref: string) =>
      String(lookupRef(store, ref)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(store, item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveValue(store, child);
    return out;
  }
  return value;
};

const compute = (args: {
  readonly mergedArgs: Record<string, unknown>;
  readonly authorityPaths?: readonly string[];
  readonly steps?: readonly unknown[];
  readonly gatedStepId?: string;
  readonly eventContextTrusted?: boolean;
  readonly store?: FixtureStore;
  readonly ingredientKinds?: ReadonlyMap<string, string>;
}) => {
  const store = fixtureStore(args.store);
  const input: ComputeOpenProjectionArgs = {
    mergedArgs: args.mergedArgs,
    authorityPaths: [
      ...WIRE_AUTHORITY_ARG_PATHS,
      ...(args.authorityPaths ?? ['to']),
    ],
    steps: args.steps ?? [],
    ...(args.gatedStepId !== undefined ? { gatedStepId: args.gatedStepId } : {}),
    ...(args.eventContextTrusted !== undefined
      ? { eventContextTrusted: args.eventContextTrusted }
      : {}),
    resolveRootValue: (ref) => lookupRef(store, ref),
    resolveArgValue: (unresolvedValue) => resolveValue(store, unresolvedValue),
    getIngredientKind: (slug) => args.ingredientKinds?.get(slug),
  };
  return computeOpenProjection(input);
};

const expectProjection = (
  result: ReturnType<typeof computeOpenProjection>,
): OpenProjectionComputation => {
  expect(isOpenProjectionRefusal(result)).toBe(false);
  if (isOpenProjectionRefusal(result)) throw new Error(result.refused);
  return result;
};

const expectRefusal = (
  result: ReturnType<typeof computeOpenProjection>,
  reason: string,
): void => {
  expect(isOpenProjectionRefusal(result)).toBe(true);
  if (!isOpenProjectionRefusal(result)) throw new Error('expected refusal');
  expect(result.refused).toContain(reason);
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('computeOpenProjection origin classification', () => {
  it('pins a literal authority value via skeleton with no roots', () => {
    const result = expectProjection(compute({ mergedArgs: { to: 'literal@example.test' } }));

    expect(result.projection.args).toEqual([
      {
        path: 'to',
        skeleton: 'literal@example.test',
        roots: [],
      },
    ]);
    expect(result.preview.pinned).toEqual([
      { label: 'to', value: '"literal@example.test"' },
    ]);
  });

  it('classifies meta roots as pinned without derived_pinned', () => {
    const arg = expectProjection(compute({ mergedArgs: { to: '{{meta.to}}' } }))
      .projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'meta.to', origin: 'meta', pinned: 'meta@example.test' },
    ]);
    expect(arg).not.toHaveProperty('derived_pinned');
  });

  it('classifies config roots as tainted, pinned, and derived-pinned', () => {
    const arg = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }))
      .projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'config.x', origin: 'config', pinned: 'config@example.test' },
    ]);
    expect(arg.derived_pinned).toBe('config@example.test');
  });

  it('classifies connection roots as clean varying without derived_pinned', () => {
    const arg = expectProjection(
      compute({ mergedArgs: { to: '{{connection.email.address}}' } }),
    ).projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'connection.email.address', origin: 'connection' },
    ]);
    expect(arg).not.toHaveProperty('derived_pinned');
  });

  it.each([
    ['data.contact.x.email', 'stored@example.test'],
    ['shared.x', 'shared@example.test'],
  ])('classifies %s as stored tainted, pinned, and derived-pinned', (ref, pinned) => {
    const arg = expectProjection(compute({ mergedArgs: { to: `{{${ref}}}` } }))
      .projection.args[0]!;

    expect(arg.roots).toEqual([{ ref, origin: 'stored', pinned }]);
    expect(arg.derived_pinned).toBe(pinned);
  });

  it('classifies trusted context.event roots as clean varying', () => {
    const arg = expectProjection(
      compute({
        mergedArgs: { to: '{{context.event.payload.to}}' },
        eventContextTrusted: true,
      }),
    ).projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'context.event.payload.to', origin: 'context_event' },
    ]);
    expect(arg).not.toHaveProperty('derived_pinned');
  });

  it.each([false, undefined])(
    'refuses context.event when eventContextTrusted is %s',
    (eventContextTrusted) => {
      expectRefusal(
        compute({
          mergedArgs: { to: '{{context.event.payload.to}}' },
          ...(eventContextTrusted !== undefined ? { eventContextTrusted } : {}),
        }),
        'untrusted_context_event',
      );
    },
  );
});

describe('computeOpenProjection refusals', () => {
  it.each([
    ['{{context.server.region}}', 'unclassified_context_root'],
    ['{{context.recipe.id}}', 'unclassified_context_root'],
    ['{{bogus.x}}', 'unknown_namespace'],
    ['{{prefs.theme}}', 'unclassified_root:prefs.theme'],
    ['{{data.x.{{item.id}}}}', 'dynamic_nested_ref'],
  ])('refuses %s with %s', (to, reason) => {
    expectRefusal(compute({ mergedArgs: { to } }), reason);
  });

  it('refuses item refs without a step context', () => {
    expectRefusal(
      compute({ mergedArgs: { to: '{{item.email}}' } }),
      'item_ref_without_step_context',
    );
  });

  it('refuses item refs without a foreach or transform collection source', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{item.email}}' },
        steps: [{ id: 'send', ingredient: 'mail.send' }],
        gatedStepId: 'send',
      }),
      'item_ref_without_collection_source',
    );
  });

  it('refuses step refs to unknown producers', () => {
    expectRefusal(
      compute({ mergedArgs: { to: '{{step.missing.email}}' } }),
      'unknown_producing_step:missing',
    );
  });

  it('refuses cyclic step output provenance', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{step.a.email}}' },
        steps: [
          { id: 'a', transform: 'pick', value: '{{step.b.email}}' },
          { id: 'b', transform: 'pick', value: '{{step.a.email}}' },
        ],
      }),
      'step_cycle:a',
    );
  });

  it('refuses an empty authority set', () => {
    expectRefusal(
      compute({ mergedArgs: { recipient: 'literal@example.test' }, authorityPaths: [] }),
      'no_authority_args_present',
    );
  });
});

describe('computeOpenProjection step recursion and AI propagation', () => {
  it('propagates taint through transform step outputs', () => {
    const arg = expectProjection(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [{ id: 'extract', transform: 'pick', value: '{{config.src}}' }],
      }),
    ).projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'config.src', origin: 'config', pinned: 'source@example.test' },
    ]);
    expect(arg.derived_pinned).toBe('derived@example.test');
  });

  it('propagates taint through AI ingredient inputs', () => {
    const arg = expectProjection(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [
          {
            id: 'extract',
            ingredient: 'ai.extract',
            input: { 'llm.data': '{{config.fwd}}' },
          },
        ],
        ingredientKinds: new Map([['ai.extract', 'ai']]),
      }),
    ).projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'config.fwd', origin: 'config', pinned: 'forward@example.test' },
    ]);
    expect(arg.derived_pinned).toBe('derived@example.test');
  });

  it('refuses AI steps with search enabled', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [
          {
            id: 'extract',
            ingredient: 'ai.extract',
            input: { 'llm.allow_search': true, 'llm.data': '{{config.fwd}}' },
          },
        ],
        ingredientKinds: new Map([['ai.extract', 'ai']]),
      }),
      'ai_allow_search',
    );
  });

  it('refuses AI steps with file_ref input', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [
          {
            id: 'extract',
            ingredient: 'ai.extract',
            input: { file_ref: '{{data.file.1}}' },
          },
        ],
        ingredientKinds: new Map([['ai.extract', 'ai']]),
      }),
      'ai_file_ref',
    );
  });

  it('refuses non-AI ingredient outputs as IO boundaries', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [{ id: 'extract', ingredient: 'http.get', input: { url: '{{config.src}}' } }],
        ingredientKinds: new Map([['http.get', 'http']]),
      }),
      'io_step_output:extract',
    );
  });

  it('refuses op step outputs as IO boundaries', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{step.extract.email}}' },
        steps: [{ id: 'extract', op: 'mail.send', input: { to: '{{config.src}}' } }],
      }),
      'io_step_output:extract',
    );
  });
});

describe('computeOpenProjection item inheritance and dotted paths', () => {
  it('inherits item provenance from the gated step foreach source', () => {
    const arg = expectProjection(
      compute({
        mergedArgs: { to: '{{item.email}}' },
        steps: [{ id: 'send', ingredient: 'mail.send', foreach: '{{config.list}}' }],
        gatedStepId: 'send',
      }),
    ).projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: 'config.list', origin: 'config', pinned: [{ email: 'item@example.test' }] },
    ]);
    expect(arg.derived_pinned).toBe('item@example.test');
  });

  it('finds flat dotted authority keys before nested paths', () => {
    const flatArg = expectProjection(
      compute({
        mergedArgs: { 'body.to': '{{config.x}}' },
        authorityPaths: ['body.to'],
      }),
    ).projection.args[0]!;

    expect(flatArg.path).toBe('body.to');
    expect(flatArg.roots[0]).toEqual({
      ref: 'config.x',
      origin: 'config',
      pinned: 'config@example.test',
    });

    const nestedArg = expectProjection(
      compute({
        mergedArgs: { body: { to: '{{config.x}}' } },
        authorityPaths: ['body.to'],
      }),
    ).projection.args[0]!;

    expect(nestedArg.path).toBe('body.to');
    expect(nestedArg.roots[0]).toEqual(flatArg.roots[0]);
  });
});

describe('computeOpenProjection hash stability', () => {
  it('returns identical hashes for identical inputs', () => {
    const first = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }));
    const second = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }));

    expect(first.pinned_projection_hash).toBe(second.pinned_projection_hash);
  });

  it('changes hash when a pinned config value changes', () => {
    const first = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }));
    const second = expectProjection(
      compute({
        mergedArgs: { to: '{{config.x}}' },
        store: { config: { x: 'changed@example.test' } },
      }),
    );

    expect(first.pinned_projection_hash).not.toBe(second.pinned_projection_hash);
  });

  it('keeps hash stable when only a clean trusted context.event value changes', () => {
    const first = expectProjection(
      compute({
        mergedArgs: { to: '{{context.event.payload.to}}' },
        eventContextTrusted: true,
      }),
    );
    const second = expectProjection(
      compute({
        mergedArgs: { to: '{{context.event.payload.to}}' },
        eventContextTrusted: true,
        store: {
          context: { event: { payload: { to: 'other-event@example.test' } } },
        },
      }),
    );

    expect(first.pinned_projection_hash).toBe(second.pinned_projection_hash);
  });

  it('changes hash when the manifest authority path set changes', () => {
    const mergedArgs = { to: '{{config.x}}', cc: 'copy@example.test' };
    const oneArg = expectProjection(compute({ mergedArgs, authorityPaths: ['to'] }));
    const twoArgs = expectProjection(compute({ mergedArgs, authorityPaths: ['to', 'cc'] }));

    expect(oneArg.pinned_projection_hash).not.toBe(twoArgs.pinned_projection_hash);
  });
});

describe('computeOpenProjection size and JSON safety caps', () => {
  it('refuses pinned values that exhaust the node budget', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{config.huge}}' },
        store: {
          config: {
            huge: Array.from({ length: OPEN_PROJECTION_MAX_NODES + 1 }, () => 'x'),
          },
        },
      }),
      'node_budget_exhausted',
    );
  });

  it('refuses projections over the serialized byte cap while under the node cap', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{config.big}}' },
        store: {
          config: { big: 'x'.repeat(OPEN_PROJECTION_MAX_BYTES + 1) },
        },
      }),
      'projection_over_size_cap',
    );
  });

  it('refuses non-JSON pinned values resolved at a root', () => {
    expectRefusal(
      compute({
        mergedArgs: { to: '{{config.nonjson}}' },
        store: { config: { nonjson: 1n } },
      }),
      'pinned_value_not_json',
    );
  });
});

describe('isWellFormedOpenProjection', () => {
  it('accepts a valid computed projection', () => {
    const projection = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }))
      .projection;

    expect(isWellFormedOpenProjection(projection)).toBe(true);
  });

  it('rejects invalid stored projection shapes', () => {
    const tainted = expectProjection(compute({ mergedArgs: { to: '{{config.x}}' } }))
      .projection;
    const clean = expectProjection(
      compute({ mergedArgs: { to: '{{connection.email.address}}' } }),
    ).projection;

    const wrongVersion = clone(tainted) as unknown as Record<string, unknown>;
    wrongVersion.version = 2;
    expect(isWellFormedOpenProjection(wrongVersion)).toBe(false);

    expect(isWellFormedOpenProjection({ version: 1, args: [] })).toBe(false);

    const unknownOrigin = clone(tainted) as OpenProjection;
    (unknownOrigin.args[0]!.roots[0] as unknown as Record<string, unknown>).origin =
      'unknown';
    expect(isWellFormedOpenProjection(unknownOrigin)).toBe(false);

    const missingRootPin = clone(tainted) as OpenProjection;
    delete (missingRootPin.args[0]!.roots[0] as unknown as Record<string, unknown>).pinned;
    expect(isWellFormedOpenProjection(missingRootPin)).toBe(false);

    const varyingWithPin = clone(clean) as OpenProjection;
    (varyingWithPin.args[0]!.roots[0] as unknown as Record<string, unknown>).pinned =
      'must-not-pin';
    expect(isWellFormedOpenProjection(varyingWithPin)).toBe(false);

    const missingDerived = clone(tainted) as OpenProjection;
    delete (missingDerived.args[0] as unknown as Record<string, unknown>).derived_pinned;
    expect(isWellFormedOpenProjection(missingDerived)).toBe(false);

    const cleanWithDerived = clone(clean) as OpenProjection;
    (cleanWithDerived.args[0] as unknown as Record<string, unknown>).derived_pinned =
      'must-not-pin';
    expect(isWellFormedOpenProjection(cleanWithDerived)).toBe(false);
  });
});
