/** D-192 M4c-UI — the messenger "Message triggers" editor (webclient host half).
 *
 *  Exercises the host wiring the ui-shared render test can't: the add/remove
 *  trigger-row actions mutate `dialog.values`, editing a slack connection
 *  pre-populates the editor from `getMatchPatterns`, and a submit persists the
 *  compiled triggers via `setMatchPatterns` alongside the connection update.
 *
 *  Fake host = string-innerHTML + synthetic delegated events (the panel's
 *  documented test seam). */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionHealth,
  ConnectionView,
  MessageMatchPattern,
} from '@recued/contracts';

import {
  mountConnectionsEnrollPanel,
  type ConnectionsEnrollListCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsUpdateCaller,
  type ConnectionsDeleteCaller,
  type ConnectionsProbeCaller,
  type ConnectionsGetMatchPatternsCaller,
  type ConnectionsSetMatchPatternsCaller,
} from '../settings/connections-enroll-panel.js';

const SUBMIT_SELECTOR = '[data-action="connections-submit-form"]';
const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const slackView: ConnectionView = {
  kind: 'notification',
  name: 'slack',
  subtype: 'slack',
  display_name: 'Slack',
  channel_id: 'C1',
} as ConnectionView;

// D-192 — WhatsApp is a chat transport with a match-pattern-list trigger field,
// exactly like slack/telegram. Its edit must hydrate + guard the same way.
const whatsappView: ConnectionView = {
  kind: 'notification',
  name: 'whatsapp',
  subtype: 'whatsapp',
  display_name: 'WhatsApp',
} as ConnectionView;

const makeHost = () => {
  let html = '';
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const submitBtn = {
    attrs: new Set<string>(),
    setAttribute(k: string) {
      this.attrs.add(k);
    },
    removeAttribute(k: string) {
      this.attrs.delete(k);
    },
    hasAttribute(k: string) {
      return this.attrs.has(k);
    },
  };
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const l = listeners.get(type) ?? [];
      l.push(fn);
      listeners.set(type, l);
    },
    removeEventListener() {},
    contains() {
      return true;
    },
    querySelector(sel: string) {
      return sel === SUBMIT_SELECTOR ? submitBtn : null;
    },
  };
  const fire = (type: string, ev: unknown): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  const click = (data: Record<string, string>): void => {
    const el = { dataset: data, closest: () => el };
    fire('click', { target: el, preventDefault() {} });
  };
  const field = (key: string, value: string, tagName = 'INPUT'): void => {
    const el = { dataset: { connField: key }, value, tagName, closest: () => el };
    const type = tagName === 'SELECT' ? 'change' : 'input';
    // The listener gates on `event.type` (a select fires both input+change), so
    // the synthetic event MUST carry `type`.
    fire(type, { target: el, type });
  };
  return { host: host as unknown as HTMLElement, click, field };
};

const NEVER = new Promise<never>(() => {}); // a getMatchPatterns that never resolves

const mountPanel = (opts: {
  patterns?: MessageMatchPattern[];
  getRejects?: boolean;
  getPending?: boolean;
  enrollName?: string; // the CANONICAL name the enroll "server" returns
  view?: ConnectionView; // the enrolled row under edit (defaults to slack)
} = {}) => {
  const view = opts.view ?? slackView;
  const fake = makeHost();
  const runList = vi.fn<ConnectionsEnrollListCaller>(async () => ({ connections: [view] }));
  const runEnroll = vi.fn<ConnectionsEnrollCaller>(async (args) => ({
    connection: { ...view, name: opts.enrollName ?? args.name },
  }));
  const runUpdate = vi.fn<ConnectionsUpdateCaller>(async () => ({ connection: view }));
  const runDelete = vi.fn<ConnectionsDeleteCaller>(async () => ({ deleted: true }));
  const runProbe = vi.fn<ConnectionsProbeCaller>(async () => ({
    health: { status: 'ok' } as ConnectionHealth,
  }));
  const runGetMatchPatterns = vi.fn<ConnectionsGetMatchPatternsCaller>(async () => {
    if (opts.getPending) return NEVER;
    if (opts.getRejects) throw new Error('read failed');
    return { match_patterns: opts.patterns ?? [] };
  });
  const runSetMatchPatterns = vi.fn<ConnectionsSetMatchPatternsCaller>(
    async ({ match_patterns }) => ({ match_patterns }),
  );
  const mount = mountConnectionsEnrollPanel({
    host: fake.host,
    document: {} as unknown as Document,
    runList,
    runEnroll,
    runUpdate,
    runDelete,
    runProbe,
    runGetMatchPatterns,
    runSetMatchPatterns,
  });
  return { ...fake, mount, calls: { runEnroll, runUpdate, runGetMatchPatterns, runSetMatchPatterns } };
};

