import { describe, expect, it } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';

const pattern = 'https://picker.example.test/allowed/*';
const initial = 'https://picker.example.test/allowed/form';
type Mode = 'outside-path' | 'other-origin' | 'malformed-url' | 'same-url' | 'allowed-spa-update'
  | 'cancel-before-click' | 'foreign-document';

// Real executor; page answers and document delivery are controlled adapters.
// The full injected-function chain is also qualified in local browser fixtures.
const pick = async (mode: Mode) => {
  const cancel = { signalled: false };
  const chosenUrl = mode === 'outside-path' ? 'https://picker.example.test/restricted/form'
    : mode === 'other-origin' ? 'https://other.example.test/allowed/form'
      : mode === 'malformed-url' ? 'not-a-url'
        : mode === 'allowed-spa-update' ? 'https://picker.example.test/allowed/results?term=Acme' : initial;
  const state = { typed: 0, clicks: [] as unknown[][], checks: 0 };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      const answer = (result: unknown) => ({ document_id: 'DOC7', result });
      switch (func.name) {
        case 'rebindPageRef': return answer({ kept: true });
        case 'describePageElement': return answer({ outputs: {
          url: initial, title: 'Company', role: 'combo box', label: 'Company', protected: false,
        } });
        case 'notePickLists': return answer({ noted: true, ref: 'e2' });
        case 'fillPageField': state.typed += 1; return answer({ outputs: { filled: true } });
        case 'findPickOption': {
          if (mode === 'cancel-before-click') cancel.signalled = true;
          return { document_id: mode === 'foreign-document' ? 'OTHER' : 'DOC7',
            result: { found: 'e40', label: 'Acme Corp', url: chosenUrl } };
        }
        case 'clickPageElement': state.clicks.push([...args]); return answer({ outputs: { clicked: true } });
        case 'pickTook': state.checks += 1; return answer({ took: 'hidden' });
        default: throw new Error(`unexpected script ${func.name}`);
      }
    },
  };
  const command: BridgeCommand = {
    command_id: 'pick', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: [pattern], domain_allowlist_signature: 'fixture' },
    action: 'pick', target_domain_pattern: pattern,
    args: { page: '7:DOC7', selector: '#company', value: 'Acme', pick: 'Acme Corp', pick_ms: 1000 },
    expects_output_keys: ['filled', 'picked'], timeout_ms: 10_000, idempotency_key: 'pick',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'pick', command, cancel });
  return { outcome, state, chosenUrl };
};

describe('autocomplete suggestion click URL scope', () => {
  it.each(['outside-path', 'other-origin', 'malformed-url'] as const)(
    'refuses a %s suggestion URL before clicking', async mode => {
      const result = await pick(mode);
      expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(result.outcome.outputs).toBeUndefined();
      expect(result.state).toEqual({ typed: 1, clicks: [], checks: 0 });
    });

  it.each(['same-url', 'allowed-spa-update'] as const)('preserves a %s pick and its confirmation', async mode => {
    const result = await pick(mode);
    expect(result.outcome).toEqual({ status: 'ok', outputs: { filled: true, picked: 'Acme Corp' } });
    expect(result.state).toEqual({ typed: 1, clicks: [['', result.chosenUrl, 'e40']], checks: 1 });
  });

  it('preserves cancellation before the suggestion click', async () => {
    const result = await pick('cancel-before-click');
    expect(result.outcome.status).toBe('cancelled');
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.state).toEqual({ typed: 1, clicks: [], checks: 0 });
  });

  it('keeps a suggestion receipt from another document from reaching the click', async () => {
    const result = await pick('foreign-document');
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'value_not_applied' } });
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.state).toEqual({ typed: 1, clicks: [], checks: 0 });
  });
});
