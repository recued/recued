/** D-167 P2 — session query lookup + outbound-write restore: the
 *  "approval-preview shows REAL values" guarantee at the write/admin/
 *  destructive plan-approval gate.
 *
 *  ## Why this file exists (P2 scope, post-S4)
 *
 *  P2's substrate is delivered by the S4 wire seam (`bb5763aa`) + the
 *  field-privacy resolver activation (`93fa73ba`): `wrapExecuteAiCallForPii`
 *  restores the ENTIRE returned AI body — `response` + every `tool_call.args`
 *  + `events` — via `restoreArgsForApproval` BEFORE `runChatTurn`'s tool loop
 *  sees it (`chat-pii-egress.ts:364-373`). So the LLM-proposed catalog-
 *  operation args are de-aliased before they reach the orchestrator, which
 *  means BOTH (a) the `chat.plan_proposed` approval card the user reviews and
 *  (b) the post-approval wire dispatch carry REAL values — the user sees "AI
 *  wants to email alice@acme.com", never "m1@d1.invalid" (spec §"Runtime flow"
 *  step 7 + §"Field declaration" `restore_policy: 'approval_preview'`).
 *
 *  The existing S4 e2e test (`d-167-p5-s4-chat-pii-egress.test.ts` — "re-
 *  aliases prior_tool_calls on reinvoke + restores tool args before dispatch")
 *  proves restore-before-dispatch for a `'read'`-classified tool that BYPASSES
 *  the plan-approval gate (`requiresPlanApproval` collapses reads to false).
 *  It does NOT exercise the write/admin/destructive path THROUGH the gate —
 *  the literal "approval-preview" surface. This file closes that gap.
 *
 *  Two tests, two distinct guarantees:
 *    1. The production `runTurn` path: a `'write'` tool whose recipient the
 *       model only ever saw as an alias surfaces the REAL recipient in the
 *       `chat.plan_proposed` approval card.
 *    2. The gate-level restore→args_hash→dispatch consistency invariant: an
 *       approved plan whose `args_hash` was computed over the RESTORED real
 *       args lets the restored dispatch proceed with real args (no alias/real
 *       hash mismatch). See the test's own note on what it does NOT model.
 *
 *  Spec: D-167 §P2, §"Runtime flow" step 7, §"Field declaration"
 *  (`restore_policy: 'approval_preview'`); plan-approval gate: D-137 P3 § A.11
 *  (`packages/gateway/src/plan-approval/`, `chat-orchestrator.ts:1283-1394`).
 */

import Database from 'better-sqlite3';
import { piiEgress, planApproval } from '@recued/gateway';
import {
  type AIOutput,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

/** A `'write'`-classified send tool → `requiresPlanApproval` returns true, so
 *  a proposal routes through the approval card before any wire dispatch. */
const mailSendEntry: ToolEntry = {
  name: 'mail.send',
  tier: 1,
  description: 'send mail',
  arg_schema: { type: 'object' },
  topic_tags: ['mail', 'send'],
  classification: 'write',
  concurrency_safe: false,
};

interface Harness {
  readonly db: Database.Database;
  readonly runTurn: () => Promise<unknown>;
  readonly broadcasts: Array<Record<string, unknown>>;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly dispatchArgs: unknown[];
  readonly egressPackets: Array<Record<string, unknown>>;
  readonly planApprovalStore: planApproval.PlanApprovalStore;
  /** One-shot override so a later `runTurn` replays an earlier turn's
   *  `turn_id` (used by the gate-consistency test — see its note). */
  setNextTurnId(id: string): void;
}

/** Build an orchestrator wired with PII egress + the plan-approval gate. The
 *  model only ever sees the alias (`alice@acme.com` is tagged + aliased on
 *  egress), and echoes that alias into the proposed `mail.send` recipient;
 *  the post-dispatch reinvoke returns no tool_calls to end the loop. */
const buildHarness = (): Harness => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });

  const egressPackets: Array<Record<string, unknown>> = [];
  const dispatchArgs: unknown[] = [];
  const broadcasts: Array<Record<string, unknown>> = [];

  // Tag the user message as an email identifier → the egress pass aliases
  // `alice@acme.com` → `m1@d1.invalid`, populating the session ledger the
  // inbound restore reads. (Restore is ledger-driven, not tag-driven, so
  // tagging the user_message alone round-trips the recipient.)
  const resolver: piiEgress.FieldPrivacyResolver = (packet) => {
    const p = packet as Record<string, unknown>;
    return typeof p.user_message === 'string'
      ? [{ path: 'user_message', kind: 'email' as const }]
      : [];
  };

  const dispatch = vi.fn(async (_name: string, args: unknown) => {
    dispatchArgs.push(args);
    return { ok: true, result: { sent: true } } as const;
  });
  const registry: InternalToolRegistry = {
    list: () => [mailSendEntry],
    listByTier: (tier) => (tier === 1 ? [mailSendEntry] : []),
    getByName: (name) => (name === 'mail.send' ? mailSendEntry : null),
    dispatch,
    subscribeRefresh: () => () => undefined,
  };

  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_m, input) => {
    const packet = JSON.parse(String(input['llm.prompt'])) as Record<
      string,
      unknown
    >;
    egressPackets.push(packet);
    if (packet.prior_tool_calls) {
      return {
        body: { response: 'sent', events: [], tool_calls: [] } satisfies AIOutput,
      };
    }
    return {
      body: {
        response: 'sending',
        events: [],
        tool_calls: [{ tool: 'mail.send', args: { to: packet.user_message } }],
      } satisfies AIOutput,
    };
  });

  const planApprovalStore = planApproval.createPlanApprovalStore();

  // Deterministic id mint, with a one-shot override (`setNextTurnId`) so a
  // later turn can replay an earlier turn's `turn_id` (the gate keys on it).
  let seq = 0;
  let forcedTurnId: string | null = null;
  const mintId = () => {
    if (forcedTurnId !== null) {
      const v = forcedTurnId;
      forcedTurnId = null;
      return v;
    }
    return `mid-${++seq}`;
  };

  const orchestrator = createChatOrchestrator({
    chatStore,
    registry,
    broadcast: { emit: (e) => broadcasts.push(e as Record<string, unknown>) },
    selfSignature,
    executeAiCall,
    planApprovalStore,
    piiLedgerStore: piiEgress.createSessionLedgerStore(),
    fieldPrivacyResolver: resolver,
    now: () => NOW,
    mintId,
  });

  return {
    db,
    runTurn: () =>
      orchestrator.runTurn({
        session_id: 'sess-1',
        message: 'alice@acme.com',
        picker_state: { current: 'self' },
      }),
    broadcasts,
    dispatch,
    dispatchArgs,
    egressPackets,
    planApprovalStore,
    setNextTurnId: (id) => {
      forcedTurnId = id;
    },
  };
};

