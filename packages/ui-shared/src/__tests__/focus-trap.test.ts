/** Shared modal focus-trap (`focus-trap.ts`).
 *
 *  Pins: initial focus to the dialog surface, Tab/Shift+Tab wrapping within the
 *  container, pulling escaped focus back in, skipping disabled / tabindex=-1
 *  nodes, focus restore + listener detach on release, and `getContainer`
 *  re-acquisition across a simulated re-render.
 *
 *  Rolls a tree-building fake document (the real focusable walk needs actual
 *  child nodes + an `activeElement` the `focus()` calls move).
 */

import { describe, expect, it } from 'vitest';

import { wireFocusTrap } from '../focus-trap.js';

// ── fake DOM ──────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  focus(): void;
}

interface FakeDoc {
  activeElement: FakeEl | null;
  createElement(tag: string): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  fireTab(opts?: { shift?: boolean }): { defaultPrevented: boolean };
  keydownCount(): number;
}

const makeDoc = (): FakeDoc => {
  let activeElement: FakeEl | null = null;
  const keydown: Array<(ev: Event) => void> = [];
  const make = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      disabled: false,
      attrs: new Map(),
      children: [],
      setAttribute: (k, v) => el.attrs.set(k, v),
      getAttribute: (k) => el.attrs.get(k) ?? null,
      appendChild: (c) => {
        el.children.push(c);
        return c;
      },
      focus: () => {
        activeElement = el;
      },
    };
    return el;
  };
  return {
    get activeElement() {
      return activeElement;
    },
    set activeElement(el: FakeEl | null) {
      activeElement = el;
    },
    createElement: make,
    addEventListener: (type, fn) => {
      if (type === 'keydown') keydown.push(fn);
    },
    removeEventListener: (type, fn) => {
      if (type !== 'keydown') return;
      const i = keydown.indexOf(fn);
      if (i >= 0) keydown.splice(i, 1);
    },
    fireTab: (o) => {
      let prevented = false;
      const ev = {
        key: 'Tab',
        shiftKey: o?.shift === true,
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as Event;
      for (const fn of [...keydown]) fn(ev);
      return { defaultPrevented: prevented };
    },
    keydownCount: () => keydown.length,
  };
};

/** A role=dialog panel holding [Close button, text input, a tabindex=-1 span,
 *  a disabled button, a link]. Focusables in order: Close, input, link. */
const buildDialog = (doc: FakeDoc) => {
  const panel = doc.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('tabindex', '-1');
  const close = doc.createElement('button');
  const input = doc.createElement('input');
  const skip = doc.createElement('span');
  skip.setAttribute('tabindex', '-1');
  const disabled = doc.createElement('button');
  disabled.disabled = true;
  const link = doc.createElement('a');
  link.setAttribute('href', '#x');
  panel.appendChild(close);
  panel.appendChild(input);
  panel.appendChild(skip);
  panel.appendChild(disabled);
  panel.appendChild(link);
  return { panel, close, input, disabled, link, skip };
};

const wire = (doc: FakeDoc, container: FakeEl, extra = {}) =>
  wireFocusTrap({
    document: doc as unknown as Document,
    getContainer: () => container as unknown as HTMLElement,
    ...extra,
  });

// ── tests ─────────────────────────────────────────────────────────

