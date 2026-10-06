/** Entry orchestration with real encrypted work/Chat storage. No browser rendering claim. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import { createMailWorkFixture } from '../../e2e/harness/mail-work-backend.js';
import { bootstrapMailWorkRoute, type MailWorkCallers } from '../mail/mail-work-route.js';
import type { MailWorkChatHandoff } from '../mail/mail-work-investigation.js';

class Control {
  constructor(readonly dataset: { workAction: string; index?: string }) {}
  closest() { return this; }
}
const fixtures: Array<ReturnType<typeof createMailWorkFixture>> = [];
const routes: Array<ReturnType<typeof bootstrapMailWorkRoute>> = [];
afterEach(() => { for (const route of routes.splice(0)) route.dispose(); for (const fixture of fixtures.splice(0)) fixture.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
/** Visible text of each work row, so identical rows compare equal. */
const rows = (html: string): string[] => [...html.matchAll(/<(div|article) class="work-card">([\s\S]*?)<\/\1>/gu)]
  .map(match => match[2]!.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim());
const setup = () => {
  vi.stubGlobal('Element', Control);
  const fixture = createMailWorkFixture(); fixtures.push(fixture);
  const handoffs: MailWorkChatHandoff[] = [];
  const listeners = new Map<string, EventListener>();
  const root = { innerHTML: '', ownerDocument: { activeElement: null, visibilityState: 'visible' },
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name), replaceChildren() {}, querySelector: () => null,
  };
  const callers: MailWorkCallers = {
    list: args => fixture.service.list(args), get: args => fixture.service.get(args.id), create: args => fixture.service.create(args),
    update: args => fixture.service.update(args), review: args => fixture.service.review(args.id, args.expected_revision),
    delete: args => fixture.service.delete(args),
    search: async args => fixture.service.search(args.query),
    openChat: async args => await fixture.rpc('chat.session.create', args) as { session_id: string },
  };
  return { fixture, root, handoffs, callers,
    mount(segments = ['follow', 'work', 'seed']) {
      const route = bootstrapMailWorkRoute({ root: root as unknown as HTMLElement, segments, callers,
        explore: handoff => handoffs.push(handoff),
      }); routes.push(route); return route;
    },
    click(action: string, index?: number) { listeners.get('click')?.({ target: new Control({ workAction: action, ...(index === undefined ? {} : { index: String(index) }) }) } as unknown as Event); },
  };
};

