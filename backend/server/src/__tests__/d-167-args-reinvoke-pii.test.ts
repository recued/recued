/** D-167 N.10 (uniform boundary) — the chat-boundary PII pass aliases EVERY
 *  ledger-known value across ALL data fields, so `runChatTurn` stays 100%
 *  PII-unaware (it threads restored real values; the wrap aliases on egress).
 *
 *  The tool loop restores the model's aliased tool-call args to real for dispatch
 *  and threads those real values into `prior_tool_calls`. The model-facing
 *  re-egress of `prior_tool_calls` (args / result / detail) — plus `user_message`
 *  / `chat_tail` / `correction_context` — is aliased uniformly at the boundary
 *  (`aliasChatAiInput`): one ledger-anchored substring scan, so a ledger-known
 *  value is aliased CONSISTENTLY wherever the model sees it (including a value the
 *  markers left embedded in an otherwise-real field, e.g. a contact/org inside a
 *  deal title — under the uniform boundary that is consistent aliasing, not
 *  corruption, because the model only ever sees the aliased form). The control
 *  fields (`tool_name` / `reason` / `status`) are not scanned.
 *
 *  Spec: docs/d-160-n10-part-pii-pending-design.md §N.10.
 */

import {
  type AIOutput,
  type ChatDispatchResult,
  type EntityPrivacyTag,
  type IngredientManifest,
  type InternalToolRegistry,
  type ToolEntry,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import {
  aliasEntityPayloadForEgress,
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { runChatTurn } from '../chat-turn-executor.js';

const MANIFEST = {} as IngredientManifest;

const entityResolver = (tags: readonly EntityPrivacyTag[] = CANONICAL_PII_ENTITY_PRIVACY_TAGS) =>
  createMetaFieldPrivacyResolver({
    getEntitySchemas: () => [],
    getEntityPrivacyTags: () => tags,
  });

const makePlan = (resolver: piiEgress.FieldPrivacyResolver): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

/** Run a prompt through the model-bound wire seam; capture the egress prompt. */
const egress = async (
  plan: PiiEgressPlan,
  prompt: string,
): Promise<{ rawPrompt: string; packet: Record<string, unknown> }> => {
  let rawPrompt = '';
  const real: ExecuteChatAiCall = async (_m, input) => {
    rawPrompt = String(input['llm.prompt']);
    return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
  };
  await wrapExecuteAiCallForPii(real, plan)(MANIFEST, { 'llm.prompt': prompt });
  let packet: Record<string, unknown> = {};
  try {
    packet = JSON.parse(rawPrompt) as Record<string, unknown>;
  } catch {
    /* non-JSON — leave empty */
  }
  return { rawPrompt, packet };
};

/** Seed the session ledger with a contact (alice@acme.com ↔ m1@d1.invalid,
 *  Alice Chen ↔ pii.Person1) the way a prior turn's gather would. */
const seedAlice = (plan: PiiEgressPlan): void => {
  aliasEntityPayloadForEgress(
    [{ email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com', kind: 'contact' }],
    'contact',
    plan,
  );
};

const priorArgs = (packet: Record<string, unknown>, idx = 0): Record<string, unknown> =>
  (packet.prior_tool_calls as Array<{ args: Record<string, unknown> }>)[idx]!.args;

/** Drive a real `runChatTurn` tool loop with a scripted model + the PII-WRAPPED
 *  executor (as the orchestrator wires it). Returns every model-bound prompt + the
 *  args dispatch actually ran on. */
const runTurnWithModel = async (
  plan: PiiEgressPlan,
  rounds: ReadonlyArray<ReadonlyArray<{ tool: string; args: Record<string, unknown> }>>,
  userMessage = 'hi',
): Promise<{ prompts: Record<string, unknown>[]; dispatched: unknown[] }> => {
  const prompts: Record<string, unknown>[] = [];
  const dispatched: unknown[] = [];
  let call = 0;
  const real: ExecuteChatAiCall = async (_m, input) => {
    prompts.push(JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>);
    const tool_calls = rounds[call] ?? [];
    call += 1;
    return { body: { response: 'ok', events: [], tool_calls } satisfies AIOutput };
  };
  const registry = {
    list: () => [],
    listByTier: () => [],
    getByName: () => ({ name: 'x', tier: 1, concurrency_safe: false } as unknown as ToolEntry),
    dispatch: async () => ({ ok: true, result: {} }) as ChatDispatchResult,
    subscribeRefresh: () => () => undefined,
  } as unknown as InternalToolRegistry;
  await runChatTurn(
    {
      session_id: 's',
      turn_id: 't',
      picker_target: 'self',
      dispatch_peer_name: null,
      available_tools: [],
      content: { chat_tail: [], user_message: userMessage },
      correction_context: [],
      model_layer: 'byok',
    },
    {
      executeAiCall: wrapExecuteAiCallForPii(real, plan),
      registry,
      dispatchTool: async ({ arg_values }) => {
        dispatched.push(arg_values);
        return { ok: true, result: { ok: true } };
      },
      emit: () => undefined,
      now: () => 0,
    },
  );
  return { prompts, dispatched };
};

// ── the boundary aliases every data field uniformly ──

describe('D-167 N.10 — uniform boundary aliases prior_tool_calls data fields', () => {
  it('aliases a ledger-known contact in prior_tool_calls[].args (restored real) at the boundary', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'follow up',
        chat_tail: [],
        prior_tool_calls: [
          { tool_name: 'contact.read', args: { email: 'alice@acme.com' }, status: 'ok', result: { ok: true } },
        ],
      }),
    );
    expect(priorArgs(packet).email).toBe('m1@d1.invalid');
    expect(rawPrompt).not.toContain('alice@acme.com');
  });

  it('aliases a ledger-known value EMBEDDED in an otherwise-real result field (a deal title) — uniform consistency', async () => {
    const plan = makePlan(entityResolver());
    // Seed "Acme Corp" as a name so it is ledger-known.
    aliasEntityPayloadForEgress(
      [{ email: 'x@acme.com', name: 'Acme Corp', target_id: 'x@acme.com', kind: 'contact' }],
      'contact',
      plan,
    );
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'deals?',
        chat_tail: [],
        prior_tool_calls: [
          {
            tool_name: 'deal.search',
            result: {
              candidates: [
                { record: { __entity: 'deal', owner: 'dana@acme.com', name: 'Acme Corp Renewal Q3', target_id: 'hubspot_deal_42' } },
              ],
            },
          },
        ],
      }),
    );
    const rec = (
      packet.prior_tool_calls as Array<{ result: { candidates: Array<{ record: Record<string, string> }> } }>
    )[0]!.result.candidates[0]!.record;
    // Owner aliased by the markers AND the title's embedded "Acme Corp" aliased by
    // the uniform substring pass (consistent aliasing, not corruption — the model
    // never sees the real value). The vendor id (no ledger value) stays real.
    expect(rec.owner).not.toBe('dana@acme.com');
    expect(rec.name).toBe('pii.Person1 Renewal Q3');
    expect(rec.target_id).toBe('hubspot_deal_42');
    expect(rawPrompt).not.toContain('Acme Corp');
  });

  it('aliases a ledger-known contact in an error detail string', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'retry',
        chat_tail: [],
        prior_tool_calls: [
          {
            tool_name: 'contact.read',
            args: { email: 'alice@acme.com' },
            status: 'error',
            reason: 'execution_error',
            detail: 'lookup failed for alice@acme.com (Alice Chen)',
          },
        ],
      }),
    );
    const entry = (packet.prior_tool_calls as Array<{ detail: string }>)[0]!;
    expect(entry.detail).toBe('lookup failed for m1@d1.invalid (pii.Person1)');
    expect(rawPrompt).not.toContain('alice@acme.com');
    expect(rawPrompt).not.toContain('Alice Chen');
  });

  it('aliases a ledger-known value under an arg key that CONTAINS a literal dot (value walk, not dot-path)', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'x',
        chat_tail: [],
        prior_tool_calls: [{ tool_name: 'crm.query', args: { 'filter.contact.email': 'alice@acme.com' } }],
      }),
    );
    expect(priorArgs(packet)['filter.contact.email']).toBe('m1@d1.invalid');
    expect(rawPrompt).not.toContain('alice@acme.com');
  });

  it('aliases a ledger-known contact that sits in a JSON KEY of a result map (not just values)', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'x',
        chat_tail: [],
        prior_tool_calls: [
          // A lookup result keyed BY the contact email + args with a PII key.
          { tool_name: 'crm.bulk', args: { flags: { 'alice@acme.com': true } }, result: { 'alice@acme.com': { stage: 'open' } } },
        ],
      }),
    );
    const entry = (packet.prior_tool_calls as Array<{ args: { flags: Record<string, unknown> }; result: Record<string, unknown> }>)[0]!;
    expect(Object.keys(entry.args.flags)).toEqual(['m1@d1.invalid']);
    expect(Object.keys(entry.result)).toEqual(['m1@d1.invalid']);
    expect(rawPrompt).not.toContain('alice@acme.com');
  });

  it('does NOT scan the control fields (tool_name / status / reason)', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { packet } = await egress(
      plan,
      JSON.stringify({
        user_message: 'x',
        chat_tail: [],
        prior_tool_calls: [
          { tool_name: 'contact.read', status: 'error', reason: 'execution_error', args: { email: 'alice@acme.com' } },
        ],
      }),
    );
    const entry = (packet.prior_tool_calls as Array<Record<string, unknown>>)[0]!;
    expect(entry.tool_name).toBe('contact.read');
    expect(entry.status).toBe('error');
    expect(entry.reason).toBe('execution_error');
    // ...while the data field IS aliased.
    expect((entry.args as { email: string }).email).toBe('m1@d1.invalid');
  });

  it('is BYTE-IDENTICAL when the ledger is empty (no PII surfaced this session)', async () => {
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const prompt = JSON.stringify({
      user_message: 'hi',
      chat_tail: [],
      prior_tool_calls: [{ tool_name: 'contact.read', args: { email: 'bob@x.com' } }],
    });
    const { rawPrompt } = await egress(plan, prompt);
    expect(rawPrompt).toBe(prompt);
  });
});

