/** D-405 slice 6 — a feature row from the model's own search: a turn whose model searched mail, a
 *  calendar or all the owner's files, with none of theirs connected, carries "Connect your mail" under
 *  its answer although the owner's words named no feature. The rules are slice 1's: the owner's
 *  ordinary turn only, one step per answer (never beside the words' step or a step the turn's calls
 *  carry), never twice in a conversation, and no line for the model (it read the search).
 *  Through the real orchestrator with a scripted model; the gate and fact are the composer's (their
 *  own tests run on the real chat wire, `d-404-thing-steps-composition.test.ts`). */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  ChatSetupFeature,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';

import { createChatOrchestrator, type BroadcastChatEvent, type ChatOrchestratorDeps } from '../chat-orchestrator.js';
import { featureStepSentence, type PromptSetupStep } from '../next-steps/prompt-steps.js';
import { featuresSearchedWithNone, searchedFeatureStep, type SearchedFeatureStep } from '../next-steps/searched-features.js';
import { thingStepsSentence } from '../next-steps/thing-steps.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' };

/** What each search answers with nothing of the owner's connected, as the handlers return it. */
const NO_MAILBOX: ChatDispatchResult = { ok: true, result: { matches: [], collections: [], source_freshness: [] } };
const A_MAILBOX: ChatDispatchResult = { ok: true, result: { matches: [], more_matches: false, collections: ['gmail'], source_freshness: [] } };
const LOCAL_ONLY: ChatDispatchResult = { ok: true, result: { matches: [], more_matches: false, collections: ['local'],
  calendar_addresses: [{ collection_slug: 'local', address: '', provider: 'Recued, on this server' }], source_freshness: [] } };
const LOCAL_AND_GOOGLE: ChatDispatchResult = { ok: true, result: { matches: [], more_matches: false, collections: ['local', 'google'], source_freshness: [] } };
const FILES: ChatDispatchResult = { ok: true, result: { files: [], source_freshness: [] } };
/** The owner's switch refused the search: no result, and the switch's own row. */
const REFUSED: ChatDispatchResult = { ok: false, reason: 'classification_blocked', detail: 'Search your mail is turned off for you.',
  fixes: [{ kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' }] };
/** A search of the owner's things that found no Passport, with D-404's step beside it. */
const NO_PASSPORT: ChatDispatchResult = { ok: true, result: { results: [], guidance: thingStepsSentence(['Passport']) },
  fixes: [{ kind: 'thing', type_id: 'passport', type_name: 'Passport' }] } as unknown as ChatDispatchResult;

const MAIL_STEP: SearchedFeatureStep = { fixes: [{ kind: 'feature', feature: 'mail' }], key: 'feature:mail' };

describe('which searches found none of the owner\'s', () => {
  it('mail with no mailbox, a calendar with only the server\'s own, a search of all the owner\'s files; once each, in order', () => {
    expect(featuresSearchedWithNone([
      { tool_name: 'file.search', args: { scope: 'all', query: 'lease' }, result: FILES },
      { tool_name: 'mail.search', args: { query: 'Anna' }, result: NO_MAILBOX },
      { tool_name: 'calendar.search', args: {}, result: LOCAL_ONLY },
      { tool_name: 'mail.search', args: { query: 'Anna lease' }, result: NO_MAILBOX },
    ])).toEqual(['file', 'mail', 'calendar']);
    expect(featuresSearchedWithNone([{ tool_name: 'calendar.search', args: {}, result: { ok: true, result: { matches: [], collections: [] } } }]))
      .toEqual(['calendar']);
  });

  it('⛔ none for a source of the owner\'s, a refused or failed call, a search of the conversation\'s own files, any other tool', () => {
    expect(featuresSearchedWithNone([
      { tool_name: 'mail.search', args: {}, result: A_MAILBOX },
      { tool_name: 'calendar.search', args: {}, result: LOCAL_AND_GOOGLE },
      { tool_name: 'mail.search', args: {}, result: REFUSED },
      { tool_name: 'mail.search', args: {} },
      // A search of the conversation's own files, unless the conversation is known to hold none the owner sent.
      { tool_name: 'file.search', args: { query: 'lease' }, result: FILES },
      { tool_name: 'file.search', args: { scope: 'session' }, result: FILES },
      { tool_name: 'work.search', args: { kind: 'asset' }, result: { ok: true, result: { collections: [] } } },
      // A search that names no list of sources says nothing about them.
      { tool_name: 'mail.search', args: {}, result: { ok: true, result: { matches: [] } } },
    ])).toEqual([]);
    expect(featuresSearchedWithNone(undefined)).toEqual([]);
  });

  it('a search of the conversation\'s own files counts only when the conversation holds no file the owner sent', () => {
    const sessionSearch = [{ tool_name: 'file.search', args: { query: 'lease' }, result: FILES }];
    expect(featuresSearchedWithNone(sessionSearch, { conversationHoldsFiles: false })).toEqual(['file']);
    expect(featuresSearchedWithNone(sessionSearch, { conversationHoldsFiles: true })).toEqual([]);
    expect(featuresSearchedWithNone(sessionSearch)).toEqual([]);
    expect(featuresSearchedWithNone([{ tool_name: 'file.search', result: FILES }], { conversationHoldsFiles: false })).toEqual(['file']);
  });

  it('the step is the first feature with none connected, the ones set aside left out; unknown is never "none"', async () => {
    const connected = vi.fn(async (feature: ChatSetupFeature) => (feature === 'mail' ? true : feature === 'calendar' ? null : false));
    expect(await searchedFeatureStep(['mail', 'calendar', 'file'], { featureConnected: connected }))
      .toEqual({ fixes: [{ kind: 'feature', feature: 'file' }], key: 'feature:file' });
    expect(await searchedFeatureStep(['file'], { featureConnected: connected, hidden: (key) => key === 'feature:file' })).toBeNull();
    expect(await searchedFeatureStep([], { featureConnected: connected })).toBeNull();
  });
});

const TOOLS: ToolEntry[] = ['mail.search', 'calendar.search', 'file.search', 'work.search'].map((name) => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: ['read'], classification: 'read', concurrency_safe: true,
}) as ToolEntry);

let store: ChatStore;
let events: BroadcastChatEvent[];
beforeEach(() => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  events = [];
  store.createSession({ id: 's', now: 1_000 });
});

