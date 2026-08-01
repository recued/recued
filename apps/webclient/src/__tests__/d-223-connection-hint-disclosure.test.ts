/** D-223 — the install dialog's disclosure for a pack that HINTS but declares no
 *  `connection_requirements`.
 *
 *  ⛔ THE DEFECT THIS EXISTS FOR, found only by a live-server run (2026-07-30).
 *  The first revision of this section offered a "Set up <slug>" link worded
 *  "setting it up now fills in what the publisher told us". Driven for real —
 *  third-party pack on a booted server, system Chrome, paired — that link
 *  reached a form with an EMPTY `config.base_url` and no attribution, because
 *  `connections-enroll-panel` sources hints from INSTALLED packs and the pack is
 *  by definition not installed while its install dialog is open. Installing
 *  first and re-opening the same form showed the value pre-filled and marked
 *  "Suggested by acme-co". So the section promised precisely the thing its own
 *  route could not deliver, and the working route (the pack detail's "Set up →")
 *  already existed and pre-dates D-223.
 *
 *  Both halves are pinned here: the copy must not promise immediate pre-fill,
 *  and the section must not carry a link at all. Neither is provable from
 *  `renderPacksInstallDialog`'s 16-prop surface, which is why the render was
 *  extracted. Fake DOM, per this package's no-jsdom discipline. */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_CONNECT_HINT_ATTR,
  renderConnectionHintDisclosure,
} from '../settings/packs-install-dialog.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeElement[];
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(el: FakeElement): FakeElement;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    children,
    attrs,
    setAttribute: (k, v) => { attrs.set(k, v); },
    getAttribute: (k) => attrs.get(k) ?? null,
    appendChild: (child) => { children.push(child); return child; },
  };
  return el;
};

const fakeDocument = {
  createElement: (tag: string) => makeFakeElement(tag),
} as unknown as Document;

/** Every tag in the subtree — the "is there a link anywhere in here" probe. */
const tags = (el: FakeElement): string[] =>
  [el.tagName, ...el.children.flatMap((c) => tags(c))];

const allText = (el: FakeElement): string =>
  [el.textContent, ...el.children.map((c) => allText(c))].join(' ');

const render = (slug = 'acme'): FakeElement =>
  renderConnectionHintDisclosure(fakeDocument, slug) as unknown as FakeElement;

describe('D-223 — hint-only pack connection disclosure', () => {
  it('names the connection the pack wants', () => {
    const section = render('acme');
    expect(section.getAttribute(PACKS_DIALOG_CONNECT_HINT_ATTR)).toBe('acme');
    expect(allText(section)).toContain('acme');
  });

  it('carries no link — the route it would offer cannot pre-fill yet', () => {
    // ⛔ The regression this file is really for. A link here reads as "the fast
    // path", and it is the one path where the hint provably does not apply.
    expect(tags(render())).not.toContain('A');
  });

  it('does not promise a pre-fill that has not happened', () => {
    // The original wording, pinned as forbidden. Anything telling the owner the
    // values are being filled in AS THEY CLICK is the false claim; naming what
    // happens after install is not.
    const text = allText(render());
    expect(text).not.toContain('Setting it up now fills in');
    expect(text).not.toMatch(/now fills in/iu);
  });

  it('names the order that does work', () => {
    // The permitting case: this must still be useful, not merely inoffensive.
    // Without this a future edit could satisfy every assertion above by emitting
    // an empty section.
    const text = allText(render());
    expect(text).toMatch(/install it first/iu);
    expect(text).toMatch(/change anything before saving/iu);
  });

  it('still renders a paragraph carrying the copy', () => {
    // Same guard, structural: the section is not an empty shell.
    const section = render();
    expect(tags(section)).toContain('P');
    expect(allText(section).trim().length).toBeGreaterThan(60);
  });

  it('uses the slug it is given rather than a hardcoded one', () => {
    const section = render('billing-api');
    expect(section.getAttribute(PACKS_DIALOG_CONNECT_HINT_ATTR)).toBe('billing-api');
    expect(allText(section)).toContain('billing-api');
  });
});
