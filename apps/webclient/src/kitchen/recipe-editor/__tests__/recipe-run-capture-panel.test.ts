/** D-402 slice C (§8.3) — a recipe saved after a trial ("Try it") is offered that trial as its saved test:
 *  Kitchen's capture panel on the saved recipe's page opens on the trial's capture, once, and loads it
 *  for review, which the owner then imports as any captured run. Through the real panel, on a small
 *  document double that does what the panel asks of a page (this repo has no DOM library). */
import { describe, expect, it, vi } from 'vitest';
import type { RecipeRunCaptureRead, RecipeRunCaptureSummary } from '@recued/contracts';

import type { RecipeRegressionCaller } from '../recipe-regression-caller.js';
import type { RecipeRunCaptureCaller } from '../recipe-run-capture-caller.js';
import { createRecipeRunCapturePanel } from '../recipe-run-capture-panel.js';

interface FakeNode {
  tagName: string; children: FakeNode[]; textContent: string; attributes: Map<string, string>; style: Record<string, string>;
  open?: boolean; ontoggle?: () => void; onclick?: () => void; disabled?: boolean; [key: string]: unknown;
  append(...nodes: FakeNode[]): void; replaceChildren(...nodes: FakeNode[]): void; remove(): void;
  setAttribute(name: string, value: string): void; getAttribute(name: string): string | null;
  querySelector(selector: string): FakeNode | null; focus(): void;
}

const element = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName, children: [], textContent: '', attributes: new Map(), style: {},
    append: (...nodes) => { node.children.push(...nodes); },
    replaceChildren: (...nodes) => { node.children = [...nodes]; },
    remove: () => undefined,
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    getAttribute: (name) => node.attributes.get(name) ?? null,
    querySelector: (selector) => {
      const name = /^\[([\w-]+)\]$/u.exec(selector)?.[1];
      const visit = (from: FakeNode): FakeNode | null => {
        for (const child of from.children) {
          if (name !== undefined && child.attributes?.has(name)) return child;
          const found = child.children ? visit(child) : null;
          if (found) return found;
        }
        return null;
      };
      return visit(node);
    },
    focus: () => undefined,
  };
  return node;
};
const fakeDocument = { createElement: element, createTextNode: (text: string) => ({ ...element('#text'), textContent: text }),
  defaultView: { confirm: () => true } };
const textOf = (node: FakeNode): string => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(' ');
const findAll = (node: FakeNode, name: string, out: FakeNode[] = []): FakeNode[] => {
  if (node.attributes?.has(name)) out.push(node);
  for (const child of node.children ?? []) findAll(child, name, out);
  return out;
};
const tick = async (n = 12): Promise<void> => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

const summary = (over: Partial<RecipeRunCaptureSummary>): RecipeRunCaptureSummary => ({ capture_id: 'c-trial', recipe_id: 'browser-plan-shop',
  created_at: 1_000, expires_at: 601_000, state: 'ready', ...over });

const panel = (captures: RecipeRunCaptureSummary[]) => {
  const get = vi.fn(async ({ capture_id }: { capture_id: string }): Promise<RecipeRunCaptureRead> =>
    ({ capture: captures.find((one) => one.capture_id === capture_id)!, draft: null }));
  const caller = { list: vi.fn(async () => ({ captures })), get, prepare: vi.fn(), run: vi.fn(), delete: vi.fn(), import: vi.fn() } as unknown as RecipeRunCaptureCaller;
  const regressionCaller = { get: vi.fn(async () => ({ head_revision: 0 })) } as unknown as RecipeRegressionCaller;
  const created = createRecipeRunCapturePanel({ document: fakeDocument as unknown as Document, recipeId: 'browser-plan-shop', caller,
    regressionCaller, testsBusy: () => false, imported: () => undefined, changed: () => undefined });
  return { root: created.element as unknown as FakeNode, get, caller };
};

describe('D-402 slice C — the saved recipe\'s page offers its trial as its saved test', () => {
  it('opens on a trial\'s ready capture, marked as the trial, and loads it for review', async () => {
    const { root, get } = panel([summary({}), summary({ capture_id: 'c-other', trial: undefined })].map((one, n) =>
      n === 0 ? { ...one, trial: true as const } : one));
    expect(root.open).not.toBe(true);
    await tick();
    expect(root.open).toBe(true);
    expect(get).toHaveBeenCalledWith({ capture_id: 'c-trial' });
    const rows = findAll(root, 'data-capture-trial');
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]!)).toContain('· ready · from your trial before you saved it');
    expect(textOf(findAll(root, 'data-capture-trial-offer')[0]!))
      .toBe('From your trial before you saved this recipe: review it, then import it as its saved test.');
  });

  it('stays closed when no trial left one ready (a trial still waiting, a trial that stopped, a capture of its own)', async () => {
    for (const captures of [[summary({ trial: true, state: 'running' })], [summary({ trial: true, state: 'unavailable' })], [summary({})], []]) {
      const { root, get } = panel(captures);
      await tick();
      expect(root.open, JSON.stringify(captures)).not.toBe(true);
      expect(get).not.toHaveBeenCalled();
    }
  });
});