let active: { mount: { dispose: () => void } } | null = null;
afterEach(() => {
  active?.mount.dispose();
  active = null;
});

const openSlackEdit = async (h: ReturnType<typeof mountPanel>): Promise<void> => {
  await tick(); // let the initial runList settle so the row is listable
  h.click({ action: 'connections-edit', kind: 'notification', name: 'slack' });
  await tick(); // let the getMatchPatterns pre-populate settle
};

describe('D-192 M4c-UI — trigger editor host wiring', () => {
  it('pre-populates the editor from getMatchPatterns on edit', async () => {
    const h = mountPanel({ patterns: [{ kind: 'tag', value: 'commit' }, { kind: 'content', value: 'send', mode: 'word' }] });
    active = h;
    await openSlackEdit(h);
    expect(h.calls.runGetMatchPatterns).toHaveBeenCalledWith({ kind: 'notification', name: 'slack' });
    const { values } = h.mount.getState().dialog;
    expect(values['config.match_patterns.0.kind']).toBe('tag');
    expect(values['config.match_patterns.0.value']).toBe('commit');
    expect(values['config.match_patterns.1.kind']).toBe('content');
    expect(values['config.match_patterns.1.mode']).toBe('word');
  });

  it('add-pattern appends a blank row; remove-pattern drops it', async () => {
    const h = mountPanel();
    active = h;
    await openSlackEdit(h);
    h.click({ action: 'connections-add-pattern', baseKey: 'config.match_patterns' });
    let values = h.mount.getState().dialog.values;
    // Row 0 (the synthetic default) is materialized + row 1 appended.
    expect(values['config.match_patterns.1.kind']).toBe('');
    expect('config.match_patterns.1.value' in values).toBe(true);

    h.click({ action: 'connections-remove-pattern', baseKey: 'config.match_patterns', patternIndex: '1' });
    values = h.mount.getState().dialog.values;
    expect('config.match_patterns.1.kind' in values).toBe(false);
    expect('config.match_patterns.1.value' in values).toBe(false);
  });

  it('submit saves the compiled triggers via setMatchPatterns alongside the update', async () => {
    const h = mountPanel();
    active = h;
    await openSlackEdit(h);
    // Author one trigger: a kind select (change) + a value input (silent).
    h.field('config.match_patterns.0.kind', 'tag', 'SELECT');
    h.field('config.match_patterns.0.value', 'commit', 'INPUT');
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runUpdate).toHaveBeenCalledTimes(1);
    expect(h.calls.runSetMatchPatterns).toHaveBeenCalledWith({
      kind: 'notification',
      name: 'slack',
      match_patterns: [{ kind: 'tag', value: 'commit' }],
    });
  });

  it('submit sends an empty list when the triggers were cleared', async () => {
    const h = mountPanel({ patterns: [{ kind: 'tag', value: 'commit' }] });
    active = h;
    await openSlackEdit(h);
    // Clear the single pre-populated row's value (a blank row compiles to none).
    h.field('config.match_patterns.0.value', '', 'INPUT');
    h.field('config.match_patterns.0.kind', '', 'SELECT');
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runSetMatchPatterns).toHaveBeenCalledWith({
      kind: 'notification',
      name: 'slack',
      match_patterns: [],
    });
  });

  it('does NOT write triggers when the edit read FAILED (never silently wipes stored triggers)', async () => {
    const h = mountPanel({ getRejects: true });
    active = h;
    await openSlackEdit(h); // hydrate rejects → editor stays un-hydrated
    // Edit only the connection (not the triggers) and save.
    h.field('config.channel_id', 'C2', 'INPUT');
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runUpdate).toHaveBeenCalledTimes(1); // the connection still saves
    expect(h.calls.runSetMatchPatterns).not.toHaveBeenCalled(); // but the triggers are LEFT ALONE
  });

  it('does NOT write triggers when Save races an unresolved read', async () => {
    const h = mountPanel({ getPending: true });
    active = h;
    await tick(); // let runList settle
    h.click({ action: 'connections-edit', kind: 'notification', name: 'slack' });
    // Save immediately — the getMatchPatterns read is still pending.
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runUpdate).toHaveBeenCalledTimes(1);
    expect(h.calls.runSetMatchPatterns).not.toHaveBeenCalled();
  });

  // D-192 H3 — WhatsApp carries a match-pattern-list field just like slack/
  // telegram, so its EDIT must hydrate + guard identically. The hydrate gate was
  // a hand-spelled `slack || telegram`, so a WhatsApp edit started the editor
  // empty, never marked it un-hydrated, and Save wrote `[]` — silently wiping
  // every stored WhatsApp trigger. It is now driven by the schema field.
  it('hydrates a WhatsApp edit (the gate is schema-driven, not slack/telegram-only)', async () => {
    const h = mountPanel({ view: whatsappView, patterns: [{ kind: 'tag', value: 'urgent' }] });
    active = h;
    await tick();
    h.click({ action: 'connections-edit', kind: 'notification', name: 'whatsapp' });
    await tick();
    expect(h.calls.runGetMatchPatterns).toHaveBeenCalledWith({
      kind: 'notification',
      name: 'whatsapp',
    });
    const { values } = h.mount.getState().dialog;
    expect(values['config.match_patterns.0.value']).toBe('urgent');
  });

  it('does NOT wipe WhatsApp triggers when Save races an unresolved read', async () => {
    const h = mountPanel({ view: whatsappView, getPending: true });
    active = h;
    await tick();
    h.click({ action: 'connections-edit', kind: 'notification', name: 'whatsapp' });
    // Fill WhatsApp's required fields so the submit is VALID — this must prove the
    // un-hydrated GUARD (not a validation bail) is what leaves the triggers alone.
    h.field('config.phone_number_id', '123456789012345', 'INPUT');
    h.field('config.wa_id', '+16505551234', 'INPUT');
    h.field('auth.type', 'bearer', 'SELECT');
    h.field('auth.token', 'EAAG-tok', 'INPUT');
    h.field('config.app_secret', 'a'.repeat(32), 'INPUT');
    h.field('config.verify_token', 'my-verify-token', 'INPUT');
    // Save while the getMatchPatterns read is still pending — pre-fix this wrote
    // `[]` because the WhatsApp edit never set `matchPatternsHydrated = false`.
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runUpdate).toHaveBeenCalledTimes(1); // the connection still saves
    expect(h.calls.runSetMatchPatterns).not.toHaveBeenCalled(); // triggers LEFT ALONE
  });

  it('on CREATE, enrolls then writes the triggers under the enroll-canonical name', async () => {
    // The enroll "server" trims the padded name — setMatchPatterns must use THAT.
    const h = mountPanel({ enrollName: 'new-slack' });
    active = h;
    await tick();
    h.click({ action: 'connections-open-add' });
    h.click({ action: 'connections-pick-kind', kind: 'notification' });
    h.click({ action: 'connections-pick-subtype', subtype: 'slack' });
    // Required fields + one trigger.
    h.field('name', 'new-slack ', 'INPUT'); // trailing space — server canonicalizes
    h.field('display_name', 'New Slack', 'INPUT');
    h.field('config.channel_id', 'C9', 'INPUT');
    h.field('auth.token', 'xoxb-new', 'INPUT');
    h.field('config.match_patterns.0.kind', 'tag', 'SELECT');
    h.field('config.match_patterns.0.value', 'commit', 'INPUT');
    h.click({ action: 'connections-submit-form' });
    await tick();
    expect(h.calls.runEnroll).toHaveBeenCalledTimes(1);
    expect(h.calls.runSetMatchPatterns).toHaveBeenCalledWith({
      kind: 'notification',
      name: 'new-slack', // the enroll-returned canonical name, NOT 'new-slack '
      match_patterns: [{ kind: 'tag', value: 'commit' }],
    });
  });
});
