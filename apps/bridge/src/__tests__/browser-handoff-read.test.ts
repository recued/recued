import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi, type BridgeScriptTiming } from '../actions/executor.js';
import { clickPageElement } from '../actions/page-fields.js';
import { describePageElement, inspectPage } from '../actions/page-inspect.js';
import { checkPageElement } from '../actions/page-wait.js';
import { PAGE_MESSAGE_RULES } from '../actions/page-problems.js';

const url = 'https://example.com/page/2/';
const guard = { before_url: url, after_url: 'https://example.com/page/3/' };
const command = (action: BridgeCommand['action'], args: Record<string, unknown>, keys: string[]): BridgeCommand => ({
  command_id: 'cmd', recipe_run_id: 'run', step_id: 'step', action, args, expects_output_keys: keys,
  ingredient: { publisher_id: 'fixture', slug: 'dom-act', version: '1', surface_kind: 'reading',
    domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: '' },
  target_domain_pattern: 'https://example.com/*', timeout_ms: 10_000, idempotency_key: 'once',
});
const browser = (executeInDocument: BridgeBrowserApi['executeInDocument']): BridgeBrowserApi => ({
  executeInDocument, findTabByUrlPattern: async () => null, executeScript: async () => null,
  captureVisibleTab: async () => '', showNotification: async id => id,
});
afterEach(() => vi.useRealTimers());

describe('combined action preparation', () => {
  it('describes the exact element and prepares its form checks in one injection', async () => {
    const calls: string[] = [];
    const timings: BridgeScriptTiming[] = [];
    const api = browser(async (_target, func, args) => {
      calls.push(func.name);
      if (func.name === 'rebindPageRef') return { document_id: 'DOC', result: { kept: true } };
      if (func === describePageElement) {
        expect(args).toEqual([{ ref: 'e1' }, null, null, PAGE_MESSAGE_RULES]);
        return { document_id: 'DOC', result: { outputs: { url, title: 'Page', role: 'button', label: 'Save', protected: false,
          prepared_sends: true } } };
      }
      return { document_id: 'DOC', result: { outputs: { submitted: true } } };
    });
    api.onScriptTiming = timing => { timings.push(timing); };
    const cmd = command('submit', { page: '7:DOC', ref: 'e1' }, ['submitted', 'problem']);
    const out = await buildActionExecutor(api).execute({ action: cmd.action, command: cmd, cancel: { signalled: false } });
    expect(out).toEqual({ status: 'ok', outputs: { submitted: true } });
    expect(calls).toEqual(['rebindPageRef', 'describePageElement', 'submitPageForm']);
    expect(timings.map(timing => timing.phase)).toEqual(['rebind', 'describe', 'write']);
    for (const timing of timings) {
      expect(timing.duration_ms).toBeGreaterThanOrEqual(0);
      expect(Object.keys(timing).sort()).toEqual(['duration_ms', 'outcome', 'phase']);
    }
  });

  it.each(['missing-facts', 'wrong-document', 'off-site', 'cancelled'] as const)(
    'a refused preparation sends no write: %s', async reason => {
      const cancel = { signalled: false };
      const calls: string[] = [];
      const api = browser(async (_target, func) => {
        calls.push(func.name);
        if (func !== describePageElement) return { document_id: 'DOC', result: { kept: true } };
        if (reason === 'cancelled') cancel.signalled = true;
        return { document_id: reason === 'wrong-document' ? 'OTHER' : 'DOC', result: { outputs: {
          url: reason === 'off-site' ? 'https://other.example/' : url, title: 'Page', role: 'button', label: 'Save', protected: false,
          ...(reason === 'missing-facts' ? {} : { prepared_sends: true }) } } };
      });
      // An observer failure must never change the action's decision.
      api.onScriptTiming = async () => { throw new Error('diagnostic sink unavailable'); };
      const cmd = command('submit', { page: '7:DOC', ref: 'e1' }, ['submitted', 'problem']);
      const out = await buildActionExecutor(api).execute({ action: cmd.action, command: cmd, cancel });
      expect(out.status).not.toBe('ok');
      expect(calls).toEqual(['rebindPageRef', 'describePageElement']);
    });

  it('captures the error baseline after an explicit readiness probe', async () => {
    const calls: string[] = [];
    const api = browser(async (_target, func, args) => {
      calls.push(func.name);
      if (func.name === 'rebindPageRef') return { document_id: 'DOC', result: { kept: true } };
      if (func === describePageElement) return { document_id: 'DOC', result: { outputs: {
        url, title: 'Page', role: 'button', label: 'Save', protected: false,
        ...(args[3] ? { prepared_sends: true } : {}) } } };
      if (func === checkPageElement) return { document_id: 'DOC', result: { url, title: 'Page', met: false } };
      return { document_id: 'DOC', result: { outputs: { submitted: true } } };
    });
    const cmd = command('submit', { page: '7:DOC', ref: 'e1', ready_check: { selector: '#saved', until: 'shown' } },
      ['submitted', 'problem']);
    expect(await buildActionExecutor(api).execute({ action: cmd.action, command: cmd, cancel: { signalled: false } }))
      .toEqual({ status: 'ok', outputs: { submitted: true } });
    expect(calls).toEqual(['rebindPageRef', 'describePageElement', 'checkPageElement', 'describePageElement', 'submitPageForm']);
  });
});

