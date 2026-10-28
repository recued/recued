/** A small fake DOM for Kitchen route tests: the calls, clicks and text a browser has,
 *  and nothing the routes do not use. */
export class FakeEl {
  hidden = false; disabled = false; value = ''; type = ''; spellcheck = true; rows = 0; className = '';
  style = { cssText: '' };
  children: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  private ownText: string | undefined;
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.ownText ?? this.children.map((child) => typeof child === 'string' ? child : child.textContent).join('');
  }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string): void { this.attrs.delete(key); }
  append(...children: Array<FakeEl | string>): void {
    this.ownText = undefined;
    for (const child of children) {
      if (typeof child !== 'string') child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Array<FakeEl | string>): void { this.children = []; this.append(...children); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  addEventListener(type: string, fn: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatch(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
  /** Like a browser: a disabled button ignores the click. */
  click(): void { if (!this.disabled) this.dispatch('click'); }
}

export const fakeDocument = (): Document => ({ createElement: (tag: string) => new FakeEl(tag) }) as unknown as Document;
export const allOf = (root: FakeEl): FakeEl[] => [root, ...root.children.flatMap((child) => typeof child === 'string' ? [] : allOf(child))];
export const byText = (root: FakeEl, tag: string, text: string): FakeEl => {
  const found = allOf(root).find((el) => el.tag === tag && el.textContent === text);
  if (!found) throw new Error(`no <${tag}> "${text}"`);
  return found;
};
export const statusOf = (root: FakeEl): string => allOf(root).find((el) => el.attrs.get('role') === 'status')?.textContent ?? '';
export const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
export const rpcError = (code: string, message = code): Error => Object.assign(new Error(message), { code });
