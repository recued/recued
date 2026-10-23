import { describe, expect, it, vi } from 'vitest';
import type { ServerExecuteResponse } from '@recued/contracts';
import { copyRecipeResultValue } from '../recipes/recipe-result-panel.js';
import { copyRecipeRunSummary, recipeRunSummary, renderRecipeRunSummary } from '../recipes/recipe-run-summary.js';

const result = (overrides: Partial<ServerExecuteResponse> = {}): ServerExecuteResponse => ({
  recipe_id: 'send-report', recipe_hash: 'a'.repeat(64), run_id: 'run-123', success: true,
  output: { render: [], sidebar: [] },
  steps: [{ id: 'send', type: 'ingredient', skipped: false, duration_ms: 9, error: null }],
  errors: [], duration_ms: 12, ...overrides,
});

describe('recipe run summary metadata projection', () => {
  it('reports a non-matching trigger as skipped while retaining the trigger work that actually ran', () => {
    const text = recipeRunSummary({ ...result({ run_id: undefined, steps: [
      { id: 'poll', type: 'trigger', skipped: false, duration_ms: 9, error: null },
    ] }), trigger_skipped: true });
    expect(text).toContain('Outcome: Skipped (trigger did not match)\n');
    expect(text).toContain('Steps run: 1');
    expect(text).toContain('Run ID: Not provided');
    expect(text).not.toContain('Outcome: Completed');
  });

  it('copies the actual execution identity and recorded metrics instead of output or free error text', () => {
    const error = { code: 'ACTION_DELIVERY_UNCERTAIN',
      get message() { throw new Error('message must not be read'); },
      get details() { throw new Error('details must not be read'); },
      source: { step_id: 'private-step' },
    };
    const response = result({ success: false, errors: [error, { code: 'private@example.test' }],
      run_facts: { steps_run: 4, items_total: 12, duration_ms: 42000, provider_calls: 2, total_tokens: 300 },
      steps: [{ id: 'private-step', type: 'ingredient', skipped: false, duration_ms: 9, error,
        foreach: { items: 12, failed: 3 } }],
      runnability_warnings: ['private provider message'],
    });
    Object.defineProperty(response, 'output', { get() { throw new Error('output must not be read'); } });
    const text = recipeRunSummary(response);
    expect(text).toContain('Recipe: send-report\n');
    expect(text).toContain('Run ID: run-123\nOutcome: Failed');
    expect(text).toContain('Duration: 42000 ms\nSteps run: 4\nItems attempted: 12\nFailed items: 3');
    expect(text).toContain('Error codes: ACTION_DELIVERY_UNCERTAIN');
    expect(text).toContain('Unrecognized error codes: present');
    expect(text).toContain('Run warnings: 1');
    expect(text).not.toMatch(/private|provider message|source|condition/);
  });

  it.each([
    [{ success: false }, 'Failed'],
    [{ awaiting_approval: true, success: false }, 'Awaiting approval'],
    [{ awaiting_peer: true, awaiting_approval: true, success: false }, 'Awaiting peer response'],
    [{ run_terminated: 'killed' as const, awaiting_approval: true }, 'Terminated'],
    [{ stopped: { step_id: 'done', condition: 'private condition' } }, 'Completed early'],
    [{}, 'Completed'],
  ])('distinguishes lifecycle outcomes for %j', (overrides, outcome) => {
    const text = recipeRunSummary(result(overrides));
    expect(text).toContain(`Outcome: ${outcome}\n`);
    expect(text).not.toContain('private condition');
  });

  it('retains partial foreach failures on a successful run and counts only executed steps', () => {
    const text = recipeRunSummary(result({ run_id: undefined, steps: [
      { id: 'each', type: 'foreach', skipped: false, duration_ms: 1, error: null, foreach: { items: 4, failed: 2 } },
      { id: 'skip', type: 'ingredient', skipped: true, duration_ms: 0, error: null },
    ] }));
    expect(text).toContain('Run ID: Not provided');
    expect(text).toContain('Outcome: Completed');
    expect(text).toContain('Steps run: 1\nFailed items: 2');
    expect(text).toContain('Error codes: Not reported');
  });

  it('rejects inherited and arbitrary codes and deduplicates known codes from errors and steps', () => {
    const text = recipeRunSummary(result({ errors: [
      { code: '__proto__' }, { code: 'toString' }, 'private failure', { code: 'BAD_INPUT' },
      { code: 'BAD_INPUT' }, { code: 'STEP_TIMEOUT' },
    ], steps: [{ id: 'send', type: 'ingredient', skipped: false, duration_ms: 0, error: { code: 'BAD_INPUT' } }] }));
    expect(text).toContain('Error codes: BAD_INPUT, STEP_TIMEOUT');
    expect(text).not.toMatch(/__proto__|toString|private failure/);
  });

  it('bounds identities, removes control characters, escapes markup and keeps missing metrics honest', () => {
    const response = result({ recipe_id: `</textarea>\n${'x'.repeat(1000)}`, recipe_hash: '\u0000',
      duration_ms: NaN, run_facts: { steps_run: -1, items_total: -1, duration_ms: Infinity } });
    const text = recipeRunSummary(response);
    expect(text).toContain('Duration: Unavailable');
    expect(text).toContain('Recipe hash: Unavailable');
    expect(text).not.toContain('\u0000');
    expect(text.length).toBeLessThan(650);
    const html = renderRecipeRunSummary(response);
    expect(html).not.toContain('</textarea> x');
    expect(html).toContain('&lt;/textarea&gt;');
    expect(html).toContain('Copy run summary');
    expect(html).toContain('readonly');
  });
});