describe('guarded link dispatch', () => {
  it.each(['detached', 'uncertain'] as const)('does not rebind or replay a %s target', async mode => {
    const calls: string[] = [];
    const execute = buildActionExecutor(browser(async (_target, func) => {
      calls.push(func.name);
      return { document_id: 'DOC', result: func === describePageElement
        ? mode === 'detached' ? { stale: true } : { outputs: { url, title: 'Page', role: 'link', label: 'Next', protected: false } }
        : func === clickPageElement ? { uncertain: true } : { outputs: {} } };
    }));
    const cmd = command('click', { page: '7:DOC', ref: 'e1', navigation_guard: guard }, ['clicked']);
    const out = await execute.execute({ action: cmd.action, command: cmd, cancel: { signalled: false } });
    expect(out.status).toBe('error');
    expect(calls).toEqual(mode === 'detached' ? ['describePageElement'] : ['describePageElement', 'clickPageElement']);
    if (mode === 'uncertain') expect(out.error?.code).toBe('delivery_uncertain');
  });

  it.each([
    ['click', { selector: '#next' }], ['submit', { page: '7:DOC', ref: 'e1' }],
    ['click', { page: '7:DOC', ref: 'e1', navigation_guard: { ...guard, after_url: url } }],
  ] as const)('rejects a guard outside a known link transition before dispatch: %s', async (action, args) => {
    const run = vi.fn(async () => null);
    const cmd = command(action, { navigation_guard: guard, ...args }, []);
    expect((await buildActionExecutor(browser(run)).execute({ action, command: cmd, cancel: { signalled: false } })).status).toBe('error');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('combined region wait and read', () => {
  it.each(['ready', 'cancelled', 'deadline', 'document-changed', 'url-changed'] as const)(
    'returns a coherent snapshot only while the request is current: %s', async mode => {
      vi.useFakeTimers(); vi.setSystemTime(0);
      const cancel = { signalled: false };
      let calls = 0;
      const cmd = command('wait_for_element', { page: '7:DOC', selector: '#result', timeout_ms: 100,
        capture_read: { expected_url: url, max_chars: 4_000, max_value_chars: 200 } },
      ['page', 'url', 'title', 'found', 'waited_ms', 'html', 'truncated', 'loading']);
      const out = await buildActionExecutor(browser(async (_target, func, args, options) => {
        expect(func).toBe(inspectPage); expect(options).toEqual({ immediate: true });
        expect(args[5]).toEqual({ selector: '#result', until: 'shown' });
        calls++;
        if (mode === 'cancelled') cancel.signalled = true;
        if (mode === 'deadline') vi.setSystemTime(101);
        return { document_id: mode === 'document-changed' ? 'NEW' : 'DOC', result: {
          outputs: { url: mode === 'url-changed' ? url + '?changed' : url, title: 'Result',
            html: '<section><h1>.name Grandfathered</h1></section>', truncated: false, loading: true } } };
      })).execute({ action: cmd.action, command: cmd, cancel });
      expect(calls).toBe(1);
      if (mode === 'ready') expect(out).toMatchObject({ status: 'ok', outputs: { page: '7:DOC', found: true,
        loading: true, html: expect.stringContaining('.name Grandfathered') } });
      else {
        expect(out.outputs?.html).toBeUndefined();
        if (mode === 'deadline') expect(out).toMatchObject({ status: 'ok', outputs: { found: false } });
        else expect(out.status).toBe(mode === 'cancelled' ? 'cancelled' : 'error');
      }
    });
});
