import { describe, expect, it, vi } from 'vitest';
import {
  RECORD_REF_CELL_ATTR,
  RECORD_REF_CELL_ENTITY_ATTR,
  RECORD_REF_CELL_FILTER_ATTR,
  RefPicker,
} from '@recued/ui-shared';

import {
  createResultActionRegistry,
  RECIPES_ROUTE_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  renderRecipeResultSection,
} from '../recipes/recipe-result-panel.js';
import {
  captureResultFilterActionFocus,
  captureResultTableEditSubmitFocus,
  restoreResultFilterActionFocus,
  restoreResultTableEditSubmitFocus,
  syncResultTableEditChrome,
  wireResultTableEditRefPickers,
} from '../recipes/result-table-edit-host.js';

interface FakeEvent {
  target: FakeNode;
  preventDefault(): void;
}

const ATTRIBUTE_SELECTOR = /^\[([^=\]]+)(?:="([^"]*)")?\]$/;

class FakeNode {
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  parentElement: FakeNode | null = null;
  value = '';
  innerHTML = '';
  disabled = false;
  tabIndex = 0;
  focused = false;

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  focus(): void {
    this.focused = true;
  }

  append(child: FakeNode): FakeNode {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const matches: FakeNode[] = [];
    const visit = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node !== null) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  private matches(selector: string): boolean {
    const match = ATTRIBUTE_SELECTOR.exec(selector);
    if (match === null) return false;
    const value = this.attrs.get(match[1]!);
    return value !== undefined && (match[2] === undefined || match[2] === value);
  }
}