// ── runChatTurn stays PII-unaware; the boundary does all aliasing ──

describe('D-167 N.10 — runChatTurn is PII-unaware; the boundary aliases the reinvoke', () => {
  it('dispatch runs on REAL args; the reinvoke prompt shows ALIASED prior_tool_calls', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan); // alice@acme.com ↔ m1@d1.invalid
    const { prompts, dispatched } = await runTurnWithModel(plan, [
      [{ tool: 'contact.read', args: { email: 'm1@d1.invalid' } }], // model emits the alias it saw
    ]);
    // The tool loop restored the alias → real for dispatch (it never touches PII).
    expect((dispatched[0] as { email: string }).email).toBe('alice@acme.com');
    // The boundary aliased the model-facing reinvoke — no raw PII reaches the LLM.
    expect(JSON.stringify(prompts[1])).not.toContain('alice@acme.com');
    const prior = prompts[1]!.prior_tool_calls as Array<{ args: { email: string } }>;
    expect(prior[0]!.args.email).toBe('m1@d1.invalid');
  });

  it('a contact copied into a free-text arg does not re-egress raw across the reinvoke', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan);
    const { prompts } = await runTurnWithModel(plan, [
      [{ tool: 'mail.send', args: { note: 'follow up with alice@acme.com (Alice Chen)' } }],
    ]);
    expect(JSON.stringify(prompts[1])).not.toContain('alice@acme.com');
    expect(JSON.stringify(prompts[1])).not.toContain('Alice Chen');
    const prior = prompts[1]!.prior_tool_calls as Array<{ args: { note: string } }>;
    expect(prior[0]!.args.note).toBe('follow up with m1@d1.invalid (pii.Person1)');
  });

  it('an ALIAS KEY the model emits in tool args is restored to the REAL key for dispatch (key-aware round trip)', async () => {
    const plan = makePlan(entityResolver());
    seedAlice(plan); // alice@acme.com ↔ m1@d1.invalid
    // The model saw a prior result map keyed by the aliased contact and copies that
    // alias KEY into a new tool call. Dispatch must receive the REAL key.
    const { prompts, dispatched } = await runTurnWithModel(plan, [
      [{ tool: 'crm.update', args: { 'm1@d1.invalid': 'done' } }],
    ]);
    expect(Object.keys(dispatched[0] as Record<string, unknown>)).toEqual(['alice@acme.com']);
    // ...and the model-facing reinvoke re-aliases the key (no raw PII to the LLM).
    const prior = prompts[1]!.prior_tool_calls as Array<{ args: Record<string, unknown> }>;
    expect(Object.keys(prior[0]!.args)).toEqual(['m1@d1.invalid']);
    expect(JSON.stringify(prompts[1])).not.toContain('alice@acme.com');
  });
});
