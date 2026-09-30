/** The work page's Delete control over real encrypted work and Chat storage. No browser rendering claim. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import { createMailWorkFixture } from '../../e2e/harness/mail-work-backend.js';
import { bootstrapMailWorkRoute, type MailWorkCallers } from '../mail/mail-work-route.js';

class Control {
  constructor(readonly dataset: { workAction: string }) {}
  closest() { return this; }
}
const fixtures: Array<ReturnType<typeof createMailWorkFixture>> = [];
const routes: Array<ReturnType<typeof bootstrapMailWorkRoute>> = [];
afterEach(() => { for (const route of routes.splice(0)) route.dispose(); for (const fixture of fixtures.splice(0)) fixture.close(); vi.unstubAllGlobals(); });
const question = 'Delete this followed work? Its notes and AI review are removed. The Chat stays; delete it in Chat if you want.';

const open = async () => {
  vi.stubGlobal('Element', Control);
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  const fixture = createMailWorkFixture(); fixtures.push(fixture);
  const created = await fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' } });
  const noted = await fixture.service.update({ id: created.work.id, expected_revision: 1, owner_notes: 'Client accepted by phone.' });
  await fixture.rpc('chat.session.create', { creation_id: created.chat_session_id, title: created.work.title });
  const listeners = new Map<string, EventListener>();
  const root = { innerHTML: '', ownerDocument: { activeElement: null, visibilityState: 'visible' },
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name), replaceChildren() {}, querySelector: () => null,
  };
  const navigate = vi.fn<(hash: string) => void>();
  const callers: MailWorkCallers = {
    list: args => fixture.service.list(args), get: args => fixture.service.get(args.id), create: args => fixture.service.create(args),
    update: args => fixture.service.update(args), review: args => fixture.service.review(args.id, args.expected_revision),
    search: async args => fixture.service.search(args.query),
    openChat: async args => await fixture.rpc('chat.session.create', args) as { session_id: string },
    delete: vi.fn((args: { id: string; expected_revision: number }) => fixture.service.delete(args)),
  };
  const route = bootstrapMailWorkRoute({ root: root as unknown as HTMLElement, segments: ['work', created.work.id], callers,
    explore: () => {}, navigate });
  routes.push(route);
  await route.whenLoaded();
  return { fixture, work: noted.work, chatId: created.chat_session_id, root, navigate, callers, confirm,
    click(action: string) { listeners.get('click')?.({ target: new Control({ workAction: action }) } as unknown as Event); },
  };
};

describe('Delete on the work page', () => {
  it('asks on the page first, then deletes the work and returns to the list while the Chat stays', async () => {
    const f = await open();
    expect(f.root.innerHTML).not.toContain(question);
    f.click('delete');
    expect(f.root.innerHTML).toContain(question);
    f.click('cancel-delete');
    expect(f.root.innerHTML).not.toContain(question);
    expect(f.callers.delete).not.toHaveBeenCalled();
    f.click('delete');
    f.click('confirm-delete');
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith('#mail/work'));
    expect(f.callers.delete).toHaveBeenCalledTimes(1);
    expect(f.callers.delete).toHaveBeenCalledWith({ id: f.work.id, expected_revision: f.work.revision });
    expect(f.confirm).not.toHaveBeenCalled();
    expect((await f.fixture.service.list()).works).toEqual([]);
    expect(f.root.innerHTML).not.toContain('Client accepted by phone.');
    await expect(f.fixture.rpc('chat.session.get', { session_id: f.chatId })).resolves.toMatchObject({ id: f.chatId, archived: false });
  });
  // The question sits at the end of a long page, so its answer is shown there.
  const besideQuestion = (html: string, text: string) => html.indexOf(text) > html.indexOf(question) && html.includes(question);
  it('tells the owner to update an older server and keeps the work', async () => {
    const f = await open();
    f.callers.delete = vi.fn(async () => { throw new RpcError('unknown_method', 'Unknown rpc method: mail.work.delete', 404); });
    f.click('delete');
    f.click('confirm-delete');
    await vi.waitFor(() => expect(f.root.innerHTML).toContain('Update your server to delete followed work.'));
    expect(besideQuestion(f.root.innerHTML, 'Update your server to delete followed work.')).toBe(true);
    expect(f.root.innerHTML).not.toContain('Unknown rpc method');
    expect(f.navigate).not.toHaveBeenCalled();
    expect((await f.fixture.service.get(f.work.id)).work).toEqual(f.work);
  });
  it('shows a stale-revision refusal beside the question, deletes nothing, and asks again after a reload', async () => {
    const f = await open();
    await f.fixture.service.update({ id: f.work.id, expected_revision: f.work.revision, owner_notes: 'Edited in another tab.' });
    f.click('delete');
    f.click('confirm-delete');
    const stale = 'This work or its mail changed. Reload it before trying again.';
    await vi.waitFor(() => expect(f.root.innerHTML).toContain(stale));
    expect(besideQuestion(f.root.innerHTML, stale)).toBe(true);
    expect(f.navigate).not.toHaveBeenCalled();
    expect((await f.fixture.service.list()).works).toHaveLength(1);
    // The question was asked about the version on screen; a reloaded version needs a new answer.
    f.click('reload');
    await vi.waitFor(() => expect(f.root.innerHTML).toContain('Edited in another tab.'));
    expect(f.root.innerHTML).not.toContain(question);
    expect(f.root.innerHTML).not.toContain(stale);
    expect(f.callers.delete).toHaveBeenCalledTimes(1);
  });
});
