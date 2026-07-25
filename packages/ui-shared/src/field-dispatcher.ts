/** Attribute-keyed form-field listener attachment.
 *
 *  Surfaces (kitchen, options) emit form inputs tagged by data
 *  attributes — `data-var`, `data-meta-field`, `data-recipe-field`,
 *  `data-step-field`, etc. Each one used to carry its own attach
 *  loop:
 *
 *    const inputs = root.querySelectorAll<...>('[data-var]');
 *    for (const input of inputs) {
 *      const evt = input.tagName === 'SELECT' || input.type === 'checkbox'
 *        ? 'change'
 *        : 'input';
 *      input.addEventListener(evt, () => handleX(input));
 *    }
 *
 *  …times nine across kitchen. The pattern is "pick event by tag,
 *  attach handler" every single time — same boilerplate, different
 *  attribute + handler.
 *
 *  This primitive factors out the attach + event-picking boilerplate
 *  and gates the set of attributes on a caller-supplied union, so the
 *  handlers map must cover every attribute the union names. Renaming
 *  a `data-*` attribute without renaming its handler becomes a compile
 *  error, and removing a handler the caller still emits stops silently
 *  working.
 *
 *  Unlike the click dispatcher, these listeners are PER-ELEMENT —
 *  `input`/`change` events bubble, but the "pick the right event by
 *  tag" logic is per-element, and the action-dispatcher-style
 *  delegation with both events would double-fire on <select>. So
 *  attach on each element, same as the pre-existing code; the win
 *  here is the compile-time coverage + unified event resolution,
 *  not listener-count reduction.
 */

export type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Handler invoked when a matching field fires its resolved event. */
export type FieldHandler = (element: FieldElement, event: Event) => void;

/** Event-picking strategy for a field.
 *  - `auto`: `change` for SELECT and checkbox inputs, `input` for
 *    everything else. Matches the hand-rolled convention.
 *  - explicit: force a single event name. Use `blur` for rename
 *    commits; `change` for selects that shouldn't respond to every
 *    keystroke; `input` for text that needs live state updates.
 */
export type FieldEventPreference = 'auto' | 'input' | 'change' | 'blur';

export interface FieldHandlerSpec {
  handler: FieldHandler;
  event?: FieldEventPreference;
  /** Skip elements that carry a `readonly` attribute. The step-field
   *  listener uses this so read-only rows (e.g. display-only step
   *  ids) don't try to mutate state on phantom inputs. */
  skipReadonly?: boolean;
}

/** Typed handlers map. Pass a handler directly (auto event picking)
 *  or a spec object for event-preference and readonly overrides. */
export type FieldHandlers<K extends string> = {
  [attribute in K]: FieldHandler | FieldHandlerSpec;
};

const resolveEvent = (el: FieldElement, preference: FieldEventPreference): string => {
  if (preference !== 'auto') return preference;
  if (el.tagName === 'SELECT') return 'change';
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') return 'change';
  return 'input';
};

/** Attach handlers for every attribute in `handlers`.
 *
 *  Called from the surface's `attachHandlers` at each re-render, like
 *  the pre-existing attach loops — the primitive doesn't try to be
 *  clever about persistence. Keeping the call-site shape unchanged
 *  means this is a pure DRY refactor with no behavioral risk. */
export const attachFieldHandlers = <K extends string>(
  root: HTMLElement,
  handlers: FieldHandlers<K>,
): void => {
  for (const attribute of Object.keys(handlers) as K[]) {
    const raw = handlers[attribute];
    const spec: FieldHandlerSpec = typeof raw === 'function' ? { handler: raw } : raw;
    const elements = root.querySelectorAll<FieldElement>(`[${attribute}]`);
    for (const el of elements) {
      if (spec.skipReadonly && el.hasAttribute('readonly')) continue;
      const evt = resolveEvent(el, spec.event ?? 'auto');
      el.addEventListener(evt, (event) => spec.handler(el, event));
    }
  }
};
