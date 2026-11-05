/** D-335 slice F — the passes for Browser Toolkit writes on the Contracts panel, beside
 *  D-329's write rules: a suggestion to always allow, with the elements its approvals were
 *  for, accepted or dismissed for good; a live pass ended. Each a deliberate second step. */

import { describe, expect, it, vi } from 'vitest';
import type { BrowserPassRow, BrowserPassSuggestionRow, WriteRuleRow } from '@recued/contracts';

import {
  BROWSER_PASS_ALWAYS_ATTR,
  BROWSER_PASS_ATTR,
  BROWSER_PASS_DISMISS_ATTR,
  BROWSER_PASS_END_ATTR,
  BROWSER_PASS_SUGGESTION_ATTR,
  mountWriteRulesPanel,
  WRITE_RULES_CANCEL_ATTR,
  WRITE_RULES_CONFIRM_ATTR,
  WRITE_RULES_ERROR_ATTR,
  WRITE_RULES_RULE_ATTR,
} from '../contracts/write-rules-panel.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

const element = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(), className: '', textContent: '', type: '', value: '', disabled: false,
    attrs: new Map(), children: [], parent: null, listeners: new Map(),
    get firstChild() { return el.children[0] ?? null; },
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); c.parent = null; return c; },
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    click() { if (!el.disabled) for (const fn of el.listeners.get('click') ?? []) fn(); },
  };
  return el;
};
const all = (root: FakeEl, attr: string): FakeEl[] => [
  ...(root.attrs.has(attr) ? [root] : []),
  ...root.children.flatMap((c) => all(c, attr)),
];
const text = (root: FakeEl): string => [root.textContent, ...root.children.map(text)].join(' ');
const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

const NOW = 1_760_000_000_000;
const suggestion: BrowserPassSuggestionRow = {
  key_hash: 'pk-1',
  key: { principal: { kind: 'owner_chat' }, recipe: 'click-web-element', site: 'https://github.com' },
  host: 'github.com', approvals: 4, occasions: 3,
  elements: ['button “Merge pull request”', 'link “Files changed”'],
  suggested_at: NOW,
};
const always: BrowserPassRow = {
  pass_id: 'pass-1', key_hash: 'pk-2',
  key: { principal: { kind: 'ai_app', contract_id: 'ct-claude' }, recipe: 'type-into-web-page', site: 'https://mail.google.com' },
  host: 'mail.google.com', kind: 'always', created_at: NOW, uses: 12,
};
const session: BrowserPassRow = {
  pass_id: 'pass-2', key_hash: 'pk-3',
  key: { principal: { kind: 'owner_chat' }, recipe: 'open-web-page', site: 'https://news.ycombinator.com' },
  host: 'news.ycombinator.com', kind: 'session', channel_session_id: 'chat:chat-1',
  created_at: NOW, expires_at: NOW + 8 * 3_600_000, uses: 1,
};

const mount = (lists: { suggestions?: BrowserPassSuggestionRow[]; passes?: BrowserPassRow[]; wired?: boolean } = {}) => {
  const host = element('div');
  const state = { suggestions: lists.suggestions ?? [suggestion], passes: lists.passes ?? [always, session] };
  const accept = vi.fn(async (args: { key_hash: string }) => {
    state.suggestions = [];
    return { pass: { ...always, pass_id: 'pass-new' }, suggestion: { ...suggestion, key_hash: args.key_hash } };
  });
  const dismiss = vi.fn(async (args: { key_hash: string }) => { state.suggestions = []; return args; });
  const revoke = vi.fn(async (args: { pass_id: string }) => {
    state.passes = state.passes.filter((pass) => pass.pass_id !== args.pass_id);
    return { pass: { ...always, revoked_at: NOW } };
  });
  const panel = mountWriteRulesPanel({
    host: host as never,
    document: { createElement: element } as never,
    listSuggestions: async () => ({ suggestions: [] }),
    listRules: async () => ({ rules: [] }),
    accept: vi.fn(), dismiss: vi.fn(), revoke: vi.fn(),
    listContracts: async () => ({ contracts: [{ contract_id: 'ct-claude', display_name: 'Claude Desktop' }] }),
    ...(lists.wired === false ? {} : {
      passes: {
        listSuggestions: async () => ({ suggestions: state.suggestions }),
        listPasses: async () => ({ passes: state.passes }),
        accept, dismiss, revoke,
      },
    }),
  });
  return { host, panel, accept, dismiss, revoke };
};

