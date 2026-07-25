import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import {
  runGate,
  type DataPresenceProbe,
  type DataSnapshot,
  type GateDeps,
  type TemplateMatcher,
  type TemplateRenderer,
} from '../index';
import type { SlotValue } from '../ner/index';
import {
  createTemplateLibrary,
  createTemplateRenderer,
  extractPlaceholderPaths,
  renderRenderTemplate,
  TemplateRenderError,
  type RegisteredTemplate,
  type TemplatePool,
} from '../templates/index';
import type {
  RenderTemplate,
  SlotName,
  StructuralPlan,
  Template,
} from '../types';

const makeRenderTemplate = (
  body: string,
  overrides: Partial<Pick<RenderTemplate, 'template_hash' | 'slot_grammar'>> = {},
): RenderTemplate => ({
  template_hash: overrides.template_hash ?? 'tpl_render',
  kind: 'render_template',
  slot_grammar: overrides.slot_grammar ?? [],
  action_class: 'read',
  short_circuit_eligible: true,
  body,
});

const makeStructuralPlan = (
  overrides: Partial<Pick<StructuralPlan, 'template_hash' | 'slot_grammar'>> = {},
): StructuralPlan => ({
  template_hash: overrides.template_hash ?? 'tpl_structural',
  kind: 'structural_plan',
  slot_grammar: overrides.slot_grammar ?? [],
  action_class: 'read',
  short_circuit_eligible: false,
});

const makeSnapshot = (data: Readonly<Record<string, unknown>>): DataSnapshot => ({
  data,
});

const renderBody = (
  body: string,
  data: Readonly<Record<string, unknown>>,
): string => renderRenderTemplate(makeRenderTemplate(body), makeSnapshot(data));

const expectTemplateRenderError = (
  body: string,
  data: Readonly<Record<string, unknown>>,
  expected: {
    readonly reason: TemplateRenderError['reason'];
    readonly path: string;
    readonly template_hash?: string;
  },
): TemplateRenderError => {
  const templateHash = expected.template_hash ?? 'tpl_error';
  try {
    renderRenderTemplate(
      makeRenderTemplate(body, { template_hash: templateHash }),
      makeSnapshot(data),
    );
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateRenderError);
    const renderError = err as TemplateRenderError;
    expect(renderError.name).toBe('TemplateRenderError');
    expect(renderError.reason).toBe(expected.reason);
    expect(renderError.path).toBe(expected.path);
    expect(renderError.template_hash).toBe(templateHash);
    expect(renderError.message).toContain(templateHash);
    return renderError;
  }
  throw new Error(`expected TemplateRenderError for ${body}`);
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

const makePool = (
  name: string,
  entries: ReadonlyArray<RegisteredTemplate>,
) => {
  const list = vi.fn<TemplatePool['list']>(() => entries);
  return { name, list };
};

