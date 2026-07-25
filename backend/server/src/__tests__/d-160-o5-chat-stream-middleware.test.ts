/** D-160 spec-O-5 Stage 3 — chat-stream source-binding adapters
 *  (`correction-learning` + `personal-recipes`), end-to-end through the
 *  chat orchestrator → `runStream` → registered hooks over shared `state`.
 *
 *  Stage 3 migrated the inline producers onto registered framework hooks:
 *  the orchestrator builds the source-binding adapters from the live
 *  first-party registry + the per-pair stores, and `runStream` drives them
 *  at each lifecycle hook. These tests pin the OBSERVABLE end-to-end
 *  contract — the `before-turn` `correction-learning` hook's summary
 *  reaching the AI packet, and the `after-turn` `personal-recipes` hook's
 *  matches reaching the assistant audit row — with tiny in-memory store
 *  fakes for only the storage methods the adapters read.
 */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createMiddlewareRegistry,
  type MiddlewareRegistry,
} from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import {
  EXTRACTION_THRESHOLD_WINDOW_MS,
  assertValidCorrectionEventRow,
  assertValidPersonalRecipesBlob,
  validateExtractionEvent,
  type AIOutput,
  type CorrectionEventRow,
  type ExtractionEvent,
  type InternalToolRegistry,
  type PersonalRecipeEntry,
  type RecuedServerSignature,
} from '@recued/contracts';

import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { CorrectionEventsStore } from '../storage/correction-events-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const firstPartyRegistry = (): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(registry);
  return registry;
};

const internalRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
  subscribeRefresh: () => () => undefined,
});

let correctionSeq = 0;
const correctionRow = (
  patch: Partial<CorrectionEventRow> &
    Pick<CorrectionEventRow, 'kind' | 'payload_blob'>,
): CorrectionEventRow => {
  correctionSeq += 1;
  const row: CorrectionEventRow = {
    id: `correction-${correctionSeq}`,
    ts: NOW,
    event_at: NOW,
    scope: 'global',
    ...patch,
  };
  assertValidCorrectionEventRow(row);
  return row;
};

const extractionEvent = (
  patch: Partial<ExtractionEvent> = {},
): ExtractionEvent => {
  const event: ExtractionEvent = {
    kind: 'extraction.preference',
    confidence: 0.91,
    args: { topic: 'travel' },
    source_message_id: 'message-1',
    subject_contact_id: 'contact-mary',
    ...patch,
  };
  const issues = validateExtractionEvent(event);
  if (issues.length > 0) {
    throw new Error(`invalid test ExtractionEvent: ${JSON.stringify(issues)}`);
  }
  return event;
};

const personalRecipeEntry = (
  patch: Partial<PersonalRecipeEntry> = {},
): PersonalRecipeEntry => {
  const entry: PersonalRecipeEntry = {
    recipe_id: 'pub/remind-mary-about-travel',
    topic: 'travel',
    enabled: true,
    created_at: NOW,
    ...patch,
  };
  assertValidPersonalRecipesBlob([entry]);
  return entry;
};

const correctionEventsStore = (
  rows: ReadonlyArray<CorrectionEventRow>,
): {
  readonly store: CorrectionEventsStore;
  readonly calls: () => number;
} => {
  let calls = 0;
  const store = {
    listRecent(): CorrectionEventRow[] {
      calls += 1;
      return [...rows];
    },
  } as unknown as CorrectionEventsStore;
  return { store, calls: () => calls };
};

const contactStore = (
  entriesByContact: Readonly<Record<string, ReadonlyArray<PersonalRecipeEntry>>>,
): {
  readonly store: ContactStore;
  readonly calls: readonly string[];
} => {
  const calls: string[] = [];
  const store = {
    getPersonalRecipes(contact_id: string): readonly PersonalRecipeEntry[] {
      calls.push(contact_id);
      return entriesByContact[contact_id] ?? [];
    },
  } as unknown as ContactStore;
  return { store, calls };
};

interface HarnessOptions {
  readonly correctionRows?: ReadonlyArray<CorrectionEventRow>;
  readonly contactRecipes?: Readonly<Record<string, ReadonlyArray<PersonalRecipeEntry>>>;
  /** The extraction events the (one-shot) AI turn emits — drives
   *  `personal-recipes`. */
  readonly events?: ReadonlyArray<ExtractionEvent>;
  /** Mutate the first-party registry before wiring (e.g. disable a
   *  middleware) to exercise the per-middleware enabled-state gate. */
  readonly registryMutator?: (registry: MiddlewareRegistry) => void;
  /** Default true — set false to leave the source getter unwired (the
   *  no-source no-op path). */
  readonly wireCorrection?: boolean;
  readonly wireContact?: boolean;
}

