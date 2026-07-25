import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import {
  createMiddlewareRegistry,
  type TurnContext,
} from '@recued/middleware';

import {
  DEFAULT_GATE_DEPS,
  createContactAttributePresenceProbe,
  createPromptCacheMiddleware,
  createTemplateRenderer,
  matchContactAttributeTemplate,
  noopDataPresenceProbe,
  promptCacheMiddleware,
  registerPromptCacheMiddleware,
  runGate,
  type DataPresenceProbe,
  type DataSnapshot,
  type GateDeps,
  type TemplateMatcher,
  type TemplateRenderer,
} from '../index';
import type { SlotValue } from '../ner/index';
import {
  attach,
  INTENTION_RESULT_STATE_KEY,
  type IntentionResult,
} from '../intention/index';
import type { Template } from '../types';

const EMAIL_TEXT = 'email bob@example.com';
const RENDERED_TEXT = 'Bob is bob@example.com';

const TEMPLATE: Template = {
  template_hash: 'tpl_email_lookup',
  kind: 'render_template',
  slot_grammar: ['entity.email'],
  action_class: 'read',
  short_circuit_eligible: true,
  body: '{{email}}',
};

const SNAPSHOT: DataSnapshot = {
  data: {
    email: 'bob@example.com',
  },
};

const EMAIL_SLOT: SlotValue = {
  kind: 'entity.email',
  value: 'bob@example.com',
  raw: 'bob@example.com',
  position: 6,
};

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

const makeTurnContext = (
  history: readonly SessionEntry[],
  state = new Map<string, unknown>(),
  surface: SessionEntry['surface'] = 'chat',
) => {
  const contribute = vi.fn();
  const resolve = vi.fn();
  const stateSet = vi.spyOn(state, 'set');
  const stateDelete = vi.spyOn(state, 'delete');
  const ctx = {
    // The deterministic short-circuit's surface scope is the P10
    // read-permission seam (`GateDeps.authorizeShortCircuitRead`; absent →
    // chat-only fallback — see `createPromptCacheMiddleware`); the default
    // fixture surface keeps the prompt-hook tests exercising the gate, and
    // the P10 describe below overrides it. `runGate` itself is
    // surface-agnostic, so the direct-`runGate` tests are unaffected.
    surface,
    history,
    prompt: {
      contribute,
      parts: () => [],
    },
    resolve,
    state,
  } as unknown as TurnContext;

  return { contribute, ctx, resolve, state, stateDelete, stateSet };
};

const makeIntentionResult = (
  referent: IntentionResult['referent'],
): IntentionResult => ({
  signal: {
    kind: 'pronoun',
    trigger: 'they',
    position: 0,
  },
  referent,
});

const makeDeps = ({
  matchResult = TEMPLATE,
  probeResult = SNAPSHOT,
  renderResult = RENDERED_TEXT,
}: {
  readonly matchResult?: Template | null;
  readonly probeResult?: DataSnapshot | null;
  readonly renderResult?: string;
} = {}) => {
  const matchTemplate = vi.fn<TemplateMatcher>(() => matchResult);
  const probeData = vi.fn<DataPresenceProbe>(() => probeResult);
  const renderTemplate = vi.fn<TemplateRenderer>(() => renderResult);
  const deps: GateDeps = {
    matchTemplate,
    probeData,
    renderTemplate,
  };

  return { deps, matchTemplate, probeData, renderTemplate };
};

const promptHook = () => {
  const prompt = promptCacheMiddleware.prompt;
  if (prompt === undefined) {
    throw new Error('promptCacheMiddleware.prompt must be registered');
  }
  return prompt;
};