const registered = (
  template: Template,
  locale = 'en',
): RegisteredTemplate => ({
  template,
  locale,
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

describe('D-164 P4f render-body placeholder grammar', () => {
  it('renders a literal placeholder path', () => {
    expect(renderBody('{{name}}', { name: 'Alice' })).toBe('Alice');
  });

  it('trims whitespace inside placeholder braces', () => {
    expect(renderBody('Hello {{ contact_name }}', { contact_name: 'Bob' })).toBe('Hello Bob');
  });

  it('renders dot paths through nested own properties', () => {
    expect(renderBody('{{contact.profile.email}}', {
      contact: {
        profile: {
          email: 'alice@example.com',
        },
      },
    })).toBe('alice@example.com');
  });

  it('accepts letter or underscore starts and alphanumeric underscore tails', () => {
    expect(renderBody('{{_root.A1_b.c_2}}', {
      _root: {
        A1_b: {
          c_2: 'identifier-ok',
        },
      },
    })).toBe('identifier-ok');
  });

  it('renders multiple placeholders in one body', () => {
    expect(renderBody('{{first}} <{{email}}> at {{time}}', {
      first: 'Alice',
      email: 'alice@example.com',
      time: '09:30',
    })).toBe('Alice <alice@example.com> at 09:30');
  });

  it('renders repeated paths each time they appear', () => {
    expect(renderBody('{{name}}/{{name}}/{{name}}', { name: 'Alice' }))
      .toBe('Alice/Alice/Alice');
  });

  it('returns a body with no placeholders unchanged', () => {
    expect(renderBody('plain text only', { unused: 'value' })).toBe('plain text only');
  });

  it('returns an empty body unchanged', () => {
    expect(renderBody('', { name: 'Alice' })).toBe('');
  });
});

describe('D-164 P4f render-body malformed placeholders', () => {
  it.each([
    ['empty path', '{{}}', '{{}}'],
    ['leading digit', '{{1foo}}', '{{1foo}}'],
    ['dash in path', '{{a-b}}', '{{a-b}}'],
    ['array index', '{{foo[0]}}', '{{foo[0]}}'],
    ['unclosed placeholder', '{{foo', '{{foo'],
    ['nested braces', '{{{{foo}}}}', '{{{{foo}}}}'],
    ['nested with content', '{{a{b}}', '{{a{b}}'],
    ['three opens two closes', '{{{foo}}', '{{{foo}}'],
    ['body ending with a single open brace', 'literal {', '{'],
  ] as const)('throws malformed_placeholder for %s', (_name, body, path) => {
    expectTemplateRenderError(
      body,
      { foo: 'ok', a: { b: 'ok' } },
      {
        reason: 'malformed_placeholder',
        path,
        template_hash: 'tpl_malformed',
      },
    );
  });
});

describe('D-164 P4f render-body missing_path and non_string_value', () => {
  it('throws missing_path when the final segment does not exist', () => {
    expectTemplateRenderError('{{contact.email}}', { contact: {} }, {
      reason: 'missing_path',
      path: 'contact.email',
    });
  });

  it.each([
    ['number', 42],
    ['boolean', true],
    ['object', { nested: 'value' }],
    ['array', ['value']],
    ['null', null],
  ] as const)('throws non_string_value when a path resolves to %s', (_kind, value) => {
    expectTemplateRenderError('{{value}}', { value }, {
      reason: 'non_string_value',
      path: 'value',
    });
  });

  it('throws missing_path when an own property resolves to undefined', () => {
    expectTemplateRenderError('{{contact.email}}', {
      contact: {
        email: undefined,
      },
    }, {
      reason: 'missing_path',
      path: 'contact.email',
    });
  });

  it('throws missing_path when an intermediate segment is null', () => {
    expectTemplateRenderError('{{contact.email}}', { contact: null }, {
      reason: 'missing_path',
      path: 'contact.email',
    });
  });
});

describe('D-164 P4f render-body prototype-pollution guards', () => {
  it('treats __proto__ as missing instead of reading from the prototype chain', () => {
    expectTemplateRenderError('{{__proto__.toString}}', {}, {
      reason: 'missing_path',
      path: '__proto__.toString',
    });
  });

  it('treats constructor as missing instead of exposing constructor properties', () => {
    expectTemplateRenderError('{{constructor.name}}', {}, {
      reason: 'missing_path',
      path: 'constructor.name',
    });
  });

  it('treats prototype as missing instead of exposing prototype properties', () => {
    expectTemplateRenderError('{{prototype.X}}', {}, {
      reason: 'missing_path',
      path: 'prototype.X',
    });
  });

  it('does not read inherited properties from the snapshot object', () => {
    const inherited = Object.create({ inheritedLeak: 'prototype leak' }) as Record<string, unknown>;

    expectTemplateRenderError('{{inheritedLeak}}', inherited, {
      reason: 'missing_path',
      path: 'inheritedLeak',
    });
  });

  it('never renders values injected onto Object.prototype', () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    objectPrototype.templateLeak = 'prototype leak';
    try {
      const renderer = createTemplateRenderer();
      const output = renderer(
        makeRenderTemplate('leaked={{templateLeak}}'),
        makeSnapshot({}),
      );

      expect(output).toBe('');
      expect(output).not.toContain('prototype leak');
    } finally {
      delete objectPrototype.templateLeak;
    }
  });
});

describe('D-164 P4f extractPlaceholderPaths', () => {
  it('returns paths in source order', () => {
    expect(extractPlaceholderPaths('{{first}} {{contact.email}} {{_last2}}'))
      .toEqual(['first', 'contact.email', '_last2']);
  });

  it('preserves duplicate placeholders', () => {
    expect(extractPlaceholderPaths('{{name}} {{name}} {{contact.name}} {{name}}'))
      .toEqual(['name', 'name', 'contact.name', 'name']);
  });

  it('returns an empty array for a body with no placeholders', () => {
    expect(extractPlaceholderPaths('plain text only')).toEqual([]);
  });

  it('ignores malformed spans that do not match the strict placeholder regex', () => {
    expect(extractPlaceholderPaths('{{good}} {{bad-dash}} {{1bad}} {{also.good}}'))
      .toEqual(['good', 'also.good']);
  });

  it('does not run the malformed scanner before extracting strict regex matches', () => {
    expect(extractPlaceholderPaths('{{{{inner}}}} {{outer}}')).toEqual(['inner', 'outer']);
  });
});

describe('D-164 P4f createTemplateLibrary match', () => {
  it('returns null for empty pools', () => {
    const library = createTemplateLibrary({ pools: [] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    })).toBeNull();
  });

  it('matches a single template from a single pool', () => {
    const template = makeRenderTemplate('{{email}}', {
      template_hash: 'tpl_email',
      slot_grammar: ['entity.email'],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    })).toBe(template);
  });

  it('returns null on locale mismatch', () => {
    const template = makeRenderTemplate('{{email}}', {
      slot_grammar: ['entity.email'],
    });
    const pool = makePool('bundle', [registered(template, 'fr')]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    })).toBeNull();
  });

  it('returns null on slot grammar shape mismatch', () => {
    const template = makeRenderTemplate('{{email}}', {
      slot_grammar: ['entity.email'],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'find Alice',
      slots: [makeSlot('entity.name', 'Alice')],
      locale: 'en',
    })).toBeNull();
  });

  it('uses first-match wins across pools in registration order', () => {
    const bundleTemplate = makeRenderTemplate('bundle', {
      template_hash: 'tpl_bundle',
      slot_grammar: ['entity.email'],
    });
    const auditTemplate = makeRenderTemplate('audit', {
      template_hash: 'tpl_audit',
      slot_grammar: ['entity.email'],
    });
    const bundlePool = makePool('bundle', [registered(bundleTemplate)]);
    const auditPool = makePool('audit-grown', [registered(auditTemplate)]);
    const library = createTemplateLibrary({ pools: [bundlePool, auditPool] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    })).toBe(bundleTemplate);
    expect(bundlePool.list).toHaveBeenCalledTimes(1);
    expect(auditPool.list).not.toHaveBeenCalled();
  });

  it('uses first-match wins within a pool registration list', () => {
    const firstTemplate = makeRenderTemplate('first', {
      template_hash: 'tpl_first',
      slot_grammar: ['entity.email'],
    });
    const secondTemplate = makeRenderTemplate('second', {
      template_hash: 'tpl_second',
      slot_grammar: ['entity.email'],
    });
    const pool = makePool('bundle', [
      registered(firstTemplate),
      registered(secondTemplate),
    ]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    })).toBe(firstTemplate);
  });

  it('does not match a single-name grammar against two extracted names', () => {
    const template = makeRenderTemplate('{{name}}', {
      slot_grammar: ['entity.name'],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'Alice and Bob',
      slots: [
        makeSlot('entity.name', 'Alice', 0),
        makeSlot('entity.name', 'Bob', 10),
      ],
      locale: 'en',
    })).toBeNull();
  });

  it('does not match a duplicate-name grammar against one extracted name', () => {
    const template = makeRenderTemplate('{{first}} {{second}}', {
      slot_grammar: ['entity.name', 'entity.name'],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'Alice',
      slots: [makeSlot('entity.name', 'Alice')],
      locale: 'en',
    })).toBeNull();
  });

  it('matches duplicate slot grammars as a multiset regardless of extraction order', () => {
    const template = makeRenderTemplate('{{name}} {{email}} {{name}}', {
      slot_grammar: ['entity.name', 'entity.email', 'entity.name'],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'alice@example.com Alice Bob',
      slots: [
        makeSlot('entity.email', 'alice@example.com', 0),
        makeSlot('entity.name', 'Alice', 18),
        makeSlot('entity.name', 'Bob', 24),
      ],
      locale: 'en',
    })).toBe(template);
  });

  it('matches an empty slot grammar against empty extracted slots', () => {
    const template = makeRenderTemplate('static answer', {
      template_hash: 'tpl_empty',
      slot_grammar: [],
    });
    const pool = makePool('bundle', [registered(template)]);
    const library = createTemplateLibrary({ pools: [pool] });

    expect(library.match({
      text: 'static prompt',
      slots: [],
      locale: 'en',
    })).toBe(template);
  });

  it('calls pool.list on each match and does not memoize pool contents', () => {
    const template = makeRenderTemplate('{{email}}', {
      template_hash: 'tpl_late',
      slot_grammar: ['entity.email'],
    });
    const pool = {
      name: 'dynamic',
      list: vi.fn<TemplatePool['list']>()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([registered(template)]),
    };
    const library = createTemplateLibrary({ pools: [pool] });
    const query = {
      text: 'email bob@example.com',
      slots: [makeSlot('entity.email', 'bob@example.com')],
      locale: 'en',
    };

    expect(library.match(query)).toBeNull();
    expect(library.match(query)).toBe(template);
    expect(pool.list).toHaveBeenCalledTimes(2);
  });
});

