/** D-322 §24 — resource checks on the exact account a pack signs in with. */
import {
  isPackAccessResponse, packAccessInput, type PackAccessPlan, type PackAccessRequest,
  type PackAccessResponse, type PackAccessResult, type PackConnectionChange,
} from '@recued/contracts';
import { connectionsReviewAccessAddress } from '../connections/connections-navigation.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export type PackResourceAccessCaller = (request: PackAccessRequest) => Promise<PackAccessResponse>;
export interface PackResourceAccessFocus {
  target: PackConnectionChange;
  attr: string;
  value: string;
  selection?: { start: number; end: number };
}
const markControl = (node: HTMLElement, target: PackConnectionChange): void => {
  node.setAttribute('data-pack-access-for-pack', target.pack_slug);
  node.setAttribute('data-pack-access-for-slot', target.slot);
  node.setAttribute('data-pack-access-for-connection', target.connection_name);
};
/** The host replaces this form during each asynchronous state change. */
export const packResourceAccessFocusOf = (node: HTMLElement | null): PackResourceAccessFocus | null => {
  if (!node || typeof node.getAttribute !== 'function') return null;
  const pack_slug = node.getAttribute('data-pack-access-for-pack');
  const slot = node.getAttribute('data-pack-access-for-slot');
  const connection_name = node.getAttribute('data-pack-access-for-connection');
  if (!pack_slug || !slot || !connection_name) return null;
  for (const attr of ['data-pack-access-action', 'data-pack-access-input', 'data-pack-access-review']) {
    const value = node.getAttribute(attr);
    if (value === null) continue;
    const input = node as HTMLInputElement;
    const selection = attr === 'data-pack-access-input' && typeof input.selectionStart === 'number' && typeof input.selectionEnd === 'number'
      ? { start: input.selectionStart, end: input.selectionEnd } : undefined;
    return { target: { pack_slug, slot, connection_name }, attr, value, ...(selection ? { selection } : {}) };
  }
  return null;
};
export const packResourceAccessFocusTargets = (focus: PackResourceAccessFocus): Array<(node: HTMLElement) => boolean> => {
  const same = (node: HTMLElement): boolean => node.getAttribute?.('data-pack-access-for-pack') === focus.target.pack_slug
    && node.getAttribute('data-pack-access-for-slot') === focus.target.slot
    && node.getAttribute('data-pack-access-for-connection') === focus.target.connection_name;
  return [
    node => same(node) && node.getAttribute(focus.attr) === focus.value,
    node => same(node) && ['open', 'refresh'].includes(focus.value) && node.hasAttribute('data-pack-access-input'),
    node => same(node) && ['open', 'refresh'].includes(focus.value) && node.hasAttribute('data-pack-access-action')
      && !['open', 'refresh', 'close'].includes(node.getAttribute('data-pack-access-action')!),
    node => same(node) && node.getAttribute('data-pack-access-action') === 'refresh',
    node => same(node) && node.getAttribute('data-pack-access-action') === 'open',
  ];
};
interface CheckState {
  target: PackConnectionChange;
  loading: boolean;
  plan?: PackAccessPlan;
  running?: string;
  inputs: Map<string, string>;
  results: Map<string, PackAccessResult>;
  error?: string;
}
const keyOf = (target: PackConnectionChange): string => JSON.stringify([target.pack_slug, target.slot, target.connection_name]);
const resultCopy = (result: PackAccessResult): string => {
  switch (result.reason) {
    case 'protected_read_passed': return 'Passed: this account could read the selected resource.';
    case 'access_denied': return 'Access denied. Review sign-in, permissions and resource sharing, or choose another account.';
    case 'resource_not_found': return 'Unverified: the resource was not found or is not visible to this account. Check its ID and sharing.';
    case 'public_resource': return 'Unverified: a sign-in requirement could not be established for this resource.';
    case 'provider_error': return 'Unverified: the vendor refused the check. Try again later.';
    case 'unreachable': return 'Unverified: the API or broker could not be reached. Try again.';
    case 'auth_unavailable': return 'Unverified: saved authentication is unavailable. Open the connection to review it.';
    case 'unsupported_auth': return 'Unverified: this authentication method cannot be checked with a read-only request.';
    case 'check_in_progress': return 'Unverified: another check is using this account. Wait for it to finish, then try again.';
  }
};
const unavailableCopy = (reason: PackAccessPlan['unavailable_reason']): string => {
  if (reason === 'pack_update_required') return 'Unverified: update this installed pack to use its current access checks.';
  if (reason === 'unsupported_connection') return 'Unverified: this connection does not match the pack’s declared checks.';
  return 'Unverified: this pack has no declared read-only access checks yet.';
};

