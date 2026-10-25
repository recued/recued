import { describe, expect, it, vi } from 'vitest';
import type { YoursCommand, YoursCommandResult, YoursSnapshot } from '@recued/contracts';
import {
  describeSourceSphere,
  mountSourceSpheresPanel,
  sourceSphereLane,
  type SourceSphereLane,
} from '../connections/source-spheres-panel.js';

/** Just enough DOM for the panel: production render + event code runs unchanged. */
class Node {
  children: Node[] = []; attrs = new Map<string, string>(); parent: Node | null = null;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  ownText = ''; className = ''; type = ''; name = ''; value = ''; checked = false; disabled = false; hidden = false;
  constructor(readonly tagName: string, readonly doc: { activeElement: Node | null }) {}
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  appendChild(child: Node): Node { child.parent = this; this.children.push(child); return child; }
  replaceChildren(): void { this.children = []; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector: string): Node | null {
    const attr = /^\[([^\]=]+)\]$/.exec(selector)?.[1];
    return attr && this.attrs.has(attr) ? this : this.parent?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): Node[] {
    const match = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
    return this.children.flatMap(child => [
      ...(match && child.attrs.has(match[1]!) && (match[2] === undefined || child.attrs.get(match[1]!) === match[2]) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  focus(): void { this.doc.activeElement = this; }
}

const dom = () => {
  const doc = { activeElement: null as Node | null, createElement: (tag: string) => new Node(tag.toUpperCase(), doc) };
  return doc;
};
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const snapshot = (rows: NonNullable<YoursSnapshot['sphere_sources']>): YoursSnapshot =>
  ({ sphere_sources: rows } as unknown as YoursSnapshot);

const SOURCES: NonNullable<YoursSnapshot['sphere_sources']> = [
  { source: 'mail:work', name: 'mail: work', sphere: 'professional' },
  { source: 'mail:home', name: 'mail: home' },
  { source: 'calendar:family', name: 'calendar: family', sphere: 'personal' },
  { source: 'work:recued.task', name: 'recued.task' },
  { source: 'work:hubspot.crm-main.deal', name: 'hubspot.crm-main.deal' },
  { source: 'work:google.drive-work.file', name: 'google.drive-work.file' },
];

const mount = (lane: SourceSphereLane, options: {
  read?: () => Promise<YoursSnapshot>;
  change?: (input: YoursCommand) => Promise<YoursCommandResult>;
  describe?: (source: string) => { title?: string; detail?: string } | undefined;
} = {}) => {
  const doc = dom();
  const read = vi.fn(options.read ?? (async () => snapshot(structuredClone(SOURCES))));
  const change = vi.fn(options.change ?? (async () => ({ message: 'Source placement updated. 2 items keep the placement you pinned.' }) as YoursCommandResult));
  const availability = vi.fn();
  const panel = mountSourceSpheresPanel({ lane, document: doc as unknown as Document, read, change, onAvailability: availability,
    ...(options.describe ? { describe: options.describe } : {}) });
  const root = panel.element as unknown as Node;
  const row = (source: string): Node => root.querySelectorAll(`[data-source-sphere-row="${source}"]`)[0]!;
  const choose = (source: string, value: 'unset' | 'personal' | 'professional'): void => {
    const input = root.querySelectorAll(`[data-source-sphere-focus="choice:${source}:${value}"]`)[0]!;
    input.checked = true; for (const fn of root.listeners.get('change') ?? []) fn({ target: input });
  };
  const act = (source: string, action: string): void => {
    const button = row(source).querySelectorAll(`[data-source-sphere-action="${action}"]`)[0]!;
    for (const fn of root.listeners.get('click') ?? []) fn({ target: button });
  };
  return { doc, panel, root, read, change, availability, row, choose, act };
};

describe('source sphere lanes and names', () => {
  it('files each source under the lane that holds it', () => {
    expect(SOURCES.map(row => sourceSphereLane(row.source))).toEqual(['mail', 'mail', 'calendar', 'others', 'others', 'file']);
  });
  it('names a source in the owner’s words instead of its key', () => {
    expect(SOURCES.map(describeSourceSphere)).toEqual([
      { title: 'work', detail: 'Mailbox' }, { title: 'home', detail: 'Mailbox' }, { title: 'family', detail: 'Calendar' },
      { title: 'Tasks', detail: 'Added in Recued' }, { title: 'crm-main', detail: 'Deals from HubSpot' },
      { title: 'drive-work', detail: 'Files from Google' },
    ]);
    expect(describeSourceSphere({ source: 'work:acme.crm.widget', name: 'acme.crm.widget' })).toEqual({ title: 'crm', detail: 'Widget records from Acme' });
  });
});

describe('Personal or work on a lane', () => {
  it('lists only this lane’s sources, with what the lane knows about each', async () => {
    const f = mount('mail', { describe: source => source === 'mail:work' ? { detail: 'me@example.test · Gmail' } : undefined });
    await f.panel.whenLoaded();
    expect(f.root.hidden).toBe(false); expect(f.availability).toHaveBeenLastCalledWith(true);
    expect(f.root.querySelectorAll('[data-source-sphere-row]').map(node => node.getAttribute('data-source-sphere-row'))).toEqual(['mail:work', 'mail:home']);
    expect(f.row('mail:work').textContent).toContain('me@example.test · Gmail');
    expect(f.row('mail:home').textContent).toContain('Mailbox');
    const checked = (source: string) => f.row(source).querySelectorAll('[data-source-sphere-choice]').find(input => input.checked)?.getAttribute('data-source-sphere-choice');
    expect(checked('mail:work')).toBe('professional'); expect(checked('mail:home')).toBe('unset');
    f.panel.dispose();
  });

  it('stays hidden when the lane has nothing to place, and leaves the page when the server has no sphere placement', async () => {
    const empty = mount('calendar', { read: async () => snapshot([{ source: 'mail:work', name: 'mail: work' }]) });
    const emptyHost = new Node('DIV', empty.doc); emptyHost.appendChild(empty.root);
    await empty.panel.whenLoaded(); expect(empty.root.hidden).toBe(true); expect(empty.availability).toHaveBeenLastCalledWith(false);
    // Nothing to place yet is still somewhere to place one later: it stays, hidden.
    expect(empty.panel.supported()).toBe(true); expect(emptyHost.children).toContain(empty.root);
    const old = mount('mail', { read: async () => { throw Object.assign(new Error('Unknown method yours.read'), { code: 'unknown_method' }); } });
    const oldHost = new Node('DIV', old.doc); oldHost.appendChild(old.root);
    await old.panel.whenLoaded(); expect(old.root.textContent).toBe('');
    // An older server never will: the panel leaves the page and says not to put it back.
    expect(old.panel.supported()).toBe(false); expect(oldHost.children).not.toContain(old.root);
    empty.panel.dispose(); old.panel.dispose();
  });

  it('holds a change as a draft that says what it widens, then saves exactly that source', async () => {
    const f = mount('mail'); await f.panel.whenLoaded();
    f.choose('mail:home', 'professional');
    expect(f.panel.hasDraft()).toBe(true); expect(f.change).not.toHaveBeenCalled();
    expect(f.row('mail:home').textContent).toContain('Items from home will count as Work');
    expect(f.row('mail:home').textContent).toContain('Anything you have shared for Work items will include them');
    f.act('mail:home', 'save'); expect(f.panel.busy()).toBe(true); await flush();
    expect(f.change).toHaveBeenCalledExactlyOnceWith({ action: 'sphere.source', source: 'mail:home', sphere: 'professional' });
    expect(f.panel.hasDraft()).toBe(false); expect(f.panel.busy()).toBe(false);
    expect(f.row('mail:home').textContent).toContain('Saved. 2 items you placed yourself keep their place.');
    expect(f.doc.activeElement?.getAttribute('data-source-sphere-focus')).toBe('choice:mail:home:professional');
    f.panel.dispose();
  });

  it('clears a placement with Not set, and Cancel puts the saved one back without a write', async () => {
    const f = mount('mail'); await f.panel.whenLoaded();
    f.choose('mail:work', 'personal'); f.act('mail:work', 'cancel');
    expect(f.panel.hasDraft()).toBe(false); expect(f.change).not.toHaveBeenCalled();
    f.choose('mail:work', 'unset');
    expect(f.row('mail:work').textContent).toContain('will no longer be sorted by where they came from');
    f.act('mail:work', 'save'); await flush();
    expect(f.change).toHaveBeenCalledExactlyOnceWith({ action: 'sphere.source', source: 'mail:work', sphere: null });
    f.panel.dispose();
  });

  it('keeps the draft and says so when the save fails', async () => {
    const f = mount('mail', { change: async () => { throw new Error('The server is updating.'); } }); await f.panel.whenLoaded();
    f.choose('mail:home', 'personal'); f.act('mail:home', 'save'); await flush();
    expect(f.panel.hasDraft()).toBe(true);
    const status = f.row('mail:home').querySelectorAll('[role]').find(node => node.getAttribute('role') === 'alert');
    expect(status?.textContent).toBe('Not saved. The server is updating.');
    f.panel.dispose();
  });

  it('offers to read again after a failed read', async () => {
    let fail = true;
    const f = mount('others', { read: async () => { if (fail) throw new Error('offline'); return snapshot(structuredClone(SOURCES)); } });
    await f.panel.whenLoaded(); expect(f.root.hidden).toBe(false); expect(f.root.textContent).toContain('could not be read');
    fail = false;
    const retry = f.root.querySelectorAll('[data-source-sphere-action="retry"]')[0]!;
    for (const fn of f.root.listeners.get('click') ?? []) fn({ target: retry });
    await f.panel.whenLoaded();
    expect(f.root.querySelectorAll('[data-source-sphere-row]').map(node => node.getAttribute('data-source-sphere-row'))).toEqual(['work:recued.task', 'work:hubspot.crm-main.deal']);
    f.panel.dispose();
  });
});
