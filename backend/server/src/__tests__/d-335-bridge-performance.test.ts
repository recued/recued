import { describe, expect, it } from 'vitest';
import { BRIDGE_ACTIONS, BRIDGE_READ_SETTLE_MAX_MS, bridgeRunsCommand, type BridgeCapabilityProfile, type BridgeCommand } from '@recued/contracts';
import { withBridgeReadiness, type BridgeDispatchTiming } from '../bridges/bridge-performance.js';
import { createBridgeDispatcher, createBridgeResultListener, type DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';

const profile: BridgeCapabilityProfile = { software_version: '0.0.9', chrome_version: '140',
  permissions_granted: ['tabs', 'scripting'], granted_origins: ['https://example.com/*'],
  offscreen_supported: true, alarms_supported: true, supported_actions: [...BRIDGE_ACTIONS] };
const command: Omit<BridgeCommand, 'command_id'> = { recipe_run_id: 'run', step_id: 'read',
  ingredient: { publisher_id: 'recued-core', slug: 'dom-inspect', version: '1.0.0', surface_kind: 'reading',
    domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: 'PUB' },
  action: 'inspect', args: { page: '7:DOC1' }, expects_output_keys: ['page', 'html'],
  target_domain_pattern: 'https://example.com/*', idempotency_key: 'read-1', timeout_ms: 100 };
const ready = { selector: '#results', until: 'shown' as const };

describe('negotiated Bridge readiness', () => {
  it('negotiates a combined read separately and refuses guarded links on older Bridges', () => {
    const wait = { ...command, action: 'wait_for_element' as const, args: { page: '7:DOC1', selector: '#result',
      capture_read: { max_chars: 4_000, max_value_chars: 200 } }, expects_output_keys: ['found'] };
    const capable = { ...profile, wait_read: true, guarded_links: true };
    const combined = withBridgeReadiness(wait, capable, {});
    expect(combined.args).toEqual(wait.args);
    expect(combined.expects_output_keys).toEqual(expect.arrayContaining(['found', 'page', 'html', 'truncated', 'loading']));
    expect(combined.idempotency_key).not.toBe(wait.idempotency_key);
    for (const candidate of [wait, { ...wait, reviewed_document: { tab_id: 7, document_id: 'DOC1', url: 'https://example.com/' } }]) {
      const legacy = withBridgeReadiness(candidate, candidate.reviewed_document ? capable : profile, {});
      expect(legacy.args).toEqual({ page: '7:DOC1', selector: '#result' });
      expect(legacy.expects_output_keys).toEqual(['found']);
    }
    const args = { navigation_guard: { before_url: 'https://example.com/2', after_url: 'https://example.com/3' } };
    expect(bridgeRunsCommand(profile, 'click', args)).toBe(false);
    expect(bridgeRunsCommand(capable, 'click', args)).toBe(true);
    expect(bridgeRunsCommand(capable, 'submit', args)).toBe(false);
  });
  it('requires structural capability and separates structural snapshots from old read receipts', () => {
    const structural = { ...command, args: { ...command.args, preserve_structure: true } };
    const capable = { ...profile, structural_reads: true };
    expect(bridgeRunsCommand(profile, 'inspect', structural.args)).toBe(false);
    expect(bridgeRunsCommand(capable, 'inspect', structural.args)).toBe(true);
    expect(bridgeRunsCommand(capable, 'reread', structural.args)).toBe(true);
    expect(bridgeRunsCommand(capable, 'click', structural.args)).toBe(false);
    const negotiated = withBridgeReadiness(structural, capable, {});
    expect(negotiated.expects_output_keys).toEqual(expect.arrayContaining(['structure_complete', 'structure_root', 'structure_scoped']));
    expect(negotiated.args).toMatchObject({ preserve_structure: true, structure_scoped: true });
    expect(negotiated.idempotency_key).not.toBe(command.idempotency_key);
    expect(withBridgeReadiness(command, capable, {})).toBe(command);
  });

  it('leaves legacy, disabled and reviewed commands exact', () => {
    expect(withBridgeReadiness(command, profile, {})).toBe(command);
    const capable = { ...profile, dom_readiness: true };
    expect(withBridgeReadiness(command, capable, { domReadiness: false })).toBe(command);
    const reviewed = { ...command, reviewed_document: { tab_id: 7, document_id: 'DOC1', url: 'https://example.com/' } };
    expect(withBridgeReadiness(reviewed, capable, { readyClicks: true }, ready)).toBe(reviewed);
  });

  it('separates replay keys for readiness policies and keeps the faster watch opt-in', () => {
    const capable = { ...profile, dom_readiness: true };
    const click = { ...command, action: 'click' as const };
    const normal = withBridgeReadiness(click, capable, {}, ready);
    const fast = withBridgeReadiness(click, capable, { readyClicks: true }, ready);
    expect(normal.args).toEqual({ page: '7:DOC1', dom_ready: true });
    expect(normal.expects_output_keys).toEqual(['page', 'html', 'loading']);
    expect(fast.args).toEqual({ ...normal.args, ready_check: ready });
    expect(new Set([click.idempotency_key, normal.idempotency_key, fast.idempotency_key]).size).toBe(3);
    expect(withBridgeReadiness(click, capable, { readyClicks: true }, ready).idempotency_key).toBe(fast.idempotency_key);
    const fill = { ...command, action: 'fill' as const };
    expect(withBridgeReadiness(fill, capable, { readyClicks: true }, ready)).toBe(fill);
  });

  it('negotiates with the Bridge actually selected by the dispatcher', async () => {
    for (const supported of [false, true]) {
      const registry = createBridgeRegistry();
      registry.attach({ client_token_id: 'bridge', session_id: 'session', online_since: 0, last_seen_at: 0,
        capabilities: { ...profile, ...(supported ? { dom_readiness: true } : {}) } });
      const listener = createBridgeResultListener();
      let args: unknown;
      const dispatcher = createBridgeDispatcher({ registry, listener, transport: {
        send: async (_id, envelope) => {
          if (envelope.kind !== 'command') throw new Error('Expected command');
          args = envelope.command.args;
          listener.resolveResult({ command_id: envelope.command.command_id, status: 'ok', outputs: {}, duration_ms: 1,
            bridge_version: profile.software_version, idempotency_key_seen: false });
          return { ok: true };
        }, cancel: async () => ({ ok: true }),
      } });
      expect((await dispatcher.dispatch({ ...command, ready_check: ready })).kind).toBe('completed');
      expect(args).toEqual(supported ? { ...command.args, dom_ready: true } : command.args);
    }
  });
});

describe('payload-free per-command timings', () => {
  it('records each transport attempt, separates elapsed durations and isolates observer errors', async () => {
    const registry = createBridgeRegistry();
    registry.attach({ client_token_id: 'bridge', session_id: 'session', online_since: 0, last_seen_at: 0, capabilities: profile });
    const listener = createBridgeResultListener();
    const timings: BridgeDispatchTiming[] = [];
    let clock = 0;
    let sent = 0;
    const dispatcher = createBridgeDispatcher({ registry, listener, monotonicNow: () => clock++,
      sleep: async () => { clock += 200; }, generateCommandId: () => 'command',
      onTiming: timing => {
        timings.push(timing);
        if (timing.attempt === 1) throw new Error('diagnostics failure');
        return Promise.reject(new Error('async diagnostics failure'));
      },
      transport: { cancel: async () => ({ ok: true }), send: async (_id, envelope) => {
        if (envelope.kind !== 'command') throw new Error('Expected command');
        clock += 4;
        if (++sent === 1) return { ok: false, reason: 'queue_full' };
        clock += 40;
        listener.resolveResult({ command_id: envelope.command.command_id, status: 'ok',
          outputs: { private: 'not-in-timing' }, duration_ms: 30, bridge_version: '0.0.8', idempotency_key_seen: false });
        return { ok: true };
      } } });
    const request: DispatchRequest = { ...command, args: { secret: 'not-in-timing', target_url: 'https://example.com/private' } };
    expect(await dispatcher.dispatch(request)).toMatchObject({ kind: 'completed', attempts: 2 });
    expect(timings).toEqual([
      { command_id: 'command', action: 'inspect', attempt: 1, status: 'queue_full', admission_ms: 1, send_ms: 5, round_trip_ms: 5 },
      { command_id: 'command', action: 'inspect', attempt: 2, status: 'ok', admission_ms: 1, send_ms: 45,
        round_trip_ms: 46, bridge_duration_ms: 30, outside_bridge_ms: 16 },
    ]);
    expect(dispatcher.canResolve('command', 'bridge')).toBe(false);
  });
});

// 2026-11-20 (the owner: "go ahead", the settle check) — a read on a Bridge that can first waits for the page to stop
// changing; every other Bridge and command is sent what it was before.
describe('a settled read, negotiated per Bridge', () => {
  const settling = { ...profile, settled_reads: true };
  it('asks a Bridge that settles to settle its reads, and to say whether they did', () => {
    for (const action of ['inspect', 'reread'] as const) {
      const asked = withBridgeReadiness({ ...command, action }, settling, {});
      expect(asked.args).toMatchObject({ page: '7:DOC1', settle_ms: BRIDGE_READ_SETTLE_MAX_MS });
      expect(asked.expects_output_keys).toEqual(expect.arrayContaining(['page', 'html', 'settled']));
      expect(asked.idempotency_key).toBe('read-1:settle:1');
      expect(bridgeRunsCommand(settling, action, asked.args)).toBe(true);
    }
  });

  it('sends every other Bridge, action, reviewed read or immediate read what it sent before', () => {
    const unchanged = (candidate: Omit<BridgeCommand, 'command_id'>, to: BridgeCapabilityProfile, options = {}) =>
      expect(withBridgeReadiness(candidate, to, options).args).not.toHaveProperty('settle_ms');
    unchanged(command, profile);
    unchanged({ ...command, action: 'describe' }, settling);
    unchanged({ ...command, action: 'read_dom' }, settling);
    unchanged({ ...command, reviewed_document: { tab_id: 7, document_id: 'DOC1', url: 'https://example.com/' } }, settling);
    unchanged(command, settling, { domReadiness: false });
    expect(bridgeRunsCommand(profile, 'inspect', { page: '7:DOC1', settle_ms: 3_000 })).toBe(false);
    expect(bridgeRunsCommand(settling, 'describe', { page: '7:DOC1', settle_ms: 3_000 })).toBe(false);
  });
});

// 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a plain wait of seconds goes as a read that waits for the page
// to change; a Bridge that cannot is sent a plain read, never refused, and answers no `changed`.
describe('a read that waits for a change, negotiated per Bridge', () => {
  const waiting = { ...profile, settled_reads: true, settled_waits: true };
  const wait = { ...command, action: 'reread' as const, args: { ...command.args, wait_change_ms: 4_000 } };
  it('asks a Bridge that can to wait in the page, and to say whether the page changed and held still', () => {
    for (const action of ['inspect', 'reread'] as const) {
      const asked = withBridgeReadiness({ ...wait, action }, waiting, {});
      expect(asked.args).toMatchObject({ page: '7:DOC1', wait_change_ms: 4_000 });
      expect(asked.expects_output_keys).toEqual(expect.arrayContaining(['page', 'html', 'settled', 'changed']));
      expect(asked.idempotency_key).toBe('read-1:change:1:settle:1');
      expect(bridgeRunsCommand(waiting, action, asked.args)).toBe(true);
    }
  });

  it('strips the wait for a Bridge that cannot, or a reviewed read, and never refuses the read', () => {
    for (const [to, candidate] of [[{ ...profile, settled_reads: true }, wait], [profile, wait],
      [waiting, { ...wait, reviewed_document: { tab_id: 7, document_id: 'DOC1', url: 'https://example.com/' } }]] as const) {
      const sent = withBridgeReadiness(candidate, to, {});
      expect(sent.args).not.toHaveProperty('wait_change_ms');
      expect(sent.expects_output_keys).not.toContain('changed');
      expect(sent.idempotency_key).not.toContain(':change:');
      expect(bridgeRunsCommand(to, 'reread', candidate.args)).toBe(true);
    }
  });

  // 2026-11-21 (D-402, benchmark task H, live) — one wait may take 30 s. A Bridge before 0.0.14 stops a wait for a change at
  // 10 s and answers "no change", so a longer wait goes to it as a plain read and the server waits all of it.
  it('asks only a Bridge with long waits to wait longer than 10 s for a change; another waits at the server', () => {
    const long = { ...wait, args: { ...wait.args, wait_change_ms: 20_000 } };
    expect(withBridgeReadiness(long, { ...waiting, long_waits: true }, {}).args).toMatchObject({ wait_change_ms: 20_000 });
    expect(withBridgeReadiness(long, waiting, {}).args).not.toHaveProperty('wait_change_ms');
    expect(withBridgeReadiness({ ...wait, args: { ...wait.args, wait_change_ms: 10_000 } }, waiting, {}).args)
      .toMatchObject({ wait_change_ms: 10_000 });
  });

  it('runs a click or a sent form watched longer than 10 s only on a Bridge that watches that long', () => {
    for (const watched of [{ watch_ms: 20_000 }, { send_watch_ms: 20_000 }]) {
      expect(bridgeRunsCommand(profile, 'click', { selector: '#go', ...watched })).toBe(false);
      expect(bridgeRunsCommand({ ...profile, long_waits: true }, 'click', { selector: '#go', ...watched })).toBe(true);
    }
    expect(bridgeRunsCommand(profile, 'click', { selector: '#go', watch_ms: 10_000 })).toBe(true);
  });
});