export const createPackResourceAccessController = (opts: {
  document: Document; call?: PackResourceAccessCaller; onChange(): void;
}) => {
  const doc = opts.document;
  let state: CheckState | undefined;
  let generation = 0;
  let disposed = false;
  const pending = new Set<Promise<void>>();
  const changed = (): void => { if (!disposed) opts.onChange(); };
  const track = (work: Promise<void>): void => { pending.add(work); void work.finally(() => pending.delete(work)); };
  const current = (expected: CheckState, version: number): boolean => !disposed && state === expected && generation === version;
  const responseFor = (response: unknown, target: PackConnectionChange): response is PackAccessResponse =>
    isPackAccessResponse(response) && keyOf(response) === keyOf(target);
  const errorCopy = (error: unknown): string => {
    if (classifyRpcError(error).code === 'conflict') return 'The pack or connection changed. Refresh the checks before trying again.';
    return 'Access checks could not be loaded or completed. Refresh and try again.';
  };
  const load = (target: PackConnectionChange): void => {
    if (!opts.call || disposed || state?.running) return;
    const version = ++generation;
    const next: CheckState = { target, loading: true, inputs: new Map(), results: new Map() };
    state = next;
    track((async () => {
      try {
        const plan = await opts.call!({ ...target, action: 'plan' });
        if (!current(next, version)) return;
        if (!responseFor(plan, target) || plan.action !== 'plan') throw new Error('Invalid access plan');
        next.plan = plan;
        for (const check of plan.checks) next.inputs.set(check.id, check.input?.default_value ?? '');
      } catch (error) { if (current(next, version)) next.error = errorCopy(error); }
      if (current(next, version)) { next.loading = false; changed(); }
    })());
    changed();
  };
  const check = (next: CheckState, id: string): void => {
    const plan = next.plan;
    const declaration = plan?.checks.find(c => c.id === id);
    if (!opts.call || !plan || !declaration || state !== next || next.running || disposed) return;
    const input = next.inputs.get(id) ?? '';
    try { packAccessInput(declaration.input, declaration.input ? input : undefined); }
    catch { next.error = 'Enter a valid resource ID or supported resource URL.'; changed(); return; }
    const version = generation;
    next.running = id; next.error = undefined; next.results.delete(id);
    track((async () => {
      try {
        const response = await opts.call!({ ...next.target, action: 'check', fingerprint: plan.fingerprint,
          check_id: id, ...(declaration.input ? { input } : {}) });
        if (!current(next, version)) return;
        if (!responseFor(response, next.target) || response.action !== 'check' || response.check_id !== id
          || response.fingerprint !== plan.fingerprint || response.connection_updated_at < plan.connection_updated_at) throw new Error('Invalid access result');
        next.results.set(id, response);
        next.plan = { ...plan, fingerprint: response.next_fingerprint ?? plan.fingerprint,
          connection_updated_at: response.connection_updated_at };
      } catch (error) {
        if (current(next, version)) {
          next.error = errorCopy(error);
          if (classifyRpcError(error).code === 'conflict') { next.results.clear(); next.plan = undefined; }
        }
      }
      if (current(next, version)) { next.running = undefined; changed(); }
    })());
    changed();
  };
  const el = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, copy?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (copy !== undefined) node.textContent = copy;
    parent.appendChild(node);
    return node;
  };
  const button = (parent: HTMLElement, target: PackConnectionChange, copy: string, action: string, disabled: boolean, run: () => void): void => {
    const node = el(parent, 'button', copy); node.type = 'button';
    markControl(node, target);
    node.className = 'rx-btn rx-btn-secondary'; node.setAttribute('data-pack-access-action', action);
    node.disabled = disabled;
    node.addEventListener('click', () => { if (!node.disabled && !disposed) run(); });
  };
  const render = (parent: HTMLElement, target: PackConnectionChange, disabled: boolean): void => {
    if (!opts.call || disposed) return;
    const section = el(parent, 'div');
    section.className = 'pc-resource-access'; section.setAttribute('data-pack-resource-access', target.connection_name);
    const next = state && keyOf(state.target) === keyOf(target) ? state : undefined;
    if (!next) { button(section, target, 'Check access for this pack', 'open', disabled || state?.running !== undefined, () => load(target)); return; }
    section.setAttribute('aria-busy', String(next.loading || next.running !== undefined));
    const busy = disabled || next.loading || next.running !== undefined;
    el(section, 'h5', 'Check access for this pack');
    el(section, 'p', 'These read-only checks use this saved account. Response bodies are discarded. Other operations and write permissions remain unverified.');
    if (next.loading) el(section, 'p', 'Loading declared checks…').setAttribute('role', 'status');
    if (next.error) el(section, 'p', next.error).setAttribute('role', 'alert');
    if (next.plan?.unavailable_reason) el(section, 'p', unavailableCopy(next.plan.unavailable_reason)).setAttribute('data-pack-access-unverified', '');
    for (const declaration of next.plan?.checks ?? []) renderCheck(section, next, declaration, busy);
    const link = el(section, 'a', 'Review permissions in Connections');
    link.href = connectionsReviewAccessAddress(target.connection_name).hash;
    link.className = 'rx-link'; link.setAttribute('data-pack-access-review', target.connection_name);
    markControl(link, target);
    button(section, target, 'Refresh checks', 'refresh', busy, () => load(target));
    button(section, target, 'Close checks', 'close', next.running !== undefined, () => { if (state === next) { generation++; state = undefined; changed(); } });
  };
  const renderCheck = (section: HTMLElement, next: CheckState, declaration: PackAccessPlan['checks'][number], busy: boolean): void => {
    const block = el(section, 'div'); block.setAttribute('data-pack-access-check', declaration.id);
    el(block, 'h6', declaration.label);
    if (declaration.input) {
      const label = el(block, 'label', declaration.input.label);
      const input = el(label, 'input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      markControl(input, next.target);
      input.value = next.inputs.get(declaration.id) ?? ''; input.disabled = busy;
      input.maxLength = 2048; input.setAttribute('data-pack-access-input', declaration.id);
      input.addEventListener('input', () => {
        if (disposed || state !== next || next.running) return;
        next.inputs.set(declaration.id, input.value); next.results.delete(declaration.id);
        block.querySelector('[data-pack-access-result]')?.remove();
      });
    }
    button(block, next.target, next.running === declaration.id ? 'Checking…' : 'Check read access', declaration.id, busy, () => check(next, declaration.id));
    const result = next.results.get(declaration.id);
    if (result) {
      const receipt = el(block, 'div');
      receipt.setAttribute('data-pack-access-result', result.status); receipt.setAttribute('role', 'status');
      el(receipt, 'p', resultCopy(result) + ' Checked ' + new Date(result.checked_at).toLocaleString() + '.');
      if (result.http_status) el(receipt, 'small', 'HTTP ' + result.http_status);
    }
  };
  return {
    busy: () => state?.running !== undefined,
    render, refresh: () => { generation++; state = undefined; },
    whenSettled: async () => { while (pending.size) await Promise.allSettled([...pending]); },
    dispose: () => { disposed = true; generation++; state = undefined; },
  };
};