interface Call { readonly tool: string; readonly args: Record<string, unknown>; readonly answer: ChatDispatchResult }

let chats = 0;
/** A chat whose model makes these calls in its first round, then answers; every input it is sent, kept. */
const chat = (deps: Pick<ChatOrchestratorDeps, 'buildSetupHint' | 'buildSearchedFeatureHint'>) => {
  const inputs: string[] = [];
  const prefix = `c${String((chats += 1))}`;
  let n = 0;
  let calls: Call[] = [];
  let round = 0;
  const registry: InternalToolRegistry = {
    list: () => TOOLS,
    listByTier: (tier) => (tier === 1 ? TOOLS : []),
    getByName: (name) => TOOLS.find((tool) => tool.name === name) ?? null,
    dispatch: async (name) => calls.find((call) => call.tool === name)?.answer ?? { ok: true, result: {} },
    subscribeRefresh: () => () => undefined,
  };
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry,
    broadcast: { emit: (event) => events.push(event) },
    selfSignature: signature,
    mintId: () => `${prefix}-${String(++n)}`,
    executeAiCall: async (_manifest, input) => {
      inputs.push(JSON.stringify(input));
      round += 1;
      const body: AIOutput = round === 1 && calls.length > 0
        ? { response: '', events: [], tool_calls: calls.map((call) => ({ tool: call.tool, args: call.args })) }
        : { response: 'No mailbox of yours is connected, so I could not read any mail from Anna.', events: [], tool_calls: [] };
      return { body };
    },
    resolveFileNames: (ids) => new Map(ids.filter((id) => id === SCAN).map((id) => [id, 'lease-scan.pdf'])),
    ...deps,
  });
  const ask = async (message: string, made: Call[], extra: { read_only?: boolean; session_id?: string; attached?: boolean } = {}) => {
    inputs.length = 0;
    calls = made;
    round = 0;
    const session_id = extra.session_id ?? 's';
    await orchestrator.runTurn({ session_id, message, picker_state: { current: 'self' },
      ...(extra.read_only !== undefined ? { read_only: extra.read_only } : {}),
      ...(extra.attached === true ? { attachments: [{ file_id: SCAN, media_class: 'document' as const }] } : {}) });
    const answers = (await store.listMessages(session_id)).filter((entry) => entry.role === 'assistant');
    return { answer: answers.at(-1), sent: [...inputs] };
  };
  return { ask };
};