interface HarnessResult {
  readonly assistantDetail: Record<string, unknown>;
  readonly promptBody: Record<string, unknown>;
  readonly correctionCalls: number;
  readonly contactCalls: readonly string[];
}

/** Run one chat turn through the real orchestrator + the registered
 *  stream hooks, capturing the AI packet body + the assistant audit row.
 *  The (single) AI call returns a one-shot `AIOutput` carrying the
 *  supplied extraction events, so `personal-recipes` runs over them. */
const runTurn = async (options: HarnessOptions = {}): Promise<HarnessResult> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });
    const correctionFake = correctionEventsStore(options.correctionRows ?? []);
    const contactFake = contactStore(options.contactRecipes ?? {});
    const auditRows: Array<{ action: string; detail?: string }> = [];
    const promptBodies: Record<string, unknown>[] = [];
    const auditLog = {
      logActivity: vi.fn(async (entry: { action: string; detail?: string }) => {
        auditRows.push({ action: entry.action, detail: entry.detail });
      }),
    } as never;
    let aiCallCount = 0;
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, input) => {
      promptBodies.push(JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>);
      aiCallCount += 1;
      const events = aiCallCount === 1 ? (options.events ?? []) : [];
      return {
        body: { response: 'assistant ok', events, tool_calls: [] } satisfies AIOutput,
      };
    });
    const registry = firstPartyRegistry();
    options.registryMutator?.(registry);
    let idSeq = 0;
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      auditLog,
      broadcast: { emit: () => {} },
      selfSignature,
      executeAiCall,
      middlewareRegistry: registry,
      ...((options.wireCorrection ?? true)
        ? { getCorrectionEventsStore: () => correctionFake.store }
        : {}),
      ...((options.wireContact ?? true)
        ? { getContactStore: () => contactFake.store }
        : {}),
      now: () => NOW,
      mintId: () => `id-${++idSeq}`,
    });

    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'please help',
      picker_state: { current: 'self' },
    });

    const assistantAudit = auditRows
      .filter((row) => row.action === 'chat_message_sent')
      .map((row) => JSON.parse(row.detail ?? '{}') as Record<string, unknown>)
      .find((detail) => detail.role === 'assistant');
    if (!assistantAudit) {
      throw new Error('assistant audit row not emitted');
    }
    return {
      assistantDetail: assistantAudit,
      promptBody: promptBodies[0] ?? {},
      correctionCalls: correctionFake.calls(),
      contactCalls: contactFake.calls,
    };
  } finally {
    db.close();
  }
};

const correctionContext = (result: HarnessResult): ReadonlyArray<string> | undefined =>
  result.promptBody.correction_context as ReadonlyArray<string> | undefined;

describe('D-160 Stage 3 correction-learning before-turn hook', () => {
  it('threads the real correction summary into the AI packet correction_context', async () => {
    const result = await runTurn({
      correctionRows: [
        correctionRow({
          kind: 'plan_outcome_corrected',
          event_at: NOW - 1_000,
          source_plan_id: 'plan-1',
          payload_blob: { plan_id: 'plan-1', user_feedback: 'wrong_tone' },
        }),
      ],
    });

    expect(result.correctionCalls).toBe(1);
    const context = correctionContext(result);
    expect(context).toBeDefined();
    expect(context?.length).toBeGreaterThan(0);
    expect(context?.[0]).toContain('recent corrections');
    expect(context?.[0]).toContain('tone_wrong_tone_recent_corrections=1');
  });

  it('omits correction_context when the correction stream is empty', async () => {
    const result = await runTurn({ correctionRows: [] });

    expect(result.correctionCalls).toBe(1);
    expect(result.promptBody).not.toHaveProperty('correction_context');
  });

  it('does not read the store or thread context when correction-learning is disabled', async () => {
    const result = await runTurn({
      correctionRows: [
        correctionRow({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'plan-1', user_feedback: 'wrong_tone' },
        }),
      ],
      registryMutator: (registry) => registry.disable('correction-learning'),
    });

    expect(result.correctionCalls).toBe(0);
    expect(result.promptBody).not.toHaveProperty('correction_context');
  });

  it('no-ops when the correction store getter is unwired', async () => {
    const result = await runTurn({
      wireCorrection: false,
      correctionRows: [
        correctionRow({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'plan-1', user_feedback: 'wrong_tone' },
        }),
      ],
    });

    expect(result.correctionCalls).toBe(0);
    expect(result.promptBody).not.toHaveProperty('correction_context');
  });

  it('honours the engine clock for the recency window (old corrections drop out)', async () => {
    const result = await runTurn({
      correctionRows: [
        correctionRow({
          kind: 'plan_outcome_corrected',
          event_at: NOW - EXTRACTION_THRESHOLD_WINDOW_MS - 1,
          source_plan_id: 'plan-old',
          payload_blob: { plan_id: 'plan-old', user_feedback: 'too_chatty' },
        }),
      ],
    });

    expect(result.correctionCalls).toBe(1);
    expect(result.promptBody).not.toHaveProperty('correction_context');
  });
});