describe('wireFocusTrap', () => {
  it('focuses the dialog surface on wire', () => {
    const doc = makeDoc();
    const { panel } = buildDialog(doc);
    wire(doc, panel);
    expect(doc.activeElement).toBe(panel);
  });

  it('initialFocus:false leaves focus untouched', () => {
    const doc = makeDoc();
    const opener = doc.createElement('button');
    opener.focus();
    const { panel } = buildDialog(doc);
    wire(doc, panel, { initialFocus: false });
    expect(doc.activeElement).toBe(opener);
  });

  it('Tab at the last focusable wraps to the first', () => {
    const doc = makeDoc();
    const { panel, close, link } = buildDialog(doc);
    wire(doc, panel);
    link.focus(); // last focusable
    const r = doc.fireTab();
    expect(r.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(close); // first focusable
  });

  it('Shift+Tab at the first focusable wraps to the last', () => {
    const doc = makeDoc();
    const { panel, close, link } = buildDialog(doc);
    wire(doc, panel);
    close.focus(); // first focusable
    const r = doc.fireTab({ shift: true });
    expect(r.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(link); // last focusable
  });

  it('a Tab in the middle of the trap is left to the browser', () => {
    const doc = makeDoc();
    const { panel, input } = buildDialog(doc);
    wire(doc, panel);
    input.focus(); // a middle focusable
    const r = doc.fireTab();
    expect(r.defaultPrevented).toBe(false); // native Tab proceeds
    expect(doc.activeElement).toBe(input);
  });

  it('pulls escaped focus back into the trap (Tab → first, Shift+Tab → last)', () => {
    const doc = makeDoc();
    const { panel, close, link } = buildDialog(doc);
    const outside = doc.createElement('button');
    wire(doc, panel);
    outside.focus(); // focus escaped the dialog
    expect(doc.activeElement).toBe(outside);
    expect(doc.fireTab().defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(close); // pulled to first
    outside.focus();
    expect(doc.fireTab({ shift: true }).defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(link); // pulled to last
  });

  it('skips disabled + tabindex=-1 nodes', () => {
    const doc = makeDoc();
    const { panel, close, link, disabled, skip } = buildDialog(doc);
    wire(doc, panel);
    // Last focusable is the link (the disabled button + tabindex=-1 span after
    // the input are skipped), so Tab from it wraps to Close.
    link.focus();
    doc.fireTab();
    expect(doc.activeElement).toBe(close);
    expect(doc.activeElement).not.toBe(disabled);
    expect(doc.activeElement).not.toBe(skip);
  });

  it('release() detaches the listener and restores the opener', () => {
    const doc = makeDoc();
    const opener = doc.createElement('button');
    opener.focus();
    const { panel, link } = buildDialog(doc);
    const handle = wire(doc, panel);
    expect(doc.keydownCount()).toBe(1);
    handle.release();
    expect(doc.keydownCount()).toBe(0); // listener gone
    expect(doc.activeElement).toBe(opener); // focus restored
    // A Tab after release is inert (no wrap).
    link.focus();
    expect(doc.fireTab().defaultPrevented).toBe(false);
    expect(doc.activeElement).toBe(link);
  });

  it('release() is idempotent', () => {
    const doc = makeDoc();
    const { panel } = buildDialog(doc);
    const handle = wire(doc, panel);
    handle.release();
    handle.release();
    expect(doc.keydownCount()).toBe(0);
  });

  it('restoreFocus:false leaves focus where it is on release', () => {
    const doc = makeDoc();
    const opener = doc.createElement('button');
    opener.focus();
    const { panel, close } = buildDialog(doc);
    const handle = wire(doc, panel, { restoreFocus: false });
    close.focus();
    handle.release();
    expect(doc.activeElement).toBe(close);
  });

  it('re-acquires the container via getContainer across a re-render', () => {
    const doc = makeDoc();
    const first = buildDialog(doc);
    let container = first.panel;
    const handle = wireFocusTrap({
      document: doc as unknown as Document,
      getContainer: () => container as unknown as HTMLElement,
      initialFocus: false,
    });
    // Simulate a repaint: a brand-new dialog element replaces the old one.
    const second = buildDialog(doc);
    container = second.panel;
    second.link.focus(); // last focusable of the NEW dialog
    expect(doc.fireTab().defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(second.close); // wrapped within the NEW dialog
    handle.release();
  });

  it('no-ops when getContainer returns null', () => {
    const doc = makeDoc();
    const handle = wireFocusTrap({
      document: doc as unknown as Document,
      getContainer: () => null,
      initialFocus: false,
    });
    expect(doc.fireTab().defaultPrevented).toBe(false);
    handle.release();
  });

  it('with no focusables, keeps focus on the container', () => {
    const doc = makeDoc();
    const bare = doc.createElement('div');
    bare.setAttribute('role', 'dialog');
    bare.setAttribute('tabindex', '-1');
    wire(doc, bare);
    expect(doc.activeElement).toBe(bare); // initial focus → container
    const r = doc.fireTab();
    expect(r.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(bare); // stays put
  });

  it('treats <summary> as focusable and keeps an open <details> in the order', () => {
    const doc = makeDoc();
    const panel = doc.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('tabindex', '-1');
    const before = doc.createElement('button');
    const details = doc.createElement('details');
    details.setAttribute('open', ''); // OPEN → content stays tabbable
    const summary = doc.createElement('summary');
    const inner = doc.createElement('input');
    details.appendChild(summary);
    details.appendChild(inner);
    panel.appendChild(before);
    panel.appendChild(details);
    // Order: before, summary, inner. Tab from the last (inner) wraps to before.
    wire(doc, panel);
    inner.focus();
    doc.fireTab();
    expect(doc.activeElement).toBe(before);
    // A Tab from the middle summary is native (not pulled back).
    summary.focus();
    expect(doc.fireTab().defaultPrevented).toBe(false);
  });

  it('skips the content of a collapsed <details> (only the summary tabs)', () => {
    const doc = makeDoc();
    const panel = doc.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('tabindex', '-1');
    const before = doc.createElement('button');
    const details = doc.createElement('details'); // CLOSED (no `open`)
    const summary = doc.createElement('summary');
    const hidden = doc.createElement('input'); // collapsed content
    details.appendChild(summary);
    details.appendChild(hidden);
    panel.appendChild(before);
    panel.appendChild(details);
    // Order: before, summary (the hidden input is unreachable). Last is summary
    // → Tab wraps to before, never landing on the collapsed input.
    wire(doc, panel);
    summary.focus();
    doc.fireTab();
    expect(doc.activeElement).toBe(before);
    expect(doc.activeElement).not.toBe(hidden);
  });

  it('excludes negative / non-numeric tabindex from the tab order', () => {
    const doc = makeDoc();
    const panel = doc.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('tabindex', '-1');
    const real = doc.createElement('button');
    const negTwo = doc.createElement('div');
    negTwo.setAttribute('tabindex', '-2');
    const bogus = doc.createElement('div');
    bogus.setAttribute('tabindex', 'nope');
    const tabbable = doc.createElement('div');
    tabbable.setAttribute('tabindex', '0');
    panel.appendChild(real);
    panel.appendChild(negTwo);
    panel.appendChild(bogus);
    panel.appendChild(tabbable);
    // Focusables: real + tabbable (the -2 / bogus divs are out). Tab from the
    // last (tabbable) wraps to real.
    wire(doc, panel);
    tabbable.focus();
    doc.fireTab();
    expect(doc.activeElement).toBe(real);
  });

  it('focusInitial() focuses a container that mounts AFTER wiring', () => {
    const doc = makeDoc();
    let container: FakeEl | null = null;
    const handle = wireFocusTrap({
      document: doc as unknown as Document,
      getContainer: () => container as unknown as HTMLElement | null,
      initialFocus: false,
    });
    expect(doc.activeElement).toBeNull(); // no container yet → nothing focused
    const built = buildDialog(doc);
    container = built.panel; // "mounted"
    handle.focusInitial();
    expect(doc.activeElement).toBe(built.panel);
    handle.release();
  });

  it('focusInitial() is a no-op after release', () => {
    const doc = makeDoc();
    const { panel } = buildDialog(doc);
    const handle = wire(doc, panel, { initialFocus: false });
    handle.release();
    handle.focusInitial();
    expect(doc.activeElement).toBeNull();
  });
});
