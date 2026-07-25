/** D-210 Phase C — the device-fanout branch.
 *
 *  `inbox_fanout_mode` picks which surface a newly-held item reaches the
 *  owner on: `'approval'` (durable actionable ask) or `'notify'` (passive
 *  heads-up, reviewed in the inbox). ONE surface per item, never both.
 *
 *  Two rulings this suite pins, because both are easy to regress into
 *  something that still typechecks and still looks like it works:
 *
 *   1. ⛔ SCOPE — reception-origin holds ONLY. An MCP / chat / agent write
 *      keeps its approve-deny card whatever the Reception page says. The
 *      failure mode if this drifts is silent and serious: a user changes a
 *      Reception setting and their AI agent stops asking before it writes.
 *
 *   2. ⛔ THE BOOT SWEEP MUST NOT UNDO NOTIFY MODE. The sweep exists to
 *      re-raise asks for `awaiting_approval` anchors with no `ask_id` — and
 *      a notify-mode hold is ask-less BY DESIGN. Without the skip, every
 *      passive hold turns into an actionable card on the next restart. */

import { describe, expect, it, vi } from 'vitest';

import type { Checkpoint, ExecutionSource } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { raisePreflightNotify, type PreflightNotifier } from '@recued/gateway';

import Database from 'better-sqlite3';
import { createCheckpointStore, createCommitStore } from '@recued/storage';
import type { Commit } from '@recued/contracts';

import { isReceptionOriginSource } from '../reception-inbox-handler.js';
import { sweepAwaitingCheckpoints } from '../preflight-boot-sweep.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
} from '../commitment-evidence-capture.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const NOW = 1_700_000_000_000;

const SUBJECT = 'anna@acme.com';

/** The evidence + payload the D-192 E3 funnel composes for an inbound
 *  extracted commitment — reused verbatim so the hold this suite drives is
 *  a REAL write-tier gateway hold, not a synthesized one. */
const PROPOSAL_PAYLOAD: Record<string, unknown> = {
  direction: 'inbound',
  statement: 'send the revised SOW by Friday',
  derivation: 'evidence_captured',
  promised_at: NOW - 3_600_000,
  evidence_blob: [
    {
      kind: 'mail',
      full_target_id: 'hubspot_email_conn_e1',
      source: 'engagement_email',
      actor_email: SUBJECT,
      snippet: 'send the revised SOW by Friday',
      confidence: 0.82,
      source_at: NOW - 3_600_000,
      captured_at: NOW,
    },
  ],
  counterparty_contact_id: SUBJECT,
};

const RECEPTION_SOURCE: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'composition.reception_form_submission',
  source_recipe: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
};

const recordingNotifier = () => {
  const asks: Array<{ title?: string; text: string }> = [];
  const notifies: Array<{ title?: string; text: string }> = [];
  const notifier: PreflightNotifier = {
    ask: vi.fn(async (message) => {
      asks.push(message as { title?: string; text: string });
      return { ask_id: `ask-${asks.length}` };
    }),
    registerAskHandler: vi.fn(),
    notify: vi.fn(async (message) => {
      notifies.push(message as { title?: string; text: string });
    }),
  };
  return { notifier, asks, notifies };
};

