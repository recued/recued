/** D-335 slice F — passes for Browser Toolkit writes, at the gate and on the ask.
 *
 *  The gate: a held browser write (`dom-write`, `dom-click`, `dom-open`) asks the host for a
 *  pass only where the owner's policy could waive the ask (`never` or `ask` before the lift),
 *  below destructive, after no D-177 grant matched; a pass admits it, anything else asks.
 *  The ask: a hold that recorded a pass offer offers "Allow on <site> for this session" and
 *  "Always allow on <site>" in place of "Allow this session", says what each allows, and an
 *  answer of either resumes with the pass it chose. */

import { describe, expect, it, vi } from 'vitest';
import {
  PreflightRequiredSignal,
  type AdmissionDecision,
  type BrowserPassOffer,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import type { Answer } from '@recued/notification';
import { createCommitStore, createInMemoryCollection, type CheckpointStore } from '@recued/storage';

import {
  wrapWithCommitGateway,
  type BrowserPassHooks,
  type BrowserTargetHooks,
  type CommitGatewayDeps,
  type GatewayInner,
  type SessionGrantHooks,
} from '../commit-gateway.js';
import {
  buildPreflightAsk,
  createPreflightAnswerHandler,
  type PreflightAskContext,
  type PreflightResumer,
} from '../preflight-reconciliation.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' };

const ask = (overrides: Partial<Extract<AdmissionDecision, { verdict: 'ask' }>> = {}): AdmissionDecision => ({
  verdict: 'ask',
  risk_tier: 'write',
  detail: 'This acts on a web page in your browser, signed in as you, so Recued always asks you first.',
  authorization_provenance: { pre_lift_approval: 'never', lift_reason: 'review_send' },
  ...overrides,
} as AdmissionDecision);

const RESOLVED = { target: '*://*/*', page: '7:DOC', ref: 'e12' };

const gate = (overrides: Partial<CommitGatewayDeps> = {}, admit: BrowserPassHooks['admit'] = async () => true) => {
  const inner = vi.fn<GatewayInner>(async () => ({ clicked: true }));
  const browserPasses = { admit: vi.fn(admit) };
  let n = 0;
  const executor = wrapWithCommitGateway(inner, {
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    identity: { request_id: 'run-1', source: owner, channel_session_id: 'chat:s', correlation_id: 'c', dispatch_depth: 0 },
    getIngredientCategory: () => 'action',
    genCommitId: () => `commit-${(n += 1)}`,
    genIdempotencyKey: () => `idem-${n}`,
    evaluateAdmission: () => ask(),
    resolveArgsForHash: () => RESOLVED,
    browserPasses,
    ...overrides,
  });
  return { executor, inner, admit: browserPasses.admit };
};

const held = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(PreflightRequiredSignal);
};

describe('D-335 slice F — the gate asks the host for a pass', () => {
  it('a pass admits a held browser write: no ask, and the host is given the resolved call', async () => {
    const { executor, inner, admit } = gate();
    await expect(executor('dom-click', { page: '{{config.page}}', ref: '{{config.ref}}' })).resolves.toEqual({ clicked: true });
    expect(admit).toHaveBeenCalledWith({ slug: 'dom-click', input: RESOLVED });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('no pass, a host that fails, or no host: the write asks', async () => {
    for (const { executor, inner } of [
      gate({}, async () => false),
      gate({}, async () => { throw new Error('store unreadable'); }),
      gate({ browserPasses: undefined }),
    ]) {
      await held(executor('dom-write', { value: 'hi' }));
      expect(inner).not.toHaveBeenCalled();
    }
  });

  it('asks the host only for a browser write the owner\'s policy leaves waivable, below destructive', async () => {
    const cases: Array<[string, Partial<CommitGatewayDeps>]> = [
      ['mail-send', {}],
      ['dom-click', { evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'always' } }) }],
      ['dom-click', { evaluateAdmission: () => ask({ risk_tier: 'destructive' }) }],
      ['dom-open', { identity: undefined }],
    ];
    for (const [slug, overrides] of cases) {
      const { executor, inner, admit } = gate(overrides);
      await held(executor(slug, {}));
      expect(admit, `${slug} ${JSON.stringify(overrides)}`).not.toHaveBeenCalled();
      expect(inner).not.toHaveBeenCalled();
    }
  });

  it('a D-177 grant that matched is spent instead, and a resumed approval needs no pass', async () => {
    const sessionGrants: SessionGrantHooks = { match: () => 'grant-1', consume: () => true };
    const granted = gate({ sessionGrants });
    await expect(granted.executor('dom-click', {})).resolves.toEqual({ clicked: true });
    expect(granted.admit).not.toHaveBeenCalled();

    const resumed = gate();
    await expect(resumed.executor('dom-click', {}, undefined, undefined, {
      step_id: 'act', recipe_id: 'click-web-element', preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'dom-click' },
    })).resolves.toEqual({ clicked: true });
    expect(resumed.admit).not.toHaveBeenCalled();
  });
});