describe('Follow this work opens Chat immediately', () => {
  it('opens and prepares one visible investigation without an intake form or linked-mail review', async () => {
    const f = setup(); const review = vi.spyOn(f.fixture.service, 'review');
    await f.mount().whenLoaded();
    expect(f.handoffs).toHaveLength(1);
    expect(f.handoffs[0]).toMatchObject({ repeat: false, prompt: expect.any(String),
      mailWork: { seeds: [expect.objectContaining({ slug: 'work', record_id: 'seed' })] } });
    expect(f.root.innerHTML).not.toContain('Name (optional)');
    expect((await f.fixture.service.list()).works).toHaveLength(1);
    expect(review).not.toHaveBeenCalled();
  });
  it('resumes a started Chat without another prompt, including resolved work', async () => {
    const f = setup();
    const created = await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' } });
    await f.fixture.service.update({ id: created.work.id, expected_revision: 1, status: 'resolved', resolution_note: 'Finished.' });
    await f.fixture.rpc('chat.session.create', { creation_id: created.chat_session_id });
    await f.fixture.rpc('chat.send', { session_id: created.chat_session_id, message: 'Investigate this work.', submission_id: crypto.randomUUID(), picker_state: { current: 'self' } });
    await f.mount().whenLoaded();
    expect(f.handoffs).toEqual([{ sessionId: created.chat_session_id, replace: true }]);
    expect((await f.fixture.service.get(created.work.id)).work.status).toBe('resolved');
  });
  it('lets the owner select among exact associations or start separate work', async () => {
    const f = setup();
    for (const title of ['Delivery', 'Billing']) await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, title, separate: true });
    await f.mount().whenLoaded();
    expect(f.handoffs).toEqual([]); expect(f.root.innerHTML).toContain('Choose an investigation');
    f.click('separate');
    await vi.waitFor(() => expect(f.handoffs).toHaveLength(1));
    expect((await f.fixture.service.list()).works).toHaveLength(3);
  });
  it('retries failed session creation without duplicating saved work', async () => {
    const f = setup(); const open = f.callers.openChat;
    f.callers.openChat = vi.fn().mockRejectedValueOnce(new Error('Temporary failure')).mockImplementation(open);
    await f.mount().whenLoaded();
    expect(f.handoffs).toEqual([]); expect(f.root.innerHTML).toContain('Try again');
    f.click('retry-entry');
    await vi.waitFor(() => expect(f.handoffs).toHaveLength(1));
    expect(f.handoffs[0]?.repeat).toBe(false);
    expect((await f.fixture.service.list()).works).toHaveLength(1);
  });
  it('refuses an older server that did not apply the email filter', async () => {
    const f = setup(); f.callers.list = async () => ({ works: [{ id: 'unrelated', title: 'Other work', status: 'active', updated_at: 1, needs_review: false }], next_cursor: null });
    await f.mount().whenLoaded();
    expect(f.root.innerHTML).toContain('Update this server'); expect(f.handoffs).toEqual([]);
  });
  it('keeps the original work page when separate Chat creation fails and retries the saved new work', async () => {
    const f = setup();
    const original = await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, title: 'Original matter' });
    const open = f.callers.openChat;
    f.callers.openChat = vi.fn().mockRejectedValueOnce(new Error('Temporary failure')).mockImplementation(open);
    await f.mount(['work', original.work.id]).whenLoaded();
    f.click('separate-current');
    await vi.waitFor(() => expect(f.root.innerHTML).toContain('Temporary failure'));
    expect(f.root.innerHTML).toContain('<h1>Original matter</h1>');
    f.click('separate-current');
    await vi.waitFor(() => expect(f.handoffs).toHaveLength(1));
    expect(f.handoffs[0]?.sessionId).not.toBe(original.chat_session_id);
    expect((await f.fixture.service.list()).works).toHaveLength(2);
  });
  it('does not open Chat after the owner leaves during association lookup', async () => {
    const f = setup(); let release!: () => void;
    f.callers.list = async () => { await new Promise<void>(done => { release = done; }); return { works: [], next_cursor: null, matched_email: { slug: 'work', record_id: 'seed' } }; };
    const route = f.mount(); route.dispose(); release(); await route.whenLoaded();
    expect(f.handoffs).toEqual([]); expect((await f.fixture.service.list()).works).toHaveLength(0);
  });
  it('hands the follow address over to Chat in its place; the work page stays in history', async () => {
    const f = setup();
    await f.mount().whenLoaded();
    expect(f.handoffs).toEqual([expect.objectContaining({ replace: true })]);
    await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, title: 'Billing', separate: true });
    const chooser = f.mount(); await chooser.whenLoaded();
    expect(f.root.innerHTML).toContain('Choose an investigation');
    f.click('resume', 1);
    await vi.waitFor(() => expect(f.handoffs).toHaveLength(2));
    expect(f.handoffs[1]).toMatchObject({ replace: true });
    chooser.dispose();
    const { works } = await f.fixture.service.list();
    await f.mount(['work', works[0]!.id]).whenLoaded();
    f.click('open-chat');
    await vi.waitFor(() => expect(f.handoffs).toHaveLength(3));
    expect(f.handoffs[2]).not.toHaveProperty('replace');
  });
  it('tells apart separate investigations that share the conversation subject', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // before setup: the work service keeps Date.now
    const f = setup();
    for (const hour of [9, 11]) {
      vi.setSystemTime(Date.UTC(2026, 8, 30, hour));
      await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, separate: true });
    }
    const chooser = f.mount(); await chooser.whenLoaded();
    const choices = rows(f.root.innerHTML);
    expect(choices).toHaveLength(2);
    for (const choice of choices) expect(choice).toContain('Acme revised offer');
    expect(new Set(choices).size).toBe(2);
    chooser.dispose();
    await f.mount(['work']).whenLoaded();
    const listed = rows(f.root.innerHTML);
    expect(listed).toHaveLength(2); expect(new Set(listed).size).toBe(2);
  });
  it('asks for a server update instead of naming a call an older server does not have', async () => {
    for (const segments of [['follow', 'work', 'seed'], ['work']]) {
      const f = setup();
      f.callers.list = async () => { throw new RpcError('unknown_method', 'Unknown rpc method: mail.work.list', 404, 'mail.work.list'); };
      await f.mount(segments).whenLoaded();
      expect(f.root.innerHTML).toContain('Update this server to follow work.');
      expect(f.root.innerHTML).not.toContain('Unknown rpc method');
      expect(f.handoffs).toEqual([]);
    }
  });
});
