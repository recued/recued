import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor } from '../actions/executor.js';
import { executeReviewedBridgeDocument, type DocumentScripting } from '../actions/reviewed-document.js';
import { fillPageField, readPageField } from '../actions/page-fields.js';
import { createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { dispatchBridgeCommand } from '../queue/dispatcher.js';

const document = { tab_id: 4, document_id: 'reviewed-document', url: 'https://app.fixture.invalid/record/1' };
const command = (action: 'fill' | 'click' | 'read_dom'): BridgeCommand => ({
  command_id: 'original', recipe_run_id: 'run', step_id: 'step', action,
  target_domain_pattern: 'https://app.fixture.invalid/*',
  ingredient: { publisher_id: 'fixture', slug: 'reviewed', version: '1', surface_kind: 'authoring',
    domain_allowlist: ['https://app.fixture.invalid/*'], domain_allowlist_signature: '' },
  reviewed_document: document, args: { selector: '#save', value: 'reviewed value' },
  expects_output_keys: [action === 'fill' ? 'filled' : action === 'click' ? 'clicked' : 'text'],
  idempotency_key: 'same-intent', timeout_ms: 5_000,
});

const executor = (scripting: DocumentScripting) => buildActionExecutor({
  executeReviewedDocument: (doc, action, args) => executeReviewedBridgeDocument(scripting, doc, action, args),
  findTabByUrlPattern: async () => { throw new Error('Reviewed calls must use the bound document'); },
  executeScript: async () => { throw new Error('Reviewed calls must use the bound document'); },
  captureVisibleTab: async () => null, showNotification: async id => id,
});

describe('reviewed command acknowledgement and durable admission', () => {
  const malformed = (action: 'click' | 'fill') => {
    const key = action === 'click' ? 'clicked' : 'filled';
    return [
      { outputs: {} }, { outputs: { [key]: false } }, { outputs: { [key]: 'true' } },
      { outputs: { [key]: true, extra: 'unexpected' } },
      { missing: 'true' }, { blocked: 1 },
      { missing: true, outputs: { [key]: true } }, { blocked: true, missing: true },
    ];
  };
  it.each((['click', 'fill'] as const).flatMap(action => malformed(action).map(ack => ({ action, ack }))))(
    'keeps a malformed reviewed $action acknowledgement uncertain ($ack)', async ({ action, ack }) => {
      const out = await executeReviewedBridgeDocument({ executeScript: async () => [
        { documentId: document.document_id, result: ack },
      ] }, document, action, { selector: '#save', value: 'value' });
      expect(out).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
      expect(out.outputs).toBeUndefined();
    });

  it.each(['click', 'fill'] as const)('accepts the exact positive reviewed $action acknowledgement', async action => {
    const outputs = { [action === 'click' ? 'clicked' : 'filled']: true };
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { outputs } },
    ] }, document, action, { selector: '#save', value: 'value' });
    expect(out).toEqual({ status: 'ok', outputs });
  });

  const failures = ['rejected injection', 'missing response', 'wrong document', 'malformed response'] as const;
  const cases = (['fill', 'click'] as const).flatMap(action => failures.map(failure => ({ action, failure })));
  it.each(cases)('preserves $action uncertainty after $failure across cache recreation and clearing', async ({ action, failure }) => {
    const indexedDB = new IDBFactory(); let clock = 1_000;
    const reopen = () => createIndexedDbIdempotencyCache({ indexedDB, now: () => clock,
      scope: { server_public_key: 'server', token_id: 'owner-bridge' } });
    // The page changed, but Chrome did not provide a usable acknowledgement.
    const scripting: DocumentScripting = { executeScript: vi.fn(async () => {
      if (failure === 'rejected injection') throw new Error('Acknowledgement lost after the page changed');
      if (failure === 'missing response') return [];
      if (failure === 'wrong document') return [{ documentId: 'other', result: { outputs: { clicked: true } } }];
      return [{ documentId: document.document_id, result: {} }];
    }) };
    const original = command(action); const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(original.ingredient, [original.target_domain_pattern], clock));
    const deps = { bridge_version: 'fixture', now: () => clock, grants, executor: executor(scripting) };
    const first = await dispatchBridgeCommand(original, { ...deps, idempotency: reopen() });
    clock += BRIDGE_IDEMPOTENCY_TTL_MS * 2;
    await reopen().clear();
    const retry = await dispatchBridgeCommand({ ...original, command_id: 'retry' }, { ...deps, idempotency: reopen() });
    expect(scripting.executeScript).toHaveBeenCalledOnce();
    expect(first.result).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(retry.result).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' }, idempotency_key_seen: true });
  });

  it.each(['blocked', 'missing'] as const)('keeps a confirmed %s refusal distinct from an unacknowledged write', async refusal => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { [refusal]: true } },
    ] }, document, 'click', { selector: '#save' });
    expect(out).toMatchObject({ status: 'error', error: {
      code: refusal === 'blocked' ? 'tab_navigation_blocked' : 'selector_not_found',
    } });
  });

  it('runs the shared field functions with the reviewed address, in the bound document', async () => {
    const calls: Array<{ func: unknown; args: readonly unknown[]; documentIds?: string[] }> = [];
    const scripting: DocumentScripting = { executeScript: async ({ func, args, target }) => {
      calls.push({ func, args, documentIds: target.documentIds });
      return [{ documentId: document.document_id, result: { missing: true } }];
    } };
    await executeReviewedBridgeDocument(scripting, document, 'read_dom', { selector: '#title' });
    await executeReviewedBridgeDocument(scripting, document, 'fill', { selector: '#draft', value: 'text' });
    expect(calls).toEqual([
      { func: readPageField, args: ['#title', document.url], documentIds: [document.document_id] },
      { func: fillPageField, args: ['#draft', 'text', document.url], documentIds: [document.document_id] },
    ]);
  });

  // D-335 — a reviewed inspect reads the reviewed document and no other.
  it('refuses an inspect whose page handle names another document, before injecting', async () => {
    const reviewed = { ...document, document_id: 'REVIEWED1' };
    const executeScript = vi.fn<DocumentScripting['executeScript']>(async () => [{ documentId: 'REVIEWED1',
      result: { outputs: { url: reviewed.url, title: 'Record', html: '<body></body>', truncated: false } } }]);
    for (const page of ['4:ANOTHER1', '5:REVIEWED1']) {
      expect(await executeReviewedBridgeDocument({ executeScript }, reviewed, 'inspect', { page }))
        .toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    }
    expect(executeScript).not.toHaveBeenCalled();
    expect(await executeReviewedBridgeDocument({ executeScript }, reviewed, 'inspect', { page: '4:REVIEWED1' }))
      .toMatchObject({ status: 'ok', outputs: { page: '4:REVIEWED1', html: '<body></body>' } });
  });

  it('keeps a write the page did not take as a confirmed failure, with its reason', async () => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { not_applied: 'No option in the list matches the value.' } },
    ] }, document, 'fill', { selector: '#stage', value: 'Lost' });
    expect(out).toEqual({ status: 'error', error: { code: 'value_not_applied', message: 'No option in the list matches the value.' } });
  });

  it('refuses a protected field on a reviewed read', async () => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { protected: true } },
    ] }, document, 'read_dom', { selector: '#password' });
    expect(out).toMatchObject({ status: 'error', error: { code: 'field_protected' } });
  });

  // A click refuses before it sends anything (an element that is disabled or
  // covered, 2026-11-01): nothing was clicked, so the refusal is confirmed.
  it('reports a click refused before anything was sent as not clicked, with its reason', async () => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { not_applied: 'It is disabled, so it was not clicked.' } },
    ] }, document, 'click', { selector: '#save' });
    expect(out).toEqual({ status: 'error', error: { code: 'value_not_applied', message: 'It is disabled, so it was not clicked.' } });
  });

  it('carries bounded obstruction evidence only for a canonical reviewed click refusal', async () => {
    const obstruction = { operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test',
      target: { tag: 'button' }, blocker: { tag: 'div', role: 'dialog' }, waited_ms: 0 };
    const message = 'Something covers it, so it was not clicked.';
    const run = (action: 'click' | 'fill', not_applied: unknown) => executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: { not_applied } },
    ] }, document, action, { selector: '#save', value: 'value' });
    expect(await run('click', { message, obstruction })).toEqual({ status: 'error', error: {
      code: 'value_not_applied', message, obstruction } });
    expect(await run('click', { message, obstruction: { ...obstruction, waited_ms: NaN } }))
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(await run('fill', { message, obstruction })).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
  });

  // A refusal belongs to one operation; on any other it proves nothing.
  it.each([
    ['click', { not_applied: true }], ['click', { protected: true }], ['fill', { protected: true }],
    ['fill', { not_applied: true }],
  ] as const)('keeps a %s answer of %j uncertain', async (action, answer) => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => [
      { documentId: document.document_id, result: answer },
    ] }, document, action, { selector: '#save', value: 'value' });
    expect(out).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
  });

  it('keeps a read injection rejection as a read failure', async () => {
    const out = await executeReviewedBridgeDocument({ executeScript: async () => { throw new Error('closed'); } },
      document, 'read_dom', { selector: '#title' });
    expect(out).toMatchObject({ status: 'error', error: { code: 'unknown' } });
  });
});