// ══════════════════════════════════════════════════════════════════
// The scope fence
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — the fanout scope fence', () => {
  it('recognizes the reception origins the inbox itself lists', () => {
    expect(isReceptionOriginSource(RECEPTION_SOURCE)).toBe(true);
    expect(
      isReceptionOriginSource({
        channel: 'reception',
        actor: 'system',
      } as unknown as ExecutionSource),
    ).toBe(true);
  });

  it('⛔ does NOT capture an MCP / chat / user write', () => {
    // The load-bearing half. If any of these ever reads true, a Reception
    // page setting can silence the AI agent's approval prompts.
    for (const src of [
      { channel: 'mcp', actor: 'contracted_user' },
      { channel: 'chat', actor: 'contracted_user' },
      { channel: 'webclient', actor: 'user_self' },
      { channel: 'schedule', actor: 'system', source_recipe: 'acme/nightly-sync' },
      { channel: 'reactive', actor: 'system', source_recipe: 'acme/unrelated-watcher' },
    ] as ExecutionSource[]) {
      expect(isReceptionOriginSource(src)).toBe(false);
    }
  });

  it('treats an absent source as out of scope (fail safe — keep the ask)', () => {
    expect(isReceptionOriginSource(undefined)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// raisePreflightNotify — the passive body
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — raisePreflightNotify', () => {
  const checkpoint = (): Checkpoint => ({
    checkpoint_id: 'cp-1',
    run_id: 'run-1',
    recipe_id: 'recued-core/reception-intake-materialize',
    gated_step_id: 'approved_operation',
    step_state: {},
    created_at: NOW,
  });

  it('fires a notify and mints NO ask', async () => {
    const { notifier, asks, notifies } = recordingNotifier();
    await raisePreflightNotify(notifier, {
      checkpoint: checkpoint(),
      context: {
        recipe_id: 'recued-core/reception-intake-materialize',
        gated_step_id: 'approved_operation',
        tool_slug: 'core.task.create',
        risk_tier: 'write',
        connection_name: 'personal',
      },
    });

    expect(notifies).toHaveLength(1);
    // The whole point of "one surface per item": no durable ask exists, so
    // the anchor stays ask-less and the inbox releases it the no-ask way.
    expect(asks).toEqual([]);
  });

  it('carries the identifying facts, and asks NO question it cannot hear', async () => {
    const { notifier, notifies } = recordingNotifier();
    await raisePreflightNotify(notifier, {
      checkpoint: checkpoint(),
      context: {
        recipe_id: 'recued-core/reception-intake-materialize',
        gated_step_id: 'approved_operation',
        tool_slug: 'core.task.create',
        risk_tier: 'write',
        connection_name: 'personal',
      },
    });

    const body = notifies[0]!;
    expect(body.title).toContain('core.task.create');
    expect(body.text).toContain('core.task.create');
    // WHICH account — the first question a reader asks of any write.
    expect(body.text).toContain('personal');
    // It must NOT pose an approve/deny question: this surface collects no
    // reply, and a question with no buttons is a surface asking something
    // it has no way to hear the answer to.
    expect(body.text).not.toMatch(/Approve\?/);
    expect(body.text).toContain('inbox');
  });

  it('names an AI agent for a raw-op hold, like the ask body does', async () => {
    const { notifier, notifies } = recordingNotifier();
    await raisePreflightNotify(notifier, {
      checkpoint: checkpoint(),
      context: { raw_op: { op_id: 'op-9' }, tool_slug: 'core.mail.send' },
    });
    expect(notifies[0]!.text).toContain('An AI agent');
  });
});

// ══════════════════════════════════════════════════════════════════
// The boot sweep must not undo notify mode
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — the boot sweep vs a deliberately ask-less hold', () => {
  const seed = async (source: ExecutionSource) => {
    const auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    const checkpoint: Checkpoint = {
      checkpoint_id: 'cp-1',
      run_id: 'run-1',
      recipe_id: 'recued-core/reception-intake-materialize',
      gated_step_id: 'approved_operation',
      step_state: {},
      created_at: NOW,
    };
    await auditLog.append({
      run_id: 'run-1',
      recipe_id: 'recued-core/reception-intake-materialize',
      recipe_hash: 'hash-1',
      started_at: NOW,
      finished_at: NOW,
      duration_ms: 0,
      commit_status: 'awaiting_approval',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: 'reactive',
      instance_id: null,
      execution_source: source,
      checkpoint_id: 'cp-1',
      // No `ask_id` — the state notify mode leaves behind.
    } as AuditEntry);
    const checkpointStore = {
      list: async () => [checkpoint],
      get: async () => checkpoint,
      delete: async () => {},
      write: async () => {},
    } as unknown as Parameters<typeof sweepAwaitingCheckpoints>[0]['checkpointStore'];
    return { auditLog, checkpointStore };
  };

  it('LEAVES a notify-mode reception hold passive instead of re-raising', async () => {
    const { auditLog, checkpointStore } = await seed(RECEPTION_SOURCE);
    const { notifier, asks } = recordingNotifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore,
      auditLog,
      notifier,
      resolveInboxFanoutMode: () => 'notify',
    });

    expect(result.leftPassive).toBe(1);
    expect(result.raised).toBe(0);
    // The regression this guards: without the skip the owner's passive
    // setting silently reverts to actionable cards on every restart.
    expect(asks).toEqual([]);
  });

  it('DOES re-raise the same hold in approval mode', async () => {
    const { auditLog, checkpointStore } = await seed(RECEPTION_SOURCE);
    const { notifier, asks } = recordingNotifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore,
      auditLog,
      notifier,
      resolveInboxFanoutMode: () => 'approval',
    });

    expect(result.raised).toBe(1);
    expect(result.leftPassive).toBe(0);
    expect(asks).toHaveLength(1);
  });

  it('⛔ still unstrands a NON-reception ask-less hold even in notify mode', async () => {
    // An MCP hold with no `ask_id` is a raise that genuinely FAILED, not a
    // deliberate choice. Notify mode must not adopt it — that would leave a
    // real orphan silently waiting forever.
    const { auditLog, checkpointStore } = await seed({
      channel: 'mcp',
      actor: 'contracted_user',
    } as ExecutionSource);
    const { notifier, asks } = recordingNotifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore,
      auditLog,
      notifier,
      resolveInboxFanoutMode: () => 'notify',
    });

    expect(result.raised).toBe(1);
    expect(result.leftPassive).toBe(0);
    expect(asks).toHaveLength(1);
  });

  it('re-raises everything ask-less when no mode resolver is wired', async () => {
    const { auditLog, checkpointStore } = await seed(RECEPTION_SOURCE);
    const { notifier } = recordingNotifier();

    const result = await sweepAwaitingCheckpoints({ checkpointStore, auditLog, notifier });

    expect(result.raised).toBe(1);
    expect(result.leftPassive).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// The execute-handler raise site — the branch actually fires, and it
// fires ABOVE the batch registration
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — the execute-handler fanout branch (real hold)', () => {
  /** Drive a REAL gateway hold through `handleExecute` and observe which
   *  surface it reached. Built on the D-192 E3 harness shape: the
   *  commitment-evidence proposal is a real write op that really holds at
   *  the preflight gate, and its execution source is reception-origin
   *  (`isCommitmentEvidenceToken`), so it is inside the fanout scope. */
  const buildEnv = (mode: 'notify' | 'approval' | undefined) => {
    const db = new Database(':memory:');
    const auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());

    ensureWorkEntitySchema(db);
    const workStore = createWorkEntityStore(db);
    autoRegisterRecuedBuiltinSources(workStore, NOW);
    const dispatchers = createWorkEntityDispatchers({
      store: workStore,
      resolver: createWorkEntityResolver(workStore),
      now: () => NOW,
    });

    const manifestBySlug = new Map(KERNEL_MANIFESTS.map((m) => [m.slug, m]));
    const executorConfig = {
      manifests: {
        get: (slug: string) => manifestBySlug.get(slug),
        slugs: () => [...manifestBySlug.keys()],
      },
      kernelDispatchers: { commitmentCreate: dispatchers.commitmentCreate },
    } as unknown as ServerExecutorConfig;

    const recipeStore = createRecipeStore('/nonexistent-d210-phase-c-recipes');
    recipeStore.register(COMMITMENT_EVIDENCE_PROPOSAL_RECIPE);

    const { notifier, asks, notifies } = recordingNotifier();
    // If the branch were placed BELOW the batch registration, this would be
    // consulted and would mint the actionable batch ask — the exact bug the
    // owner's ruling exists to prevent. A call here in notify mode is a
    // defect, so the coordinator records rather than refuses.
    const batchRegistrations: unknown[] = [];
    const batchApprovals = {
      registerHold: async (input: unknown) => {
        batchRegistrations.push(input);
        return { kind: 'registered' as const, ask_id: 'batch-ask-1' };
      },
      hooks: { handleAnswer: async () => 'fallback' as const },
    } as unknown as NonNullable<ExecuteHandlerDeps['batchApprovals']>;

    const executeDeps: ExecuteHandlerDeps = {
      recipeStore,
      executorConfig,
      baseVault: {},
      auditLog,
      checkpointStore,
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      preflightNotifier: notifier,
      batchApprovals,
      ...(mode !== undefined ? { resolveInboxFanoutMode: () => mode } : {}),
    } as unknown as ExecuteHandlerDeps;

    const source: ExecutionSource = {
      channel: 'reactive',
      actor: 'system',
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
    };
    const fire = (run_id: string): Promise<unknown> =>
      handleExecute(
        executeDeps,
        {
          recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE as unknown as Record<string, unknown>,
          trigger_source: 'reactive',
          execution_source: source,
          context: { event: { payload: PROPOSAL_PAYLOAD } },
        } as never,
        { run_id } as never,
      );
    return { db, auditLog, checkpointStore, asks, notifies, batchRegistrations, fire };
  };

  it('notify mode: fires the passive notify, mints NO ask, and skips batching', async () => {
    const env = buildEnv('notify');
    await env.fire('run-phase-c-notify');

    // The hold is real — a checkpoint exists and the run is awaiting.
    const held = await env.checkpointStore.list();
    expect(held).toHaveLength(1);
    const anchor = await env.auditLog.get('run-phase-c-notify');
    expect(anchor?.commit_status).toBe('awaiting_approval');

    // One surface, and it is the passive one.
    expect(env.notifies).toHaveLength(1);
    expect(env.asks).toEqual([]);

    // ⛔ The owner's ruling: the branch sits ABOVE the batch registration.
    // Placed below it, `registerHold` would win first and mint an
    // actionable batch ask — notify mode would silently do nothing here.
    expect(env.batchRegistrations).toEqual([]);

    // And the anchor is ask-less, which is what the no-ask release keys on.
    expect(anchor?.ask_id).toBeUndefined();
    env.db.close();
  });

  it('approval mode: the same hold takes the actionable path', async () => {
    const env = buildEnv('approval');
    await env.fire('run-phase-c-approval');

    expect(env.notifies).toEqual([]);
    // Either the batch ask or the per-hold ask — both are actionable; what
    // matters is that the passive surface was NOT the one used.
    expect(env.batchRegistrations.length + env.asks.length).toBeGreaterThan(0);
    env.db.close();
  });

  it('unwired resolver: byte-identical to pre-Phase-C (never passive)', async () => {
    const env = buildEnv(undefined);
    await env.fire('run-phase-c-unwired');

    expect(env.notifies).toEqual([]);
    expect(env.batchRegistrations.length + env.asks.length).toBeGreaterThan(0);
    env.db.close();
  });
});