const MAIL_SEARCH: Call = { tool: 'mail.search', args: { query: 'Anna' }, answer: NO_MAILBOX };
/** A file the owner sends with a message. */
const SCAN = 'file:0123456789abcdef0123456789abcdef';

describe('D-405 slice 6 — a feature row from the model\'s own search', () => {
  it('joins the answer when the model searched mail and none is connected, though the words named no feature', async () => {
    const searched = vi.fn(async (_features: readonly ChatSetupFeature[], _ctx: unknown) => MAIL_STEP);
    const { answer, sent } = await chat({ buildSetupHint: async () => null, buildSearchedFeatureHint: searched })
      .ask('What did Anna send me last week?', [MAIL_SEARCH]);
    expect(searched).toHaveBeenCalledTimes(1);
    expect(searched.mock.calls[0]![0]).toEqual(['mail']);
    expect(answer?.fixes).toEqual(MAIL_STEP.fixes);
    const complete = events.find((event) => event.kind === 'chat.message_complete');
    expect((complete as { final?: { fixes?: unknown } } | undefined)?.final?.fixes).toEqual(MAIL_STEP.fixes);
    // ⛔ No line for the model: it read the search, and the row is decided after it answered.
    expect(sent.length).toBeGreaterThan(1);
    for (const input of sent) {
      expect(input).not.toContain(featureStepSentence('mail').slice(0, 40));
      expect(input).not.toContain('Connect your mail');
    }
  });

  it('⛔ none when the search found a mailbox, or the gate says one is connected or may not say', async () => {
    const searched = vi.fn(async () => MAIL_STEP);
    const first = await chat({ buildSearchedFeatureHint: searched })
      .ask('What did Anna send me?', [{ tool: 'mail.search', args: {}, answer: A_MAILBOX }]);
    expect(searched).not.toHaveBeenCalled();
    expect(first.answer).not.toHaveProperty('fixes');
    const gated = await chat({ buildSearchedFeatureHint: async () => null }).ask('What did Anna send me?', [MAIL_SEARCH]);
    expect(gated.answer).not.toHaveProperty('fixes');
  });

  it('⛔ a refused search is not one: its own row (the switch) is the answer\'s', async () => {
    const searched = vi.fn(async () => MAIL_STEP);
    const { answer } = await chat({ buildSearchedFeatureHint: searched })
      .ask('What did Anna send me?', [{ tool: 'mail.search', args: {}, answer: REFUSED }]);
    expect(searched).not.toHaveBeenCalled();
    expect(answer?.fixes).toEqual([{ kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' }]);
  });

  it('⛔ one step per answer: never beside the words\' own step, or a step the turn\'s calls carry', async () => {
    const PASSPORT: PromptSetupStep = { fixes: [{ kind: 'thing', type_id: 'passport', type_name: 'Passport' }], offers: [],
      line: thingStepsSentence(['Passport']), key: 'thing:passport' };
    const searched = vi.fn(async () => MAIL_STEP);
    const words = await chat({ buildSetupHint: async () => PASSPORT, buildSearchedFeatureHint: searched })
      .ask('When does my passport expire?', [MAIL_SEARCH]);
    expect(words.answer?.fixes).toEqual(PASSPORT.fixes);
    const calls = await chat({ buildSearchedFeatureHint: searched })
      .ask('Where is my passport?', [{ tool: 'work.search', args: { kind: 'asset', query: 'passport' }, answer: NO_PASSPORT }, MAIL_SEARCH]);
    expect(calls.answer?.fixes).toEqual([{ kind: 'thing', type_id: 'passport', type_name: 'Passport' }]);
    expect(searched).not.toHaveBeenCalled();
  });

  it('⛔ never twice in one conversation, whichever path carried it first', async () => {
    const MAIL_WORDS: PromptSetupStep = { fixes: [{ kind: 'feature', feature: 'mail' }], offers: [], line: featureStepSentence('mail'), key: 'feature:mail' };
    let words: PromptSetupStep | null = MAIL_WORDS;
    const { ask } = chat({ buildSetupHint: async () => words, buildSearchedFeatureHint: async () => MAIL_STEP });
    expect((await ask('Did Anna reply to my email?', [])).answer?.fixes).toEqual(MAIL_WORDS.fixes);
    words = null;
    expect((await ask('What did Anna send me?', [MAIL_SEARCH])).answer).not.toHaveProperty('fixes');
  });

  it('a calendar searched with only the server\'s own, and all the owner\'s files, are features too', async () => {
    const searched = vi.fn(async (features: readonly ChatSetupFeature[]) => ({ fixes: [{ kind: 'feature' as const, feature: features[0]! }], key: `feature:${features[0]!}` }));
    const calendar = await chat({ buildSearchedFeatureHint: searched })
      .ask('Am I free on Friday?', [{ tool: 'calendar.search', args: {}, answer: LOCAL_ONLY }]);
    expect(calendar.answer?.fixes).toEqual([{ kind: 'feature', feature: 'calendar' }]);
    const files = await chat({ buildSearchedFeatureHint: searched })
      .ask('Find the lease', [{ tool: 'file.search', args: { scope: 'all', query: 'lease' }, answer: FILES }]);
    expect(files.answer?.fixes).toEqual([{ kind: 'feature', feature: 'file' }]);
  });

  // Live, "Find my lease agreement." searched only the conversation's (empty) files in 1 of 3 runs, and the
  // model asked whether it was in a folder or a connected service, with no row: slice 2's rule now holds here.
  it('the conversation\'s own files count while it holds no file the owner sent; once it holds one, "the file" is that one', async () => {
    const searched = vi.fn(async (_features: readonly ChatSetupFeature[]) => ({ fixes: [{ kind: 'feature' as const, feature: 'file' as const }], key: 'feature:file' }));
    const none = await chat({ buildSearchedFeatureHint: searched })
      .ask('Find my lease agreement.', [{ tool: 'file.search', args: { query: 'lease' }, answer: FILES }]);
    expect(searched.mock.calls[0]![0]).toEqual(['file']);
    expect(none.answer?.fixes).toEqual([{ kind: 'feature', feature: 'file' }]);
    searched.mockClear();
    store.createSession({ id: 's2', now: 2_000 });
    const sentOne = await chat({ buildSearchedFeatureHint: searched })
      .ask('What does it say?', [{ tool: 'file.search', args: {}, answer: FILES }], { session_id: 's2', attached: true });
    expect(searched).not.toHaveBeenCalled();
    expect(sentOne.answer).not.toHaveProperty('fixes');
    // All the owner's files still count there: that search is not about the file sent.
    const all = await chat({ buildSearchedFeatureHint: searched })
      .ask('Find my lease agreement in my folders.', [{ tool: 'file.search', args: { scope: 'all' }, answer: FILES }], { session_id: 's2' });
    expect(all.answer?.fixes).toEqual([{ kind: 'feature', feature: 'file' }]);
  });

  it('⛔ only the owner\'s ordinary turn: a read-only one gets none', async () => {
    const searched = vi.fn(async () => MAIL_STEP);
    const { answer } = await chat({ buildSearchedFeatureHint: searched }).ask('What did Anna send me?', [MAIL_SEARCH], { read_only: true });
    expect(searched).not.toHaveBeenCalled();
    expect(answer?.fixes ?? []).toEqual([]);
  });

  it('a step that fails leaves the answer as it was', async () => {
    const { answer } = await chat({ buildSearchedFeatureHint: async () => { throw new Error('the fact could not be read'); } })
      .ask('What did Anna send me?', [MAIL_SEARCH]);
    expect(answer?.content).toContain('No mailbox of yours is connected');
    expect(answer).not.toHaveProperty('fixes');
  });
});
