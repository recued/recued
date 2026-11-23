import { describe, expect, it } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { checkPageElement } from '../actions/page-wait.js';
import { pageProblem } from '../actions/page-problems.js';

type Mode = 'first-invalid' | 'first-blocked' | 'first-malformed' | 'first-missing' | 'first-foreign'
  | 'repeat-invalid' | 'repeat-missing' | 'success' | 'failure-wins' | 'repeat-failure-wins' | 'problem' | 'no-failure';
const url = 'https://wait.example.test/page';
const problem = 'Your password is invalid!';

// Real executor and failure-result decoder; page checks and document delivery
// are controlled replies. Native DOM checks are qualified separately.
const wait = async (mode: Mode) => {
  const repeated = mode.startsWith('repeat-') || mode === 'problem';
  const state = { primary: 0, failure: 0, problems: 0 };
  const met = (yes: boolean) => ({ outputs: { url, title: 'Fixture', met: yes } });
  const reply = (result: unknown) => ({ document_id: 'DOC7', result });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (func === pageProblem) { state.problems += 1; return reply(problem); }
      if (func !== checkPageElement) throw new Error(`unexpected script ${func.name}`);
      if ((args[0] as { selector: string }).selector === '#ready') {
        state.primary += 1;
        return reply(met(!repeated));
      }
      state.failure += 1;
      if (repeated && state.failure === 1) return reply(met(false));
      if (mode === 'first-invalid' || mode === 'repeat-invalid') return reply({ invalid: true });
      if (mode === 'first-blocked') return reply({ blocked: true });
      if (mode === 'first-malformed') return reply({ outputs: { url, title: 'Fixture', met: 'yes' } });
      if (mode === 'first-missing' || mode === 'repeat-missing') return null;
      if (mode === 'first-foreign') return { document_id: 'OTHER', result: met(false) };
      return reply(met(mode === 'failure-wins' || mode === 'repeat-failure-wins'));
    },
  };
  const command: BridgeCommand = {
    command_id: 'wait', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://wait.example.test/*'], domain_allowlist_signature: 'fixture' },
    action: 'wait_for_element', target_domain_pattern: 'https://wait.example.test/*',
    args: { page: '7:DOC7', selector: '#ready', until: 'shown', timeout_ms: 0,
      ...(mode === 'no-failure' ? {} : { fail: { selector: mode === 'first-invalid' ? '[' : '#failed', text: 'Request failed' } }),
      ...(repeated ? { problems: true } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'found', 'waited_ms', 'failed', 'problem'],
    timeout_ms: 5000, idempotency_key: 'wait',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'wait_for_element', command, cancel: { signalled: false } });
  return { outcome, state };
};

describe('configured wait failure checks require a verified result', () => {
  it.each([
    ['first-invalid', 'selector_not_found'],
    ['first-blocked', 'tab_navigation_blocked'],
    ['first-malformed', 'unknown'],
    ['first-missing', 'selector_not_found'],
    ['first-foreign', 'selector_not_found'],
    ['repeat-invalid', 'selector_not_found'],
    ['repeat-missing', 'selector_not_found'],
  ] as const)('propagates %s instead of reporting success or an unverified problem', async (mode, code) => {
    const result = await wait(mode);
    expect(result.outcome).toMatchObject({ status: 'error', error: { code } });
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.state).toEqual({ primary: 1, failure: mode.startsWith('repeat-') ? 2 : 1,
      problems: mode.startsWith('repeat-') ? 1 : 0 });
  });

  it.each([
    ['success', { found: true }, { primary: 1, failure: 1, problems: 0 }],
    ['failure-wins', { found: false, failed: true }, { primary: 1, failure: 1, problems: 0 }],
    ['repeat-failure-wins', { found: false, failed: true, problem }, { primary: 1, failure: 2, problems: 1 }],
    ['problem', { found: false, problem }, { primary: 1, failure: 2, problems: 1 }],
    ['no-failure', { found: true }, { primary: 1, failure: 0, problems: 0 }],
  ] as const)('preserves the confirmed %s outcome', async (mode, expected, state) => {
    const result = await wait(mode);
    expect(result.outcome.status).toBe('ok');
    const { waited_ms, ...outputs } = result.outcome.outputs ?? {};
    expect(typeof waited_ms).toBe('number');
    expect(waited_ms).toBeGreaterThanOrEqual(0);
    expect(outputs).toEqual({ page: '7:DOC7', url, title: 'Fixture', ...expected });
    expect(result.state).toEqual(state);
  });
});
