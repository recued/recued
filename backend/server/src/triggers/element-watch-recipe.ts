/** "Watch this element" — pure recipe scaffold for the Bridge dom-watch UX
 *  affordance (the client surface on top of the D-179 reactive dom-watch
 *  substrate).
 *
 *  The Bridge's element picker captures a `(url, selector)` target; the
 *  server rpc `triggers.createElementWatch` (element-watch-handler.ts) calls
 *  this to mint a minimal LOCAL recipe — an `element.changed` sugar trigger
 *  plus one `notification-send` step that fires when the watched element's
 *  text changes. Saving that recipe is the WHOLE server-side action: the
 *  declarative event-trigger reconciler (wired on `recipeStore.setOnMutated`
 *  in `serve/compose-listeners.ts`) compiles the sugar via
 *  `compileTriggerSugarEntry` into a `data.dom.element.<target>.updated`
 *  subscription and materializes the trigger row. No explicit
 *  `triggers.create` is needed.
 *
 *  The materialized row is DISARMED by default (D-179 P5c) — the user arms
 *  it in #automation. So this scaffold CREATES the watch; it does not start
 *  the poll.
 *
 *  Pure + deterministic: the same `(url, selector)` always yields the same
 *  `recipe_id`, so re-watching the same element OVERWRITES rather than
 *  duplicating (the reconciler's diff then treats the watch as already
 *  present and leaves its enabled / fire bookkeeping untouched).
 *
 *  The recipe stays LOCAL (`source: 'inline'`, publisher `local`). The §5
 *  publish gate bars an arbitrary-domain dom watch from a self-serve
 *  PUBLISHED recipe; the shareable form ships in a signed pack. This
 *  affordance authors a local recipe, so it is squarely on the allowed
 *  side of that gate. */

import { createHash } from 'node:crypto';
import type { RecipeDefinition } from '@recued/contracts';

/** Local publisher / author sentinel — the same value `getVaultScope`
 *  assigns unverified / local content. */
export const ELEMENT_WATCH_PUBLISHER = 'local';

/** `recipe_id` prefix for element-watch scaffolds. The suffix is a
 *  digest of the target (see `elementWatchRecipeId`); both stay within the
 *  `[a-z0-9-]` recipe_id grammar. */
export const ELEMENT_WATCH_RECIPE_ID_PREFIX = 'element-watch-';

export interface ElementWatchRecipeInput {
  /** Chrome match pattern naming the tab/origin to watch
   *  (e.g. `https://app.hubspot.com/contacts/*`). Whitespace-free. */
  url: string;
  /** CSS selector whose text is polled for change. */
  selector: string;
  /** Optional human label; falls back to a host-derived name. */
  label?: string;
}

/** Stable 16-hex digest of the `(url, selector)` target. Hex keeps the
 *  `recipe_id` inside the `[a-z0-9-]` grammar AND makes re-watching the same
 *  element idempotent. The `\n` separator can appear in neither half (the
 *  url is whitespace-free; a newline carries no meaning in a selector), so
 *  the digest is injective over realistic targets. */
const targetDigest = (url: string, selector: string): string =>
  createHash('sha256').update(`${url}\n${selector}`).digest('hex').slice(0, 16);

export const elementWatchRecipeId = (url: string, selector: string): string =>
  `${ELEMENT_WATCH_RECIPE_ID_PREFIX}${targetDigest(url, selector)}`;

/** Best-effort host for the recipe name + notify copy — the match pattern's
 *  authority segment, or the raw pattern when it doesn't parse as a URL.
 *  Display-only; never feeds the watch target (that is the literal url). */
const patternHost = (url: string): string => {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url;
  const host = afterScheme.split('/')[0] ?? afterScheme;
  return host.length > 0 ? host : url;
};

/** Build the minimal local notify recipe for a `(url, selector)` watch.
 *  Well-formed by construction; the handler runs `validateRecipe` over the
 *  result defensively so any grammar drift surfaces as a clean rpc error. */
export const buildElementWatchRecipe = (input: ElementWatchRecipeInput): RecipeDefinition => {
  const { url, selector } = input;
  const recipe_id = elementWatchRecipeId(url, selector);
  const host = patternHost(url);
  const trimmedLabel = input.label?.trim();
  const name = trimmedLabel && trimmedLabel.length > 0
    ? trimmedLabel
    : `Watch element on ${host}`;

  return {
    recipe_id,
    version: 1,
    ttl: 60,
    // Reactive watch, not a chat-invocable action — keep it out of the chat
    // agent's tool catalog.
    chat_exposed: false,
    metadata: {
      name,
      description:
        `Notifies when the element "${selector}" on ${host} changes. ` +
        'Created from the Browser Bridge "watch this element" affordance.',
      author: ELEMENT_WATCH_PUBLISHER,
      supported_platforms: [],
      tags: ['dom-watch', 'reactive', 'local'],
    },
    variables: {},
    // notification-send needs the notification_send permission (D-158).
    requires: ['notification_send'],
    // DOM-watch authoring sugar (trigger-sugar.ts). The reconciler compiles
    // this to `data.dom.element.<encodeDomWatchTarget(url, selector)>.updated`.
    event_triggers: [{ on: 'element.changed', url, selector }],
    prefetch_steps: [],
    steps: [
      // The dom poll emits one record keyed by the selector with `{ text }`,
      // surfaced at `context.event.payload.record.text`. Doorbell-shaped
      // events can omit it, so default for robustness (a missing value must
      // never blank the notification body).
      {
        id: 'new_text',
        transform: 'default',
        value: '{{context.event.payload.record.text}}',
        fallback: '(content unavailable)',
      },
      {
        id: 'notify',
        ingredient: 'notification-send',
        input: {
          channels: ['in_app'],
          title: name,
          text: `A watched element on ${host} changed. New content: {{step.new_text}}`,
          link_url: null,
        },
      },
    ],
    output: {
      render: [{ type: 'text', source: 'step.new_text' }],
    },
  };
};