describe('2026-11-04 — a held browser write whose page or element has gone fails instead of asking', () => {
  const GONE = new Error('The page changed since it was inspected: inspect it again.');
  const withTargets = (refusal: BrowserTargetHooks['refusal'], overrides: Partial<CommitGatewayDeps> = {},
    admit: BrowserPassHooks['admit'] = async () => false) => {
    const browserTargets = { refusal: vi.fn(refusal) };
    return { ...gate({ browserTargets, ...overrides }, admit), refusal: browserTargets.refusal };
  };

  it('fails with the host\'s error, given the resolved call: nothing asked, nothing run', async () => {
    const { executor, inner, refusal } = withTargets(async () => GONE);
    await expect(executor('dom-click', { page: '{{config.page}}', ref: '{{config.ref}}' })).rejects.toBe(GONE);
    expect(refusal).toHaveBeenCalledWith({ slug: 'dom-click', input: RESOLVED });
    expect(inner).not.toHaveBeenCalled();
  });

  it('no refusal, or a host that fails: the write asks, as before', async () => {
    for (const { executor, inner } of [
      withTargets(async () => undefined),
      withTargets(async () => { throw new Error('bridge unreachable'); }),
    ]) {
      await held(executor('dom-write', { value: 'hi' }));
      expect(inner).not.toHaveBeenCalled();
    }
  });

  it('asked only when the write would be asked: not for a pass, a grant, a resumed approval or another call', async () => {
    const passed = withTargets(async () => GONE, {}, async () => true);
    await expect(passed.executor('dom-click', {})).resolves.toEqual({ clicked: true });
    expect(passed.refusal).not.toHaveBeenCalled();

    const granted = withTargets(async () => GONE, { sessionGrants: { match: () => 'grant-1', consume: () => true } });
    await expect(granted.executor('dom-click', {})).resolves.toEqual({ clicked: true });
    expect(granted.refusal).not.toHaveBeenCalled();

    const resumed = withTargets(async () => GONE);
    await expect(resumed.executor('dom-click', {}, undefined, undefined, {
      step_id: 'act', recipe_id: 'click-web-element', preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'dom-click' },
    })).resolves.toEqual({ clicked: true });
    expect(resumed.refusal).not.toHaveBeenCalled();

    const mail = withTargets(async () => GONE);
    await held(mail.executor('mail-send', {}));
    expect(mail.refusal).not.toHaveBeenCalled();
  });

  it('applies whatever the owner\'s policy, destructive included: no answer brings the page back', async () => {
    for (const evaluateAdmission of [
      () => ask({ authorization_provenance: { pre_lift_approval: 'always' } }),
      () => ask({ risk_tier: 'destructive' }),
    ]) {
      const { executor, refusal } = withTargets(async () => GONE, { evaluateAdmission });
      await expect(executor('dom-click', {})).rejects.toBe(GONE);
      expect(refusal).toHaveBeenCalledTimes(1);
    }
  });
});

const OFFER: BrowserPassOffer = {
  key: { principal: { kind: 'owner_chat' }, recipe: 'click-web-element', site: 'https://github.com' },
  host: 'github.com',
  channel_session_id: 'chat:s',
};

const checkpoint = (preflight_context: Record<string, unknown> = { browser_pass: OFFER }): Checkpoint => ({
  checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'click-web-element', gated_step_id: 'click',
  step_state: { click: { input: RESOLVED } }, created_at: 1,
  preflight_context: { tool_slug: 'dom-click', risk_tier: 'write', ...preflight_context },
} as Checkpoint);

const context = (overrides: Partial<PreflightAskContext> = {}): PreflightAskContext => ({
  recipe_id: 'click-web-element', gated_step_id: 'click', tool_slug: 'dom-click', risk_tier: 'write',
  session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' },
  ...overrides,
});

