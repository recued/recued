/** Typed delegated click dispatch for `data-action` markup.
 *
 *  Surfaces (kitchen, sidebar) emit `<button data-action="foo" data-x="...">`
 *  and used to carry ad-hoc dispatchers: a big switch statement keyed on
 *  `dataset.action` plus a per-button `addEventListener` loop. Typos in
 *  the emitted strings, missing handlers, and extra handlers all fell
 *  through silently — the compiler had no way to match templates to
 *  dispatchers.
 *
 *  The primitive here does the plumbing:
 *    - A single delegated click listener on the root (re-render replaces
 *      the inner DOM, so per-button listeners would be re-attached every
 *      frame anyway — one root listener is both cheaper and simpler).
 *    - `dataset` is handed to the handler so each action reads whatever
 *      extra data-* attributes it needs (`data-step-id`, `data-key`, …).
 *    - The handlers map is typed by a caller-supplied action union, so
 *      TypeScript enforces that every action the templates emit has a
 *      handler and every handler maps to an action that exists.
 *
 *  Callers build the action union as a literal string-type export so the
 *  same identifier gates both the primitive (`button({ action: 'save' })`)
 *  and the dispatcher (`handlers: { save: ..., ... }`). The compiler
 *  then catches "renamed the action string but forgot to rename the
 *  handler" as an unassigned-key error.
 */

/** Handler for a single action. Receives the dataset of the matched
 *  element, the original event, and the element itself — most handlers
 *  only need the dataset, but edge cases (stopPropagation, element
 *  mutation like `btn.textContent = 'Installing…'`) can reach the
 *  event or element directly. */
export type ActionHandler = (
  dataset: DOMStringMap,
  event: Event,
  element: HTMLElement,
) => void;

/** Map of action name → handler. The `A` type parameter is a string
 *  literal union that callers export alongside their templates. */
export type ActionHandlers<A extends string> = {
  readonly [K in A]: ActionHandler;
};

export interface ActionDispatcherProps<A extends string> {
  /** Root element whose event bubbles are listened to. The listeners
   *  stay attached for the lifetime of the root; call the returned
   *  `dispose` function to detach (e.g. on teardown). */
  root: HTMLElement;
  /** Typed handlers map. */
  handlers: ActionHandlers<A>;
  /** Event types to listen for. Defaults to `['click']`. Surfaces
   *  with `<select data-action="...">` dispatching on value-commit
   *  should pass `['click', 'change']` so the select and button
   *  dispatches share one handler map. */
  events?: readonly string[];
  /** Optional scope predicate — return false for events that should
   *  NOT trigger dispatch (e.g. when a nested widget has its own
   *  handling). Defaults to "always dispatch". */
  shouldDispatch?: (target: HTMLElement, event: Event) => boolean;
}

/** Install the dispatcher and return a `dispose` function. The
 *  dispatcher calls `event.preventDefault()` when it matches an
 *  action — it matches the legacy per-button behavior and keeps
 *  `<a data-action="...">` from navigating. */
export const createActionDispatcher = <A extends string>(
  props: ActionDispatcherProps<A>,
): (() => void) => {
  const { root, handlers, shouldDispatch } = props;
  const events = props.events ?? ['click'];
  const listener = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const el = target.closest<HTMLElement>('[data-action]');
    if (!el || !root.contains(el)) return;
    if (shouldDispatch && !shouldDispatch(el, event)) return;
    const action = el.dataset.action;
    if (!action) return;
    const handler = (handlers as Record<string, ActionHandler>)[action];
    if (!handler) return;
    event.preventDefault();
    handler(el.dataset, event, el);
  };
  for (const evt of events) root.addEventListener(evt, listener);
  return () => {
    for (const evt of events) root.removeEventListener(evt, listener);
  };
};
