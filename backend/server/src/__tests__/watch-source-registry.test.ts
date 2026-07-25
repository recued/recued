/** WatchSource generalization — push-source governance registry suite. */

import { describe, expect, it } from 'vitest';
import type { WatchSourceStatusEntry } from '@recued/contracts';
import {
  createWatchSourceRegistry,
  messengerSourceKey,
  receptionSourceKey,
  webhookSourceKey,
} from '../watch/source-registry.js';

const row = (overrides: Partial<WatchSourceStatusEntry> = {}): WatchSourceStatusEntry => ({
  source_key: 'webhook/hubspot/main-crm',
  mechanism: 'webhook',
  label: 'hubspot webhook — main-crm',
  emits: ['data.connection.api.hubspot.deal.main-crm.**'],
  active: true,
  inactive_reason: null,
  last_event_at: null,
  ...overrides,
});

describe('watch source registry', () => {
  it('source_key mints are slash-delimited per mechanism', () => {
    expect(webhookSourceKey('hubspot', 'main-crm')).toBe('webhook/hubspot/main-crm');
    expect(messengerSourceKey('slack')).toBe('messenger/slack');
    expect(receptionSourceKey('intake_form')).toBe('reception/intake_form');
  });

  it('flattens provider rows sorted by source_key', () => {
    const registry = createWatchSourceRegistry();
    registry.register('webhook', { list: () => [row({ source_key: 'webhook/z/x' })] });
    registry.register('others', {
      list: () => [
        row({ source_key: 'messenger/slack', mechanism: 'messenger' }),
        row({ source_key: 'reception/intake_form', mechanism: 'reception' }),
      ],
    });
    expect(registry.list().map((r) => r.source_key)).toEqual([
      'messenger/slack',
      'reception/intake_form',
      'webhook/z/x',
    ]);
  });

  it('markEvent decorates the matching row, keeps the max, and never goes backwards', () => {
    const registry = createWatchSourceRegistry();
    registry.register('webhook', { list: () => [row()] });
    expect(registry.list()[0]?.last_event_at).toBeNull();

    registry.markEvent('webhook/hubspot/main-crm', 1_000);
    expect(registry.list()[0]?.last_event_at).toBe(1_000);

    registry.markEvent('webhook/hubspot/main-crm', 500);
    expect(registry.list()[0]?.last_event_at).toBe(1_000);

    registry.markEvent('webhook/hubspot/main-crm', 2_000);
    expect(registry.list()[0]?.last_event_at).toBe(2_000);
  });

  it('a provider-supplied last_event_at survives when newer than the mark', () => {
    const registry = createWatchSourceRegistry();
    registry.register('webhook', { list: () => [row({ last_event_at: 5_000 })] });
    registry.markEvent('webhook/hubspot/main-crm', 1_000);
    expect(registry.list()[0]?.last_event_at).toBe(5_000);
  });

  it('a throwing provider drops its rows without failing the listing', () => {
    const warnings: string[] = [];
    const registry = createWatchSourceRegistry({
      log: (_level, msg) => warnings.push(msg),
    });
    registry.register('broken', {
      list: () => {
        throw new Error('store offline');
      },
    });
    registry.register('webhook', { list: () => [row()] });
    expect(registry.list()).toHaveLength(1);
    expect(warnings.some((w) => w.includes('store offline'))).toBe(true);
  });

  it('re-registering a provider id REPLACES it — recomposition never duplicates rows', () => {
    const registry = createWatchSourceRegistry();
    registry.register('webhook', { list: () => [row({ label: 'first' })] });
    registry.register('webhook', { list: () => [row({ label: 'second' })] });
    const rows = registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('second');
  });

  it('marks for unknown source keys are inert', () => {
    const registry = createWatchSourceRegistry();
    registry.register('webhook', { list: () => [row()] });
    registry.markEvent('messenger/slack', 9_000);
    expect(registry.list()[0]?.last_event_at).toBeNull();
  });

  it('a markEvent burst coalesces to ONE change notify per window', () => {
    const registry = createWatchSourceRegistry();
    // holder object so a captured callback survives TS flow-narrowing.
    const window: { fire: (() => void) | null; arms: number } = { fire: null, arms: 0 };
    const notifies: number[] = [];
    registry.setChangeNotifier(() => notifies.push(1), {
      schedule: (fn) => {
        window.fire = fn;
        window.arms += 1;
      },
    });

    registry.markEvent('webhook/hubspot/main-crm', 1_000);
    registry.markEvent('messenger/slack', 1_001);
    registry.markEvent('reception/intake_form', 1_002);
    // burst still in the window — coalesced to one armed window, nothing fired
    expect(notifies).toHaveLength(0);
    expect(window.arms).toBe(1);

    window.fire?.(); // window closes, fires once
    expect(notifies).toEqual([1]);

    // next mark opens a fresh window
    registry.markEvent('webhook/hubspot/main-crm', 2_000);
    expect(window.arms).toBe(2);
    window.fire?.();
    expect(notifies).toEqual([1, 1]);
  });

  it('a sustained stream rate-caps to one notify per window (coalescing throttle, not starved)', () => {
    // Codex-flagged scenario: a continuous inbound flood must keep
    // surfacing liveness (≤1 / window) rather than be starved until the
    // stream goes quiet (which a reset-on-every-mark debounce would do).
    const registry = createWatchSourceRegistry();
    const window: { fire: (() => void) | null; arms: number } = { fire: null, arms: 0 };
    let notifies = 0;
    registry.setChangeNotifier(() => (notifies += 1), {
      schedule: (fn) => {
        window.fire = fn;
        window.arms += 1;
      },
    });

    // Three back-to-back windows of continuous marks — each window
    // arms once, fires once, and the next mark re-opens immediately.
    for (let w = 0; w < 3; w += 1) {
      registry.markEvent('webhook/hubspot/main-crm', w * 10 + 1);
      registry.markEvent('webhook/hubspot/main-crm', w * 10 + 2); // coalesced
      registry.markEvent('webhook/hubspot/main-crm', w * 10 + 3); // coalesced
      window.fire?.(); // window closes
    }
    // One arm + one notify per window — NOT once-per-mark, NOT starved.
    expect(window.arms).toBe(3);
    expect(notifies).toBe(3);
  });

  it('markEvent does not notify until a change notifier is wired', () => {
    const registry = createWatchSourceRegistry();
    // no setChangeNotifier — scheduling must be inert (no throw, no leak)
    expect(() => registry.markEvent('webhook/hubspot/main-crm', 1_000)).not.toThrow();
  });

  it('a throwing notifier never breaks the emit path', () => {
    const registry = createWatchSourceRegistry();
    const window: { fire: (() => void) | null } = { fire: null };
    registry.setChangeNotifier(
      () => {
        throw new Error('bus offline');
      },
      {
        schedule: (fn) => {
          window.fire = fn;
        },
      },
    );
    registry.markEvent('webhook/hubspot/main-crm', 1_000);
    expect(() => window.fire?.()).not.toThrow();
  });
});
