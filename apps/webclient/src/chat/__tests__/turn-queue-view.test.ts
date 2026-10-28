import { describe, expect, it, vi } from 'vitest';
import type { ChatQueuedTurn, ChatQueuedTurnStatus, ChatTurnQueueSnapshot } from '@recued/contracts';
import { createChatQueueView, type ChatQueueClient } from '../turn-queue-view.js';

/** Enough of a DOM for the strip: elements, attributes, text, clicks. */
interface FakeNode {
  tagName: string;
  type: string;
  disabled: boolean;
  children: FakeNode[];
  attributes: Map<string, string>;
  ownText: string;
  listeners: Map<string, Array<() => void>>;
  textContent: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  addEventListener(kind: string, listener: () => void): void;
}

const makeNode = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    type: '',
    disabled: false,
    children: [],
    attributes: new Map(),
    ownText: '',
    listeners: new Map(),
    get textContent(): string {
      return node.ownText + node.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      node.ownText = value;
      node.children = [];
    },
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    getAttribute: (name) => node.attributes.get(name) ?? null,
    appendChild: (child) => { node.children.push(child); return child; },
    addEventListener: (kind, listener) => {
      node.listeners.set(kind, [...(node.listeners.get(kind) ?? []), listener]);
    },
  };
  return node;
};

const doc = { createElement: (tag: string) => makeNode(tag) } as unknown as Document;

const turn = (
  turn_id: string,
  status: ChatQueuedTurnStatus,
  message: string,
  extra: Partial<ChatQueuedTurn> = {},
): ChatQueuedTurn => ({
  turn_id, session_id: 's', position: 0, status, message, created_at: 1, duplicate_count: 0, ...extra,
});