const emit = (shell: FakeNode, type: string, target: FakeNode): void => {
  const event: FakeEvent = { target, preventDefault() {} };
  for (const listener of shell.listeners.get(type) ?? []) listener(event);
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('shared result table edit host', () => {
  it('restores the exact filter action and crosses a terminal page boundary', () => {
    const key = 'sheet:stored-sheet-hash:1';
    const current = new FakeNode();
    const next = current.append(new FakeNode());
    next.setAttribute(RECIPES_ROUTE_ACTION_ATTR, 'result-filter-page:next');
    next.setAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR, key);
    const focused = captureResultFilterActionFocus(
      next as unknown as HTMLElement,
    );
    expect(focused).toEqual({ action: 'next', filterKey: key });
    expect(restoreResultFilterActionFocus(
      current as unknown as HTMLElement,
      focused,
    )).toBe(true);
    expect(next.focused).toBe(true);

    const lastPage = new FakeNode();
    const previous = lastPage.append(new FakeNode());
    previous.setAttribute(
      RECIPES_ROUTE_ACTION_ATTR,
      'result-filter-page:previous',
    );
    previous.setAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR, key);
    expect(restoreResultFilterActionFocus(
      lastPage as unknown as HTMLElement,
      focused,
    )).toBe(true);
    expect(previous.focused).toBe(true);
  });

  it('keeps Save focusable through busy and restores it by grid key', () => {
    const root = new FakeNode();
    const grid = root.append(new FakeNode());
    grid.setAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR, 'sheet#grid-0');
    const submit = grid.append(new FakeNode());
    submit.setAttribute(RECIPES_ROUTE_ACTION_ATTR, 'result-grid-submit');
    submit.setAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR, 'sheet#grid-0');

    const clean = {
      rows: [], baseline: [], busy: false, error: null, dirty: false,
    };
    syncResultTableEditChrome(
      grid as unknown as HTMLElement,
      clean,
    );
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(submit.tabIndex).toBe(-1);

    syncResultTableEditChrome(
      grid as unknown as HTMLElement,
      { ...clean, busy: true, dirty: true },
    );
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(submit.tabIndex).toBe(0);

    const key = captureResultTableEditSubmitFocus(
      submit as unknown as HTMLElement,
    );
    expect(key).toBe('sheet#grid-0');
    expect(restoreResultTableEditSubmitFocus(
      root as unknown as HTMLElement,
      key,
    )).toBe(true);
    expect(submit.focused).toBe(true);
  });

  it('upgrades a ref-valued editable column to a scoped picker when the host can search', () => {
    const section = {
      type: 'table',
      data: { rows: [{ leg_ref: 'leg/1', tag_ref: 'tag/alice' }] },
      record_columns: {
        entity: 'leg_tag',
        columns: [
          { field: 'leg_ref', label: 'Line', kind: 'ref', references: 'leg' },
          { field: 'tag_ref', label: 'Category', kind: 'ref', references: 'tag' },
        ],
      },
      table_edit: {
        section_index: 0,
        recipe_hash: 'stored-tag-lines-hash',
        into: 'assignments',
        submit: 'Apply tags',
        rows: 'fixed',
        editable: ['tag_ref'],
        carry: ['leg_ref'],
        hidden: {},
        scopes: { tag_ref: { root_ref: 'tag/department' } },
      },
    } as never;
    const registry = createResultActionRegistry(
      [],
      new Map(),
      false,
      new Set(),
      new Map(),
      new Set(),
    );

    const fallback = renderRecipeResultSection(
      section, registry, new Map(), 'tag-lines', false,
    );
    expect(fallback).toContain('data-recued-record-ref-cell="0:tag_ref"');
    expect(fallback).not.toContain('data-ref-picker=');

    const upgraded = renderRecipeResultSection(
      section, registry, new Map(), 'tag-lines', false, new Map(), false, true,
    );
    expect(upgraded).toContain('data-ref-picker="tag-lines#grid-0-ref-0:tag_ref"');
    expect(upgraded).toContain('data-recued-record-ref-cell-entity="tag"');
    expect(upgraded).toContain(
      'data-recued-record-ref-cell-filter="{&quot;root_ref&quot;:&quot;tag/department&quot;}"',
    );
  });

  it('wires scoped ref cells and stores a picked record as a canonical ref', async () => {
    const root = new FakeNode();
    const grid = root.append(new FakeNode());
    grid.setAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR, 'sheet#grid-0');
    const cell = grid.append(new FakeNode());
    cell.setAttribute(RECORD_REF_CELL_ATTR, '0:tag_ref');
    cell.setAttribute(RECORD_REF_CELL_ENTITY_ATTR, 'tag');
    cell.setAttribute(
      RECORD_REF_CELL_FILTER_ATTR,
      JSON.stringify({ root_ref: 'tag/department' }),
    );

    const shell = cell.append(new FakeNode());
    shell.setAttribute('data-ref-picker', 'grid-ref-picker');
    const field = shell.append(new FakeNode());
    const input = field.append(new FakeNode());
    input.setAttribute(RefPicker.REF_PICKER_INPUT_ATTR, '');
    const clear = field.append(new FakeNode());
    clear.setAttribute(RefPicker.REF_PICKER_CLEAR_ATTR, '');
    const results = shell.append(new FakeNode());
    results.setAttribute(RefPicker.REF_PICKER_RESULTS_ATTR, '');

    const caller = vi.fn<RefPicker.RefPickerSearchCaller>(async () => [
      { id: 'alice', label: 'Alice' },
    ]);
    const search = vi.fn(() => caller);
    const onChange = vi.fn();
    const handles = wireResultTableEditRefPickers(
      root as unknown as ParentNode,
      {
        search,
        valueAt: () => 'tag/alice',
        onChange,
      },
    );

    expect(handles).toHaveLength(1);
    expect(search).toHaveBeenCalledWith('tag', { root_ref: 'tag/department' });
    expect(input.value).toBe('alice');

    emit(shell, 'focusin', input);
    await settle();
    // Reopening a committed picker shows the scoped inventory, rather than
    // searching the display value and reducing the list to itself.
    expect(caller).toHaveBeenCalledWith('');

    const option = new FakeNode();
    option.parentElement = shell;
    option.setAttribute(RefPicker.REF_PICKER_OPTION_INDEX_ATTR, '0');
    emit(shell, 'mousedown', option);
    expect(onChange).toHaveBeenLastCalledWith(
      'sheet#grid-0',
      grid,
      0,
      'tag_ref',
      'tag/alice',
    );

    emit(shell, 'click', clear);
    expect(onChange).toHaveBeenLastCalledWith(
      'sheet#grid-0',
      grid,
      0,
      'tag_ref',
      '',
    );
    handles[0]!.destroy();
  });
});