describe('D-164 P4f createTemplateRenderer', () => {
  it('renders render_template bodies on the happy path', () => {
    const renderer = createTemplateRenderer();

    expect(renderer(
      makeRenderTemplate('Hello {{name}}'),
      makeSnapshot({ name: 'Alice' }),
    )).toBe('Hello Alice');
  });

  it('returns an empty string for structural_plan templates', () => {
    const renderer = createTemplateRenderer();

    expect(renderer(makeStructuralPlan(), makeSnapshot({ name: 'Alice' }))).toBe('');
  });

  it('catches TemplateRenderError, returns empty string, and invokes onRenderError', () => {
    const onRenderError = vi.fn<(error: TemplateRenderError) => void>();
    const renderer = createTemplateRenderer({ onRenderError });

    expect(renderer(makeRenderTemplate('{{missing}}'), makeSnapshot({}))).toBe('');
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError.mock.calls[0]?.[0]).toMatchObject({
      template_hash: 'tpl_render',
      path: 'missing',
      reason: 'missing_path',
    });
  });

  it('swallows a throwing onRenderError hook and still returns empty string', () => {
    const hookError = new Error('hook failed');
    const onRenderError = vi.fn<(error: TemplateRenderError) => void>(() => {
      throw hookError;
    });
    const renderer = createTemplateRenderer({ onRenderError });

    expect(() => renderer(makeRenderTemplate('{{missing}}'), makeSnapshot({})))
      .not.toThrow();
    expect(renderer(makeRenderTemplate('{{missing}}'), makeSnapshot({}))).toBe('');
    expect(onRenderError).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-TemplateRenderError failures from below the adapter', () => {
    const renderer = createTemplateRenderer();
    const boom = new Error('body getter failed');
    const throwingTemplate = {
      template_hash: 'tpl_throw',
      kind: 'render_template',
      slot_grammar: [],
      action_class: 'read',
      short_circuit_eligible: true,
      get body(): string {
        throw boom;
      },
    } satisfies RenderTemplate;

    expect(() => renderer(throwingTemplate, makeSnapshot({}))).toThrow(boom);
  });
});

describe('D-164 P4f gate not-short-circuit-eligible branch', () => {
  it('passes through structural plans without probing data or rendering', async () => {
    const emailText = 'email bob@example.com';
    const emailSlot = makeSlot('entity.email', 'bob@example.com', 6);
    const structuralPlan = makeStructuralPlan({
      template_hash: 'tpl_structural_email',
      slot_grammar: ['entity.email'],
    });
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', emailText, 1),
    ]);
    const matchTemplate = vi.fn<TemplateMatcher>(() => structuralPlan);
    const probeData = vi.fn<DataPresenceProbe>(() => {
      throw new Error('probeData must not run for structural plans');
    });
    const renderTemplate = vi.fn<TemplateRenderer>(() => {
      throw new Error('renderTemplate must not run for structural plans');
    });
    const deps: GateDeps = {
      matchTemplate,
      probeData,
      renderTemplate,
    };

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'not-short-circuit-eligible',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(matchTemplate).toHaveBeenCalledWith({
      text: emailText,
      slots: [emailSlot],
      locale: 'en',
    });
    expect(probeData).not.toHaveBeenCalled();
    expect(renderTemplate).not.toHaveBeenCalled();
  });
});
