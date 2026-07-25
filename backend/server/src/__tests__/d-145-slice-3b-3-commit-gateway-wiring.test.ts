/** D-145 engine-wiring slice 3b.3 — server commit Gateway wiring. */

import { describe, expect, it } from 'vitest';
import type {
  ContractSnapshot,
  ExecutionSource,
  StepMeta,
  StepOptions,
} from '@recued/contracts';
import type { GatewayCallProbe } from '@recued/gateway';

import {
  buildCommitRunIdentity,
  cacheAwareGatewayInner,
  observeCacheStatus,
} from '../commit-gateway-wiring.js';

const delay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const contractSnapshot = (): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v1',
  allowed_tools: ['mail-send'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
});

describe('buildCommitRunIdentity', () => {
  it('copies run identity fields, threads dispatch_depth, and omits cognition_session_id', () => {
    const executionSource = source();
    const identity = buildCommitRunIdentity({
      request_id: 'run-1',
      source: executionSource,
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-1',
      // D-160 P3 — `dispatch_depth` is a real param now: the Gateway's
      // I-7 loop bound depends on a re-entrant hop's depth being
      // threaded through, not forced back to 0.
      dispatch_depth: 99,
      cognition_session_id: 'cog-1',
    } as Parameters<typeof buildCommitRunIdentity>[0] & {
      cognition_session_id: string;
    });

    expect(identity).toMatchObject({
      request_id: 'run-1',
      source: executionSource,
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-1',
      dispatch_depth: 99,
    });
    expect('contract_snapshot' in identity).toBe(false);
    expect('cognition_session_id' in identity).toBe(false);
  });

  it('includes contract_snapshot only when the argument carries the key', () => {
    const snapshot = contractSnapshot();

    const withoutSnapshot = buildCommitRunIdentity({
      request_id: 'run-without',
      source: source(),
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-without',
    });
    const withSnapshot = buildCommitRunIdentity({
      request_id: 'run-with',
      source: source(),
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-with',
      contract_snapshot: snapshot,
    });

    expect('contract_snapshot' in withoutSnapshot).toBe(false);
    expect('contract_snapshot' in withSnapshot).toBe(true);
    expect(withSnapshot.contract_snapshot).toBe(snapshot);
  });
});

describe('cacheAwareGatewayInner', () => {
  it('forwards the five executor arguments unchanged and returns the executor value unchanged', async () => {
    const input = { q: 'ada' };
    const stepOutput = { name: 'name' };
    const stepOptions: StepOptions = { cache: 'acceptable' };
    const stepMeta: StepMeta = { step_id: 'step-1', recipe_id: 'recipe-1' };
    const result = { ok: true };
    const calls: unknown[][] = [];

    const inner = cacheAwareGatewayInner(async (...args) => {
      calls.push(args);
      return result;
    });

    await expect(inner(
      'lookup',
      input,
      stepOutput,
      stepOptions,
      stepMeta,
      { cached: false },
    )).resolves.toBe(result);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('lookup');
    expect(calls[0]?.[1]).toBe(input);
    expect(calls[0]?.[2]).toBe(stepOutput);
    expect(calls[0]?.[3]).toBe(stepOptions);
    expect(calls[0]?.[4]).toBe(stepMeta);
  });

  it('propagates executor throws unchanged', async () => {
    const thrown = new Error('executor failed');
    const inner = cacheAwareGatewayInner(async () => {
      throw thrown;
    });

    await expect(inner(
      'lookup',
      {},
      undefined,
      undefined,
      undefined,
      { cached: false },
    )).rejects.toBe(thrown);
  });

  it('preserves ALS correlation across awaits', async () => {
    const probe: GatewayCallProbe = { cached: false };
    const inner = cacheAwareGatewayInner(async () => {
      await delay();
      observeCacheStatus('hit', { slug: 'lookup' });
      return { ok: true };
    });

    await inner('lookup', {}, undefined, undefined, undefined, probe);

    expect(probe.cached).toBe(true);
  });

  it('isolates cache probes across concurrent async calls', async () => {
    const hitProbe: GatewayCallProbe = { cached: false };
    const missProbe: GatewayCallProbe = { cached: false };
    const inner = cacheAwareGatewayInner(async (slug) => {
      await delay();
      if (slug === 'cache-hit') {
        observeCacheStatus('hit', { slug });
      }
      return { slug };
    });

    const [hitResult, missResult] = await Promise.all([
      inner('cache-hit', {}, undefined, undefined, undefined, hitProbe),
      inner('cache-miss', {}, undefined, undefined, undefined, missProbe),
    ]);

    expect(hitResult).toEqual({ slug: 'cache-hit' });
    expect(missResult).toEqual({ slug: 'cache-miss' });
    expect(hitProbe.cached).toBe(true);
    expect(missProbe.cached).toBe(false);
  });
});

describe('observeCacheStatus', () => {
  it('marks the active probe only for hit statuses', async () => {
    const hitProbe: GatewayCallProbe = { cached: false };
    const staleProbe: GatewayCallProbe = { cached: false };
    const missProbe: GatewayCallProbe = { cached: false };
    const skippedProbe: GatewayCallProbe = { cached: false };
    const inner = cacheAwareGatewayInner(async (slug) => {
      observeCacheStatus(
        slug as 'hit' | 'hit_stale' | 'miss' | 'skipped',
        { slug },
      );
      return null;
    });

    await inner('hit', {}, undefined, undefined, undefined, hitProbe);
    await inner('hit_stale', {}, undefined, undefined, undefined, staleProbe);
    await inner('miss', {}, undefined, undefined, undefined, missProbe);
    await inner('skipped', {}, undefined, undefined, undefined, skippedProbe);

    expect(hitProbe.cached).toBe(true);
    expect(staleProbe.cached).toBe(true);
    expect(missProbe.cached).toBe(false);
    expect(skippedProbe.cached).toBe(false);
  });

  it('is a safe no-op when called outside an active probe', () => {
    expect(() => observeCacheStatus('hit', { slug: 'outside' })).not.toThrow();
    expect(() => observeCacheStatus('hit_stale', { slug: 'outside' })).not.toThrow();
    expect(() => observeCacheStatus('miss', { slug: 'outside' })).not.toThrow();
    expect(() => observeCacheStatus('skipped', { slug: 'outside' })).not.toThrow();
  });
});