describe('D-335 slice F — the passes on the Contracts panel', () => {
  it('shows nothing of passes when there are none, or when the page is not given them', async () => {
    for (const h of [mount({ suggestions: [], passes: [] }), mount({ wired: false })]) {
      await h.panel.whenLoaded();
      expect(h.host.children[0]!.children).toHaveLength(0);
    }
  });

  it('says what a suggestion would let happen, who asks, what earned it and what it was for', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    expect(text(h.host)).toContain('Always allow in your browser?');
    const [card] = all(h.host, BROWSER_PASS_SUGGESTION_ATTR);
    expect(text(card!)).toContain('Click on github.com');
    expect(text(card!)).toContain('Asked by your chats');
    expect(text(card!)).toContain('You said yes 4 times, on 3 different occasions');
    expect(text(card!)).toContain('For: button “Merge pull request”, link “Files changed”');
  });

  it('lists each pass with who asks, how long it lasts and how often it was used', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    expect(text(h.host)).toContain('Happening without asking');
    const [first, second] = all(h.host, BROWSER_PASS_ATTR);
    expect(text(first!)).toContain('Type into pages on mail.google.com');
    expect(text(first!)).toContain('Asked by Claude Desktop');
    expect(text(first!)).toContain(`Always, since ${new Date(NOW).toLocaleDateString()}; used 12 times`);
    expect(text(second!)).toContain('Open pages on news.ycombinator.com');
    expect(text(second!)).toContain('In one conversation, until ');
    expect(text(second!)).toContain('used 1 time');
  });

  it('always allows only after saying it does not end by itself', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, BROWSER_PASS_ALWAYS_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('It happens without asking until you end it here.');
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.accept).toHaveBeenCalledWith({ key_hash: 'pk-1' });
    await h.panel.whenLoaded();
    expect(all(h.host, BROWSER_PASS_SUGGESTION_ATTR)).toHaveLength(0);
  });

  it('dismisses only after saying it is for good, and Cancel leaves it', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, BROWSER_PASS_DISMISS_ATTR)[0]!.click();
    expect(text(h.host)).toContain('Recued will not suggest this again.');
    all(h.host, WRITE_RULES_CANCEL_ATTR)[0]!.click();
    expect(h.dismiss).not.toHaveBeenCalled();
    all(h.host, BROWSER_PASS_DISMISS_ATTR)[0]!.click();
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.dismiss).toHaveBeenCalledWith({ key_hash: 'pk-1' });
  });

  it('ends a pass after one more step, saying an always pass is not suggested again', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, BROWSER_PASS_END_ATTR)[0]!.click();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('It asks again from now on, and Recued will not suggest it again.');
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.revoke).toHaveBeenCalledWith({ pass_id: 'pass-1' });
    await h.panel.whenLoaded();
    expect(all(h.host, BROWSER_PASS_ATTR).map((card) => card.getAttribute(BROWSER_PASS_ATTR))).toEqual(['pass-2']);
    // A session pass says only that it asks again.
    all(h.host, BROWSER_PASS_END_ATTR)[0]!.click();
    const [card] = all(h.host, BROWSER_PASS_ATTR);
    expect(text(card!)).toContain('It asks again from now on.');
    expect(text(card!)).not.toContain('will not suggest it again');
  });

  it('a server from before passes still lists its write rules, with no error; another failure still says so', async () => {
    const rule: WriteRuleRow = {
      rule_id: 'rule-1', key_hash: 'kh-2',
      key: { principal: { kind: 'ai_app', contract_id: 'ct-claude' }, tool: 'calendar.create', scope: 'local' },
      created_at: NOW, expires_at: NOW + 10 * 86_400_000, max_uses: 100, uses_remaining: 97,
    };
    const mountOn = (code: string) => {
      const host = element('div');
      const refuse = () => Promise.reject(Object.assign(new Error(`refused: ${code}`), { code }));
      const panel = mountWriteRulesPanel({
        host: host as never,
        document: { createElement: element } as never,
        listSuggestions: async () => ({ suggestions: [] }),
        listRules: async () => ({ rules: [rule] }),
        accept: vi.fn(), dismiss: vi.fn(), revoke: vi.fn(),
        listContracts: async () => ({ contracts: [] }),
        passes: { listSuggestions: refuse, listPasses: refuse, accept: vi.fn(), dismiss: vi.fn(), revoke: vi.fn() },
      });
      return { host, panel };
    };
    for (const code of ['unknown_method', 'not_configured']) {
      const older = mountOn(code);
      await older.panel.whenLoaded();
      expect(all(older.host, WRITE_RULES_RULE_ATTR).map((card) => card.getAttribute(WRITE_RULES_RULE_ATTR))).toEqual(['rule-1']);
      expect(all(older.host, WRITE_RULES_ERROR_ATTR)).toHaveLength(0);
      expect(all(older.host, BROWSER_PASS_ATTR)).toHaveLength(0);
    }
    const broken = mountOn('internal');
    await broken.panel.whenLoaded();
    expect(all(broken.host, WRITE_RULES_ERROR_ATTR)).toHaveLength(1);
  });

  it('a refused decision stays on its card, in words', async () => {
    const h = mount();
    h.revoke.mockRejectedValueOnce(Object.assign(new Error('no browser pass'), { code: 'not_found' }));
    await h.panel.whenLoaded();
    all(h.host, BROWSER_PASS_END_ATTR)[0]!.click();
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    await h.panel.whenLoaded();
    const [card] = all(h.host, BROWSER_PASS_ATTR);
    expect(all(card!, WRITE_RULES_ERROR_ATTR)).toHaveLength(1);
  });
});
