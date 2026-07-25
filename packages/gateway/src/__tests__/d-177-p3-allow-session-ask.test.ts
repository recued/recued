/** D-177 P3 allow-session preflight ask tests. */

import type { Checkpoint } from '@recued/contracts';
import {
  ALLOW_SESSION_ASK_OPTION,
  PREFLIGHT_ASK_OPTIONS,
  buildPreflightAsk,
  createPreflightAnswerHandler,
  type PreflightAskContext,
  type PreflightResumer,
} from '@recued/gateway';
import type { Answer } from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const ANSWERED_AT = NOW + 1_000;

const sessionGrant = {
  ttl_ms: 3_600_000,
  max_uses: 5,
  risk_tier: 'write',
};

const answer = (option: string): Answer => ({
  option,
  answered_at: ANSWERED_AT,
});

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: { previous: { ok: true } },
  created_at: NOW,
  ...overrides,
});

const askContext = (
  overrides: Partial<PreflightAskContext> = {},
): PreflightAskContext => ({
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  tool_slug: 'mail.send',
  risk_tier: 'write',
  reason: 'write tier needs approval',
  ...overrides,
});

const payload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  tool_slug: 'mail.send',
  risk_tier: 'write',
  reason: 'write tier needs approval',
  ...overrides,
});

const checkpointStore = (
  cp: Checkpoint | null = checkpoint(),
): CheckpointStore & {
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} => ({
  write: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(cp),
  listByRun: vi.fn().mockResolvedValue(cp === null ? [] : [cp]),
  setArgOverrides: vi.fn().mockImplementation(async (_id, patch) => ({
    ...(cp ?? checkpoint()),
    ...patch,
  })),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue(cp === null ? [] : [cp]),
  size: vi.fn().mockResolvedValue(cp === null ? 0 : 1),
}) as unknown as CheckpointStore & {
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const resumer = (): PreflightResumer & {
  resumeRun: ReturnType<typeof vi.fn>;
  denyRun: ReturnType<typeof vi.fn>;
} => ({
  resumeRun: vi.fn().mockResolvedValue(undefined),
  denyRun: vi.fn().mockResolvedValue(undefined),
});

const expectNoSessionGrant = (context: PreflightAskContext): void => {
  expect(context).not.toHaveProperty('session_grant');
};

describe('D-177 P3 buildPreflightAsk allow_session option', () => {
  it('keeps binary approve/deny options and no payload session_grant when no offer is present', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({ session_grant: undefined }),
    });

    expect(ask.options).toBe(PREFLIGHT_ASK_OPTIONS);
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'deny']);
    expect(ask.handler.payload).not.toHaveProperty('session_grant');
  });

  it('inserts allow_session between approve and deny and persists the offer verbatim', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({ session_grant: sessionGrant }),
    });

    expect(ask.options.map((option) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(ask.options[0]).toBe(PREFLIGHT_ASK_OPTIONS[0]);
    expect(ask.options[1]).toBe(ALLOW_SESSION_ASK_OPTION);
    expect(ask.options[2]).toBe(PREFLIGHT_ASK_OPTIONS[1]);
    expect(ask.handler.payload.session_grant).toBe(sessionGrant);
  });
});

describe('D-177 P3 createPreflightAnswerHandler allow_session threading', () => {
  it('threads valid allow_session payloads into resumeRun and consumes the checkpoint', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload({ session_grant: sessionGrant }), answer('allow_session'));

    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    const [calledCheckpoint, context] = r.resumeRun.mock.calls[0]!;
    expect(calledCheckpoint).toBe(cp);
    expect(context.session_grant).toEqual(sessionGrant);
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('does not thread session_grant for a plain approve even when the payload carries an offer', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload({ session_grant: sessionGrant }), answer('approve'));

    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    expectNoSessionGrant(r.resumeRun.mock.calls[0]![1]);
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['array', [sessionGrant]],
    ['ttl_ms zero', { ...sessionGrant, ttl_ms: 0 }],
    ['ttl_ms negative', { ...sessionGrant, ttl_ms: -1 }],
    ['ttl_ms NaN', { ...sessionGrant, ttl_ms: Number.NaN }],
    ['ttl_ms string', { ...sessionGrant, ttl_ms: '3600' }],
    ['max_uses zero', { ...sessionGrant, max_uses: 0 }],
    ['max_uses non-integer', { ...sessionGrant, max_uses: 1.5 }],
    ['max_uses string', { ...sessionGrant, max_uses: '5' }],
    ['risk_tier empty', { ...sessionGrant, risk_tier: '' }],
    ['risk_tier missing', { ttl_ms: 3_600_000, max_uses: 5 }],
  ])('degrades malformed allow_session payloads to plain approve: %s', async (_name, rawGrant) => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });
    const p =
      rawGrant === undefined
        ? payload()
        : payload({ session_grant: rawGrant });

    await expect(handler(p, answer('allow_session'))).resolves.toBeUndefined();

    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    expectNoSessionGrant(r.resumeRun.mock.calls[0]![1]);
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('treats deny as deny and never forwards session_grant', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload({ session_grant: sessionGrant }), answer('deny'));

    expect(r.denyRun).toHaveBeenCalledTimes(1);
    expectNoSessionGrant(r.denyRun.mock.calls[0]![1]);
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });
});

describe('D-177 P3 PREFLIGHT_ASK_OPTIONS pin', () => {
  it('leaves the binary option vocabulary unchanged', () => {
    expect(PREFLIGHT_ASK_OPTIONS).toEqual([
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ]);
  });
});