describe('D-164 P4e data-presence and default deps', () => {
  it('noopDataPresenceProbe returns null for any query', () => {
    expect(noopDataPresenceProbe({
      template: TEMPLATE,
      slots: [EMAIL_SLOT],
    })).toBeNull();
  });

  it('DEFAULT_GATE_DEPS wires the no-op data-presence probe', () => {
    expect(DEFAULT_GATE_DEPS.probeData).toBe(noopDataPresenceProbe);
  });

  it('DEFAULT_GATE_DEPS returns no-template after a successful NER extraction', async () => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);

    await expect(runGate(ctx, DEFAULT_GATE_DEPS)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'no-template',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('D-164 P4e runGate pass-through branches', () => {
  it.each([
    {
      name: 'anaphora-without-referent',
      expectedCalls: { matchTemplate: 0, probeData: 0, renderTemplate: 0 },
      setup: () => {
        const { ctx, resolve, state } = makeTurnContext([
          makeSessionEntry('user', 'they', 1),
        ]);
        state.set(INTENTION_RESULT_STATE_KEY, makeIntentionResult(null));
        const deps = makeDeps();
        return { ...deps, ctx, resolve };
      },
    },
    {
      name: 'empty-text',
      expectedCalls: { matchTemplate: 0, probeData: 0, renderTemplate: 0 },
      setup: () => {
        const { ctx, resolve } = makeTurnContext([]);
        const deps = makeDeps();
        return { ...deps, ctx, resolve };
      },
    },
    {
      name: 'no-extraction',
      expectedCalls: { matchTemplate: 0, probeData: 0, renderTemplate: 0 },
      setup: () => {
        const { ctx, resolve } = makeTurnContext([
          makeSessionEntry('user', 'plain words only', 1),
        ]);
        const deps = makeDeps();
        return { ...deps, ctx, resolve };
      },
    },
    {
      name: 'no-template',
      expectedCalls: { matchTemplate: 1, probeData: 0, renderTemplate: 0 },
      setup: () => {
        const { ctx, resolve } = makeTurnContext([
          makeSessionEntry('user', EMAIL_TEXT, 1),
        ]);
        const deps = makeDeps({ matchResult: null });
        return { ...deps, ctx, resolve };
      },
    },
    {
      name: 'no-data-presence',
      expectedCalls: { matchTemplate: 1, probeData: 1, renderTemplate: 0 },
      setup: () => {
        const { ctx, resolve } = makeTurnContext([
          makeSessionEntry('user', EMAIL_TEXT, 1),
        ]);
        const deps = makeDeps({ probeResult: null });
        return { ...deps, ctx, resolve };
      },
    },
    {
      name: 'empty-render',
      expectedCalls: { matchTemplate: 1, probeData: 1, renderTemplate: 1 },
      setup: () => {
        const { ctx, resolve } = makeTurnContext([
          makeSessionEntry('user', EMAIL_TEXT, 1),
        ]);
        const deps = makeDeps({ renderResult: '' });
        return { ...deps, ctx, resolve };
      },
    },
  ] as const)('returns pass-through: $name', async ({ name, expectedCalls, setup }) => {
    const {
      ctx,
      deps,
      matchTemplate,
      probeData,
      renderTemplate,
      resolve,
    } = setup();

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: name,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(matchTemplate).toHaveBeenCalledTimes(expectedCalls.matchTemplate);
    expect(probeData).toHaveBeenCalledTimes(expectedCalls.probeData);
    expect(renderTemplate).toHaveBeenCalledTimes(expectedCalls.renderTemplate);
  });
});

describe('D-164 P4e runGate short-circuit and dependency inputs', () => {
  it('resolves exactly once with rendered text and returns the same GateOutcome text', async () => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const { deps, matchTemplate, probeData, renderTemplate } = makeDeps();

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: RENDERED_TEXT,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(RENDERED_TEXT);
    expect(matchTemplate).toHaveBeenCalledWith({
      text: EMAIL_TEXT,
      slots: [EMAIL_SLOT],
      locale: 'en',
      localeCandidates: ['en'],
    });
    expect(probeData).toHaveBeenCalledWith({
      template: TEMPLATE,
      slots: [EMAIL_SLOT],
      locale: 'en',
    });
    expect(renderTemplate).toHaveBeenCalledWith(TEMPLATE, SNAPSHOT);
  });

  it('contributes only bounded schema data before a deterministic resolve', async () => {
    const { contribute, ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const snapshot: DataSnapshot = {
      data: {
        email: 'bob@example.com',
        raw_probe_state: 'must not be retained',
      },
      entity_parts: [{
        entity: 'contact',
        payload: [{ email: 'bob@example.com' }],
      }],
    };
    const { deps } = makeDeps({ probeResult: snapshot });

    await expect(runGate(ctx, deps)).resolves.toMatchObject({
      kind: 'short-circuit',
    });
    expect(contribute).toHaveBeenCalledOnce();
    expect(contribute).toHaveBeenCalledWith({
      role: 'entity',
      entity: 'contact',
      payload: [{ email: 'bob@example.com' }],
      render: expect.any(Function),
    });
    expect(contribute.mock.invocationCallOrder[0]).toBeLessThan(
      resolve.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(contribute.mock.calls[0]?.[0])).not.toContain(
      'raw_probe_state',
    );
  });

  it('passes the exact matcher slots through to the data-presence probe', async () => {
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const { deps, matchTemplate, probeData } = makeDeps();

    await runGate(ctx, deps);

    const matcherSlots = matchTemplate.mock.calls[0]?.[0].slots;
    const probeSlots = probeData.mock.calls[0]?.[0].slots;
    expect(probeSlots).toBe(matcherSlots);
  });

  it('does not call probe or renderer after a null template match', async () => {
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const { deps, probeData, renderTemplate } = makeDeps({ matchResult: null });

    await runGate(ctx, deps);

    expect(probeData).not.toHaveBeenCalled();
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it('does not call renderer after a null data-presence snapshot', async () => {
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const { deps, renderTemplate } = makeDeps({ probeResult: null });

    await runGate(ctx, deps);

    expect(renderTemplate).not.toHaveBeenCalled();
  });
});

describe('D-164 P4e runGate input-text selection', () => {
  it('defers an anaphoric turn whose referent carries no resolvable name (anaphora-unresolved)', async () => {
    // The two-text rewrite (P9) binds the prompt's pronoun to the referent's
    // UNIQUE certainty-gated name. A referent with no name slot (here: just an
    // email address) has nothing to bind, so the rewrite declines and the gate
    // passes through with NER + the matcher never reached.
    const referent = makeSessionEntry('assistant', 'email referent@example.com', 1);
    const { ctx, resolve, state } = makeTurnContext([
      referent,
      makeSessionEntry('user', 'email user@example.com; what about them?', 2),
    ]);
    state.set(INTENTION_RESULT_STATE_KEY, makeIntentionResult({ entry: referent }));
    const { deps, matchTemplate } = makeDeps();

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'anaphora-unresolved',
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(matchTemplate).not.toHaveBeenCalled();
  });

  it('short-circuits direct contact-attribute prompts; the rewritten anaphoric follow-up faces the same whitelist', async () => {
    const directText = "what is Alice Bond's email address?";
    const renderedText = "Alice Bond's email address is alice@x.com.";
    const lookup = vi.fn(() => [{
      name: 'Alice Bond',
      email: 'alice@x.com',
    }]);
    const deps: GateDeps = {
      matchTemplate: matchContactAttributeTemplate,
      probeData: createContactAttributePresenceProbe(lookup),
      renderTemplate: createTemplateRenderer(),
    };

    const { ctx: directCtx, resolve: directResolve } = makeTurnContext([
      makeSessionEntry('user', directText, 1),
    ]);

    await expect(runGate(directCtx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: renderedText,
    });
    expect(directResolve).toHaveBeenCalledTimes(1);
    expect(directResolve).toHaveBeenCalledWith(renderedText);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenLastCalledWith('Alice Bond');

    const referent = makeSessionEntry('assistant', directText, 1);
    const {
      ctx: referentCtx,
      resolve: referentResolve,
      state,
    } = makeTurnContext([
      referent,
      makeSessionEntry('user', 'what about them?', 2),
    ]);
    state.set(INTENTION_RESULT_STATE_KEY, makeIntentionResult({ entry: referent }));

    // The rewrite binds "them" → "Alice Bond" ("what about Alice Bond?"),
    // but the rewritten prompt carries NO attribute — the contact-attribute
    // whitelist rejects it like any direct prompt of that shape. The
    // referent's OWN template is never blindly re-fired.
    await expect(runGate(referentCtx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'no-template',
    });
    expect(referentResolve).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('passes through anaphora with a null referent without falling back to user text', async () => {
    const { ctx, state } = makeTurnContext([
      makeSessionEntry('user', 'email user@example.com; what about them?', 1),
    ]);
    state.set(INTENTION_RESULT_STATE_KEY, makeIntentionResult(null));
    const { deps, matchTemplate } = makeDeps();

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'anaphora-without-referent',
    });
    expect(matchTemplate).not.toHaveBeenCalled();
  });

  it('uses the latest user text when no intention is present', async () => {
    const latest = makeSessionEntry('user', 'email latest@example.com', 3);
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', 'email older@example.com', 1),
      makeSessionEntry('assistant', 'older result', 2),
      latest,
    ]);
    const { deps, matchTemplate } = makeDeps({ matchResult: null });

    await runGate(ctx, deps);

    expect(matchTemplate).toHaveBeenCalledWith(expect.objectContaining({
      text: latest.text,
    }));
    expect(matchTemplate).not.toHaveBeenCalledWith(expect.objectContaining({
      text: 'email older@example.com',
    }));
  });

  it('walks backward past assistant entries to find the latest user text', async () => {
    const latestUser = makeSessionEntry('user', 'email latest@example.com', 2);
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', 'email older@example.com', 1),
      latestUser,
      makeSessionEntry('assistant', 'assistant tail with helper@example.com', 3),
    ]);
    const { deps, matchTemplate } = makeDeps({ matchResult: null });

    await runGate(ctx, deps);

    expect(matchTemplate).toHaveBeenCalledWith(expect.objectContaining({
      text: latestUser.text,
    }));
  });
});

describe('D-164 contextual known-name lookup seam', () => {
  const contextualDeps = (
    lookupKnownEntityNames: NonNullable<GateDeps['lookupKnownEntityNames']>,
  ): GateDeps => ({
    lookupKnownEntityNames,
    matchTemplate: matchContactAttributeTemplate,
    probeData: createContactAttributePresenceProbe((name) => name === 'Alice Bond'
      ? [{ name: 'Alice Bond', email: 'alice@x.com' }]
      : []),
    renderTemplate: createTemplateRenderer(),
  });

  it('recovers a lowercase name, then preserves the ordinary matcher + unique probe path', async () => {
    const text = "what is alice bond's email address?";
    const lookupKnownEntityNames = vi.fn(() => ['Alice Bond']);
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', text, 1),
    ]);

    await expect(runGate(ctx, contextualDeps(lookupKnownEntityNames))).resolves.toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's email address is alice@x.com.",
    });
    expect(lookupKnownEntityNames).toHaveBeenCalledOnce();
    expect(lookupKnownEntityNames).toHaveBeenCalledWith(text);
    expect(resolve).toHaveBeenCalledWith("Alice Bond's email address is alice@x.com.");
  });

  it('fails open to ordinary NER when the optional name index throws', async () => {
    const lookupKnownEntityNames = vi.fn(() => {
      throw new Error('local index unavailable');
    });
    const { ctx } = makeTurnContext([
      makeSessionEntry('user', "what is Alice Bond's email address?", 1),
    ]);

    await expect(runGate(ctx, contextualDeps(lookupKnownEntityNames))).resolves.toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's email address is alice@x.com.",
    });
  });

  it.each([
    ['malformed', (() => null) as unknown as NonNullable<GateDeps['lookupKnownEntityNames']>],
    ['malformed-structured', (() => [{
      surface: 'alice bond',
      canonicalValue: 'Alice Bond',
      referenceKey: 'contact_alice',
      evidence: 'guessed',
    }]) as unknown as NonNullable<GateDeps['lookupKnownEntityNames']>],
    ['over-cap', () => Array.from({ length: 1_001 }, () => 'Alice Bond')],
  ])('ignores a %s proposal result instead of weakening NER', async (_label, lookup) => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', "what is alice bond's email address?", 1),
    ]);

    await expect(runGate(ctx, contextualDeps(lookup))).resolves.toEqual({
      kind: 'pass-through',
      reason: 'no-extraction',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('D-164 P4e runGate sync and async deps', () => {
  it.each(['sync', 'async'] as const)('short-circuits with %s deps', async (mode) => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const matchTemplate = mode === 'sync'
      ? vi.fn<TemplateMatcher>(() => TEMPLATE)
      : vi.fn<TemplateMatcher>(async () => TEMPLATE);
    const probeData = mode === 'sync'
      ? vi.fn<DataPresenceProbe>(() => SNAPSHOT)
      : vi.fn<DataPresenceProbe>(async () => SNAPSHOT);
    const renderTemplate = mode === 'sync'
      ? vi.fn<TemplateRenderer>(() => RENDERED_TEXT)
      : vi.fn<TemplateRenderer>(async () => RENDERED_TEXT);
    const deps: GateDeps = { matchTemplate, probeData, renderTemplate };

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: RENDERED_TEXT,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(matchTemplate).toHaveBeenCalledTimes(1);
    expect(probeData).toHaveBeenCalledTimes(1);
    expect(renderTemplate).toHaveBeenCalledTimes(1);
  });

  it.each(['sync', 'async'] as const)('passes through no-template with %s matcher deps', async (mode) => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);
    const matchTemplate = mode === 'sync'
      ? vi.fn<TemplateMatcher>(() => null)
      : vi.fn<TemplateMatcher>(async () => null);
    const probeData = vi.fn<DataPresenceProbe>(() => SNAPSHOT);
    const renderTemplate = vi.fn<TemplateRenderer>(() => RENDERED_TEXT);

    await expect(runGate(ctx, {
      matchTemplate,
      probeData,
      renderTemplate,
    })).resolves.toEqual({
      kind: 'pass-through',
      reason: 'no-template',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(probeData).not.toHaveBeenCalled();
    expect(renderTemplate).not.toHaveBeenCalled();
  });
});

describe('D-164 P4e runGate state discipline', () => {
  it.each([
    ['short-circuit', makeDeps()],
    ['pass-through', makeDeps({ matchResult: null })],
  ] as const)('does not mutate ctx.state on %s', async (_label, { deps }) => {
    const { ctx, state, stateDelete, stateSet } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);

    await runGate(ctx, deps);

    expect(stateSet).not.toHaveBeenCalled();
    expect(stateDelete).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('does not mutate ctx.state when reading an existing referent intention', async () => {
    const referent = makeSessionEntry('assistant', EMAIL_TEXT, 1);
    const state = new Map<string, unknown>([
      [INTENTION_RESULT_STATE_KEY, makeIntentionResult({ entry: referent })],
    ]);
    const { ctx, stateDelete, stateSet } = makeTurnContext([
      referent,
      makeSessionEntry('user', 'what about them?', 2),
    ], state);
    const { deps } = makeDeps();

    await runGate(ctx, deps);

    expect(stateSet).not.toHaveBeenCalled();
    expect(stateDelete).not.toHaveBeenCalled();
    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual(
      makeIntentionResult({ entry: referent }),
    );
  });
});

describe('D-164 P4e prompt-cache middleware factory and registration', () => {
  it('createPromptCacheMiddleware returns fresh instances with default deps', () => {
    expect(createPromptCacheMiddleware()).not.toBe(createPromptCacheMiddleware());
  });

  it('createPromptCacheMiddleware returns fresh instances with custom deps', () => {
    const first = createPromptCacheMiddleware(makeDeps().deps);
    const second = createPromptCacheMiddleware(makeDeps().deps);

    expect(first).not.toBe(second);
    expect(first).not.toBe(promptCacheMiddleware);
    expect(second).not.toBe(promptCacheMiddleware);
  });

  it('registerPromptCacheMiddleware without deps registers the canonical const', () => {
    const registry = createMiddlewareRegistry();

    registerPromptCacheMiddleware(registry);

    expect(registry.enabled()[0]).toBe(promptCacheMiddleware);
  });

  it('registerPromptCacheMiddleware with custom deps registers a fresh instance', () => {
    const registry = createMiddlewareRegistry();

    registerPromptCacheMiddleware(registry, makeDeps().deps);

    const registered = registry.enabled()[0];
    expect(registered).not.toBe(promptCacheMiddleware);
    expect(registered?.id).toBe(promptCacheMiddleware.id);
  });

  it('a custom registered middleware uses the injected gate deps', async () => {
    const registry = createMiddlewareRegistry();
    const deps = makeDeps();
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);

    registerPromptCacheMiddleware(registry, deps.deps);
    await registry.enabled()[0]?.prompt?.(ctx);

    expect(resolve).toHaveBeenCalledWith(RENDERED_TEXT);
    expect(deps.matchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.probeData).toHaveBeenCalledTimes(1);
    expect(deps.renderTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('D-164 P4e intention clear', () => {
  it('clears prior anaphoric state when the next attach sees non-anaphoric text', () => {
    const assistant = makeSessionEntry('assistant', 'Alice and Bob match', 1);
    const { ctx, state, stateDelete, stateSet } = makeTurnContext([
      assistant,
      makeSessionEntry('user', 'they', 2),
    ]);

    attach(ctx);
    expect(stateSet).toHaveBeenCalledTimes(1);
    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual(
      makeIntentionResult({ entry: assistant }),
    );

    const nextCtx = {
      ...ctx,
      history: [
        assistant,
        makeSessionEntry('user', 'find Bob email', 3),
      ],
    } as unknown as TurnContext;
    attach(nextCtx);

    expect(stateDelete).toHaveBeenCalledTimes(1);
    expect(stateDelete).toHaveBeenCalledWith(INTENTION_RESULT_STATE_KEY);
    expect(state.has(INTENTION_RESULT_STATE_KEY)).toBe(false);
  });
});

describe('D-164 P4e promptCacheMiddleware.prompt end-to-end defaults', () => {
  it('walks non-anaphoric input with default deps without resolving or setting state', async () => {
    const { contribute, ctx, resolve, state, stateDelete, stateSet } = makeTurnContext([
      makeSessionEntry('user', EMAIL_TEXT, 1),
    ]);

    await promptHook()(ctx);

    expect(contribute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stateSet).not.toHaveBeenCalled();
    expect(stateDelete).toHaveBeenCalledTimes(1);
    expect(state.size).toBe(0);
  });

  it('walks anaphoric input with default deps without resolving beyond attach state', async () => {
    const assistant = makeSessionEntry('assistant', EMAIL_TEXT, 1);
    const { contribute, ctx, resolve, state, stateDelete, stateSet } = makeTurnContext([
      assistant,
      makeSessionEntry('user', 'they', 2),
    ]);

    await promptHook()(ctx);

    expect(contribute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stateSet).toHaveBeenCalledTimes(1);
    expect(stateDelete).not.toHaveBeenCalled();
    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual(
      makeIntentionResult({ entry: assistant }),
    );
  });
});

describe('D-164 P10 read-permission surface seam (authorizeShortCircuitRead)', () => {
  const fireableHistory = () => [makeSessionEntry('user', EMAIL_TEXT, 1)];

  it('absent seam → the original chat-only scope: messenger defers, gate never runs', async () => {
    const deps = makeDeps();
    const { ctx, resolve } = makeTurnContext(
      fireableHistory(),
      new Map(),
      'messenger-slack',
    );

    await createPromptCacheMiddleware(deps.deps).prompt?.(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(deps.matchTemplate).not.toHaveBeenCalled();
    expect(deps.probeData).not.toHaveBeenCalled();
  });

  it('an authorizing seam fires the gate on a messenger surface', async () => {
    const deps = makeDeps();
    const authorize = vi.fn((surface: string) => surface === 'messenger-slack');
    const { ctx, resolve } = makeTurnContext(
      fireableHistory(),
      new Map(),
      'messenger-slack',
    );

    await createPromptCacheMiddleware({
      ...deps.deps,
      authorizeShortCircuitRead: authorize,
    }).prompt?.(ctx);

    // The hook forwards the turn's source as the second arg (P12); a bare
    // harness context carries none, so the seam sees `undefined` and the
    // backend falls back to the P10 surface→source map.
    expect(authorize).toHaveBeenCalledWith('messenger-slack', undefined);
    expect(resolve).toHaveBeenCalledWith(RENDERED_TEXT);
  });

  it('the seam is the authority on chat too — a denying seam defers the chat surface', async () => {
    const deps = makeDeps();
    const lookupKnownEntityNames = vi.fn(() => ['Alice Bond']);
    const { ctx, resolve } = makeTurnContext(fireableHistory());

    await createPromptCacheMiddleware({
      ...deps.deps,
      lookupKnownEntityNames,
      authorizeShortCircuitRead: () => false,
    }).prompt?.(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(lookupKnownEntityNames).not.toHaveBeenCalled();
    expect(deps.matchTemplate).not.toHaveBeenCalled();
  });

  it('a throwing seam fails closed to pass-through', async () => {
    const deps = makeDeps();
    const { ctx, resolve } = makeTurnContext(fireableHistory());

    await createPromptCacheMiddleware({
      ...deps.deps,
      authorizeShortCircuitRead: () => {
        throw new Error('policy store unavailable');
      },
    }).prompt?.(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(deps.matchTemplate).not.toHaveBeenCalled();
  });

  it('a non-true seam value fails closed (strict === true)', async () => {
    const deps = makeDeps();
    const { ctx, resolve } = makeTurnContext(fireableHistory());

    await createPromptCacheMiddleware({
      ...deps.deps,
      authorizeShortCircuitRead: (() => 1) as unknown as () => boolean,
    }).prompt?.(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(deps.matchTemplate).not.toHaveBeenCalled();
  });

  it('an async authorizing seam is awaited', async () => {
    const deps = makeDeps();
    const { ctx, resolve } = makeTurnContext(
      fireableHistory(),
      new Map(),
      'messenger-telegram',
    );

    await createPromptCacheMiddleware({
      ...deps.deps,
      authorizeShortCircuitRead: () => Promise.resolve(true),
    }).prompt?.(ctx);

    expect(resolve).toHaveBeenCalledWith(RENDERED_TEXT);
  });
});
