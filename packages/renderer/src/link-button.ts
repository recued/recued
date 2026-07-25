/** D-196 § 4.5 / D-207 slice 2 — the link-button block. ONE renderer, every
 *  surface: the reception PAGE (authored rows, from registry metadata) and the
 *  intake-form RESPONSE (rows a recipe run produced). D-196 § 4.5 settled this
 *  as *"a general form element… available to any reception form/page
 *  composition"* — not a seller-specific one — so a second renderer for it is a
 *  bug, not a convenience. Both consumers call this.
 *
 *  ## Why this block exists when `button` already does
 *
 *  `button` carries a `recipe.run` descriptor and renders an INERT label: the
 *  shared renderer has no execution path, so it never navigates anywhere. That
 *  is the right answer for the owner's sidebar (the result panel owns the real
 *  control) and a useless one for a visitor, who has no way to run a recipe at
 *  all. A link button is just an anchor. It is what makes "Proceed to payment →
 *  [Checkout]" and D-196's Subscribe page the same block.
 *
 *  ## The href fence
 *
 *  ⛔ ESCAPING IS NOT THE FENCE. `htmlEscape('javascript:alert(1)')` is
 *  `javascript:alert(1)` — every character survives, and it stays a working
 *  `href`. What makes the target safe is `isReceptionLinkButtonUrl`'s
 *  absolute-HTTPS check, reached here through `selectValidReceptionLinkButtons`.
 *  We revalidate the RAW data on every render rather than trusting the caller:
 *  these rows arrive from stored registry metadata and from recipe-run output,
 *  neither of which passed through the D-145 packet's strict-pick, and a caller
 *  that forgot to filter is exactly the caller that would emit the bad target.
 *
 *  Invalid rows are DROPPED, not thrown on — one corrupt row must not 500 a
 *  visitor's page, and must not render either. */

import { selectValidReceptionLinkButtons, type ReceptionLinkButton } from '@recued/contracts';

import { e } from './escape.js';
import { renderBlockEmpty } from './block-error.js';

const renderOneLinkButton = (button: ReceptionLinkButton): string => {
  const description =
    typeof button.description === 'string' && button.description.length > 0
      ? `<p class="link-button-description">${e(button.description)}</p>`
      : '';
  // `rel="noopener noreferrer"`: the destination is off-site and, for a public
  // reception surface, attacker-reachable via whatever the recipe computed. It
  // gets no `window.opener` handle back and no referrer.
  return `<div class="link-button"><a class="link-button-link" href="${e(button.url)}" rel="noopener noreferrer">${e(button.label)}</a>${description}</div>`;
};

export const renderLinkButtonBlock = (data: unknown): string => {
  const buttons = selectValidReceptionLinkButtons(data);
  if (buttons.length === 0) return renderBlockEmpty('link_button');
  return `
    <div class="block link-button-block">
      ${buttons.map(renderOneLinkButton).join('')}
    </div>
  `;
};