describe('D-160 Stage 3 personal-recipes after-turn hook', () => {
  it('surfaces a match on the assistant audit row for a valid extraction event', async () => {
    const result = await runTurn({
      contactRecipes: { 'contact-mary': [personalRecipeEntry()] },
      events: [extractionEvent()],
    });

    expect(result.contactCalls).toEqual(['contact-mary']);
    expect(result.assistantDetail.personal_recipe_matches).toEqual([
      {
        recipe_id: 'pub/remind-mary-about-travel',
        contact_id: 'contact-mary',
        topic: 'travel',
      },
    ]);
  });

  it('drops a malformed no-prefix kind, does not abort the turn, and still matches a valid event', async () => {
    const malformedNoPrefix = {
      kind: 'foo',
      confidence: 0.91,
      args: { topic: 'travel' },
      subject_contact_id: 'contact-mary',
    } as unknown as ExtractionEvent;
    const valid = extractionEvent({ args: { topic_tags: ['travel', 'followup'] } });

    const result = await runTurn({
      contactRecipes: { 'contact-mary': [personalRecipeEntry()] },
      events: [malformedNoPrefix, valid],
    });

    expect(result.contactCalls).toEqual(['contact-mary']);
    expect(result.assistantDetail.personal_recipe_matches).toMatchObject([
      {
        recipe_id: 'pub/remind-mary-about-travel',
        contact_id: 'contact-mary',
        topic: 'travel',
      },
    ]);
  });

  it('filters an extraction-prefix spoof that is not in EXTRACTION_EVENT_KINDS', async () => {
    const prefixSpoof = {
      kind: 'extraction.totally_made_up',
      confidence: 0.91,
      args: { topic: 'travel' },
      subject_contact_id: 'contact-mary',
    } as unknown as ExtractionEvent;

    const result = await runTurn({
      contactRecipes: { 'contact-mary': [personalRecipeEntry()] },
      events: [prefixSpoof],
    });

    expect(result.contactCalls).toEqual([]);
    expect(result.assistantDetail).not.toHaveProperty('personal_recipe_matches');
  });

  it('does not read the store or surface matches when personal-recipes is disabled', async () => {
    const result = await runTurn({
      contactRecipes: { 'contact-mary': [personalRecipeEntry()] },
      events: [extractionEvent()],
      registryMutator: (registry) => registry.disable('personal-recipes'),
    });

    expect(result.contactCalls).toEqual([]);
    expect(result.assistantDetail).not.toHaveProperty('personal_recipe_matches');
  });

  it('no-ops when the contact store getter is unwired', async () => {
    const result = await runTurn({
      wireContact: false,
      contactRecipes: { 'contact-mary': [personalRecipeEntry()] },
      events: [extractionEvent()],
    });

    expect(result.contactCalls).toEqual([]);
    expect(result.assistantDetail).not.toHaveProperty('personal_recipe_matches');
  });

  it('surfaces no matches when the contact has no matching personal_recipe entries', async () => {
    const result = await runTurn({
      contactRecipes: { 'contact-mary': [personalRecipeEntry({ topic: 'finance' })] },
      events: [extractionEvent({ args: { fact_type: 'travel' } })],
    });

    expect(result.contactCalls).toEqual(['contact-mary']);
    expect(result.assistantDetail).not.toHaveProperty('personal_recipe_matches');
  });
});
