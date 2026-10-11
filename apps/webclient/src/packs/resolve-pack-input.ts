/** Add-a-pack (2026-07-01) — parse the "Add a pack" input into a marketplace
 *  slug or a direct URL. Mirrors `resolveRecipeInput` (marketplace client) but
 *  for the `/packs/` route, and lives in the webclient so it never imports
 *  `@recued/marketplace` (role-boundary lint). Recognises:
 *    - `pack-slug`                                   → `{ slug }`
 *    - `recued.com/packs/pack-slug[.json]`           → `{ slug }`
 *    - `https://recued.com/marketplace/packs/slug`   → `{ slug }`
 *    - `https://example.com/pack.json`               → `{ url }` (local import — deferred)
 *  Empty / unparseable → `null`. Pure + exported for unit tests.
 *
 *  ⛔ ITS OWN MODULE, SO NOTHING HAS TO IMPORT THE PACKS ROUTE FOR IT.
 *  `packs-surface.ts` used to take it from `bootstrap-packs-route.ts`, which reads
 *  the surface's styles while it loads: loaded surface-first, the route joined an
 *  empty string where those styles go (`packs-route-styles-load-order.test.ts`). */
export const resolvePackInput = (
  input: string,
): { slug: string } | { url: string } | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Marketplace pack URL (apex root or legacy /marketplace prefix) → slug.
  const webUrl = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?recued\.com(?:\/marketplace)?\/packs\/([a-z0-9][a-z0-9-]*[a-z0-9])(?:\.json)?$/i,
  );
  if (webUrl) return { slug: webUrl[1] };
  // Any other full URL → pass through (an arbitrary/local JSON — the local-import
  // path is deferred, so the resolve caller surfaces it as an unsupported failure).
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  // Bare slug (alphanumeric + hyphens).
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(trimmed)) return { slug: trimmed };
  // Contains a dot but no scheme → treat as a URL.
  if (trimmed.includes('.')) return { url: `https://${trimmed}` };
  // Single short token → slug.
  return { slug: trimmed };
};