const copyRig = (write?: (text: string) => Promise<void>) => {
  const attrs = new Map([['data-value', 'safe summary'], ['data-recued-run-summary-copy', '']]);
  const status = { textContent: '' };
  const details = { open: false };
  const state = { connected: true, active: null as unknown };
  const field = { focus: vi.fn(() => { state.active = field; }), select: vi.fn() };
  const host = {
    contains: (node: unknown) => node === button,
    querySelector: (selector: string) => selector === 'details' ? details : selector === 'textarea' ? field : status,
  };
  const button = {
    get isConnected() { return state.connected; },
    closest: () => host,
    getAttribute: (key: string) => attrs.get(key) ?? null,
    setAttribute: (key: string, value: string) => { attrs.set(key, value); },
    removeAttribute: (key: string) => { attrs.delete(key); },
  } as unknown as HTMLElement;
  state.active = button;
  const navigator = { clipboard: write ? { writeText: write } : undefined };
  const doc = { defaultView: { navigator }, get activeElement() { return state.active; } } as unknown as Document;
  return { button, doc, attrs, status, details, state, field, navigator };
};

describe('recipe run summary clipboard lifecycle', () => {
  it('uses the shared result copy handler and reports completion on the same result', async () => {
    const write = vi.fn(async () => {});
    const rig = copyRig(write);
    await copyRecipeResultValue(rig.button, rig.doc);
    expect(write).toHaveBeenCalledWith('safe summary');
    expect(rig.status.textContent).toBe('Run summary copied.');
    expect(rig.attrs.has('aria-busy')).toBe(false);
  });

  it.each(['missing', 'denied', 'throwing-getter'])('offers manual selection when clipboard access is %s', async mode => {
    const rig = copyRig(mode === 'denied' ? async () => { throw new Error('private error'); } : undefined);
    if (mode === 'throwing-getter') Object.defineProperty(rig.navigator, 'clipboard', { get() { throw new Error('private error'); } });
    await copyRecipeRunSummary(rig.button, rig.doc);
    expect(rig.details.open).toBe(true);
    expect(rig.field.focus).toHaveBeenCalledOnce();
    expect(rig.field.select).toHaveBeenCalledOnce();
    expect(rig.status.textContent).toBe('Recued could not copy it. Copy the summary below.');
    expect(rig.attrs.has('aria-disabled')).toBe(false);
  });

  it.each([true, false])('ignores a late clipboard result after a new run replaces its DOM (success=%s)', async success => {
    let resolve!: () => void; let reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const rig = copyRig(write);
    const pending = copyRecipeRunSummary(rig.button, rig.doc);
    await copyRecipeRunSummary(rig.button, rig.doc);
    expect(write).toHaveBeenCalledOnce();
    rig.state.connected = false;
    rig.status.textContent = 'replacement result';
    if (success) resolve(); else reject(new Error('old denial'));
    await pending;
    expect(rig.status.textContent).toBe('replacement result');
    expect(rig.details.open).toBe(false);
    expect(rig.field.focus).not.toHaveBeenCalled();
  });

  it('does not steal focus when clipboard denial arrives after the user moved to another control', async () => {
    let reject!: (error: Error) => void;
    const rig = copyRig(() => new Promise<void>((_yes, no) => { reject = no; }));
    const pending = copyRecipeRunSummary(rig.button, rig.doc);
    rig.state.active = {};
    reject(new Error('denied'));
    await pending;
    expect(rig.details.open).toBe(true);
    expect(rig.field.focus).not.toHaveBeenCalled();
  });
});
