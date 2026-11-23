/** D-402 slice H3b (§4.2 item 3) — the commands a browser step may send, read before the run
 *  (`browser-step-commands.ts`), checked against what the real adapter sends.
 *
 *  ⛔ THE DRIFT GUARD. Each kind of Act step, and each single operation, runs through the real adapter
 *  (`createBridgeDomAdapter`) against a Bridge that answers everything; every command it sends must run on
 *  the least Bridge the static list asks for. `bridgeRunsCommand` only gains as a Bridge gains actions and
 *  flags, so that least Bridge passing means every Bridge that passes the check before step 1 runs them all.
 *  A kind the authoring schema accepts with no case here fails too. */
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_ACTIONS, BROWSER_ACT_STEPS_ARGUMENT_SCHEMA, bridgeRunsCommand, kernelOpForBackingSlug,
  type BridgeAction, type BridgeCapabilityProfile, type BridgeResult,
} from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createBrowserDataStore } from '../bridges/browser-data-store.js';
import { browserStepCommands, type BrowserCommand } from '../bridges/browser-step-commands.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import type { BridgeDispatcher, DispatchRequest } from '../bridges/dispatcher.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const PAGE = '7:DOC1';
const URL0 = 'https://shop.example/orders';
const HTML = '<main><h1>Orders</h1><form><label>Name <input ref="e2" name="name"></label><button ref="e1">Send</button></form>'
  + '<a ref="e3" href="https://shop.example/next">Next</a><table ref="e4"><tr><th>Item</th></tr><tr><td>Lamp</td></tr></table>'
  + '<ul><li ref="e5">Bob <input ref="e11" aria-label="Note"> <button ref="e6">Open</button></li><li ref="e7">Ann <button ref="e8">Open</button></li></ul>'
  + '<input ref="e9" type="file" aria-label="Attachment"><a ref="e10" href="https://shop.example/f.pdf">Invoice PDF</a></main>';
