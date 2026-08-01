/** The `record_ref` variable — a chooser over the owner's stored rows.
 *
 *  ⛔ Before this there was no way to say "one of your stored records": a
 *  variable's `options` is a static list authored into the recipe, and the
 *  typed pickers were for FILES and CONNECTIONS. `rental-book` inverted the
 *  flow instead — find the customer in a list, press "Start a tenancy", and
 *  let a `recipe.run` button carry the id in. That still works; this removes
 *  the need for it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RECORD_REF_FILTER_ATTR,
  RECORD_REF_VARIABLE_ATTR,
  recordRefVariablePickerId,
  renderVariableWidget,
  toWidgetShape,
} from '../variable-widgets.js';
import {
  REF_PICKER_CLEAR_ATTR,
  REF_PICKER_INPUT_ATTR,
  REF_PICKER_OPTION_INDEX_ATTR,
  REF_PICKER_RESULTS_ATTR,
} from '../ref-picker/index.js';
import { wireRecordRefVariables } from '../record-ref-variable.js';

const HINT = { label: 'Customer', type: 'record_ref', entity: 'customer' } as never;

describe('record_ref variable widget', () => {
  it('carries the entity onto the widget shape', () => {
    const shape = toWidgetShape('customer_id', HINT);
    expect(shape.type).toBe('record_ref');
    expect(shape.entity).toBe('customer');
  });

  it('renders a picker shell naming the entity it searches', () => {
    const html = renderVariableWidget(toWidgetShape('customer_id', HINT), {
      recordRefPicker: true,
    });
    expect(html).toContain('data-recued-record-ref-variable="customer_id"');
    expect(html).toContain('data-recued-record-ref-entity="customer"');
    // The host reads the committed id off the hidden input, exactly as
    // `file_ref` does — the picker is chrome over a plain value.
    expect(html).toContain('data-var-key="customer_id" data-var-type="record_ref"');
    expect(html).toContain('Search customer');
  });

  it('seeds a selected id as its own label, for the host to resolve', () => {
    // A PURE string renderer: the inventory has not been consulted, so a
    // stale id shows as an id rather than silently as somebody's name.
    const html = renderVariableWidget(
      toWidgetShape('customer_id', HINT, 'rec_abc'), { recordRefPicker: true },
    );
    expect(html).toContain('value="rec_abc"');
  });

  it('falls back to a text box when the host has no inventory', () => {
    // ⛔ A host with no record search must not render a dead combobox. The
    // value is still a plain id, so the box remains usable.
    const html = renderVariableWidget(toWidgetShape('customer_id', HINT), {});
    expect(html).not.toContain('data-recued-record-ref-variable');
    expect(html).toContain('data-var-key="customer_id"');
  });

  it('multi-entity forms get one picker each', () => {
    // The reason the caller is keyed by entity: a tenancy names a customer
    // AND a unit, so one shared inventory would have to guess.
    const unit = renderVariableWidget(
      toWidgetShape('unit_id', { label: 'Unit', type: 'record_ref', entity: 'unit' } as never),
      { recordRefPicker: true },
    );
    expect(unit).toContain('data-recued-record-ref-entity="unit"');
    expect(unit).toContain('Search unit');
  });

  it('carries an entity equality scope through shape and inspectable markup', () => {
    const scoped = {
      label: 'Department tag',
      type: 'record_ref',
      entity: 'tag',
      entity_filter: { root_ref: 'tag/department' },
    } as never;
    const shape = toWidgetShape('tag_id', scoped);
    expect(shape.entityFilter).toEqual({ root_ref: 'tag/department' });
    const html = renderVariableWidget(shape, { recordRefPicker: true });
    expect(html).toContain(
      `${RECORD_REF_FILTER_ATTR}="{&quot;root_ref&quot;:&quot;tag/department&quot;}"`,
    );
  });

  it('shared wiring works with record search alone, hydrates labels, and stores ids', async () => {
    const pickerId = recordRefVariablePickerId('customer_id', 'config');
    const root = node();
    const row = root.append(node({ [RECORD_REF_VARIABLE_ATTR]: 'customer_id' }));
    const shell = row.append(node({ 'data-ref-picker': pickerId }));
    const field = shell.append(node());
    const input = field.append(node({ [REF_PICKER_INPUT_ATTR]: '' }));
    const clear = field.append(node({ [REF_PICKER_CLEAR_ATTR]: '' }));
    const results = shell.append(node({ [REF_PICKER_RESULTS_ATTR]: '' }));
    const hidden = row.append(node({ 'data-var-key': 'customer_id' }));
    hidden.value = 'customer_1';

    const caller = vi.fn(async () => [{ id: 'customer_1', label: 'Acme Ltd' }]);
    const search = vi.fn(() => caller);
    const onChange = vi.fn();
    const handles = wireRecordRefVariables(root as unknown as ParentNode, {
      variables: {
        customer_id: {
          label: 'Customer',
          type: 'record_ref',
          entity: 'customer',
          entity_filter: { status: 'active' },
        } as never,
      },
      values: { customer_id: 'customer_1' },
      idPrefix: 'config',
      search,
      onChange,
    });

    expect(handles).toHaveLength(1);
    expect(search).toHaveBeenCalledWith('customer', { status: 'active' });
    await settle();
    expect(input.value).toBe('Acme Ltd');

    emit(input, 'focusin');
    await settle();
    const option = results.append(node({ [REF_PICKER_OPTION_INDEX_ATTR]: '0' }));
    emit(option, 'mousedown');
    expect(hidden.value).toBe('customer_1');
    expect(onChange).toHaveBeenLastCalledWith('customer_id', 'customer_1');

    emit(clear, 'click');
    expect(hidden.value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith('customer_id', '');
    handles[0]!.destroy();
  });

  it('does not let late label hydration overwrite an in-progress query', async () => {
    const pickerId = recordRefVariablePickerId('customer_id', 'config');
    const root = node();
    const row = root.append(node({ [RECORD_REF_VARIABLE_ATTR]: 'customer_id' }));
    const shell = row.append(node({ 'data-ref-picker': pickerId }));
    const field = shell.append(node());
    const input = field.append(node({ [REF_PICKER_INPUT_ATTR]: '' }));
    field.append(node({ [REF_PICKER_CLEAR_ATTR]: '' }));
    shell.append(node({ [REF_PICKER_RESULTS_ATTR]: '' }));
    row.append(node({ 'data-var-key': 'customer_id' }));
    let resolveHydration!: (value: Array<{ id: string; label: string }>) => void;
    const caller = vi.fn(() => new Promise<Array<{ id: string; label: string }>>(
      (resolve) => { resolveHydration = resolve; },
    ));
    const handles = wireRecordRefVariables(root as unknown as ParentNode, {
      variables: { customer_id: HINT },
      values: { customer_id: 'customer_1' },
      idPrefix: 'config',
      search: () => caller,
      onChange() {},
    });

    await Promise.resolve();
    input.value = 'new customer';
    emit(input, 'input');
    resolveHydration([{ id: 'customer_1', label: 'Acme Ltd' }]);
    await settle();
    expect(input.value).toBe('new customer');
    expect(handles[0]!.getValue()).toEqual({ id: 'customer_1', label: 'customer_1' });
    handles[0]!.destroy();
  });

  it('shares one cached inventory caller across equivalent fields in a form', () => {
    const root = node();
    for (const key of ['tag_id', 'new_parent_id']) {
      const row = root.append(node({ [RECORD_REF_VARIABLE_ATTR]: key }));
      row.append(node({
        'data-ref-picker': recordRefVariablePickerId(key, 'config'),
      }));
    }
    const caller = vi.fn(async () => []);
    const search = vi.fn(() => caller);
    const tagHint = { label: 'Tag', type: 'record_ref', entity: 'tag' } as never;
    const handles = wireRecordRefVariables(root as unknown as ParentNode, {
      variables: { tag_id: tagHint, new_parent_id: tagHint },
      idPrefix: 'config',
      search,
      onChange() {},
    });

    expect(handles).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(1);
    for (const handle of handles) handle.destroy();
  });
});

class FakeNode {
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, Array<(event: { target: FakeNode; preventDefault(): void }) => void>>();
  parentElement: FakeNode | null = null;
  value = '';
  innerHTML = '';

  constructor(attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
  }

  append(child: FakeNode): FakeNode {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void {}

  addEventListener(
    type: string,
    listener: (event: { target: FakeNode; preventDefault(): void }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(
    type: string,
    listener: (event: { target: FakeNode; preventDefault(): void }) => void,
  ): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  querySelector(selector: string): FakeNode | null {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (match === null) return null;
    const visit = (parent: FakeNode): FakeNode | null => {
      for (const child of parent.children) {
        const value = child.attrs.get(match[1]!);
        if (value !== undefined && (match[2] === undefined || value === match[2])) {
          return child;
        }
        const nested = visit(child);
        if (nested !== null) return nested;
      }
      return null;
    };
    return visit(this);
  }
}

const node = (attrs: Record<string, string> = {}): FakeNode => new FakeNode(attrs);

const emit = (target: FakeNode, type: string): void => {
  const event = { target, preventDefault() {} };
  let current: FakeNode | null = target;
  while (current !== null) {
    for (const listener of current.listeners.get(type) ?? []) listener(event);
    current = current.parentElement;
  }
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};
