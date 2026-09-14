/** Slice 1 — the Tier-1 `work.create` tool: the chat AI's first write into the
 *  owner's own zero-config work graph.
 *
 *  ⛔ WHY THIS TOOL NEEDS ITS OWN GATE TESTS AND NOT JUST HAPPY-PATH ONES.
 *  `work.create` is `classification: 'unknown'`, which means it deliberately
 *  BYPASSES the P3 plan-approval gate (the `memory.write` precedent — an
 *  approval card between "add a task" and a task is the whole cost of the
 *  feature). So the per-kind op grant is not the FIRST line of defence, it is
 *  the ONLY one. Every refusal below is therefore load-bearing, and a green
 *  happy path proves nothing about them.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';

const ownerSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

/** The owner reaching in over Telegram — the shape the whole cold-start case
 *  depends on. No `contract_id`, so it is NOT a door and carries full owner
 *  authority, exactly like the webclient source above. */
const messengerOwnerSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'telegram',
  from: '12345',
};

const ctx = (source: ExecutionSource = ownerSource) =>
  ({ execution_source: source, session_id: 'sess-1' }) as never;

/** ⛔ THE DOUBLE SITS AT THE DISPATCHER, NOT AT THE DEPS OBJECT. The handler
 *  calls the REAL `handleWorkEntityUpsert`, so faking the deps wholesale would
 *  test the fake and skip every check that handler performs (kind validation,
 *  upsert-mode resolution, and the strip of a forged `origin_execution_source`).
 *  Doubling `dispatchers.taskCreate` is the natural seam: everything above it is
 *  the real path, and the spy still proves the fenced cases never reach a write. */
const deps = (opts: {
  granted?: readonly string[];
  upsert?: ReturnType<typeof vi.fn>;
  crudPresent?: boolean;
} = {}) => {
  const upsert = opts.upsert ?? vi.fn(async () => ({ task: { id: 'task-1', title: 'Call the dentist' } }));
  const granted = opts.granted ?? [
    'core.work-entity.task.create',
    'core.work-entity.note.create',
    'core.work-entity.commitment.create',
    'core.work-entity.project.create',
  ];
  return {
    __upsert: upsert,
    getWorkEntityCrudDeps: () =>
      opts.crudPresent === false
        ? undefined
        : ({
            dispatchers: {
              taskCreate: upsert,
              noteCreate: upsert,
              commitmentCreate: upsert,
              projectCreate: upsert,
            },
          } as unknown as never),
    getOpAdmissionGate: () => ({
      isFrozenByPause: () => false,
      isOpGranted: (_s: ExecutionSource, opId: string | undefined) =>
        opId !== undefined && granted.includes(opId),
    }),
  } as unknown as ChatToolHandlerDeps & { __upsert: ReturnType<typeof vi.fn> };
};

describe('work.create — the grant is the ONLY gate, so every refusal matters', () => {
  it('refuses a kind the contract does not grant, and names the kind', async () => {
    // Granting `task` must NOT grant `commitment`: the ops are per-kind precisely
    // so "may add notes" never silently becomes "may promise things on my behalf".
    const d = deps({ granted: ['core.work-entity.task.create'] });
    const handlers = buildChatTier1Handlers(d);
    const res = await handlers['work.create']!(
      { kind: 'commitment', title: 'Ship the thing' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    expect((res as { detail: string }).detail).toContain('commitment');
    expect(d.__upsert).not.toHaveBeenCalled();
  });

  it('fails CLOSED when no admission gate is wired at all', async () => {
    const upsert = vi.fn();
    const handlers = buildChatTier1Handlers({
      getWorkEntityCrudDeps: () => ({}) as never,
      // no getOpAdmissionGate
    } as unknown as ChatToolHandlerDeps);
    const res = await handlers['work.create']!({ kind: 'task', title: 'X' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses an anonymous actor even when the op is granted', async () => {
    // A Reception visitor must never create rows in the owner's work graph
    // through the chat surface. The actor check sits ahead of the grant check.
    const d = deps();
    const handlers = buildChatTier1Handlers(d);
    const res = await handlers['work.create']!({ kind: 'task', title: 'X' }, ctx({
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'r1',
    } as ExecutionSource));
    expect(res.ok).toBe(false);
    expect(d.__upsert).not.toHaveBeenCalled();
  });
});

describe('work.create — argument validation names the field that is missing', () => {
  it('rejects an unknown kind rather than guessing one', async () => {
    const handlers = buildChatTier1Handlers(deps());
    const res = await handlers['work.create']!({ kind: 'booking', title: 'X' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/task \/ note \/ commitment \/ project/);
  });

  it('a note is its BODY, so a bodyless note is refused and says so', async () => {
    // ⚠ The asymmetry is the point: every other kind is identified by its title,
    // a note by its body. A single "title required" message would send the model
    // to supply the wrong field.
    const handlers = buildChatTier1Handlers(deps());
    const res = await handlers['work.create']!({ kind: 'note', title: 'Heading only' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/body/i);
  });

  it('a task needs a title and says THAT', async () => {
    const handlers = buildChatTier1Handlers(deps());
    const res = await handlers['work.create']!({ kind: 'task', body: 'detail only' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/title/i);
  });

  it('reports execution_error when the write path is not wired, never a silent ok', async () => {
    const handlers = buildChatTier1Handlers(deps({ crudPresent: false }));
    const res = await handlers['work.create']!({ kind: 'task', title: 'X' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).not.toBe('classification_blocked');
  });
});

describe('work.create — the owner over MESSENGER is the owner', () => {
  it('a telegram-originated owner turn creates, exactly like webclient chat', async () => {
    // 🔑 The cold-start case. `(messenger, user_self)` carries no contract_id and
    // is not a door, so it must reach the same write with the same authority —
    // if this ever diverges, "run my life from Telegram" quietly stops working
    // while the webclient keeps passing.
    const d = deps();
    const handlers = buildChatTier1Handlers(d);
    const res = await handlers['work.create']!(
      { kind: 'task', title: 'Call the dentist' },
      ctx(messengerOwnerSource),
    );
    expect(res.ok).toBe(true);
    expect((res as { result: { created: boolean; kind: string } }).result).toMatchObject({
      created: true,
      kind: 'task',
    });
  });
});