describe('D-335 slice F — the ask offers the pass, in place of "Allow this session"', () => {
  it('offers both site answers between approve and deny, and says what each allows', () => {
    const built = buildPreflightAsk({ checkpoint: checkpoint(), context: context() });
    expect(built.options).toEqual([
      { id: 'approve', label: 'Approve' },
      { id: 'allow_site_session', label: 'Allow on github.com for this session' },
      { id: 'allow_site_always', label: 'Always allow on github.com' },
      { id: 'deny', label: 'Deny' },
    ]);
    expect(built.message.text).toContain('\n\n“Allow on github.com for this session” stops asking about clicks on '
      + 'github.com in this conversation, for up to 8 hours. “Always allow on github.com” stops asking about them in '
      + 'all your chats, until you end it under Contracts.\n\nApprove?');
    expect(built.message.text).not.toContain("'Allow this session'");
    expect(built.handler.payload.session_grant).toBeUndefined();
  });

  it('an AI app\'s pass is for that app', () => {
    const app = { ...OFFER, key: { ...OFFER.key, principal: { kind: 'ai_app' as const, contract_id: 'ct-1' } } };
    expect(buildPreflightAsk({ checkpoint: checkpoint({ browser_pass: app }), context: context() }).message.text)
      .toContain('stops asking about them for this AI app, until you end it under Contracts.');
  });

  it('a host too long for a button is shortened on the button, and every label fits Slack\'s 75', () => {
    const host = `${'a'.repeat(60)}.example.com`;
    const long = { ...OFFER, host, key: { ...OFFER.key, site: `https://${host}` } };
    const labels = buildPreflightAsk({ checkpoint: checkpoint({ browser_pass: long }), context: context() })
      .options.map(option => option.label);
    expect(labels.every(label => label.length <= 75)).toBe(true);
    expect(labels).toContain(`Always allow on ${host.slice(0, 44)}…`);
  });

  it('an offer that no longer reads, a batch or a foreach cover: no site answers', () => {
    const unread = buildPreflightAsk({ checkpoint: checkpoint({ browser_pass: { ...OFFER, key: { ...OFFER.key,
      site: 'https://github.com/owner/repo' } } }), context: context() });
    expect(unread.options.map(option => option.id)).toEqual(['approve', 'allow_session', 'deny']);
    const cover = buildPreflightAsk({ checkpoint: checkpoint({ browser_pass: OFFER, foreach_cover: { total: 3 } }),
      context: context({ foreach_cover: { total: 3 } }) });
    expect(cover.options.map(option => option.id)).not.toContain('allow_site_always');
  });
});

describe('D-335 slice F — an answer resumes with the pass it chose', () => {
  const answer = (option: string): Answer => ({ option, answered_at: 5 } as Answer);
  const store = (cp: Checkpoint | null) => ({
    get: vi.fn(async () => cp), delete: vi.fn(async () => undefined),
  }) as unknown as CheckpointStore;
  const run = async (option: string, cp: Checkpoint | null = checkpoint()) => {
    const resumer = { resumeRun: vi.fn(async () => undefined), denyRun: vi.fn(async () => undefined) } as
      PreflightResumer & { resumeRun: ReturnType<typeof vi.fn>; denyRun: ReturnType<typeof vi.fn> };
    const handler = createPreflightAnswerHandler({ checkpointStore: store(cp), resumer });
    await handler(buildPreflightAsk({ checkpoint: cp ?? checkpoint(), context: context() }).handler.payload, answer(option));
    return resumer;
  };

  it('each site answer approves, with its pass; a plain approve carries none', async () => {
    expect((await run('allow_site_session')).resumeRun.mock.calls[0]![1]).toMatchObject({ browser_pass_kind: 'session' });
    expect((await run('allow_site_always')).resumeRun.mock.calls[0]![1]).toMatchObject({ browser_pass_kind: 'always' });
    expect((await run('approve')).resumeRun.mock.calls[0]![1].browser_pass_kind).toBeUndefined();
    const denied = await run('deny');
    expect(denied.resumeRun).not.toHaveBeenCalled();
    expect(denied.denyRun).toHaveBeenCalledTimes(1);
  });

  it('a site answer on a hold whose offer no longer reads is a plain approve', async () => {
    const resumer = await run('allow_site_always', checkpoint({ browser_pass: { host: 'github.com' } }));
    expect(resumer.resumeRun).toHaveBeenCalledTimes(1);
    expect(resumer.resumeRun.mock.calls[0]![1].browser_pass_kind).toBeUndefined();
  });
});