/** A Bridge that answers every command as if it went well. */
const answer = (request: DispatchRequest): Record<string, unknown> => {
  const args = request.args as Record<string, unknown>;
  const base = { page: typeof args.page === 'string' ? args.page : PAGE, url: URL0, title: 'Orders' };
  switch (request.action) {
    case 'list_tabs': return { tabs: [{ ...base }], truncated: false };
    case 'open_tab': return { ...base, page: '8:DOC2', url: String(args.url ?? URL0) };
    case 'inspect': case 'reread': return { ...base, html: HTML, truncated: false };
    case 'describe': return { ...base, role: 'textbox', label: 'Name', protected: false };
    case 'fill': return { ...base, filled: true, value: args.value };
    case 'pick': return { ...base, picked: args.pick };
    case 'click': return { ...base, clicked: 1 };
    case 'press': return { ...base, pressed: true };
    case 'submit': return { ...base, sent: true };
    case 'wait_for_element': return { ...base, found: true, waited_ms: 1, html: HTML };
    case 'read_table': return { ...base, columns: ['Item'], rows: [['Lamp']], truncated: false };
    case 'scroll': return { ...base, scrolled: true, screen: 2, screens: 3 };
    case 'close_tab': return { closed: true };
    case 'hover': return { ...base, hovered: true };
    case 'download_file': return { ...base, address: 'https://shop.example/f.pdf', filename: 'f.pdf', mime_type: 'application/pdf', size: 3, data: 'YWJj' };
    case 'upload_file': return { ...base, attached: true };
    default: return { ...base };
  }
};
/** What a step sends through the real adapter, by slug and input. */
const sends = async (slug: string, input: Record<string, unknown>): Promise<Array<{ action: BridgeAction; args: Record<string, unknown> }>> => {
  const sent: Array<{ action: BridgeAction; args: Record<string, unknown> }> = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    sent.push({ action: request.action, args: request.args as Record<string, unknown> });
    return { kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok', outputs: answer(request) } as BridgeResult };
  });
  const files = {
    keep: async () => ({ file_ref: `file:${'b'.repeat(32)}`, filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 3 }),
    read: async () => ({ bytes: Buffer.from('abc'), filename: 'f.pdf', mime_type: 'application/pdf' }),
    about: () => ({ filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 3 }),
  };
  const adapter = createBridgeDomAdapter({ manifests: { get: (one: string) => KERNEL_MANIFESTS.find((m) => m.slug === one) ?? null },
    data: createBrowserDataStore(), pageReads: createPageReadStore(), files: files as never,
    askModel: (async () => ({ result: { answer: 'Lamp' } })) as never,
    secrets: { resolve: async () => ({ value: 'hunter2', said: 'your password' }) } as never,
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const resolved: ResolvedCall = { slug, input: { target: '*://*/*', ...input }, risk_tier: 'write', output: {},
    stepMeta: { run_id: 'run', recipe_id: 'r', step_id: 'step', execution_source: { channel: 'user', actor: 'user_self', user_id: 'u' } as never } };
  // A step this Bridge's answers cannot finish still sent what it sent: those are the commands that count.
  await adapter(resolved).catch(() => undefined);
  return sent;
};
/** The least Bridge the static list asks for: its actions, `describe` for a command on a page handle,
 *  and each flag a listed command needs. */
const leastBridge = (commands: readonly BrowserCommand[]): BridgeCapabilityProfile => {
  const actions = new Set<BridgeAction>(commands.map((one) => one.action));
  if (commands.some((one) => one.action !== 'inspect' && one.action !== 'describe' && (one.args.page !== undefined || one.args.ref !== undefined))) actions.add('describe');
  return { software_version: '0.0.0', chrome_version: '140', permissions_granted: [], granted_origins: ['*://*/*'],
    offscreen_supported: true, alarms_supported: true, supported_actions: [...actions],
    row_checks: commands.some((one) => one.args.within !== undefined),
    structural_reads: commands.some((one) => one.args.preserve_structure === true),
    guarded_links: false };
};

const COLLECT = { items: 'li', fields: { name: { selector: 'button' } }, max_items: 10, max_seconds: 10 };
/** Each kind of Act step, with the variants that send more: an element by its text, a row, a check. */
const ACT: Array<[string, unknown[]]> = [
  ['type', [{ do: 'type', ref: 'e2', value: 'Bob' }]],
  ['type by text', [{ do: 'type', text: 'Name', value: 'Bob' }]],
  ['type, sending its form', [{ do: 'type', ref: 'e2', value: 'Bob', submit: true }]],
  ['type, picking a suggestion', [{ do: 'type', ref: 'e2', value: 'Bo', pick: 'Bob' }]],
  ['type, picking and sending', [{ do: 'type', ref: 'e2', value: 'Bo', pick: 'Bob', submit: true }]],
  ['type a secret', [{ do: 'type', ref: 'e2', secret: 'password' }]],
  ['type in a row', [{ do: 'type', text: 'Note', value: 'x', within: { text: ['Bob'] } }]],
  ['type in a row, sending', [{ do: 'type', text: 'Note', value: 'x', submit: true, within: { text: ['Bob'] } }]],
  ['type with success_when', [{ do: 'type', ref: 'e2', value: 'Bob', success_when: { shows: 'h1' } }]],
  ['click', [{ do: 'click', ref: 'e1' }]],
  ['click by text', [{ do: 'click', text: 'Send' }]],
  ['click in a row', [{ do: 'click', text: 'Open', within: { text: ['Bob'] } }]],
  ['click with success_when', [{ do: 'click', ref: 'e1', success_when: { shows: 'h1' } }]],
  ['click with fail_when', [{ do: 'click', ref: 'e1', fail_when: { shows: '.error' } }]],
  ['click with then_read', [{ do: 'click', ref: 'e1', then_read: 'main' }]],
  ['press', [{ do: 'press', ref: 'e2', key: 'Enter' }]],
  ['submit', [{ do: 'submit', ref: 'e2' }]],
  ['wait a while', [{ do: 'wait', seconds: 1 }, { do: 'read' }]],
  ['wait for an element', [{ do: 'wait', selector: 'h1', seconds: 2 }, { do: 'read' }]],
  ['wait for an address', [{ do: 'wait', url_includes: 'orders', seconds: 2 }, { do: 'read' }]],
  ['wait until ready', [{ do: 'wait', until: 'ready', seconds: 1 }, { do: 'read' }]],
  ['read', [{ do: 'read' }]],
  ['read as text', [{ do: 'read', form: 'text' }]],
  ['read an element', [{ do: 'read', ref: 'e4' }]],
  ['read, then data', [{ do: 'read', data_format: 'entries' }, { do: 'data', source: 'latest', pipeline: [{ transform: 'count' }] }]],
  ['ask', [{ do: 'ask', question: 'Which item?' }]],
  ['collect', [{ do: 'collect', ...COLLECT, max_pages: 1 }]],
  ['collect by position', [{ do: 'collect', ...COLLECT, items: 'li:nth-child(1)', max_pages: 1 }]],
  ['collect, paging by text', [{ do: 'collect', ...COLLECT, next: { text: 'Next' }, max_pages: 2 }]],
  ['table', [{ do: 'table' }]],
  ['scroll', [{ do: 'scroll' }]],
  ['scroll an element', [{ do: 'scroll', ref: 'e4' }]],
  ['go', [{ do: 'go', address: 'https://shop.example/next' }]],
  ['go, then read', [{ do: 'go', address: 'https://shop.example/next', then_read: 'main' }]],
  ['back', [{ do: 'back' }]],
  ['reload', [{ do: 'reload' }]],
  ['close', [{ do: 'close' }]],
  ['hover by text', [{ do: 'hover', text: 'Send' }]],
  ['download', [{ do: 'download', ref: 'e10' }]],
  ['download by text', [{ do: 'download', text: 'Invoice PDF' }]],
  ['download an address', [{ do: 'download', address: 'https://shop.example/f.pdf' }]],
  ['upload', [{ do: 'upload', ref: 'e9', file: `file:${'a'.repeat(32)}` }]],
  ['a tab by its address', [{ url: 'https://shop.example/other', do: 'read' }]],
];
const SINGLE: Array<[string, Record<string, unknown>]> = [
  ['dom-read', { selector: 'h1' }], ['dom-write', { selector: '#name', value: 'Bob' }], ['dom-click', { selector: '#send' }],
  ['dom-write', { page: PAGE, ref: 'e2', value: 'Bob' }], ['dom-click', { page: PAGE, ref: 'e1' }],
  ['dom-inspect', { page: PAGE }], ['dom-tabs', {}], ['dom-open', { address: 'https://shop.example/x' }],
  ['dom-wait', { page: PAGE, selector: 'h1' }], ['dom-table', { page: PAGE }], ['dom-screenshot', { page: PAGE }],
  ['dom-scroll', { page: PAGE }], ['dom-download', { page: PAGE, ref: 'e10' }],
];

const runsAll = (sent: ReadonlyArray<{ action: BridgeAction; args: Record<string, unknown> }>, listed: readonly BrowserCommand[]) =>
  sent.filter((one) => !bridgeRunsCommand(leastBridge(listed), one.action, one.args)).map((one) => `${one.action} ${JSON.stringify(one.args)}`);

describe('D-402 slice H3b — what a step sends, read before the run', () => {
  it.each(ACT)('an Act step, %s: every command it sends runs on the least Bridge its list asks for', async (_name, steps) => {
    const listed = browserStepCommands('core.dom.act', { steps });
    expect(listed).toBeDefined();
    const sent = await sends('dom-act', { page: PAGE, steps });
    expect(sent.length).toBeGreaterThan(0);
    expect(runsAll(sent, listed!)).toEqual([]);
  });

  it.each(SINGLE)('%s, %o: its command runs on the least Bridge its list asks for', async (slug, input) => {
    const op = kernelOpForBackingSlug(slug)!;
    const listed = browserStepCommands(op, input);
    expect(listed).toBeDefined();
    const sent = await sends(slug, input);
    expect(sent.length).toBeGreaterThan(0);
    expect(runsAll(sent, listed!)).toEqual([]);
  });

  it('⛔ every kind the authoring schema accepts has a case here', () => {
    const kinds: readonly string[] = BROWSER_ACT_STEPS_ARGUMENT_SCHEMA.items.properties.do.enum;
    const covered = new Set(ACT.flatMap(([, steps]) => steps.map((step) => (step as { do: string }).do)));
    expect(kinds.filter((kind) => !covered.has(kind))).toEqual([]);
    expect(kinds.length).toBeGreaterThanOrEqual(18);
  });

  it('a step known only at the run (its steps a setting) has no list, and a Bridge with every action runs any list', () => {
    expect(browserStepCommands('core.dom.act', { steps: '{{config.steps}}' })).toBeUndefined();
    expect(browserStepCommands('core.dom.act', { steps: [{ do: 'teleport' }] })).toBeUndefined();
    const every: BridgeCapabilityProfile = { ...leastBridge([]), supported_actions: [...BRIDGE_ACTIONS], row_checks: true, structural_reads: true };
    for (const [, steps] of ACT) for (const one of browserStepCommands('core.dom.act', { steps })!) {
      expect(bridgeRunsCommand(every, one.action, one.args)).toBe(true);
    }
  });
});
