/** Fullscreen for the recipe result container — the operator's big board.
 *
 *  A grouped `table.group_by` board is the first output worth more screen than
 *  the detail pane gives it, so the result host can take the whole display.
 *
 *  ⛔⛔ THIS IS A LAYOUT AFFORDANCE AND NOT A VISITOR SURFACE, and the
 *  difference is one line elsewhere: reception renders with
 *  `RECEPTION_RENDER_CONTEXT = { audience: 'public', interactive: false }`.
 *  Fullscreen changes how much of the screen the owner's output occupies. It
 *  does NOT change the render context — the session is still the owner's, every
 *  row action is still live, and the data is still owner-scoped rather than
 *  visitor-scoped. Hiding the chrome does not remove the session behind it, so
 *  a fullscreened panel must never be described as a public display. The
 *  codebase already settled this: "View as visitor" IFRAMES the real
 *  server-rendered page rather than restyling the owner's.
 *
 *  ⚠ THE API IS INJECTED. `requestFullscreen` needs a live user activation and
 *  a real document, neither of which a unit test has — but the decisions worth
 *  testing (what to do when it is unsupported, which direction to toggle, what
 *  the chrome should then say) are pure. They live here; the DOM lives in
 *  `domFullscreenApi`.
 */
import { RECIPES_ROUTE_ACTION_ATTR } from './recipe-result-panel.js';

/** The attribute the panel stamps on its toggle. */
export const RESULT_FULLSCREEN_ACTION = 'toggle-result-fullscreen';

/** The seam over the Fullscreen API. `supported` is separate from `request`
 *  because a browser that lacks it and an iframe denied `allowfullscreen` fail
 *  differently and must both end as "the button is not offered". */
export interface ResultFullscreenApi {
  readonly supported: boolean;
  current: () => Element | null;
  request: (element: Element) => Promise<void> | void;
  exit: () => Promise<void> | void;
}

interface FullscreenDocumentLike {
  fullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
}
interface FullscreenElementLike {
  requestFullscreen?: (options?: { navigationUI?: string }) => Promise<void>;
}

export const domFullscreenApi = (doc: FullscreenDocumentLike): ResultFullscreenApi => ({
  supported: doc.fullscreenEnabled === true && typeof doc.exitFullscreen === 'function',
  current: () => doc.fullscreenElement ?? null,
  request: (element) => (element as FullscreenElementLike).requestFullscreen?.(),
  exit: () => doc.exitFullscreen?.(),
});

export type ResultFullscreenOutcome = 'entered' | 'exited' | 'unsupported' | 'failed';

/** Toggle the host in or out of fullscreen.
 *
 *  ⛔ Resolves against `current()` rather than a remembered boolean. The user
 *  can leave fullscreen with Escape or the window chrome, and neither tells
 *  this module — a cached flag would invert on the next click and the button
 *  would stop working exactly once per Escape. The document is the only source
 *  of truth for whether we are in it.
 */
export const toggleResultFullscreen = async (
  host: Element,
  api: ResultFullscreenApi,
): Promise<ResultFullscreenOutcome> => {
  if (!api.supported) return 'unsupported';
  try {
    if (api.current() === host) {
      await api.exit();
      return 'exited';
    }
    await api.request(host);
    return 'entered';
  } catch {
    // A rejected request is ordinary — no user activation, a denied iframe, a
    // platform that refuses on this element. The panel stays usable at its
    // normal size, which is the correct fallback, so this is not an error the
    // owner needs to see.
    return 'failed';
  }
};

/** What the toggle should say. Named for the ACTION it performs, not the state
 *  it is in: a button reading "Fullscreen" while already fullscreen is the
 *  ambiguity every toggle-label bug starts from. */
export const resultFullscreenLabel = (active: boolean): string =>
  (active ? 'Exit fullscreen' : 'Fullscreen');

/** Bring the toggle's chrome back in line with the document. Called on
 *  `fullscreenchange`, because Escape and the window chrome both change the
 *  state without routing through the click handler. */
export const syncResultFullscreenChrome = (
  root: { querySelector?: (selector: string) => Element | null },
  host: Element,
  api: ResultFullscreenApi,
): void => {
  const button = root.querySelector?.(
    `[${RECIPES_ROUTE_ACTION_ATTR}="${RESULT_FULLSCREEN_ACTION}"]`,
  );
  if (button === null || button === undefined) return;
  const active = api.current() === host;
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.textContent = resultFullscreenLabel(active);
};
