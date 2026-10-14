/** D-322 §24 — resource-edit, stale-reply and teardown behavior at the controller. */
import { describe, expect, it, vi } from 'vitest';
import { RpcError, type PackAccessPlan, type PackAccessResult } from '@recued/contracts';
import { createPackResourceAccessController, packResourceAccessFocusOf, packResourceAccessFocusTargets,
  type PackResourceAccessCaller } from '../settings/pack-resource-access-controls.js';

class Node {
  children: Node[] = [];
  parent: Node | null = null;
  attrs = new Map<string, string>();
  handlers = new Map<string, Array<() => void>>();
  textContent = ''; value = ''; disabled = false; href = '';
  constructor(readonly tagName = 'DIV') {}
  appendChild(node: Node): Node { this.children.push(node); node.parent = this; return node; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  addEventListener(event: string, handler: () => void): void { this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]); }
  trigger(event: string): void { if (!this.disabled) for (const h of this.handlers.get(event) ?? []) h(); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  querySelector(selector: string): Node | null {
    const key = selector.slice(1, -1);
    return all(this).find(n => n.attrs.has(key)) ?? null;
  }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const text = (node: Node): string => all(node).map(n => n.textContent).join(' ');
const one = (root: Node, attr: string, value?: string): Node => {
  const node = all(root).find(n => n.attrs.has(attr) && (value === undefined || n.attrs.get(attr) === value));
  if (!node) throw new Error('Missing ' + attr + ':' + value);
  return node;
};
const target = { pack_slug: 'google-sheets', slot: 'google', connection_name: 'work-sheets' };
const plan = (): PackAccessPlan => ({ ...target, action: 'plan', fingerprint: 'a'.repeat(64), connection_updated_at: 2,
  checks: [{ id: 'spreadsheet', label: 'Read spreadsheet metadata', operation: 'spreadsheet.read', required_scopes: [],
    input: { key: 'spreadsheetId', label: 'Spreadsheet ID or Google Sheets URL', format: 'google_spreadsheet' } }], other_operation_count: 6 });
const receipt = (): PackAccessResult => ({ ...target, action: 'check', fingerprint: 'a'.repeat(64), connection_updated_at: 2,
  check_id: 'spreadsheet', status: 'passed', reason: 'protected_read_passed', checked_at: 1000, http_status: 200 });
const rig = (handler: PackResourceAccessCaller = async request => request.action === 'plan' ? plan() : receipt()) => {
  const root = new Node();
  const call = vi.fn(handler);
  let changes = 0;
  const render = () => { root.children = []; controller.render(root as unknown as HTMLElement, target, false); };
  const controller = createPackResourceAccessController({
    document: { createElement: (tag: string) => new Node(tag.toUpperCase()) } as unknown as Document, call,
    onChange: () => { changes++; render(); },
  });
  render();
  const open = async () => { one(root, 'data-pack-access-action', 'open').trigger('click'); await controller.whenSettled(); };
  const input = (value: string) => { const field = one(root, 'data-pack-access-input'); field.value = value; field.trigger('input'); };
  const run = async () => { one(root, 'data-pack-access-action', 'spreadsheet').trigger('click'); await controller.whenSettled(); };
  return { root, call, controller, render, open, input, run, changes: () => changes };
};

describe('D-322 pack resource access controls', () => {
  it('restores resource focus only within the same pack, slot and saved account', async () => {
    const f = rig(); await f.open();
    const input = one(f.root, 'data-pack-access-input');
    Object.assign(input, { selectionStart: 2, selectionEnd: 4 });
    const focus = packResourceAccessFocusOf(input as unknown as HTMLElement)!;
    expect(focus.selection).toEqual({ start: 2, end: 4 });
    const matches = packResourceAccessFocusTargets(focus);
    expect(matches[0]!(input as unknown as HTMLElement)).toBe(true);
    for (const attr of ['data-pack-access-for-pack', 'data-pack-access-for-slot', 'data-pack-access-for-connection']) {
      const other = new Node('INPUT'); other.attrs = new Map(input.attrs); other.setAttribute(attr, 'another');
      expect(matches.some(match => match(other as unknown as HTMLElement))).toBe(false);
    }
  });
  it('requires an explicit check and a resource, preserves the entered URL, and reports a scoped read result', async () => {
    const f = rig(); expect(f.call).not.toHaveBeenCalled();
    await f.open(); await f.run(); expect(f.call).toHaveBeenCalledTimes(1);
    expect(text(f.root)).toContain('Enter a valid resource ID');
    f.input('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=1'); await f.run();
    expect(f.call.mock.calls[1]![0]).toMatchObject({ action: 'check', connection_name: 'work-sheets',
      input: 'https://docs.google.com/spreadsheets/d/abc_123/edit#gid=1' });
    expect(one(f.root, 'data-pack-access-result').attrs.get('data-pack-access-result')).toBe('passed');
    expect(text(f.root)).toContain('write permissions remain unverified');
    expect(one(f.root, 'data-pack-access-review').href).toBe('#connections/others/review-access/api/work-sheets');
  });
  it('clears the previous resource’s receipt and HTTP status immediately on input edits', async () => {
    const f = rig(); await f.open(); f.input('first'); await f.run();
    expect(text(f.root)).toContain('HTTP 200'); f.input('second');
    expect(text(f.root)).not.toContain('HTTP 200');
    expect(all(f.root).some(n => n.attrs.has('data-pack-access-result'))).toBe(false);
  });
  it('blocks path injection on the client without sending a check request', async () => {
    const f = rig(); await f.open(); f.input('../tokens'); await f.run();
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['denied', 'access_denied', 'Access denied'],
    ['unverified', 'resource_not_found', 'not found'],
    ['unverified', 'unreachable', 'could not be reached'],
  ] as const)('shows %s for %s', async (status, reason, copy) => {
    const f = rig(async request => request.action === 'plan' ? plan() : { ...receipt(), status, reason, http_status: status === 'denied' ? 403 : 404 });
    await f.open(); f.input('test'); await f.run();
    expect(one(f.root, 'data-pack-access-result').attrs.get('data-pack-access-result')).toBe(status);
    expect(text(f.root)).toContain(copy);
  });
  it('renders undeclared checks as unverified without making vendor requests', async () => {
    const f = rig(async () => ({ ...plan(), checks: [], unavailable_reason: 'not_declared' }));
    await f.open(); expect(text(f.root)).toContain('no declared read-only access checks');
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(all(f.root).some(n => n.attrs.get('data-pack-access-action') === 'spreadsheet')).toBe(false);
  });
  it('rejects a result for another account and sanitizes malformed replies', async () => {
    const f = rig(async request => request.action === 'plan' ? plan() : { ...receipt(), connection_name: 'someone-else', secret: 'hidden' });
    await f.open(); f.input('test'); await f.run();
    expect(text(f.root)).toContain('could not be loaded or completed');
    expect(text(f.root)).not.toMatch(/hidden|Passed:/);
  });
  it('requires a fresh plan after a conflict and removes older successful evidence', async () => {
    let stale = false;
    const f = rig(async request => { if (request.action === 'plan') return plan(); if (stale) throw new RpcError('conflict', 'stale'); return receipt(); });
    await f.open(); f.input('test'); await f.run(); stale = true; await f.run();
    expect(text(f.root)).toContain('Refresh the checks'); expect(text(f.root)).not.toContain('Passed:');
    expect(all(f.root).some(n => n.attrs.has('data-pack-access-input'))).toBe(false);
  });
  it('uses only a validated refresh continuation for the next resource check', async () => {
    const f = rig(async request => request.action === 'plan' ? plan()
      : { ...receipt(), fingerprint: request.fingerprint, next_fingerprint: 'b'.repeat(64), connection_updated_at: 3 });
    await f.open(); f.input('first'); await f.run(); f.input('second'); await f.run();
    expect(f.call.mock.calls[2]![0]).toMatchObject({ action: 'check', fingerprint: 'b'.repeat(64), input: 'second' });
    expect(f.call).toHaveBeenCalledTimes(3);
  });
  it('does not accept a revision older than the reviewed plan', async () => {
    const f = rig(async request => request.action === 'plan' ? plan() : { ...receipt(), connection_updated_at: 1 });
    await f.open(); f.input('test'); await f.run();
    expect(text(f.root)).not.toContain('Passed:');
  });
  it('locks actions during a request and retires a late reply after refresh or disposal', async () => {
    let resolve!: (value: PackAccessResult) => void;
    const wait = new Promise<PackAccessResult>(r => { resolve = r; });
    const f = rig(async request => request.action === 'plan' ? plan() : wait);
    await f.open(); f.input('test'); one(f.root, 'data-pack-access-action', 'spreadsheet').trigger('click');
    expect(one(f.root, 'data-pack-access-input').disabled).toBe(true);
    expect(one(f.root, 'data-pack-access-action', 'refresh').disabled).toBe(true);
    const before = f.changes(); f.controller.dispose(); resolve(receipt()); await f.controller.whenSettled();
    expect(f.changes()).toBe(before);
  });
  it('drops a late loading response after closing its form', async () => {
    let resolve!: (value: PackAccessPlan) => void;
    const f = rig(() => new Promise(r => { resolve = r; }));
    one(f.root, 'data-pack-access-action', 'open').trigger('click');
    one(f.root, 'data-pack-access-action', 'close').trigger('click');
    resolve(plan()); await f.controller.whenSettled();
    expect(all(f.root).some(n => n.attrs.has('data-pack-access-input'))).toBe(false);
  });
});
