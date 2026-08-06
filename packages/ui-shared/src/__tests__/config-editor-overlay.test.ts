import { describe, expect, it, vi } from 'vitest';

import { wireConfigEditorOverlay } from '../config-editor-overlay.js';

interface FakeElement {
  className: string;
  innerHTML: string;
  textContent: string;
  removed: boolean;
  children: FakeElement[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<(event: Event) => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  remove(): void;
}

const makeElement = (): FakeElement => {
  const element: FakeElement = {
    className: '',
    innerHTML: '',
    textContent: '',
    removed: false,
    children: [],
    attrs: new Map(),
    listeners: new Map(),
    setAttribute(name, value) {
      element.attrs.set(name, value);
    },
    getAttribute(name) {
      return element.attrs.get(name) ?? null;
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      const listeners = element.listeners.get(type) ?? [];
      listeners.push(listener);
      element.listeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = element.listeners.get(type);
      if (listeners === undefined) return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    remove() {
      element.removed = true;
    },
  };
  return element;
};

const makeDocument = () => {
  const body = makeElement();
  const head = makeElement();
  const documentListeners = new Map<string, Array<(event: Event) => void>>();
  return {
    body,
    styles: head.children,
    head: {
      querySelector: () => null,
      appendChild: (element: FakeElement) => head.appendChild(element),
    },
    activeElement: null,
    createElement: () => makeElement(),
    addEventListener(type: string, listener: (event: Event) => void) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      const listeners = documentListeners.get(type);
      if (listeners === undefined) return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
};

describe('config editor overlay', () => {
  it('injects usable targets for buttons and embedded variable controls', () => {
    const document = makeDocument();
    const handle = wireConfigEditorOverlay({
      document: document as unknown as Document,
      title: 'Config',
      confirmLabel: 'Save',
      variables: {},
      currentOverlay: {},
      onConfirm: vi.fn(),
    });
    const styles = document.styles[0]?.textContent ?? '';
    expect(styles).toContain(
      '.config-editor-button {\n  box-sizing: border-box;\n  min-width: 36px;\n  min-height: 36px;',
    );
    expect(styles).toContain(
      'box-sizing: border-box; width: 100%; min-height: 36px; border:',
    );
    expect(styles).toContain(
      '.config-editor-panel .ref-picker-clear {\n  right: 0;\n  width: 36px;\n  height: 36px;',
    );
    expect(styles).toContain(
      '.config-editor-panel .var-file-refs-btn {\n  width: 36px;\n  height: 36px;',
    );
    expect(styles).toContain(
      '.config-editor-title {\n  min-width: 0;\n  margin: 0;\n  overflow-wrap: anywhere;',
    );
    expect(styles).toContain(
      '.config-editor-header .config-editor-button { flex: 0 0 auto; }',
    );
    handle.destroy();
  });

  it('leaves composing Escape to the active IME', () => {
    const document = makeDocument();
    const onClose = vi.fn();
    const handle = wireConfigEditorOverlay({
      document: document as unknown as Document,
      title: 'Config',
      confirmLabel: 'Save',
      variables: {},
      currentOverlay: {},
      onConfirm: vi.fn(),
      onClose,
    });
    const overlay = handle.element as unknown as FakeElement;
    const fireEscape = (isComposing: boolean) => {
      const stopPropagation = vi.fn();
      for (const listener of overlay.listeners.get('keydown') ?? []) {
        listener({
          key: 'Escape',
          isComposing,
          stopPropagation,
        } as unknown as Event);
      }
      return stopPropagation;
    };

    expect(fireEscape(true)).toHaveBeenCalledTimes(1);
    expect(overlay.removed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    expect(fireEscape(false)).toHaveBeenCalledTimes(1);
    expect(overlay.removed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
