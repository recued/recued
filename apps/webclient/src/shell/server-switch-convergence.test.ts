import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountServerSwitchConvergence,
  SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR,
  SERVER_SWITCH_CONVERGENCE_COPY_ATTR,
  SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR,
  SERVER_SWITCH_CONVERGENCE_STATUS_ATTR,
  type MountServerSwitchConvergenceOptions,
  type ServerSwitchConvergenceMount,
  type ServerSwitchConvergenceState,
} from './server-switch-convergence.js';

type Listener = (event: { preventDefault(): void }) => void;
class ElementFixture {
  readonly attrs = new Map<string, string>();
  readonly children: ElementFixture[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  parent: ElementFixture | null = null;
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: 'forward' | 'backward' | 'none' = 'none';
  private text = '';
  constructor(readonly ownerDocument: DocumentFixture) {}
  get firstChild(): ElementFixture | null { return this.children[0] ?? null; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value: string) { this.text = value; this.children.length = 0; }
  appendChild(child: ElementFixture): ElementFixture {
    child.remove(); child.parent = this; this.children.push(child); return child;
  }
  removeChild(child: ElementFixture): ElementFixture {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('Not a child');
    this.children.splice(index, 1); child.parent = null; return child;
  }
  remove(): void { this.parent?.removeChild(this); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  click(): void { for (const listener of this.listeners.get('click') ?? []) listener({ preventDefault() {} }); }
  focus(): void { this.ownerDocument.activeElement = this; }
  readonly setSelectionRange = vi.fn((start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none'): void => {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
  });
  find(attr: string): ElementFixture | undefined {
    if (this.hasAttribute(attr)) return this;
    for (const child of this.children) { const found = child.find(attr); if (found) return found; }
    return undefined;
  }
}
class DocumentFixture {
  activeElement: ElementFixture | null = null;
  readonly write = vi.fn(async (_text: string): Promise<void> => undefined);
  readonly defaultView = { navigator: { clipboard: { writeText: this.write } } };
  createElement(): ElementFixture { return new ElementFixture(this); }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const DRAFT = 'Private source-server thought\nKeep this 😀 and the line breaks.';
const STATE: ServerSwitchConvergenceState = {
  source: { id: 'home', label: 'Home', serverUrl: 'wss://home.example/ws' },
  target: { id: 'office', label: 'Office', serverUrl: 'wss://office.example/ws' },
  workState: 'chat_draft', chatDraft: DRAFT,
};
const mounts: ServerSwitchConvergenceMount[] = [];
afterEach(() => { for (const mount of mounts.splice(0)) mount.dispose(); vi.useRealTimers(); });
const fixture = (options: Partial<Pick<MountServerSwitchConvergenceOptions,
  'state' | 'writeClipboard' | 'onContinue' | 'onCheck'>> = {}) => {
  const doc = new DocumentFixture();
  const root = doc.createElement(); const background = doc.createElement();
  root.appendChild(background); background.focus();
  const onContinue = vi.fn<MountServerSwitchConvergenceOptions['onContinue']>(options.onContinue ?? (() => undefined));
  const mount = mountServerSwitchConvergence({
    ...options, state: options.state ?? STATE, onContinue,
    document: doc as unknown as Document,
    portal: root as unknown as HTMLElement, background: background as unknown as HTMLElement,
  });
  mounts.push(mount);
  const node = (attr: string): ElementFixture => {
    const found = root.find(attr); if (!found) throw new Error(`Missing ${attr}`); return found;
  };
  return { doc, root, background, mount, onContinue, write: doc.write,
    copy: () => node(SERVER_SWITCH_CONVERGENCE_COPY_ATTR),
    draft: () => node(SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR),
    status: () => node(SERVER_SWITCH_CONVERGENCE_STATUS_ATTR),
    commit: () => node(SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR) };
};
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('server-switch draft copying', () => {
  it.each(['missing', 'navigator getter', 'clipboard getter', 'writeText getter', 'synchronous throw', 'rejection'])(
    'offers a selected draft when clipboard access fails with %s', async mode => {
      const f = fixture();
      const denied = (): never => { throw new Error('private clipboard policy detail'); };
      const navigator = f.doc.defaultView.navigator;
      if (mode === 'missing') Object.defineProperty(navigator, 'clipboard', { value: undefined });
      else if (mode === 'navigator getter') Object.defineProperty(f.doc.defaultView, 'navigator', { get: denied });
      else if (mode === 'clipboard getter') Object.defineProperty(navigator, 'clipboard', { get: denied });
      else Object.defineProperty(navigator.clipboard, 'writeText', mode === 'writeText getter'
        ? { get: denied } : { value: mode === 'synchronous throw' ? denied : () => Promise.reject(new Error('private clipboard policy detail')) });
      f.copy().focus();
      expect(() => f.copy().click()).not.toThrow();
      await flush();
      expect(f.draft().value).toBe(DRAFT);
      expect(f.draft().hasAttribute('readonly')).toBe(true);
      expect(f.doc.activeElement).toBe(f.draft());
      expect([f.draft().selectionStart, f.draft().selectionEnd]).toEqual([0, DRAFT.length]);
      expect(f.status().textContent).toContain('message is selected');
      expect(f.root.textContent).not.toContain('private clipboard policy detail');
      expect(f.background.hasAttribute('inert')).toBe(true);
      expect(f.onContinue).not.toHaveBeenCalled();
    },
  );

  it('keeps the native receiver and exact source draft, without switching servers', async () => {
    const f = fixture(); const clipboard = f.doc.defaultView.navigator.clipboard;
    const write = vi.fn(function(this: unknown, text: string): Promise<void> {
      expect(this).toBe(clipboard); expect(text).toBe(DRAFT); return Promise.resolve();
    });
    clipboard.writeText = write;
    f.copy().focus(); f.copy().click(); await flush();
    expect(write).toHaveBeenCalledOnce();
    expect(f.status().textContent).toContain('still not saved on the new server');
    expect(f.doc.activeElement).toBe(f.copy());
    expect(f.onContinue).not.toHaveBeenCalled();
  });

  it('recovers a synchronously throwing injected writer', () => {
    const f = fixture({ writeClipboard: () => { throw new Error('private clipboard policy detail'); } });
    f.copy().focus(); expect(() => f.copy().click()).not.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    expect([f.draft().selectionStart, f.draft().selectionEnd]).toEqual([0, DRAFT.length]);
  });

  it('keeps copy single-flight and leaves a later focused control in place on rejection', async () => {
    const pending = deferred(); const write = vi.fn(() => pending.promise);
    const f = fixture({ writeClipboard: write });
    f.copy().focus(); f.copy().click(); f.copy().click();
    expect(write).toHaveBeenCalledOnce();
    expect(f.copy().getAttribute('aria-busy')).toBe('true');
    expect(f.copy().getAttribute('aria-disabled')).toBe('true');
    expect(f.copy().hasAttribute('disabled')).toBe(false);
    f.commit().focus(); pending.reject(new Error('private clipboard policy detail')); await flush();
    expect(f.doc.activeElement).toBe(f.commit());
    expect([f.draft().selectionStart, f.draft().selectionEnd]).toEqual([0, DRAFT.length]);
    expect(f.copy().hasAttribute('aria-busy')).toBe(false);
    expect(f.copy().hasAttribute('aria-disabled')).toBe(false);
    expect(f.onContinue).not.toHaveBeenCalled();
  });

  it('offers manual copy after a stalled write and ignores its late success', async () => {
    vi.useFakeTimers(); const pending = deferred();
    const f = fixture({ writeClipboard: () => pending.promise });
    f.copy().focus(); f.copy().click(); await vi.advanceTimersByTimeAsync(5_001);
    expect(f.doc.activeElement).toBe(f.draft());
    expect([f.draft().selectionStart, f.draft().selectionEnd]).toEqual([0, DRAFT.length]);
    expect(f.status().textContent).toContain('message is selected');
    expect(f.copy().hasAttribute('aria-busy')).toBe(false);
    f.commit().focus(); pending.resolve(); await flush();
    expect(f.status().textContent).toContain('message is selected');
    expect(f.doc.activeElement).toBe(f.commit());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { outcome: 'rejection', start: 2, end: 14, direction: 'backward' },
    { outcome: 'timeout', start: 2, end: 14, direction: 'backward' },
    { outcome: 'rejection', start: 9, end: 9, direction: 'none' },
    { outcome: 'timeout', start: 0, end: DRAFT.length, direction: 'backward' },
  ] as const)('preserves a later selection ($start, $end, $direction) after $outcome', async ({ outcome, start, end, direction }) => {
    vi.useFakeTimers(); const pending = deferred();
    const f = fixture({ writeClipboard: () => pending.promise });
    f.draft().setSelectionRange(0, DRAFT.length, 'forward');
    f.copy().focus(); f.copy().click();
    f.draft().focus(); f.draft().setSelectionRange(start, end, direction);
    if (start === end) f.commit().focus();
    const active = f.doc.activeElement;
    f.draft().setSelectionRange.mockClear();
    if (outcome === 'rejection') { pending.reject(new Error('private clipboard policy detail')); await flush(); }
    else await vi.advanceTimersByTimeAsync(5_001);
    expect([f.draft().selectionStart, f.draft().selectionEnd, f.draft().selectionDirection])
      .toEqual([start, end, direction]);
    expect(f.draft().setSelectionRange).not.toHaveBeenCalled();
    expect(f.doc.activeElement).toBe(active);
    expect(f.copy().hasAttribute('aria-busy')).toBe(false);
    expect(f.root.textContent).not.toContain('private clipboard policy detail');
    expect(f.onContinue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['update', 'dispose', 'switch', 'check'] as const)(
    'ignores a late copy failure after %s and cancels its deadline', async change => {
      vi.useFakeTimers(); const pending = deferred();
      const next: ServerSwitchConvergenceState = { ...STATE,
        target: { id: 'studio', label: 'Studio', serverUrl: 'wss://studio.example/ws' },
        chatDraft: 'A new review', status: 'Review the updated destination.' };
      const f = fixture({ writeClipboard: () => pending.promise,
        state: { ...STATE, workState: 'in_flight_with_chat_draft' }, onCheck: async () => next });
      const previousDraft = f.draft();
      f.copy().focus(); f.copy().click();
      if (change === 'update') f.mount.update(next);
      else if (change === 'dispose') f.mount.dispose();
      else if (change === 'switch') f.commit().click();
      else f.root.find('data-recued-server-switch-convergence-check')!.click();
      await flush();
      if (change === 'check') await vi.waitFor(() => expect(f.status().textContent).toBe(next.status));
      const active = f.doc.activeElement; const text = f.root.textContent;
      pending.reject(new Error('private clipboard policy detail')); await flush();
      expect(f.doc.activeElement).toBe(active);
      expect(f.root.textContent).toBe(text);
      expect(previousDraft.setSelectionRange).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if (change === 'switch') expect(f.onContinue).toHaveBeenCalledOnce();
      else expect(f.onContinue).not.toHaveBeenCalled();
    },
  );
});