const buttons = (root: FakeNode | null): FakeNode[] => {
  if (root === null) return [];
  const out: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (node.tagName === 'BUTTON') out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const click = (button: FakeNode): void => {
  for (const listener of button.listeners.get('click') ?? []) listener();
};

const controls = async (initial: ChatQueuedTurn[]) => {
  let snapshot: ChatTurnQueueSnapshot = { generation: 'g', revision: 1, turns: initial };
  const changed = vi.fn();
  const restore = vi.fn(async () => true);
  const conn = vi.fn(async (method: string, _args?: unknown): Promise<unknown> => {
    if (method === 'chat.turns.list') return snapshot;
    return { ok: true };
  });
  const view = createChatQueueView(conn as unknown as ChatQueueClient, changed, restore);
  view.render(doc, 's');
  await view.refresh('s');
  return { conn, changed, restore, view,
    snapshot: () => snapshot,
    set: (next: ChatTurnQueueSnapshot) => { snapshot = next; },
    render: (session = 's') => view.render(doc, session) as unknown as FakeNode | null,
  };
};

/** Render the strip for one snapshot, after the view has read it. */
const strip = async (turns: ChatQueuedTurn[], conn = vi.fn()) => {
  const snapshot: ChatTurnQueueSnapshot = { generation: 'g', revision: 1, turns };
  conn.mockImplementation(async (method: string) => (method === 'chat.turns.list' ? snapshot : { ok: true }));
  const view = createChatQueueView(conn as unknown as ChatQueueClient, () => {});
  view.render(doc, 's');
  await view.refresh('s');
  const root = view.render(doc, 's') as unknown as FakeNode | null;
  return { root, conn, view };
};

describe('the conversation queue strip', () => {
  /** ⛔ It echoed every finished turn ("Completed: …", with "Run last message
   *  again" beside it) — two rows the owner could not place, which also
   *  pushed Send below the window. The answer is in the conversation. */
  it('shows nothing once a turn has simply finished', async () => {
    const { root } = await strip([turn('t1', 'completed', 'What should I focus on today?')]);
    expect(root).toBeNull();
  });

  it('shows the running turn with Stop, and no second run of it', async () => {
    const { root } = await strip([turn('t1', 'running', 'What should I focus on today?')]);
    expect(root?.textContent).toContain('Working: What should I focus on today?');
    expect(buttons(root).map((button) => button.textContent)).toEqual(['Stop turn']);
  });

  it('offers to try again a turn that did not finish', async () => {
    for (const [status, label] of [
      ['failed', 'Failed'],
      ['cancelled', 'Cancelled'],
      ['interrupted', 'Interrupted by a restart'],
    ] as const) {
      const { root } = await strip([turn('t1', status, 'Draft the reply')]);
      expect(root?.textContent).toContain(`${label}: Draft the reply`);
      expect(buttons(root).map((button) => button.textContent)).toEqual(['Try again']);
    }
  });

  /** D-265 runs A/A once: the repeated message was folded into the answered
   *  turn, and running it again is the one way to get a second answer. */
  it('explains a repeated message folded into an answered turn, and runs it again on request', async () => {
    const { root, conn } = await strip([
      turn('t1', 'completed', 'What should I focus on today?', { duplicate_count: 1 }),
    ]);
    expect(root?.textContent).toContain(
      'Already answered: What should I focus on today? · 1 repeated message uses this turn',
    );
    const again = buttons(root).find((button) => button.textContent === 'Run it again')!;
    for (const listener of again.listeners.get('click') ?? []) listener();
    expect(conn).toHaveBeenCalledWith('chat.turn.retry', expect.objectContaining({
      session_id: 's', turn_id: 't1',
    }));
  });

  it('shows the latest turn only: an older failure under a finished turn is history', async () => {
    const { root } = await strip([
      turn('t1', 'failed', 'First try'),
      turn('t2', 'completed', 'Second try'),
    ]);
    expect(root).toBeNull();
  });

  it.each([
    ['running', 'Stop turn', 'Stopping…'],
    ['queued', 'Cancel queued message', 'Cancelling…'],
  ] as const)('keeps %s cancellation pending across refreshes and excludes a conflicting withdrawal', async (status, label, progress) => {
    const f = await controls([turn('t1', status, 'First', { withdraw_to_edit_available: true }), turn('t2', 'queued', 'Second')]);
    const request = deferred<{ ok: true }>();
    f.conn.mockImplementation(async method => method === 'chat.turn.cancel' ? request.promise : f.snapshot());
    click(buttons(f.render()).find(button => button.textContent === label)!);
    await f.view.refresh('s');
    const current = buttons(f.render());
    const busy = current.find(button => button.textContent === progress)!;
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    click(busy);
    const withdraw = current.find(button => button.textContent === 'Withdraw to edit');
    if (status === 'queued') {
      expect(withdraw?.getAttribute('aria-disabled')).toBe('true');
      click(withdraw!);
    }
    expect(current.find(button => button.textContent === 'Cancel queued message')?.getAttribute('aria-disabled')).not.toBe('true');
    expect(f.conn.mock.calls.filter(([method]) => method === 'chat.turn.cancel')).toHaveLength(1);
    expect(f.conn.mock.calls.filter(([method]) => method === 'chat.turn.withdraw')).toHaveLength(0);
    request.reject(new Error('Lost acknowledgement'));
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('Could not confirm cancellation'));
    expect(buttons(f.render()).find(button => button.textContent === label)?.getAttribute('aria-disabled')).not.toBe('true');
    f.view.dispose();
  });

  it('keeps retry pending through redraws and reuses its submission after a lost acknowledgement', async () => {
    const f = await controls([turn('t1', 'failed', 'Try this')]);
    const request = deferred<unknown>();
    f.conn.mockImplementation(async method => method === 'chat.turn.retry' ? request.promise : f.snapshot());
    click(buttons(f.render())[0]!);
    await f.view.refresh('s');
    const busy = buttons(f.render())[0]!;
    expect(busy.textContent).toBe('Trying again…');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    click(busy);
    expect(f.conn.mock.calls.filter(([method]) => method === 'chat.turn.retry')).toHaveLength(1);
    request.reject(new Error('Lost acknowledgement'));
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('Could not confirm the new attempt'));
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turn.retry') {
        f.set({ generation: 'g', revision: 2, turns: [turn('t2', 'queued', 'Try this')] });
        return { turn_id: 't2', disposition: 'replayed' };
      }
      return f.snapshot();
    });
    click(buttons(f.render())[0]!);
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('Queued: Try this'));
    const requests = f.conn.mock.calls.filter(([method]) => method === 'chat.turn.retry');
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]).toEqual(requests[0]![1]);
    f.view.dispose();
  });

  it('waits for the fresh read after an action rather than an already pending snapshot', async () => {
    const f = await controls([turn('t1', 'running', 'First')]);
    const oldRead = deferred<ChatTurnQueueSnapshot>();
    const freshRead = deferred<ChatTurnQueueSnapshot>();
    let reads = 0;
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turns.list') return ++reads === 1 ? oldRead.promise : freshRead.promise;
      return { ok: true };
    });
    const refresh = f.view.refresh('s');
    click(buttons(f.render())[0]!);
    await vi.waitFor(() => expect(f.conn).toHaveBeenCalledWith('chat.turn.cancel', { session_id: 's', turn_id: 't1' }));
    oldRead.resolve(f.snapshot());
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(buttons(f.render())[0]?.textContent).toBe('Stopping…');
    expect(buttons(f.render())[0]?.getAttribute('aria-disabled')).toBe('true');
    freshRead.resolve({ generation: 'g', revision: 2, turns: [turn('t1', 'cancelled', 'First')] });
    await refresh;
    await vi.waitFor(() => expect(buttons(f.render())[0]?.textContent).toBe('Try again'));
    f.view.dispose();
  });

  it('keeps a confirmed retry identity if its follow-up status read fails', async () => {
    const f = await controls([turn('t1', 'failed', 'Try this')]);
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turns.list') throw new Error('Status unavailable');
      return { turn_id: 't2' };
    });
    click(buttons(f.render())[0]!);
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('could not refresh'));
    click(buttons(f.render())[0]!);
    await vi.waitFor(() => expect(f.conn.mock.calls.filter(([method]) => method === 'chat.turn.retry')).toHaveLength(2));
    const requests = f.conn.mock.calls.filter(([method]) => method === 'chat.turn.retry');
    expect(requests[1]![1]).toEqual(requests[0]![1]);
    f.view.dispose();
  });

  it('does not let an old generation finish a newer action on the same turn', async () => {
    const f = await controls([turn('t1', 'running', 'First')]);
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    let requests = 0;
    f.conn.mockImplementation(async method => method === 'chat.turn.cancel'
      ? ++requests === 1 ? oldRequest.promise : newRequest.promise : f.snapshot());
    click(buttons(f.render())[0]!);
    f.set({ generation: 'new', revision: 1, turns: [turn('t1', 'running', 'Replacement')] });
    await f.view.refresh('s');
    click(buttons(f.render())[0]!);
    oldRequest.reject(new Error('Old failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(buttons(f.render())[0]?.textContent).toBe('Stopping…');
    expect(f.render()?.textContent).not.toContain('Could not confirm cancellation');
    newRequest.resolve({ ok: true });
    f.view.dispose();
  });

  it('retires an action without another read or repaint after disposal', async () => {
    const f = await controls([turn('t1', 'running', 'First')]);
    const request = deferred<unknown>();
    f.conn.mockImplementation(async method => method === 'chat.turn.cancel' ? request.promise : f.snapshot());
    click(buttons(f.render())[0]!);
    f.view.dispose();
    const calls = f.conn.mock.calls.length;
    const paints = f.changed.mock.calls.length;
    request.resolve({ ok: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.conn.mock.calls).toHaveLength(calls);
    expect(f.changed.mock.calls).toHaveLength(paints);
  });

  it('reconciles a lost withdrawal acknowledgement even when its broadcast was missed', async () => {
    const f = await controls([turn('t1', 'queued', 'Recover me', { withdraw_to_edit_available: true })]);
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turn.withdraw') {
        f.set({ generation: 'g', revision: 2, turns: [turn('t1', 'withdrawn', 'Recover me', { withdraw_to_edit_available: true })] });
        throw new Error('Lost acknowledgement and broadcast');
      }
      return f.snapshot();
    });
    click(buttons(f.render()).find(button => button.textContent === 'Withdraw to edit')!);
    await vi.waitFor(() => expect(buttons(f.render()).map(button => button.textContent)).toContain('Restore withdrawn draft'));
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.render()?.textContent).toContain('Could not confirm withdrawal');
    f.view.dispose();
  });

  it('checks the fresh generation before restoring a confirmed withdrawal', async () => {
    const f = await controls([turn('t1', 'queued', 'Old draft', { withdraw_to_edit_available: true })]);
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turn.withdraw') {
        f.set({ generation: 'new', revision: 1, turns: [turn('t2', 'queued', 'Replacement')] });
        return { session_id: 's', turn_id: 't1', message: 'Old draft' };
      }
      return f.snapshot();
    });
    click(buttons(f.render()).find(button => button.textContent === 'Withdraw to edit')!);
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('Replacement'));
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.render()?.textContent).not.toContain('Message withdrawn');
    f.view.dispose();
  });

  it('shares the initial generation read without invalidating it or making Send wait for another RPC', async () => {
    const read = deferred<ChatTurnQueueSnapshot>();
    const conn = vi.fn(async () => read.promise);
    const view = createChatQueueView(conn as unknown as ChatQueueClient, () => {});
    view.render(doc, 's');
    await vi.waitFor(() => expect(conn).toHaveBeenCalledTimes(1));
    const generation = view.generation('s');
    read.resolve({ generation: 'g', revision: 1, turns: [] });
    await expect(generation).resolves.toBe('g');
    expect(conn).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('keeps a confirmed withdrawal recoverable when its status read is unavailable', async () => {
    const f = await controls([turn('t1', 'queued', 'Recover me', { withdraw_to_edit_available: true })]);
    f.conn.mockImplementation(async method => {
      if (method === 'chat.turns.list') throw new Error('Status unavailable');
      return { session_id: 's', turn_id: 't1', message: 'Recover me' };
    });
    click(buttons(f.render()).find(button => button.textContent === 'Withdraw to edit')!);
    await vi.waitFor(() => expect(f.render()?.textContent).toContain('could not refresh'));
    expect(f.restore).not.toHaveBeenCalled();
    expect(buttons(f.render()).find(button => button.textContent === 'Withdraw to edit')?.getAttribute('aria-disabled')).not.toBe('true');
    f.view.dispose();
  });
});