describe('D-167 P2 — approval-preview shows REAL (de-aliased) values', () => {
  let active: Harness | undefined;
  afterEach(() => {
    active?.db.close();
    active = undefined;
  });

  it('surfaces the REAL recipient in the chat.plan_proposed approval card for an aliased write proposal', async () => {
    const h = (active = buildHarness());
    await h.runTurn();

    // The cloud model never saw the real recipient — only the alias.
    expect(String(h.egressPackets[0]?.user_message)).toMatch(
      /^m\d+@d\d+\.invalid$/,
    );
    // The approval card the USER reviews carries the REAL recipient — the
    // restore ran before the gate built the proposal — never the alias.
    const proposed = h.broadcasts.find((b) => b.kind === 'chat.plan_proposed');
    expect(proposed).toBeDefined();
    expect(proposed?.tool).toBe('mail.send');
    expect(proposed?.args).toEqual({ to: 'alice@acme.com' });
    // Awaiting approval — nothing has hit the wire yet.
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches the REAL recipient once the plan is approved (restore→args_hash→dispatch consistency at the gate)', async () => {
    const h = (active = buildHarness());

    // Turn A — the model proposes the write; the gate mints a proposal whose
    // args_hash is computed over the RESTORED real recipient, and pauses.
    await h.runTurn();
    const proposed = h.broadcasts.find((b) => b.kind === 'chat.plan_proposed');
    expect(proposed?.args).toEqual({ to: 'alice@acme.com' });
    expect(h.dispatch).not.toHaveBeenCalled();
    const plan_id = proposed?.plan_id as string;
    const turn_id = proposed?.turn_id as string;

    // Approve the exact proposed plan.
    h.planApprovalStore.resolve(plan_id, 'approved', NOW);

    // Re-issue the same tool call under the SAME turn so the gate's
    // (session, turn, tool, args_hash) lookup finds the approved plan.
    //
    // NOTE on what this does and does NOT model: this pins the GATE-level
    // invariant — given an approved plan whose hash matches the restored
    // args, the gate dispatches the REAL args (the alias→restore→args_hash
    // round-trip stays consistent end to end, so approval can't be defeated
    // by an alias/real mismatch). It mirrors how the D-137 phase-3 gate tests
    // exercise the gate with a fixed `turn_id`. It is NOT a model of the
    // production approval→resume handshake: real `chat.send`→`runTurn` mints a
    // fresh `turn_id`, and `chat.plan.approve` only flips status + broadcasts
    // — auto-resume is unbuilt P4 polish. Replaying turn A's `turn_id` here is
    // the minimal faithful way to drive the approved-plan dispatch THROUGH the
    // PII restore path.
    h.setNextTurnId(turn_id);
    await h.runTurn();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatchArgs[0]).toEqual({ to: 'alice@acme.com' });
  });
});
