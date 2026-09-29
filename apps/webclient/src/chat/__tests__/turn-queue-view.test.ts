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
});
