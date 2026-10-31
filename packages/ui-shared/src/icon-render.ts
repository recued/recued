/** Inline-SVG renderer for the shared UI templates.
 *
 *  Returns the raw SVG markup of an icon with an optional CSS class
 *  injected onto the root `<svg>` element. The SVG itself comes from
 *  `icons.generated.ts` and the shared action glyphs in `action-icons.ts`.
 *
 *  Glyph icons (settings, play, check, x, marketplace, info, spinner)
 *  use `currentColor` so a single file works across light/dark themes.
 *  Brand icons (logo, action) carry explicit fills.
 *
 *  Usage in a template:
 *    `${renderIcon('settings', 'icon icon-md')}`
 *
 *  The injected class is appended to whatever class attribute the
 *  source SVG already has (or added if missing). If `name` doesn't
 *  exist in the registry, returns an empty string — the template
 *  silently degrades instead of breaking the page.
 */

import type { WorkEntityIconName } from '@recued/contracts';

import { ICONS, type IconName } from './icons.generated.js';
import { e } from './template.js';

export type { IconName } from './icons.generated.js';
export { ICONS, ICON_NAMES } from './icons.generated.js';

/** Typed seam between TWO closed vocabularies that had only a prose link.
 *
 *  `WorkEntityIconName` (contracts, now aliased to `WorkEntityKind`) names the
 *  icon every work-entity nav spec must carry; `IconName` (here) names the
 *  glyphs that actually exist. Nothing enforced the overlap — the nav
 *  registry's comment merely ASKED for "a matching SVG entry over there", and
 *  `renderIcon` returns `''` on a miss, so a kind with no glyph renders a blank
 *  space rather than failing.
 *
 *  This makes the omission a compile error instead. When the union widens
 *  without a glyph, the conditional resolves to `never` and this assignment
 *  fails, naming the file to edit. Exported so it cannot be pruned as unused.
 *  [[feedback_two_closed_lists_need_a_typed_seam]] */
export const WORK_ENTITY_ICONS_ARE_REGISTERED: WorkEntityIconName extends IconName
  ? true
  : never = true;

/** Inline an icon into a template literal. The optional `className`
 *  is added to the root `<svg>` tag so callers can size + theme it
 *  without separate CSS hooks. Pure — no DOM, no side effects. */
export interface IconRenderOptions {
  /** The surrounding control supplies the name. Hide the glyph and its title. */
  decorative?: boolean;
  /** Positive, finite pixel size. Invalid runtime values leave sizing to CSS. */
  size?: number;
}

export const renderIcon = (name: IconName, className?: string, options: IconRenderOptions = {}): string => {
  let svg = ICONS[name];
  if (!svg) return '';
  if (options.decorative) {
    svg = svg.replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').replace(/^<svg([^>]*)>/, (_match, attrs: string) =>
      `<svg${attrs.replace(/\s(?:role|aria-label|aria-labelledby|aria-describedby|aria-hidden|focusable)="[^"]*"/g, '')} aria-hidden="true" focusable="false">`);
  }
  if (typeof options.size === 'number' && Number.isFinite(options.size) && options.size > 0) {
    svg = svg.replace(/^<svg([^>]*)>/, (_match, attrs: string) =>
      `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, '')} width="${options.size}" height="${options.size}">`);
  }
  if (!className) return svg;
  const escapedClass = e(className);

  // Inject the class into the root svg tag. If a class attribute
  // already exists, append; otherwise add a new one. We only touch
  // the FIRST <svg ... > to avoid mangling nested svg if the icon
  // ever uses one (none currently do).
  return svg.replace(/^<svg([^>]*)>/, (_match, attrs: string) => {
    const classMatch = attrs.match(/(\sclass=")([^"]*)(")/);
    if (classMatch) {
      return `<svg${attrs.replace(
        /(\sclass=")([^"]*)(")/,
        (_match, prefix: string, current: string, suffix: string) => `${prefix}${current} ${escapedClass}${suffix}`,
      )}>`;
    }
    return `<svg class="${escapedClass}"${attrs}>`;
  });
};

/** A compact glyph inside a named action control. */
export const renderActionIcon = (name: IconName, className?: string): string =>
  renderIcon(name, className, { decorative: true, size: 18 });

/** Contents for a labelled action. Keep the control and its listeners intact
 * when updating a DOM button's label during loading or recovery. */
export const renderActionLabel = (name: IconName, label: string): string =>
  `${renderActionIcon(name)}<span>${e(label)}</span>`;
